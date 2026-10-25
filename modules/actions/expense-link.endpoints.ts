/**
 * Kosten-Link je Aktion: Personen reichen ohne Login eine oder mehrere Auslagen (je ein Beleg) mit
 * Kontodaten ein (öffentlicher multipart-POST, gemeinsame `batch_id`). Bearbeitende prüfen die Einreichungen und übernehmen sie als
 * Auslage (Buchung „bezahlt von Person“) oder lehnen sie ab (Kontodaten und Beleg werden gelöscht).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { formatEuro } from '$lib/components/layout/money';
import { formatDateDe } from '$lib/sdk/dates';
import {
	type ApiEndpoint,
	core,
	errors,
	logBestEffort,
	moduleDb,
	type RequestContext,
	rowsOf,
	secureFileResponse,
	toIsoOrNull,
	type Tx
} from '$lib/sdk/server';
import { requireAccess } from './access';
import { linkTokenValues, storedToken, tokenMatchSql } from './link-tokens';
import { assertOpen, closedInfo } from './accounting-core';
import { detectReceiptType, sanitizeName } from './action-archive';
import { ibanLast, maskFromLast } from './iban';
import { neutralizeLinks } from './form-support';
import { globalPrivacyUrl, takeMailQuota } from './public-mail';
import {
	CALC_CATEGORIES,
	CALC_CATEGORY_LABELS,
	EXPENSE_PUBLIC_PREFIX,
	MAX_EXPENSE_BATCH_BYTES,
	MAX_EXPENSE_BATCH_ITEMS,
	MAX_RECEIPT_BYTES,
	MODULE_ID,
	NOTIFY_EXPENSE_SUBMITTED,
	expenseAcceptInput,
	expenseLinkInput,
	expenseRejectInput,
	expenseSubmissionParams,
	expenseSubmissionsQuery,
	idParams,
	publicExpenseBatchInput,
	publicTokenParams,
	type CalcCategory,
	type ExpenseAcceptInput,
	type ExpenseLinkConfig,
	type ExpenseSubmission,
	type ExpenseSubmissionStatus,
	type PublicExpenseLink,
	type PublicExpenseBatchInput,
	type PublicExpenseBatchResult,
	type UserRef
} from './schemas';

const crypt = () => core.crypto.forModule(MODULE_ID);
const TAGS = ['Modul: actions'];

/** Höchstens so viele offene Einreichungen je Aktion (Missbrauchsschutz). */
export const MAX_PENDING_SUBMISSIONS = 50;

const NOT_AVAILABLE = 'Link nicht verfügbar';
const TOO_MANY = 'Zu viele offene Einreichungen. Bitte wende dich direkt an die Verantwortlichen.';
const STORAGE_DOWN =
	'Belege können gerade nicht angenommen werden. Bitte versuche es später erneut.';

const str = (v: unknown): string | null => (v == null ? null : String(v));
const newToken = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
const systemCtx = () => core.auth.systemContext('expense-link');

const euro = formatEuro;
const deDate = (d: string) => formatDateDe(d);

// --- Interne Konfiguration ---------------------------------------------------

async function pendingCount(tx: Tx, actionId: string): Promise<number> {
	const [c] = await rowsOf(
		tx,
		sql`SELECT COUNT(*) AS n FROM expense_submissions
			WHERE action_id = ${actionId} AND status = 'pending'`
	);
	return Number(c?.n ?? 0);
}

async function loadConfig(tx: Tx, actionId: string, canEdit: boolean): Promise<ExpenseLinkConfig> {
	const [link] = await rowsOf(
		tx,
		sql`SELECT token, token_enc, enabled FROM expense_links WHERE action_id = ${actionId}`
	);
	const token = link && canEdit ? storedToken(link) : null;
	return {
		exists: !!link,
		enabled: link ? Boolean(link.enabled) : false,
		publicPath: token ? `${EXPENSE_PUBLIC_PREFIX}/${token}` : null,
		accountingClosed: !!(await closedInfo(tx, actionId)),
		pendingCount: await pendingCount(tx, actionId)
	};
}

// --- Einreichungen -------------------------------------------------------------

const SUBMISSION_COLUMNS = sql`id, status, submitter_name, submitter_email, category, description,
	amount_cents, to_char(expense_date, 'YYYY-MM-DD') AS expense_date, account_holder, iban_last4, bic,
	note, receipt_path, receipt_name, receipt_content_type, created_at, decided_at, decided_by,
	entry_id, reject_reason, batch_id`;

function mapSubmission(r: Record<string, unknown>, users: Map<string, UserRef>): ExpenseSubmission {
	const decidedBy = str(r.decided_by);
	return {
		id: String(r.id),
		status: String(r.status) as ExpenseSubmissionStatus,
		submitterName: String(r.submitter_name),
		submitterEmail: str(r.submitter_email),
		category: String(r.category) as CalcCategory,
		description: String(r.description),
		amountCents: Number(r.amount_cents),
		expenseDate: String(r.expense_date),
		accountHolder: str(r.account_holder),
		ibanMasked: maskFromLast(str(r.iban_last4)),
		bic: str(r.bic),
		note: str(r.note),
		receipt:
			r.receipt_path == null
				? null
				: {
						name: String(r.receipt_name ?? 'Beleg'),
						contentType: String(r.receipt_content_type ?? 'application/octet-stream')
					},
		createdAt: toIsoOrNull(r.created_at) ?? new Date(0).toISOString(),
		decidedAt: toIsoOrNull(r.decided_at),
		decidedBy: decidedBy
			? (users.get(decidedBy) ?? { userId: decidedBy, name: 'Unbekannt', email: null })
			: null,
		entryId: str(r.entry_id),
		rejectReason: str(r.reject_reason),
		batchId: str(r.batch_id)
	};
}

/** Namen der Prüfenden auflösen – immer NACH der Transaktion (Core-Service). */
async function resolveUsers(
	ctx: RequestContext,
	rows: Record<string, unknown>[]
): Promise<Map<string, UserRef>> {
	const ids = [...new Set(rows.map((r) => str(r.decided_by)).filter((v): v is string => !!v))];
	const map = new Map<string, UserRef>();
	for (const u of (await core.users.byIds(ctx, ids)).values()) {
		map.set(u.id, { userId: u.id, name: u.name, email: u.email });
	}
	return map;
}

async function toDtos(ctx: RequestContext, rows: Record<string, unknown>[]) {
	const users = await resolveUsers(ctx, rows);
	return rows.map((r) => mapSubmission(r, users));
}

async function lockSubmission(tx: Tx, actionId: string, submissionId: string) {
	const [row] = await rowsOf(
		tx,
		sql`SELECT *, to_char(expense_date, 'YYYY-MM-DD') AS expense_day FROM expense_submissions
			WHERE id = ${submissionId} AND action_id = ${actionId} FOR UPDATE`
	);
	if (!row) throw errors.notFound('Einreichung nicht gefunden');
	if (String(row.status) !== 'pending') {
		throw errors.conflict('Die Einreichung wurde bereits bearbeitet');
	}
	return row;
}

async function loadSubmissionRow(tx: Tx, submissionId: string) {
	const [row] = await rowsOf(
		tx,
		sql`SELECT ${SUBMISSION_COLUMNS} FROM expense_submissions WHERE id = ${submissionId}`
	);
	if (!row) throw errors.notFound('Einreichung nicht gefunden');
	return row;
}

// --- Öffentlich ----------------------------------------------------------------

interface PublicLink {
	actionId: string;
	actionName: string;
	startsOn: string;
	endsOn: string | null;
	privacyUrl: string | null;
}

/** Link per Token; `null` bei unbekannt, deaktiviert oder abgeschlossener Abrechnung. */
async function loadByToken(tx: Tx, token: string, lock = false): Promise<PublicLink | null> {
	const [row] = await rowsOf(
		tx,
		sql`SELECT l.action_id, l.enabled, a.name, to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on,
				to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on,
				(SELECT f.privacy_url FROM action_forms f WHERE f.action_id = l.action_id) AS privacy_url
			FROM expense_links l JOIN actions a ON a.id = l.action_id
			WHERE ${tokenMatchSql(token, 'l')} ${lock ? sql`FOR UPDATE OF l` : sql``}`
	);
	if (!row || !row.enabled) return null;
	const actionId = String(row.action_id);
	if (await closedInfo(tx, actionId)) return null;
	return {
		actionId,
		actionName: String(row.name),
		startsOn: String(row.starts_on),
		endsOn: str(row.ends_on),
		privacyUrl: str(row.privacy_url)
	};
}

/**
 * Eingangsbestätigung an die (unbestätigte) Adresse aus dem Formular. Enthält bewusst KEINE
 * Freitexte (Name, Beschreibungen, Notizen), nur Aktionsname, Kategorie, Datum, Betrag und feste
 * Texte – so lässt sich der Kosten-Link nicht als Mail-Relay nutzen (Issue #17).
 */
function confirmationMail(link: PublicLink, input: PublicExpenseBatchInput, totalCents: number) {
	const many = input.items.length > 1;
	const lines = [
		'Hallo,',
		'',
		many
			? `deine ${input.items.length} Auslagen für „${link.actionName}“ sind bei uns eingegangen:`
			: `deine Auslage für „${link.actionName}“ ist bei uns eingegangen:`,
		''
	];
	input.items.forEach((item, i) => {
		lines.push(
			`${i + 1}. ${CALC_CATEGORY_LABELS[item.category]} vom ${deDate(item.expenseDate)}: ${euro(item.amountCents)}`
		);
	});
	lines.push(
		'',
		`Summe: ${euro(totalCents)}`,
		'',
		'Wir prüfen deine Angaben und die Belege. Nach der Freigabe wird der Betrag auf das angegebene Konto überwiesen.',
		'',
		'Hast du nichts eingereicht? Dann ignoriere diese E-Mail.',
		'',
		'Diese E-Mail wurde automatisch erstellt.'
	);
	return {
		subject: `${many ? 'Auslagen' : 'Auslage'} eingegangen: ${link.actionName}`,
		text: lines.join('\n')
	};
}

/** Hinweis an die Eigentümer*in der Aktion (ohne Kontodaten). Fehler werden abgefangen. */
async function notifyOwner(
	ownerId: string | null,
	link: PublicLink,
	submitterName: string,
	count: number,
	totalCents: number
): Promise<boolean> {
	if (!ownerId) return false;
	const body = [
		`Über den Kosten-Link von „${link.actionName}“ wurden neue Auslagen eingereicht:`,
		'',
		`Eingereicht von: ${neutralizeLinks(submitterName)}`,
		`Anzahl: ${count}`,
		`Summe: ${euro(totalCents)}`,
		'',
		'Bitte prüfe die Einreichung im Tab „Abrechnung“:'
	].join('\n');
	const r = await core.notifications.send(systemCtx(), MODULE_ID, [
		{
			type: NOTIFY_EXPENSE_SUBMITTED,
			userIds: [ownerId],
			title: `Neue Auslagen für ${link.actionName}`,
			body,
			pushBody: `${count} Auslage(n) über ${euro(totalCents)} – bitte prüfen`,
			link: `/modules/actions/${link.actionId}?tab=accounting`
		}
	]);
	return r.email + r.push + r.queued > 0;
}

interface CheckedReceipt {
	bytes: Uint8Array;
	contentType: string;
	displayName: string;
}

/** Belege prüfen (Anzahl, leer, Größe, Magic-Bytes) – vor jedem Upload. */
async function checkReceipts(files: File[], count: number): Promise<CheckedReceipt[]> {
	if (files.length !== count) {
		throw errors.validation({
			items:
				files.length < count
					? 'Bitte zu jeder Auslage genau einen Beleg hochladen'
					: 'Mehr Belege als Auslagen'
		});
	}
	const out: CheckedReceipt[] = [];
	for (const [i, file] of files.entries()) {
		const key = `items.${i}.file`;
		if (file.size === 0) throw errors.validation({ [key]: 'Die Datei ist leer' });
		if (file.size > MAX_RECEIPT_BYTES) {
			throw errors.tooLarge(`Beleg ${i + 1} ist zu groß (höchstens 10 MB)`);
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		const contentType = detectReceiptType(bytes);
		if (!contentType) {
			throw errors.validation({ [key]: 'Nur PDF, JPEG, PNG oder WebP sind erlaubt' });
		}
		const displayName = (file.name || '').trim().slice(0, 200) || 'beleg';
		out.push({ bytes, contentType, displayName });
	}
	return out;
}

async function removeAll(paths: string[]): Promise<void> {
	for (const path of paths) {
		await core.storage
			.remove(systemCtx(), { module: MODULE_ID, path })
			.catch((e) => logBestEffort('actions.expense.receipt-cleanup', e));
	}
}

async function submitExpenses(
	ctx: RequestContext,
	token: string,
	input: PublicExpenseBatchInput,
	files: File[]
): Promise<PublicExpenseBatchResult> {
	const count = input.items.length;
	// Honeypot: wie Erfolg antworten, nichts speichern, niemanden benachrichtigen
	if (input.website && input.website.trim()) {
		return { batchId: randomUUID(), count, emailSent: !!input.email };
	}

	const link = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const l = await loadByToken(tx, token);
		if (!l) return null;
		return { ...l, pending: await pendingCount(tx, l.actionId) };
	});
	if (!link) throw errors.notFound(NOT_AVAILABLE);
	if (link.pending + count > MAX_PENDING_SUBMISSIONS) throw errors.conflict(TOO_MANY);

	const receipts = await checkReceipts(files, count);
	const batchId = randomUUID();
	const rows = receipts.map((r, i) => {
		const id = randomUUID();
		return {
			id,
			item: input.items[i]!,
			receipt: r,
			path: `${link.actionId}/submission-${id}-${randomUUID()}-${sanitizeName(r.displayName)}`
		};
	});

	// Alle Belege VOR der Transaktion hochladen; bei Fehler bereits hochgeladene wieder löschen
	const uploaded: string[] = [];
	try {
		for (const row of rows) {
			await core.storage.upload(systemCtx(), {
				module: MODULE_ID,
				path: row.path,
				file: row.receipt.bytes,
				contentType: row.receipt.contentType,
				name: row.receipt.displayName
			});
			uploaded.push(row.path);
		}
	} catch (e) {
		await removeAll(uploaded);
		if ((e as { code?: string }).code === 'unavailable') throw errors.unavailable(STORAGE_DOWN);
		throw e;
	}

	const ibanEnc = crypt().encrypt(input.iban);
	const last4 = ibanLast(input.iban);
	let ownerId: string | null;
	let quota = { confirm: false, owner: false };
	try {
		ownerId = await moduleDb(MODULE_ID).transaction(async (tx) => {
			// Link sperren: serialisiert parallele Einreichungen (Obergrenze offener Einreichungen)
			const l = await loadByToken(tx, token, true);
			if (!l || l.actionId !== link.actionId) throw errors.notFound(NOT_AVAILABLE);
			if ((await pendingCount(tx, l.actionId)) + count > MAX_PENDING_SUBMISSIONS) {
				throw errors.conflict(TOO_MANY);
			}
			for (const [i, row] of rows.entries()) {
				const { item } = row;
				// Reihenfolge innerhalb der Einreichung: erste Auslage = neuester Zeitstempel
				await tx.execute(
					sql`INSERT INTO expense_submissions (id, action_id, status, submitter_name, submitter_email,
							category, description, amount_cents, expense_date, account_holder, iban_enc, iban_last4,
							bic, receipt_path, receipt_name, receipt_content_type, note, batch_id, created_at)
						VALUES (${row.id}, ${l.actionId}, 'pending', ${input.name}, ${input.email}, ${item.category},
							${item.description}, ${item.amountCents}, ${item.expenseDate}, ${input.accountHolder},
							${ibanEnc}, ${last4}, ${input.bic}, ${row.path}, ${row.receipt.displayName},
							${row.receipt.contentType}, ${item.note}, ${batchId},
							now() - (${i} * interval '1 millisecond'))`
				);
			}
			// Tageslimit je Link: darüber wird gespeichert, aber keine Mail mehr verschickt
			quota = {
				confirm: input.email ? await takeMailQuota(tx, l.actionId, 'expense-confirm') : false,
				owner: await takeMailQuota(tx, l.actionId, 'expense-owner')
			};
			const [a] = await rowsOf(tx, sql`SELECT owner_id FROM actions WHERE id = ${l.actionId}`);
			return str(a?.owner_id);
		});
	} catch (e) {
		await removeAll(uploaded);
		throw e;
	}

	const totalCents = input.items.reduce((s, item) => s + item.amountCents, 0);
	let emailSent = false;
	if (input.email && quota.confirm) {
		try {
			await core.mail.send({ to: input.email, ...confirmationMail(link, input, totalCents) });
			emailSent = true;
		} catch (e) {
			logBestEffort('actions.expense.confirmation-mail', e, { ctx, target: link.actionId });
			emailSent = false;
		}
	}
	const ownerNotified = quota.owner
		? await notifyOwner(ownerId, link, input.name, count, totalCents)
		: false;
	try {
		await core.audit.log({
			action: 'actions.expense.submitted',
			actor: { type: 'system', id: 'expense-link', name: 'Kosten-Link' },
			target: link.actionId,
			ip: ctx.ip,
			requestId: ctx.requestId,
			metadata: {
				actionId: link.actionId,
				batchId,
				submissionIds: rows.map((r) => r.id),
				count,
				totalCents,
				size: receipts.reduce((s, r) => s + r.bytes.byteLength, 0),
				emailSent,
				ownerNotified
			}
		});
	} catch (e) {
		// Audit-Fehler dürfen die Einreichung nicht verwerfen
		logBestEffort('actions.expense.audit', e, { ctx, target: link.actionId });
	}
	return { batchId, count, emailSent };
}

// --- Annehmen / Ablehnen ---------------------------------------------------------

async function accept(
	ctx: RequestContext,
	actionId: string,
	submissionId: string,
	input: ExpenseAcceptInput
) {
	const result = await moduleDb(MODULE_ID).transaction(async (tx) => {
		await requireAccess(tx, ctx, actionId, 'edit');
		await assertOpen(tx, actionId);
		const s = await lockSubmission(tx, actionId, submissionId);

		let payeeId: string;
		let payeeCreated = false;
		if (input.payeeId) {
			const [p] = await rowsOf(
				tx,
				sql`SELECT id FROM accounting_payees WHERE id = ${input.payeeId} AND action_id = ${actionId}`
			);
			if (!p) {
				throw errors.validation({ payeeId: 'Die Person gehört nicht zu dieser Aktion' });
			}
			payeeId = String(p.id);
		} else {
			if (s.iban_enc == null) {
				throw errors.validation({ payeeId: 'Keine Kontodaten vorhanden – bitte Person wählen' });
			}
			const name = String(s.account_holder ?? s.submitter_name);
			const last = str(s.iban_last4);
			const [existing] = await rowsOf(
				tx,
				sql`SELECT id FROM accounting_payees WHERE action_id = ${actionId}
					AND lower(name) = lower(${name}) AND iban_last4 = ${last}
					ORDER BY created_at LIMIT 1`
			);
			if (existing) {
				payeeId = String(existing.id);
			} else {
				payeeId = randomUUID();
				payeeCreated = true;
				// iban_enc stammt aus derselben Verschlüsselung (core.crypto.forModule('actions'))
				await tx.execute(
					sql`INSERT INTO accounting_payees (id, action_id, name, iban_enc, iban_last4, bic, note)
						VALUES (${payeeId}, ${actionId}, ${name}, ${String(s.iban_enc)}, ${last},
							${str(s.bic)}, ${'Aus Kosten-Link'})`
				);
			}
		}

		const entryId = randomUUID();
		const category = input.category ?? (String(s.category) as CalcCategory);
		const amountCents = input.amountCents ?? Number(s.amount_cents);
		const description = input.description ?? String(s.description);
		const entryDate = input.expenseDate ?? String(s.expense_day);
		await tx.execute(
			sql`INSERT INTO accounting_entries (id, action_id, type, category, description, amount_cents,
					entry_date, paid_by, payee_id, created_by, receipt_path, receipt_name, receipt_content_type)
				VALUES (${entryId}, ${actionId}, 'expense', ${category}, ${description}, ${amountCents},
					${entryDate}, 'person', ${payeeId}, ${ctx.userId ?? null}, ${str(s.receipt_path)},
					${str(s.receipt_name)}, ${str(s.receipt_content_type)})`
		);
		// Kontodaten liegen jetzt beim Empfänger; in der Einreichung bleibt nur die Maske
		await tx.execute(
			sql`UPDATE expense_submissions SET status = 'accepted', decided_at = now(),
					decided_by = ${ctx.userId ?? null}, entry_id = ${entryId}, iban_enc = NULL
				WHERE id = ${submissionId}`
		);
		return {
			row: await loadSubmissionRow(tx, submissionId),
			entryId,
			payeeId,
			payeeCreated,
			amountCents,
			category
		};
	});
	const [submission] = await toDtos(ctx, [result.row]);
	await core.audit.logFromContext(ctx, 'actions.expense.accepted', {
		target: actionId,
		metadata: {
			actionId,
			submissionId,
			entryId: result.entryId,
			payeeId: result.payeeId,
			payeeCreated: result.payeeCreated,
			category: result.category,
			amountCents: result.amountCents
		}
	});
	return {
		submission: submission!,
		entryId: result.entryId,
		payeeId: result.payeeId,
		payeeCreated: result.payeeCreated
	};
}

async function reject(
	ctx: RequestContext,
	actionId: string,
	submissionId: string,
	input: { reason: string | null; notify: boolean }
) {
	const result = await moduleDb(MODULE_ID).transaction(async (tx) => {
		await requireAccess(tx, ctx, actionId, 'edit');
		const s = await lockSubmission(tx, actionId, submissionId);
		await tx.execute(
			sql`UPDATE expense_submissions SET status = 'rejected', decided_at = now(),
					decided_by = ${ctx.userId ?? null}, reject_reason = ${input.reason},
					iban_enc = NULL, bic = NULL, account_holder = NULL,
					receipt_path = NULL, receipt_name = NULL, receipt_content_type = NULL
				WHERE id = ${submissionId}`
		);
		const [a] = await rowsOf(tx, sql`SELECT name FROM actions WHERE id = ${actionId}`);
		return {
			row: await loadSubmissionRow(tx, submissionId),
			path: str(s.receipt_path),
			email: str(s.submitter_email),
			name: String(s.submitter_name),
			description: String(s.description),
			amountCents: Number(s.amount_cents),
			actionName: String(a?.name ?? '')
		};
	});
	if (result.path) {
		await core.storage
			.remove(systemCtx(), { module: MODULE_ID, path: result.path })
			.catch((e) => logBestEffort('actions.expense.receipt-cleanup', e, { ctx, target: actionId }));
	}
	let emailSent = false;
	if (input.notify && result.email) {
		try {
			const lines = [
				`Hallo ${result.name},`,
				'',
				`deine Auslage für „${result.actionName}“ (${result.description}, ${euro(result.amountCents)}) wurde leider nicht übernommen.`,
				...(input.reason ? ['', `Begründung: ${input.reason}`] : []),
				'',
				'Deine Kontodaten und der Beleg wurden gelöscht. Bei Fragen wende dich bitte an die Verantwortlichen der Aktion.'
			];
			await core.mail.send({
				to: result.email,
				subject: `Auslage nicht übernommen: ${result.actionName}`,
				text: lines.join('\n')
			});
			emailSent = true;
		} catch (e) {
			logBestEffort('actions.expense.reject-mail', e, { ctx, target: actionId });
			emailSent = false;
		}
	}
	const [submission] = await toDtos(ctx, [result.row]);
	await core.audit.logFromContext(ctx, 'actions.expense.rejected', {
		target: actionId,
		metadata: { actionId, submissionId, notified: emailSent }
	});
	return { submission: submission!, emailSent };
}

// --- Endpunkte ----------------------------------------------------------------

type IdP = { id: string };
type SubP = { id: string; submissionId: string };

export const expenseLinkEndpoints = [
	{
		method: 'GET',
		path: '/actions/:id/expense-link',
		summary: 'Kosten-Link einer Aktion lesen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as IdP).id;
			return moduleDb(MODULE_ID).transaction(async (tx) => {
				const access = await requireAccess(tx, ctx, id, 'read');
				return loadConfig(tx, id, access.level === 'edit');
			});
		}
	},
	{
		method: 'PUT',
		path: '/actions/:id/expense-link',
		summary: 'Kosten-Link aktivieren oder deaktivieren (legt ihn bei Bedarf an)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: expenseLinkInput,
		handler: async ({ ctx, params, body }) => {
			const id = (params as IdP).id;
			const { enabled } = body as { enabled: boolean };
			const config = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				const fresh = linkTokenValues(newToken());
				await tx.execute(
					sql`INSERT INTO expense_links (action_id, token_hash, token_enc, enabled)
						VALUES (${id}, ${fresh.hash}, ${fresh.enc}, ${enabled})
						ON CONFLICT (action_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`
				);
				return loadConfig(tx, id, true);
			});
			await core.audit.logFromContext(ctx, 'actions.expense.link_updated', {
				target: id,
				metadata: { actionId: id, enabled }
			});
			return config;
		}
	},
	{
		method: 'POST',
		path: '/actions/:id/expense-link/rotate',
		summary: 'Kosten-Link erneuern (alter Link wird ungültig)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as IdP).id;
			const config = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				const fresh = linkTokenValues(newToken());
				const res = await rowsOf(
					tx,
					sql`UPDATE expense_links SET token = NULL, token_hash = ${fresh.hash},
						token_enc = ${fresh.enc}, updated_at = now()
						WHERE action_id = ${id} RETURNING action_id`
				);
				if (!res.length) throw errors.notFound('Der Kosten-Link wurde noch nicht angelegt');
				return loadConfig(tx, id, true);
			});
			await core.audit.logFromContext(ctx, 'actions.expense.link_rotated', {
				target: id,
				metadata: { actionId: id }
			});
			return config;
		}
	},
	{
		method: 'GET',
		path: '/actions/:id/expense-submissions',
		summary: 'Eingereichte Auslagen einer Aktion',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		query: expenseSubmissionsQuery,
		handler: async ({ ctx, params, query }) => {
			const id = (params as IdP).id;
			const status = (query as { status?: ExpenseSubmissionStatus }).status;
			const rows = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'read');
				return rowsOf(
					tx,
					sql`SELECT ${SUBMISSION_COLUMNS} FROM expense_submissions
						WHERE action_id = ${id} ${status ? sql`AND status = ${status}` : sql``}
						ORDER BY (status = 'pending') DESC, created_at DESC, id
						LIMIT 500`
				);
			});
			return toDtos(ctx, rows);
		}
	},
	{
		method: 'GET',
		path: '/actions/:id/expense-submissions/:submissionId/receipt',
		summary: 'Beleg einer eingereichten Auslage herunterladen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: expenseSubmissionParams,
		handler: async ({ ctx, params }) => {
			const { id, submissionId } = params as SubP;
			const ref = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'read');
				const [r] = await rowsOf(
					tx,
					sql`SELECT receipt_path, receipt_name FROM expense_submissions
						WHERE id = ${submissionId} AND action_id = ${id}`
				);
				if (!r) throw errors.notFound('Einreichung nicht gefunden');
				return { path: str(r.receipt_path), name: str(r.receipt_name) };
			});
			await core.permissions.require(ctx, 'actions.storage.read');
			if (!ref.path) throw errors.notFound('Kein Beleg vorhanden');
			const { buffer, file } = await core.storage.download(ctx, {
				module: MODULE_ID,
				path: ref.path
			});
			const name = ref.name || file.name || 'beleg';
			// Gemeinsame gehärtete Antwort (CSP-Sandbox, nosniff, RFC-5987-Name; #67, 01b-11)
			return secureFileResponse(buffer, {
				contentType: file.contentType,
				size: buffer.byteLength,
				name,
				download: true,
				cache: 'private, no-store'
			});
		}
	},
	{
		method: 'POST',
		path: '/actions/:id/expense-submissions/:submissionId/accept',
		summary: 'Eingereichte Auslage übernehmen (Buchung + Empfänger)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: expenseSubmissionParams,
		body: expenseAcceptInput,
		handler: async ({ ctx, params, body }) => {
			const { id, submissionId } = params as SubP;
			return accept(ctx, id, submissionId, body as ExpenseAcceptInput);
		}
	},
	{
		method: 'POST',
		path: '/actions/:id/expense-submissions/:submissionId/reject',
		summary: 'Eingereichte Auslage ablehnen (Kontodaten und Beleg werden gelöscht)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: expenseSubmissionParams,
		body: expenseRejectInput,
		handler: async ({ ctx, params, body }) => {
			const { id, submissionId } = params as SubP;
			return reject(ctx, id, submissionId, body as { reason: string | null; notify: boolean });
		}
	},
	{
		method: 'GET',
		path: '/public/expense-links/:token',
		summary: 'Öffentlichen Kosten-Link lesen',
		tags: TAGS,
		permission: null,
		public: true,
		rateLimit: { limit: 60, windowSec: 60 },
		params: publicTokenParams,
		handler: async ({ params }) => {
			const { token } = params as { token: string };
			const link = await moduleDb(MODULE_ID).transaction((tx) => loadByToken(tx, token));
			if (!link) throw errors.notFound(NOT_AVAILABLE);
			const result: PublicExpenseLink = {
				actionName: link.actionName,
				startsOn: link.startsOn,
				endsOn: link.endsOn,
				categories: CALC_CATEGORIES.map((value) => ({
					value,
					label: CALC_CATEGORY_LABELS[value]
				})),
				privacyUrl: link.privacyUrl ?? (await globalPrivacyUrl()),
				maxReceiptBytes: MAX_RECEIPT_BYTES
			};
			return result;
		}
	},
	{
		method: 'POST',
		path: '/public/expense-links/:token/submit',
		summary:
			'Auslagen über den Kosten-Link einreichen (multipart, ein Beleg je Auslage im Feld "file", Reihenfolge wie items)',
		tags: TAGS,
		permission: null,
		public: true,
		rateLimit: { limit: 5, windowSec: 600 },
		multipart: { maxBytes: MAX_EXPENSE_BATCH_BYTES, maxFiles: MAX_EXPENSE_BATCH_ITEMS },
		params: publicTokenParams,
		body: publicExpenseBatchInput,
		handler: async ({ ctx, params, body, files }) =>
			submitExpenses(
				ctx,
				(params as { token: string }).token,
				body as PublicExpenseBatchInput,
				files ?? []
			)
	}
] as ApiEndpoint[];
