/**
 * Rechnungsdokumente: Jede versendete Fassung einer Rechnung wird als Version mit Snapshot gespeichert;
 * das PDF entsteht deterministisch aus dem Snapshot (kein Datei-Speicher noetig). Aendert sich eine
 * bereits versendete Rechnung (Betrag, Rolle, Ermaessigung, Frist, Storno), geht automatisch eine neue
 * Fassung an dieselben Adressen. Core-Dienste (PDF, Mail, Audit) laufen ausserhalb von Transaktionen.
 */
import { sql } from 'drizzle-orm';
import { core, errors, type RequestContext } from '$lib/sdk/server';
import type { PdfBlock } from '$lib/sdk/types';
import {
	collectIds,
	idList,
	invoiceAddresses,
	loadPayerNames,
	loadRawInvoices,
	mdb,
	membersService,
	num,
	resolveNames,
	rows,
	str,
	type NameMaps,
	type RawInvoice
} from './db';
import {
	centsToCsv,
	epcPayload,
	formatDateDe,
	groupByAddress,
	sanitizeName,
	type BankData
} from './logic';
import { formatIban } from './iban';
import { composeMail } from './mail-compose';
import { paymentBox, paymentText } from './mail-html';
import { loadBankData } from './notify';
import {
	DEFAULT_INVOICE_BODY,
	DEFAULT_INVOICE_SUBJECT,
	SETTING_KEYS,
	type DocumentReason,
	type InvoiceDocument
} from './schemas';

export interface InvoiceSnapshot {
	number: string;
	recipientName: string;
	/** Adressfeld (Name, Straße, PLZ Ort) */
	address: string[];
	issuedOn: string;
	dueOn: string;
	note: string | null;
	actionName: string | null;
	cancelled: boolean;
	lines: {
		description: string;
		amountCents: number;
		waivedCents: number;
		waiveReason: string | null;
	}[];
	totalCents: number;
	paidCents: number;
	bank: BankData;
}

/** Teile des Snapshots, deren Aenderung eine neue Fassung ausloest (nicht: Zahlungen, Bankdaten) */
export function snapshotKey(s: InvoiceSnapshot): string {
	return JSON.stringify({
		recipient: s.recipientName,
		due: s.dueOn,
		cancelled: s.cancelled,
		lines: s.lines.map((l) => [l.description, l.amountCents, l.waivedCents])
	});
}

/** Beschreibt, was sich gegenueber der letzten Fassung geaendert hat (fuer `{aenderung}`) */
export function describeChange(prev: InvoiceSnapshot | null, next: InvoiceSnapshot): string {
	if (next.cancelled)
		return 'die folgende Rechnung wurde storniert. Bitte überweise dafür nichts (mehr).';
	if (!prev) return 'anbei die Rechnung zur Anmeldung.';
	const parts: string[] = [];
	if (prev.totalCents !== next.totalCents) {
		parts.push(
			`Der Betrag hat sich von ${centsToCsv(prev.totalCents)} € auf ${centsToCsv(next.totalCents)} € geändert.`
		);
	}
	if (prev.dueOn !== next.dueOn) parts.push(`Neue Zahlungsfrist: ${formatDateDe(next.dueOn)}.`);
	if (!parts.length) parts.push('Die Posten der Rechnung haben sich geändert.');
	return `unsere Rechnung hat sich geändert. ${parts.join(' ')}`;
}

async function addressFor(inv: RawInvoice): Promise<string[]> {
	const memberId = inv.lines.find((l) => l.member_id)?.member_id;
	const contact = memberId
		? (await (await membersService()).listMemberContacts({ ids: [String(memberId)] }))[0]
		: undefined;
	return [
		String(inv.row.recipient_name),
		...(contact ? [contact.street, `${contact.postalCode} ${contact.city}`.trim()] : [])
	]
		.filter((l) => l && l.trim())
		.map((l) => l.slice(0, 60));
}

export async function buildSnapshot(
	inv: RawInvoice,
	names: NameMaps,
	bank: BankData
): Promise<InvoiceSnapshot> {
	const lines = inv.lines.map((l) => ({
		description: String(l.description),
		amountCents: num(l.amount_cents),
		waivedCents: num(l.waived_cents),
		waiveReason: str(l.waive_reason)
	}));
	const actionId = str(inv.row.action_id) ?? str(inv.lines.find((l) => l.action_id)?.action_id);
	return {
		number: String(inv.row.number),
		recipientName: String(inv.row.recipient_name),
		address: await addressFor(inv),
		issuedOn: String(inv.row.issued_on),
		dueOn: String(inv.row.due_on),
		note: str(inv.row.note),
		actionName: actionId ? (names.actions.get(actionId) ?? null) : null,
		cancelled: inv.row.cancelled_at != null,
		lines,
		totalCents: lines.reduce((s, l) => s + Math.max(0, l.amountCents - l.waivedCents), 0),
		paidCents: inv.lines.reduce((s, l) => s + num(l.paid_cents), 0),
		bank
	};
}

const eur = (c: number) => `${centsToCsv(c)} €`;

/** Verwendungszweck einer Rechnung (Nummer + Name, max. 140 Zeichen) */
export const invoicePurpose = (s: Pick<InvoiceSnapshot, 'number' | 'recipientName'>) =>
	`${s.number} ${s.recipientName}`.slice(0, 140);

/** Zahlungsteil fuer PDF-Dokumente (Tabelle + GiroCode); auch fuer Sammelrechnungen */
export async function paymentBlocks(p: {
	bank: BankData;
	amountCents: number;
	purpose: string;
	dueOn: string | null;
}): Promise<PdfBlock[]> {
	if (!p.bank.iban || !p.bank.holder) {
		return [
			{ type: 'heading', text: 'Zahlung', level: 2 },
			{
				type: 'paragraph',
				text: `Bitte überweise ${eur(p.amountCents)} mit dem Verwendungszweck „${p.purpose}“. Die Kontodaten erhältst du bei der Kasse.`
			}
		];
	}
	const rows: string[][] = [
		['Empfänger', p.bank.holder],
		['IBAN', formatIban(p.bank.iban)],
		...(p.bank.bic || p.bank.name
			? [['Bank / BIC', [p.bank.name, p.bank.bic].filter(Boolean).join(' · ')]]
			: []),
		['Betrag', eur(p.amountCents)],
		...(p.dueOn ? [['Zahlbar bis', formatDateDe(p.dueOn)]] : []),
		['Verwendungszweck', p.purpose]
	];
	const blocks: PdfBlock[] = [
		{ type: 'heading', text: 'Zahlung', level: 2 },
		{
			type: 'table',
			variant: 'grid',
			noHeader: true,
			columns: ['', ''],
			widths: [1, 3],
			rows
		}
	];
	const epc = epcPayload({
		holder: p.bank.holder,
		iban: p.bank.iban,
		bic: p.bank.bic,
		amountCents: p.amountCents,
		purpose: p.purpose
	});
	if (epc) {
		try {
			blocks.push(
				{
					type: 'image',
					dataUrl: await core.qr.dataUrl(epc, { widthPx: 320 }),
					widthMm: 26,
					alt: 'GiroCode'
				},
				{
					type: 'paragraph',
					text: 'GiroCode: mit der Banking-App scannen – alle Angaben sind ausgefüllt.'
				}
			);
		} catch {
			/* ohne QR-Code weiter */
		}
	}
	return blocks;
}

/** PDF einer Rechnungsfassung (Briefvorlage mit Adressfeld; der Titel kommt aus der Vorlage) */
export async function renderInvoicePdf(
	ctx: RequestContext,
	s: InvoiceSnapshot,
	version?: number
): Promise<Uint8Array> {
	const title = s.cancelled ? `Stornierung der Rechnung ${s.number}` : `Rechnung ${s.number}`;
	const openCents = Math.max(0, s.totalCents - s.paidCents);
	// Eckdaten kompakt in einer Zeile (Kopfzeile = Bezeichnungen)
	const infoCols = [
		'Rechnungsnummer',
		'Rechnungsdatum',
		...(s.cancelled ? [] : ['Zahlbar bis']),
		...(version && version > 1 ? ['Fassung'] : [])
	];
	const infoRow = [
		s.number,
		formatDateDe(s.issuedOn),
		...(s.cancelled ? [] : [formatDateDe(s.dueOn)]),
		...(version && version > 1 ? [String(version)] : [])
	];
	const content: PdfBlock[] = [
		{ type: 'table', variant: 'grid', columns: infoCols, rows: [infoRow] },
		{
			type: 'paragraph',
			text:
				'Hallo,\n' +
				(s.cancelled
					? `die Rechnung ${s.number} für ${s.recipientName} wurde storniert:`
					: s.actionName
						? `vielen Dank für die Anmeldung von ${s.recipientName} zu „${s.actionName}“. Für die Teilnahme berechnen wir:`
						: `für ${s.recipientName} berechnen wir die folgenden Posten:`)
		},
		{
			type: 'table',
			variant: 'grid',
			columns: ['Posten', 'Betrag'],
			align: ['left', 'right'],
			widths: [4, 1],
			rows: s.lines.map((l) => [
				l.waivedCents > 0
					? `${l.description} (ermäßigt um ${eur(l.waivedCents)}${l.waiveReason ? `: ${l.waiveReason}` : ''})`
					: l.description,
				eur(l.amountCents - l.waivedCents)
			]),
			totalRow: ['Rechnungsbetrag', eur(s.totalCents)]
		}
	];
	if (s.cancelled) {
		content.push({
			type: 'paragraph',
			text:
				s.paidCents > 0
					? `Bereits bezahlte ${eur(s.paidCents)} erstatten wir dir zurück.`
					: 'Es ist nichts zu zahlen.'
		});
	} else {
		if (s.paidCents > 0) {
			content.push({
				type: 'paragraph',
				text: `Bereits bezahlt: ${eur(s.paidCents)} · noch offen: ${eur(openCents)}`
			});
		}
		if (openCents > 0) {
			content.push(
				...(await paymentBlocks({
					bank: s.bank,
					amountCents: openCents,
					purpose: invoicePurpose(s),
					dueOn: s.dueOn
				}))
			);
		} else {
			content.push({
				type: 'paragraph',
				text: 'Die Rechnung ist vollständig bezahlt – vielen Dank!'
			});
		}
		if (s.note) content.push({ type: 'paragraph', text: s.note });
	}
	content.push({
		type: 'paragraph',
		text: 'Bei Fragen zur Rechnung melde dich gern bei der Kasse. Gut Pfad!'
	});
	const hasLetter = core.pdf.listTemplates().some((t) => t.id === 'stamm-brief');
	const pdf = await core.pdf.generate(ctx, {
		template: hasLetter ? 'stamm-brief' : 'default',
		title,
		recipient: hasLetter ? s.address : undefined,
		content
	});
	return pdf.buffer;
}

export const pdfFileName = (s: InvoiceSnapshot, version?: number) =>
	sanitizeName(
		`${s.cancelled ? 'Storno' : 'Rechnung'}-${s.number}${version && version > 1 ? `-v${version}` : ''}.pdf`
	);

interface Loaded {
	inv: RawInvoice;
	names: NameMaps;
}

async function loadInvoices(ids: string[]): Promise<Loaded[]> {
	if (!ids.length) return [];
	const { invoices, payers } = await mdb().transaction(async (tx) => ({
		invoices: await loadRawInvoices(tx, sql`i.id IN (${idList(ids)})`),
		payers: await loadPayerNames(tx)
	}));
	const names = await resolveNames({ ...collectIds(invoices), payers });
	return invoices.map((inv) => ({ inv, names }));
}

async function latestDocuments(
	ids: string[]
): Promise<Map<string, { version: number; snapshot: InvoiceSnapshot; sent: boolean }>> {
	const out = new Map<string, { version: number; snapshot: InvoiceSnapshot; sent: boolean }>();
	if (!ids.length) return out;
	const found = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT DISTINCT ON (invoice_id) invoice_id, version, snapshot, sent_at
			FROM invoice_documents WHERE invoice_id IN (${idList(ids)})
			ORDER BY invoice_id, version DESC`
		)
	);
	for (const r of found) {
		const snapshot = (
			typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : r.snapshot
		) as InvoiceSnapshot;
		out.set(String(r.invoice_id), { version: num(r.version), snapshot, sent: r.sent_at != null });
	}
	return out;
}

async function storeDocument(
	invoiceId: string,
	reason: DocumentReason,
	snapshot: InvoiceSnapshot,
	userId: string | null,
	sent: { recipients: number } | null
): Promise<number> {
	return mdb().transaction(async (tx) => {
		await tx.execute(sql`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`);
		const [r] = await rows(
			tx,
			sql`SELECT coalesce(max(version), 0) + 1 AS v FROM invoice_documents WHERE invoice_id = ${invoiceId}`
		);
		const version = num(r?.v) || 1;
		await tx.execute(
			sql`INSERT INTO invoice_documents (id, invoice_id, version, reason, snapshot, sent_at, recipients, created_by)
			VALUES (${crypto.randomUUID()}, ${invoiceId}, ${version}, ${reason}, ${JSON.stringify(snapshot)}::jsonb,
				${sent ? new Date().toISOString() : null}, ${sent?.recipients ?? 0}, ${userId})`
		);
		return version;
	});
}

/**
 * Anmeldung: Fassung 1 der Rechnung erzeugen und als PDF zurueckgeben (`actions` haengt sie an die
 * Anmeldebestaetigung). Bereits vorhandene Fassungen werden nicht dupliziert.
 */
export async function registrationDocument(invoiceId: string): Promise<{
	filename: string;
	data: Uint8Array;
	number: string;
	totalCents: number;
	paymentText: string;
	paymentHtml: string;
} | null> {
	const [loaded] = await loadInvoices([invoiceId]);
	if (!loaded || loaded.inv.row.cancelled_at) return null;
	const bank = await loadBankData();
	const snapshot = await buildSnapshot(loaded.inv, loaded.names, bank);
	if (snapshot.totalCents <= 0) return null;
	const existing = (await latestDocuments([invoiceId])).get(invoiceId);
	const version = existing
		? existing.version
		: await storeDocument(invoiceId, 'registration', snapshot, null, { recipients: 1 });
	const ctx = core.auth.systemContext('treasury-documents');
	const used = existing?.snapshot ?? snapshot;
	const data = await renderInvoicePdf(ctx, used, version);
	const pay = {
		bank: used.bank,
		amountCents: used.totalCents,
		purpose: invoicePurpose(used),
		dueOn: formatDateDe(used.dueOn)
	};
	return {
		filename: pdfFileName(used, version),
		data,
		number: used.number,
		totalCents: used.totalCents,
		paymentText: paymentText(pay),
		paymentHtml: paymentBox(pay)
	};
}

export interface SendResult {
	invoices: number;
	mailsSent: number;
	mailErrors: number;
	withoutAddress: number;
}

/** Neue Fassung erzeugen und (je Adresse) mit PDF-Anhang versenden */
export async function sendDocuments(
	ctx: RequestContext,
	invoiceIds: string[],
	reason: DocumentReason
): Promise<SendResult> {
	const result: SendResult = { invoices: 0, mailsSent: 0, mailErrors: 0, withoutAddress: 0 };
	const loaded = await loadInvoices(invoiceIds);
	if (!loaded.length) return result;
	const bank = await loadBankData();
	const latest = await latestDocuments(invoiceIds);
	const s = await core.settings.getMany([SETTING_KEYS.invoiceSubject, SETTING_KEYS.invoiceBody]);
	const system = core.auth.systemContext('treasury-documents');
	for (const { inv, names } of loaded) {
		const id = String(inv.row.id);
		const snapshot = await buildSnapshot(inv, names, bank);
		const prev = latest.get(id)?.snapshot ?? null;
		const nextVersion = (latest.get(id)?.version ?? 0) + 1;
		const addresses = invoiceAddresses(inv, names);
		if (!addresses.length) {
			result.withoutAddress++;
			await storeDocument(id, reason, snapshot, ctx.userId, null);
			continue;
		}
		const pdf = await renderInvoicePdf(system, snapshot, nextVersion);
		const anlass = snapshot.cancelled
			? 'Stornierung'
			: reason === 'changed'
				? 'Geänderte Rechnung'
				: 'Rechnung';
		const mail = composeMail({
			subjectTpl: String(s[SETTING_KEYS.invoiceSubject] || DEFAULT_INVOICE_SUBJECT),
			bodyTpl: String(s[SETTING_KEYS.invoiceBody] || DEFAULT_INVOICE_BODY),
			invoices: [
				{
					number: snapshot.number,
					recipientName: snapshot.recipientName,
					dueOn: snapshot.dueOn,
					lines: snapshot.lines.map((l) => ({
						description: l.description,
						cents: l.amountCents - l.waivedCents
					}))
				}
			],
			bank,
			// Storno: kein Zahlungskasten
			mode: snapshot.cancelled ? 'paid' : 'open',
			extraVars: { anlass, aenderung: describeChange(prev, snapshot) }
		});
		let delivered = 0;
		for (const address of groupByAddress([{ addresses }]).keys()) {
			try {
				await core.mail.send({
					to: address,
					...mail,
					attachments: [
						{
							filename: pdfFileName(snapshot, nextVersion),
							contentType: 'application/pdf',
							data: pdf
						}
					]
				});
				delivered++;
				result.mailsSent++;
			} catch (e) {
				result.mailErrors++;
				console.warn(
					'[treasury] Rechnungsversand fehlgeschlagen:',
					e instanceof Error ? e.message : e
				);
			}
		}
		await storeDocument(
			id,
			reason,
			snapshot,
			ctx.userId,
			delivered ? { recipients: delivered } : null
		);
		if (delivered) result.invoices++;
	}
	if (result.invoices || result.mailErrors) {
		await core.audit.logFromContext(ctx, 'treasury.invoice.sent', {
			metadata: { reason, ...result }
		});
	}
	return result;
}

/**
 * Prueft Rechnungen mit bereits versendeter Fassung auf Aenderungen und verschickt automatisch die
 * neue Fassung („Geänderte Rechnung“ bzw. „Stornierung“). Ohne versendete Fassung passiert nichts.
 */
export async function refreshSentDocuments(
	ctx: RequestContext,
	invoiceIds?: string[]
): Promise<SendResult> {
	const sentIds = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT DISTINCT invoice_id FROM invoice_documents WHERE sent_at IS NOT NULL
				${invoiceIds?.length ? sql`AND invoice_id IN (${idList(invoiceIds)})` : sql``}`
		)
	);
	const ids = sentIds.map((r) => String(r.invoice_id));
	const empty: SendResult = { invoices: 0, mailsSent: 0, mailErrors: 0, withoutAddress: 0 };
	if (!ids.length) return empty;
	const loaded = await loadInvoices(ids);
	const latest = await latestDocuments(ids);
	const bank = await loadBankData();
	const changed: string[] = [];
	const cancelled: string[] = [];
	for (const { inv, names } of loaded) {
		const id = String(inv.row.id);
		const prev = latest.get(id);
		if (!prev) continue;
		const now = await buildSnapshot(inv, names, bank);
		if (snapshotKey(now) === snapshotKey(prev.snapshot)) continue;
		// Bereits storniert versendet und weiterhin storniert → nichts zu tun
		if (now.cancelled && prev.snapshot.cancelled) continue;
		(now.cancelled ? cancelled : changed).push(id);
	}
	const a = changed.length ? await sendDocuments(ctx, changed, 'changed') : empty;
	const b = cancelled.length ? await sendDocuments(ctx, cancelled, 'cancelled') : empty;
	return {
		invoices: a.invoices + b.invoices,
		mailsSent: a.mailsSent + b.mailsSent,
		mailErrors: a.mailErrors + b.mailErrors,
		withoutAddress: a.withoutAddress + b.withoutAddress
	};
}

export async function listDocuments(invoiceId: string): Promise<InvoiceDocument[]> {
	const found = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT version, reason, snapshot, created_at, sent_at, recipients FROM invoice_documents
			WHERE invoice_id = ${invoiceId} ORDER BY version DESC`
		)
	);
	return found.map((r) => {
		const s = (
			typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : r.snapshot
		) as InvoiceSnapshot;
		return {
			version: num(r.version),
			reason: r.reason as DocumentReason,
			createdAt: new Date(String(r.created_at)).toISOString(),
			sentAt: r.sent_at ? new Date(String(r.sent_at)).toISOString() : null,
			recipients: num(r.recipients),
			totalCents: s.totalCents
		};
	});
}

/** PDF einer gespeicherten Fassung (`version`) bzw. der aktuellen Rechnung (ohne `version`) */
export async function invoicePdfResponse(
	ctx: RequestContext,
	invoiceId: string,
	version?: number
): Promise<Response> {
	let snapshot: InvoiceSnapshot;
	if (version) {
		const [r] = await mdb().transaction((tx) =>
			rows(
				tx,
				sql`SELECT snapshot FROM invoice_documents WHERE invoice_id = ${invoiceId} AND version = ${version}`
			)
		);
		if (!r) throw errors.notFound('Fassung nicht gefunden');
		snapshot = (
			typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : r.snapshot
		) as InvoiceSnapshot;
	} else {
		const [loaded] = await loadInvoices([invoiceId]);
		if (!loaded) throw errors.notFound('Rechnung nicht gefunden');
		snapshot = await buildSnapshot(loaded.inv, loaded.names, await loadBankData());
	}
	const pdf = await renderInvoicePdf(ctx, snapshot, version);
	await core.audit.logFromContext(ctx, 'treasury.invoice.pdf', {
		target: invoiceId,
		metadata: { version: version ?? null }
	});
	return new Response(Buffer.from(pdf), {
		status: 200,
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': `inline; filename="${pdfFileName(snapshot, version)}"`,
			'cache-control': 'private, no-store'
		}
	});
}

/** Sammelrechnung: alle offenen Rechnungen eines Zahlers in einem PDF (mit GiroCode ueber die Summe) */
export async function payerStatementResponse(
	ctx: RequestContext,
	payerId: string
): Promise<Response> {
	const { payer, memberId } = await mdb().transaction(async (tx) => {
		const [p] = await rows(
			tx,
			sql`SELECT id, name, account_holder FROM payers WHERE id = ${payerId}`
		);
		if (!p) throw errors.notFound('Zahler nicht gefunden');
		const [m] = await rows(
			tx,
			sql`SELECT member_id FROM payer_members WHERE payer_id = ${payerId} ORDER BY member_id LIMIT 1`
		);
		return { payer: p, memberId: str(m?.member_id) };
	});
	const invoices = (
		await loadInvoices(
			(
				await mdb().transaction((tx) =>
					rows(
						tx,
						sql`SELECT i.id FROM invoices i WHERE i.cancelled_at IS NULL AND (i.payer_id = ${payerId}
							OR EXISTS (SELECT 1 FROM invoice_lines l JOIN payer_members pm ON pm.member_id = l.member_id
								WHERE l.invoice_id = i.id AND pm.payer_id = ${payerId}))`
					)
				)
			).map((r) => String(r.id))
		)
	).filter(({ inv }) =>
		inv.lines.some((l) => num(l.amount_cents) - num(l.waived_cents) - num(l.paid_cents) > 0)
	);
	const bank = await loadBankData();
	const contact = memberId
		? (await (await membersService()).listMemberContacts({ ids: [memberId] }))[0]
		: undefined;
	const name = str(payer.account_holder) ?? String(payer.name);
	const address = [
		name,
		...(contact ? [contact.street, `${contact.postalCode} ${contact.city}`.trim()] : [])
	]
		.filter((l) => l && l.trim())
		.map((l) => l.slice(0, 60));
	const rowsOut: string[][] = [];
	let total = 0;
	let earliest: string | null = null;
	const numbers: string[] = [];
	for (const { inv } of invoices.sort((a, b) =>
		String(a.inv.row.due_on).localeCompare(String(b.inv.row.due_on))
	)) {
		numbers.push(String(inv.row.number));
		const due = String(inv.row.due_on);
		if (!earliest || due < earliest) earliest = due;
		for (const l of inv.lines) {
			const open = num(l.amount_cents) - num(l.waived_cents) - num(l.paid_cents);
			if (open <= 0) continue;
			total += open;
			rowsOut.push([String(inv.row.number), String(l.description), formatDateDe(due), eur(open)]);
		}
	}
	const content: PdfBlock[] = [
		{
			type: 'paragraph',
			text: rowsOut.length
				? `hier findest du alle noch offenen Beträge für ${String(payer.name)} auf einen Blick. Du kannst alles mit einer Überweisung bezahlen.`
				: `für ${String(payer.name)} sind derzeit keine Beträge offen. Vielen Dank!`
		}
	];
	if (rowsOut.length) {
		content.push(
			{
				type: 'table',
				variant: 'grid',
				columns: ['Rechnung', 'Posten', 'Fällig', 'Offen'],
				align: ['left', 'left', 'left', 'right'],
				widths: [1.2, 4, 1.2, 1.2],
				rows: rowsOut,
				totalRow: ['', 'Summe offen', '', eur(total)]
			},
			...(await paymentBlocks({
				bank,
				amountCents: total,
				purpose: `${numbers.join(' ')} ${String(payer.name)}`.slice(0, 140),
				dueOn: earliest
			}))
		);
	}
	content.push({ type: 'paragraph', text: 'Bei Fragen melde dich gern bei der Kasse. Gut Pfad!' });
	const hasLetter = core.pdf.listTemplates().some((t) => t.id === 'stamm-brief');
	const pdf = await core.pdf.generate(ctx, {
		template: hasLetter ? 'stamm-brief' : 'default',
		title: 'Übersicht offener Rechnungen',
		recipient: hasLetter ? address : undefined,
		content
	});
	await core.audit.logFromContext(ctx, 'treasury.payer.statement', {
		target: payerId,
		metadata: { invoices: numbers.length }
	});
	return new Response(Buffer.from(pdf.buffer), {
		status: 200,
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': `inline; filename="${sanitizeName(`Offene-Rechnungen-${String(payer.name)}.pdf`)}"`,
			'cache-control': 'private, no-store'
		}
	});
}
