/**
 * Bestellungen (Modul `orders`) → Kasse: Rechnungen und Auszahlungen per Push (siehe `contract.ts`).
 *
 * Die Kasse vertraut dem aufrufenden Modul (keine Prüfung von `treasury.*`-Rechten). Alle Funktionen
 * laufen AUSSERHALB von Modul-Transaktionen: Dienste (`members`), Mail, Audit, Storage und das Amt
 * „Kasse“ werden vor bzw. nach der eigenen Transaktion aufgerufen (PGlite hat nur eine Sitzung).
 */
import { sql } from 'drizzle-orm';
import { core, errors, type RequestContext, type Tx } from '$lib/sdk/server';
import { storeIban } from './bank';
import type {
	ExternalInvoiceStatus,
	ExternalPayableStatus,
	OrderInvoiceInput,
	OrderInvoiceResult,
	OrderPayableInput
} from './contract';
import {
	idList,
	loadRawInvoices,
	mdb,
	membersService,
	nextInvoiceNumber,
	num,
	rows,
	str,
	today,
	type Row
} from './db';
import { refreshSentDocuments, sendDocuments } from './documents';
import { addDays, invoiceTotals, sanitizeName } from './logic';
import { notifyKasse, payableNotification } from './office-notify';
import {
	MAX_RECEIPT_BYTES,
	MODULE_ID,
	RECEIPT_CONTENT_TYPES,
	SETTING_KEYS,
	payableInput
} from './schemas';

const ORDER_CANCEL_REASON = 'Bestellung storniert';
const MAX_KEY = 200;
const MAX_LINES = 200;

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** Gemeinsame Sperre je Schlüssel bis zum Transaktionsende (parallele Aufrufe derselben Bestellung) */
async function lockKey(tx: Tx, key: string): Promise<void> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`treasury.order:${key}`}))`);
}

// --- Rechnungen ------------------------------------------------------------------

interface WantLine {
	ref: string;
	description: string;
	amountCents: number;
	position: number;
}

function validateInvoiceInput(input: OrderInvoiceInput): WantLine[] {
	const issues: { path: (string | number)[]; message: string }[] = [];
	if (!input.sourceKey || input.sourceKey.length > MAX_KEY) {
		issues.push({ path: ['sourceKey'], message: 'Ungültiger Schlüssel der Bestellung' });
	}
	if (!input.memberId) issues.push({ path: ['memberId'], message: 'Mitglied fehlt' });
	if (input.lines.length > MAX_LINES) {
		issues.push({ path: ['lines'], message: `Höchstens ${MAX_LINES} Posten` });
	}
	const seen = new Set<string>();
	const lines: WantLine[] = [];
	input.lines.forEach((l, i) => {
		if (!l.ref || l.ref.length > MAX_KEY || !l.ref.startsWith(`${input.sourceKey}:`)) {
			issues.push({
				path: ['lines', i, 'ref'],
				message: 'Der Schlüssel des Postens muss mit dem Schlüssel der Bestellung beginnen'
			});
		} else if (seen.has(l.ref)) {
			issues.push({ path: ['lines', i, 'ref'], message: 'Posten doppelt' });
		}
		seen.add(l.ref);
		const description = (l.description ?? '').trim();
		if (!description) {
			issues.push({ path: ['lines', i, 'description'], message: 'Bezeichnung fehlt' });
		}
		if (!Number.isSafeInteger(l.amountCents) || l.amountCents < 0) {
			issues.push({
				path: ['lines', i, 'amountCents'],
				message: 'Betrag muss eine ganze Zahl ≥ 0 (Cent) sein'
			});
		}
		lines.push({
			ref: l.ref,
			description: clip(description, 200),
			amountCents: l.amountCents,
			position: i
		});
	});
	if (issues.length) throw errors.validation(issues);
	return lines;
}

function orderNote(orderNumber: string, note: string | null | undefined): string {
	const head = `Bestellung ${orderNumber}`.trim();
	const extra = note?.trim();
	return clip(extra ? `${head}\n${extra}` : head, 1000);
}

interface InvoiceChange {
	invoiceId: string | null;
	number: string | null;
	totalCents: number;
	cancelled: boolean;
	created: boolean;
	/** Posten geändert, storniert oder reaktiviert */
	changed: boolean;
	becameCancelled: boolean;
	reactivated: boolean;
	added: number;
	updated: number;
	removed: number;
}

/**
 * Legt die Rechnung einer Bestellung an bzw. gleicht ihre Posten an. Semantik wie der Abgleich mit
 * Aktionen (`planSync`): geänderte Beträge → Ermäßigung gekappt; entfallene Posten mit Zahlungen
 * bleiben mit Betrag 0 stehen (Bezahltes wird Guthaben), ohne Zahlungen werden sie gelöscht;
 * keine Posten mehr → automatisch storniert; wieder Posten → reaktiviert (nur automatisch stornierte).
 * Empfänger, Frist und Notiz gehören nach dem Anlegen der Kasse (PUT /invoices/:id) und bleiben.
 */
export async function upsertOrderInvoice(
	ctx: RequestContext,
	input: OrderInvoiceInput
): Promise<OrderInvoiceResult> {
	const want = validateInvoiceInput(input);
	const [member] = await (await membersService()).listMemberContacts({ ids: [input.memberId] });
	if (!member) {
		throw errors.validation([{ path: ['memberId'], message: 'Mitglied nicht gefunden' }]);
	}
	const recipientName = clip(
		input.recipientName?.trim() || `${member.firstName} ${member.lastName}`.trim(),
		150
	);
	const s = await core.settings.getMany([SETTING_KEYS.minDays]);
	const minDays = Number(s[SETTING_KEYS.minDays] ?? 14);
	const todayIso = today();

	const r = await mdb().transaction(async (tx): Promise<InvoiceChange> => {
		await lockKey(tx, input.sourceKey);
		const [cur] = await rows(
			tx,
			sql`SELECT id, number, source, cancelled_at, auto_cancelled FROM invoices
			WHERE source_key = ${input.sourceKey} FOR UPDATE`
		);
		const change: InvoiceChange = {
			invoiceId: null,
			number: null,
			totalCents: 0,
			cancelled: false,
			created: false,
			changed: false,
			becameCancelled: false,
			reactivated: false,
			added: 0,
			updated: 0,
			removed: 0
		};

		if (!cur) {
			if (!want.length) return change;
			// Posten dürfen noch keiner anderen Rechnung gehören (source_ref ist UNIQUE)
			await assertRefsFree(tx, want, null);
			const id = crypto.randomUUID();
			const n = await nextInvoiceNumber(tx, todayIso);
			await tx.execute(
				sql`INSERT INTO invoices (id, number, year, seq, source, source_key, recipient_name, issued_on,
					due_on, note, created_by)
				VALUES (${id}, ${n.number}, ${n.year}, ${n.seq}, 'order', ${input.sourceKey}, ${recipientName},
					${todayIso}, ${addDays(todayIso, Math.max(0, minDays))}, ${orderNote(input.orderNumber, input.note)},
					${ctx.userId})`
			);
			for (const l of want) {
				await tx.execute(
					sql`INSERT INTO invoice_lines (id, invoice_id, position, description, amount_cents, member_id, source_ref)
					VALUES (${crypto.randomUUID()}, ${id}, ${l.position}, ${l.description}, ${l.amountCents},
						${input.memberId}, ${l.ref})`
				);
			}
			return {
				...change,
				invoiceId: id,
				number: n.number,
				totalCents: want.reduce((sum, l) => sum + l.amountCents, 0),
				created: true,
				changed: true,
				added: want.length
			};
		}

		const id = String(cur.id);
		if (cur.source !== 'order') throw errors.conflict('Rechnung gehört nicht zu einer Bestellung');
		change.invoiceId = id;
		change.number = String(cur.number);
		const wasCancelled = cur.cancelled_at != null;

		if (!want.length) {
			// Keine Posten mehr → stornieren, Posten bleiben (Stornierung zeigt, was storniert wurde)
			if (!wasCancelled) {
				await tx.execute(
					sql`UPDATE invoices SET cancelled_at = now(), cancel_reason = ${ORDER_CANCEL_REASON},
						auto_cancelled = true, updated_at = now() WHERE id = ${id}`
				);
				change.changed = true;
				change.becameCancelled = true;
			}
		} else {
			await assertRefsFree(tx, want, id);
			const existing = await rows(
				tx,
				sql`SELECT l.id, l.position, l.description, l.amount_cents, l.waived_cents, l.member_id, l.source_ref,
					coalesce((SELECT sum(a.amount_cents) FROM allocations a WHERE a.line_id = l.id), 0) AS paid_cents
				FROM invoice_lines l WHERE l.invoice_id = ${id}`
			);
			const byRef = new Map(existing.map((e) => [String(e.source_ref ?? ''), e]));
			const wanted = new Set(want.map((l) => l.ref));
			for (const l of want) {
				const e = byRef.get(l.ref);
				if (!e) {
					await tx.execute(
						sql`INSERT INTO invoice_lines (id, invoice_id, position, description, amount_cents, member_id, source_ref)
						VALUES (${crypto.randomUUID()}, ${id}, ${l.position}, ${l.description}, ${l.amountCents},
							${input.memberId}, ${l.ref})`
					);
					change.added++;
					continue;
				}
				if (
					num(e.amount_cents) !== l.amountCents ||
					String(e.description) !== l.description ||
					str(e.member_id) !== input.memberId
				) {
					await tx.execute(
						sql`UPDATE invoice_lines SET amount_cents = ${l.amountCents},
							waived_cents = ${Math.min(num(e.waived_cents), l.amountCents)},
							description = ${l.description}, member_id = ${input.memberId}, position = ${l.position}
						WHERE id = ${String(e.id)}`
					);
					change.updated++;
				} else if (num(e.position) !== l.position) {
					// Nur Reihenfolge: keine fachliche Änderung
					await tx.execute(
						sql`UPDATE invoice_lines SET position = ${l.position} WHERE id = ${String(e.id)}`
					);
				}
			}
			let tail = want.length;
			for (const e of existing) {
				if (wanted.has(String(e.source_ref ?? ''))) continue;
				if (num(e.paid_cents) > 0) {
					// Zuordnungen bleiben erhalten: Posten schuldet nichts mehr, Bezahltes wird Guthaben
					if (num(e.amount_cents) !== 0) {
						await tx.execute(
							sql`UPDATE invoice_lines SET amount_cents = 0, waived_cents = 0, position = ${tail}
							WHERE id = ${String(e.id)}`
						);
						change.removed++;
					}
					tail++;
				} else {
					await tx.execute(sql`DELETE FROM invoice_lines WHERE id = ${String(e.id)}`);
					change.removed++;
				}
			}
			if (wasCancelled && Boolean(cur.auto_cancelled)) {
				await tx.execute(
					sql`UPDATE invoices SET cancelled_at = NULL, cancel_reason = NULL, auto_cancelled = false,
						updated_at = now() WHERE id = ${id}`
				);
				change.reactivated = true;
			}
			change.changed = change.reactivated || change.added + change.updated + change.removed > 0;
			if (change.changed && !change.reactivated) {
				await tx.execute(sql`UPDATE invoices SET updated_at = now() WHERE id = ${id}`);
			}
		}

		const [inv] = await loadRawInvoices(tx, sql`i.id = ${id}`);
		const cancelled = inv?.row.cancelled_at != null;
		const totals = invoiceTotals(
			(inv?.lines ?? []).map((l) => ({
				amountCents: num(l.amount_cents),
				waivedCents: num(l.waived_cents),
				paidCents: num(l.paid_cents)
			})),
			cancelled
		);
		return { ...change, totalCents: totals.totalCents, cancelled };
	});

	let mailed = false;
	if (r.invoiceId) {
		try {
			const sent = r.created
				? input.send
					? await sendDocuments(ctx, [r.invoiceId], 'order')
					: null
				: r.changed
					? await refreshSentDocuments(ctx, [r.invoiceId])
					: null;
			mailed = (sent?.invoices ?? 0) > 0;
		} catch (e) {
			console.error(
				'[treasury] Versand der Bestell-Rechnung fehlgeschlagen:',
				e instanceof Error ? e.message : e
			);
		}
	}

	if (r.invoiceId && r.created) {
		await core.audit.logFromContext(ctx, 'treasury.invoice.created', {
			target: r.invoiceId,
			metadata: { source: 'order', lines: r.added, totalCents: r.totalCents }
		});
	} else if (r.invoiceId && r.becameCancelled) {
		await core.audit.logFromContext(ctx, 'treasury.invoice.cancelled', {
			target: r.invoiceId,
			metadata: { source: 'order', automatic: true }
		});
	} else if (r.invoiceId && r.changed) {
		if (r.reactivated) {
			await core.audit.logFromContext(ctx, 'treasury.invoice.reactivated', {
				target: r.invoiceId,
				metadata: { source: 'order' }
			});
		}
		if (r.added + r.updated + r.removed > 0) {
			await core.audit.logFromContext(ctx, 'treasury.invoice.updated', {
				target: r.invoiceId,
				metadata: {
					source: 'order',
					added: r.added,
					updated: r.updated,
					removed: r.removed,
					totalCents: r.totalCents
				}
			});
		}
	}

	return {
		invoiceId: r.invoiceId,
		number: r.number,
		totalCents: r.totalCents,
		cancelled: r.cancelled,
		mailed
	};
}

/** Posten-Schlüssel dürfen nicht schon an einer anderen Rechnung hängen (409 statt UNIQUE-Fehler) */
async function assertRefsFree(tx: Tx, want: WantLine[], invoiceId: string | null): Promise<void> {
	const taken = await rows(
		tx,
		sql`SELECT source_ref FROM invoice_lines WHERE source_ref IN (${idList(want.map((l) => l.ref))})
			${invoiceId ? sql`AND invoice_id <> ${invoiceId}` : sql``} LIMIT 1`
	);
	if (taken.length) throw errors.conflict('Ein Posten gehört bereits zu einer anderen Rechnung');
}

// --- Auszahlungen ------------------------------------------------------------------

function validateReceipt(receipt: OrderPayableInput['receipt']) {
	if (!receipt) return null;
	const contentType = (receipt.contentType || '').split(';')[0]!.trim().toLowerCase();
	if (!(RECEIPT_CONTENT_TYPES as readonly string[]).includes(contentType)) {
		throw errors.badRequest('Dateityp nicht erlaubt (PDF, JPEG, PNG oder WebP)');
	}
	if (receipt.bytes.byteLength === 0) throw errors.badRequest('Datei ist leer');
	if (receipt.bytes.byteLength > MAX_RECEIPT_BYTES) {
		throw errors.tooLarge('Datei überschreitet 10 MB');
	}
	return { bytes: receipt.bytes, contentType, name: receipt.name?.trim() || 'beleg' };
}

/**
 * Legt eine Auszahlung (Lieferantenrechnung) an bzw. aktualisiert sie. Prüfung wie `POST /payables`
 * (IBAN, BIC, Längen). Betrag nie unter bereits Gezahltes (409), stornierte werden reaktiviert.
 * Reihenfolge: Auszahlung → Audit/Amt „Kasse“ → Beleg (Fehler beim Beleg werden geworfen,
 * die Auszahlung bleibt bestehen).
 */
export async function upsertOrderPayable(
	ctx: RequestContext,
	input: OrderPayableInput
): Promise<{ payableId: string }> {
	if (!input.ref || input.ref.length > MAX_KEY) {
		throw errors.validation([{ path: ['ref'], message: 'Ungültiger Schlüssel der Auszahlung' }]);
	}
	const parsed = payableInput.safeParse({
		recipientName: input.recipientName,
		description: input.description,
		amountCents: input.amountCents,
		dueOn: input.dueOn ?? null,
		iban: input.iban,
		bic: input.bic ?? null,
		note: input.note ?? null
	});
	if (!parsed.success) {
		throw errors.validation(
			parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message }))
		);
	}
	const data = parsed.data;
	const receipt = validateReceipt(input.receipt);
	const bank = storeIban(data.iban);
	const dueOn = data.dueOn ?? today();

	const r = await mdb().transaction(async (tx) => {
		await lockKey(tx, input.ref);
		const [cur] = await rows(
			tx,
			sql`SELECT p.id, p.source, p.cancelled_at, p.receipt_path,
				coalesce((SELECT sum(pp.amount_cents) FROM payable_payments pp WHERE pp.payable_id = p.id), 0) AS paid
			FROM payables p WHERE p.source_ref = ${input.ref} FOR UPDATE`
		);
		if (!cur) {
			const id = crypto.randomUUID();
			await tx.execute(
				sql`INSERT INTO payables (id, source, source_ref, recipient_name, iban_enc, iban_last4, bic,
					description, amount_cents, due_on, note, created_by)
				VALUES (${id}, 'order', ${input.ref}, ${data.recipientName}, ${bank?.enc ?? null},
					${bank?.last4 ?? null}, ${data.bic}, ${data.description}, ${data.amountCents}, ${dueOn},
					${data.note}, ${ctx.userId})`
			);
			return { id, created: true, reactivated: false, oldReceipt: null as string | null };
		}
		if (cur.source !== 'order') {
			throw errors.conflict('Auszahlung gehört nicht zu einer Bestellung');
		}
		const id = String(cur.id);
		if (data.amountCents < num(cur.paid)) {
			throw errors.conflict('Der Betrag ist kleiner als bereits gezahlt');
		}
		const reactivated = cur.cancelled_at != null;
		await tx.execute(
			sql`UPDATE payables SET recipient_name = ${data.recipientName}, description = ${data.description},
				amount_cents = ${data.amountCents}, due_on = ${dueOn}, note = ${data.note}, bic = ${data.bic},
				cancelled_at = NULL, auto_cancelled = false, updated_at = now()
			WHERE id = ${id}`
		);
		if (bank) {
			await tx.execute(
				sql`UPDATE payables SET iban_enc = ${bank.enc}, iban_last4 = ${bank.last4} WHERE id = ${id}`
			);
		}
		return { id, created: false, reactivated, oldReceipt: str(cur.receipt_path) };
	});

	await core.audit.logFromContext(
		ctx,
		r.created ? 'treasury.payable.created' : 'treasury.payable.updated',
		{
			target: r.id,
			metadata: { source: 'order', amountCents: data.amountCents, reactivated: r.reactivated }
		}
	);
	if (r.created) {
		await notifyKasse(ctx, [
			payableNotification({
				source: 'order',
				recipientName: data.recipientName,
				amountCents: data.amountCents,
				description: data.description,
				actionName: null
			})
		]);
	}

	if (receipt) {
		// Der Aufrufer hat keine Kassen-Speicherrechte: Ablage im Systemkontext der Kasse
		const system = core.auth.systemContext('treasury-orders');
		const path = `payables/${r.id}/receipt-${crypto.randomUUID()}-${sanitizeName(receipt.name)}`;
		await core.storage.upload(system, {
			module: MODULE_ID,
			path,
			file: receipt.bytes,
			contentType: receipt.contentType,
			name: receipt.name
		});
		try {
			await mdb().transaction((tx) =>
				tx.execute(
					sql`UPDATE payables SET receipt_path = ${path}, receipt_name = ${receipt.name},
						receipt_content_type = ${receipt.contentType}, updated_at = now() WHERE id = ${r.id}`
				)
			);
		} catch (e) {
			await core.storage.remove(system, { module: MODULE_ID, path }).catch(() => undefined);
			throw e;
		}
		if (r.oldReceipt) {
			await core.storage
				.remove(system, { module: MODULE_ID, path: r.oldReceipt })
				.catch(() => undefined);
		}
		await core.audit.logFromContext(ctx, 'treasury.payable.receipt_uploaded', { target: r.id });
	}
	return { payableId: r.id };
}

/** Storniert eine Auszahlung aus `upsertOrderPayable`; unbekannt → nichts, (teilweise) bezahlt → 409 */
export async function cancelOrderPayable(ctx: RequestContext, ref: string): Promise<void> {
	if (!ref) return;
	const id = await mdb().transaction(async (tx) => {
		await lockKey(tx, ref);
		const [cur] = await rows(
			tx,
			sql`SELECT p.id, p.source, p.cancelled_at,
				coalesce((SELECT sum(pp.amount_cents) FROM payable_payments pp WHERE pp.payable_id = p.id), 0) AS paid
			FROM payables p WHERE p.source_ref = ${ref} FOR UPDATE`
		);
		if (!cur || cur.source !== 'order' || cur.cancelled_at != null) return null;
		if (num(cur.paid) > 0) {
			throw errors.conflict('Die Auszahlung ist bereits (teilweise) bezahlt');
		}
		await tx.execute(
			sql`UPDATE payables SET cancelled_at = now(), auto_cancelled = false, updated_at = now()
			WHERE id = ${String(cur.id)}`
		);
		return String(cur.id);
	});
	if (id) {
		await core.audit.logFromContext(ctx, 'treasury.payable.cancelled', {
			target: id,
			metadata: { source: 'order', cancelled: true }
		});
	}
}

// --- Zahlstand ------------------------------------------------------------------------

export async function invoiceStatus(
	invoiceIds: string[]
): Promise<Record<string, ExternalInvoiceStatus>> {
	const ids = [...new Set(invoiceIds.filter(Boolean))];
	if (!ids.length) return {};
	const list = await mdb().transaction((tx) => loadRawInvoices(tx, sql`i.id IN (${idList(ids)})`));
	const t = today();
	const out: Record<string, ExternalInvoiceStatus> = {};
	for (const inv of list) {
		const cancelled = inv.row.cancelled_at != null;
		const totals = invoiceTotals(
			inv.lines.map((l) => ({
				amountCents: num(l.amount_cents),
				waivedCents: num(l.waived_cents),
				paidCents: num(l.paid_cents)
			})),
			cancelled
		);
		const dueOn = str(inv.row.due_on);
		const id = String(inv.row.id);
		out[id] = {
			invoiceId: id,
			number: String(inv.row.number),
			status: totals.status,
			// Stornierte Rechnungen schulden nichts
			dueCents: cancelled ? 0 : totals.totalCents,
			paidCents: totals.paidCents,
			openCents: totals.openCents,
			dueOn,
			overdue: totals.openCents > 0 && !!dueOn && dueOn < t
		};
	}
	return out;
}

export async function payableStatus(
	refs: string[]
): Promise<Record<string, ExternalPayableStatus>> {
	const list = [...new Set(refs.filter(Boolean))];
	if (!list.length) return {};
	const found: Row[] = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT p.id, p.source_ref, p.amount_cents, p.cancelled_at,
				coalesce((SELECT sum(pp.amount_cents) FROM payable_payments pp WHERE pp.payable_id = p.id), 0) AS paid
			FROM payables p WHERE p.source_ref IN (${idList(list)})`
		)
	);
	const out: Record<string, ExternalPayableStatus> = {};
	for (const p of found) {
		const amount = num(p.amount_cents);
		const paid = num(p.paid);
		out[String(p.source_ref)] = {
			payableId: String(p.id),
			status:
				p.cancelled_at != null
					? 'cancelled'
					: paid >= amount
						? 'paid'
						: paid > 0
							? 'partial'
							: 'open',
			amountCents: amount,
			paidCents: paid
		};
	}
	return out;
}
