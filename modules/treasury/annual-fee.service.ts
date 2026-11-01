/**
 * Jahresbeitrag: Läufe je Beitragsjahr anlegen/ändern, Vorschau (JSON, PDF, Mail), Versand
 * (sofort, geplant per Job) und Nachberechnung. Kontaktdaten von `members` und Core-Dienste
 * (PDF, Mail, Audit) laufen AUSSERHALB der Modul-Transaktion (PGlite).
 */
import { sql } from 'drizzle-orm';
import { core, errors, type RequestContext, type Tx } from '$lib/sdk/server';
import type { MemberContact } from '$modules/members/contract';
import {
	annualInvoiceDueOn,
	defaultAnnualDueOn,
	planAnnualInvoices,
	type AnnualMember,
	type AnnualPayer,
	type AnnualPlan,
	type PlannedInvoice
} from './annual-fee';
import {
	idList,
	iso,
	isoOrNull,
	mdb,
	membersService,
	nextInvoiceNumber,
	num,
	rows,
	str,
	today
} from './db';
import {
	allAdults,
	annualVars,
	isAdultOn,
	renderInvoicePdf,
	sendDocuments,
	withoutMemberHint,
	type InvoiceSnapshot
} from './documents';
import { suggestPayers } from './logic';
import { composeMail } from './mail-compose';
import { loadBankData } from './notify';
import {
	DEFAULT_ANNUAL_BODY,
	DEFAULT_ANNUAL_PDF_TEXT,
	DEFAULT_ANNUAL_SUBJECT,
	DEFAULT_FEE_RATES,
	FEE_LEVELS,
	SETTING_KEYS,
	type AnnualMailPreview,
	type AnnualPreview,
	type AnnualRun,
	type AnnualRunStatus,
	type AnnualRunUpdate,
	type AnnualSendResult,
	type FeeLevel,
	type FeeRates
} from './schemas';

type Row = Record<string, unknown>;
export type AnnualMode = 'run' | 'catch-up';

const RUN_COLUMNS = sql`r.id, r.year, to_char(r.created_on, 'YYYY-MM-DD') AS created_on,
	to_char(r.due_on, 'YYYY-MM-DD') AS due_on, to_char(r.send_on, 'YYYY-MM-DD') AS send_on, r.status,
	r.sent_at, r.rates, r.mail_subject, r.mail_body, r.pdf_text, r.last_result, r.created_at, r.updated_at,
	(SELECT count(*)::int FROM invoices i WHERE i.annual_run_id = r.id) AS invoice_count`;

const json = <T>(v: unknown): T | null =>
	v == null ? null : ((typeof v === 'string' ? JSON.parse(v) : v) as T);

/** Hängender Versand ohne Lebenszeichen (z. B. Neustart mittendrin) → als abgebrochen melden */
function withSendState(r: AnnualSendResult | null): AnnualSendResult | null {
	if (!r?.sending || isSending(r)) return r;
	return { ...r, sending: false, interrupted: true };
}

function toRun(r: Row): AnnualRun {
	const rates = json<Partial<FeeRates>>(r.rates) ?? {};
	return {
		id: String(r.id),
		year: num(r.year),
		createdOn: String(r.created_on),
		dueOn: String(r.due_on),
		sendOn: str(r.send_on),
		status: r.status as AnnualRunStatus,
		sentAt: isoOrNull(r.sent_at),
		rates: Object.fromEntries(FEE_LEVELS.map((l) => [l, num(rates[l])])) as FeeRates,
		mailSubject: String(r.mail_subject),
		mailBody: String(r.mail_body),
		pdfText: String(r.pdf_text),
		lastResult: withSendState(json<AnnualSendResult>(r.last_result)),
		invoiceCount: num(r.invoice_count),
		createdAt: iso(r.created_at),
		updatedAt: iso(r.updated_at)
	};
}

async function loadRun(tx: Tx, id: string, lock = false): Promise<AnnualRun> {
	if (lock) await tx.execute(sql`SELECT id FROM annual_fee_runs WHERE id = ${id} FOR UPDATE`);
	const [r] = await rows(tx, sql`SELECT ${RUN_COLUMNS} FROM annual_fee_runs r WHERE r.id = ${id}`);
	if (!r) throw errors.notFound('Beitragslauf nicht gefunden');
	return toRun(r);
}

export async function listRuns(): Promise<AnnualRun[]> {
	const found = await mdb().transaction((tx) =>
		rows(tx, sql`SELECT ${RUN_COLUMNS} FROM annual_fee_runs r ORDER BY r.year DESC`)
	);
	return found.map(toRun);
}

export async function getRun(id: string): Promise<AnnualRun> {
	return mdb().transaction((tx) => loadRun(tx, id));
}

export async function createRun(ctx: RequestContext, year: number): Promise<AnnualRun> {
	const s = await core.settings.getMany([
		SETTING_KEYS.annualStamm,
		SETTING_KEYS.annualGau,
		SETTING_KEYS.annualLandesmark,
		SETTING_KEYS.annualBund,
		SETTING_KEYS.annualSubject,
		SETTING_KEYS.annualBody,
		SETTING_KEYS.annualPdfText,
		SETTING_KEYS.minDays
	]);
	const rate = (k: string, d: number) => {
		const v = Number(s[k]);
		return Number.isInteger(v) && v >= 0 ? v : d;
	};
	const rates: FeeRates = {
		stamm: rate(SETTING_KEYS.annualStamm, DEFAULT_FEE_RATES.stamm),
		gau: rate(SETTING_KEYS.annualGau, DEFAULT_FEE_RATES.gau),
		landesmark: rate(SETTING_KEYS.annualLandesmark, DEFAULT_FEE_RATES.landesmark),
		bund: rate(SETTING_KEYS.annualBund, DEFAULT_FEE_RATES.bund)
	};
	const todayIso = today();
	const id = crypto.randomUUID();
	await mdb().transaction(async (tx) => {
		// ON CONFLICT statt vorheriger Abfrage: zwei gleichzeitige Anlagen → 409 statt Datenbankfehler
		const inserted = await rows(
			tx,
			sql`INSERT INTO annual_fee_runs (id, year, created_on, due_on, rates, mail_subject, mail_body, pdf_text, created_by)
			VALUES (${id}, ${year}, ${todayIso}, ${defaultAnnualDueOn(year, todayIso, rate(SETTING_KEYS.minDays, 14))},
				${JSON.stringify(rates)}::jsonb,
				${String(s[SETTING_KEYS.annualSubject] || DEFAULT_ANNUAL_SUBJECT)},
				${String(s[SETTING_KEYS.annualBody] || DEFAULT_ANNUAL_BODY)},
				${String(s[SETTING_KEYS.annualPdfText] || DEFAULT_ANNUAL_PDF_TEXT)}, ${ctx.userId})
			ON CONFLICT (year) DO NOTHING RETURNING id`
		);
		if (!inserted.length) {
			throw errors.conflict('Für dieses Jahr gibt es bereits einen Beitragslauf');
		}
	});
	await core.audit.logFromContext(ctx, 'treasury.annual-fee.created', {
		target: id,
		metadata: { year }
	});
	return getRun(id);
}

function requireEditable(run: AnnualRun): void {
	if (run.status === 'sent') {
		throw errors.conflict(
			'Der Beitragslauf ist bereits versendet und kann nicht mehr geändert werden'
		);
	}
}

export async function updateRun(
	ctx: RequestContext,
	id: string,
	input: AnnualRunUpdate
): Promise<AnnualRun> {
	if (input.dueOn && input.dueOn < today()) {
		throw errors.validation([{ path: ['dueOn'], message: 'Die Frist liegt in der Vergangenheit' }]);
	}
	const unscheduled = await mdb().transaction(async (tx) => {
		const run = await loadRun(tx, id, true);
		requireEditable(run);
		// Geplanter Versand wurde mit `invoice.send` freigegeben: Inhaltsänderung → wieder Entwurf
		await tx.execute(
			sql`UPDATE annual_fee_runs SET
				status = 'draft', send_on = NULL,
				due_on = ${input.dueOn ?? run.dueOn},
				rates = ${JSON.stringify(input.rates ?? run.rates)}::jsonb,
				mail_subject = ${input.mailSubject ?? run.mailSubject},
				mail_body = ${input.mailBody ?? run.mailBody},
				pdf_text = ${input.pdfText ?? run.pdfText},
				updated_at = now()
			WHERE id = ${id}`
		);
		return run.status === 'scheduled';
	});
	await core.audit.logFromContext(ctx, 'treasury.annual-fee.updated', {
		target: id,
		metadata: {
			fields: Object.keys(input).filter((k) => input[k as keyof AnnualRunUpdate] != null),
			unscheduled
		}
	});
	return getRun(id);
}

export async function deleteRun(ctx: RequestContext, id: string): Promise<void> {
	const year = await mdb().transaction(async (tx) => {
		const run = await loadRun(tx, id, true);
		if (run.status === 'sent' || run.invoiceCount > 0) {
			throw errors.conflict('Versendete Beitragsläufe können nicht gelöscht werden');
		}
		await tx.execute(sql`DELETE FROM annual_fee_runs WHERE id = ${id}`);
		return run.year;
	});
	await core.audit.logFromContext(ctx, 'treasury.annual-fee.deleted', {
		target: id,
		metadata: { year }
	});
}

export async function scheduleRun(
	ctx: RequestContext,
	id: string,
	sendOn: string | null
): Promise<AnnualRun> {
	if (sendOn && sendOn < today()) {
		throw errors.validation([
			{ path: ['sendOn'], message: 'Das Versanddatum liegt in der Vergangenheit' }
		]);
	}
	await mdb().transaction(async (tx) => {
		const run = await loadRun(tx, id, true);
		requireEditable(run);
		await tx.execute(
			sql`UPDATE annual_fee_runs SET status = ${sendOn ? 'scheduled' : 'draft'}, send_on = ${sendOn},
				updated_at = now() WHERE id = ${id}`
		);
	});
	await core.audit.logFromContext(ctx, 'treasury.annual-fee.scheduled', {
		target: id,
		metadata: { sendOn }
	});
	return getRun(id);
}

// --- Planung -------------------------------------------------------------------------

const toAnnualMember = (c: MemberContact): AnnualMember => ({
	id: c.id,
	firstName: c.firstName,
	lastName: c.lastName,
	emails: c.emails ?? [],
	entryDate: c.entryDate ?? null,
	exitDate: c.exitDate ?? null,
	secondaryMember: Boolean(c.secondaryMember),
	feeLevels: (c.feeLevels ?? FEE_LEVELS) as FeeLevel[]
});

/** Obergrenze von `listMemberContacts` (ohne Blättern) */
export const MAX_ANNUAL_CONTACTS = 1000;

async function loadContacts(): Promise<MemberContact[]> {
	const list = await (await membersService()).listMemberContacts({ limit: MAX_ANNUAL_CONTACTS });
	// Abgeschnittene Liste würde Mitglieder stillschweigend nicht abrechnen → lieber abbrechen
	if (list.length >= MAX_ANNUAL_CONTACTS) {
		throw errors.conflict(
			`Der Jahresbeitrag unterstützt derzeit höchstens ${MAX_ANNUAL_CONTACTS - 1} Mitglieder (inkl. ausgetretener)`
		);
	}
	return list;
}

/** Zahler je Mitglied und bereits vorhandene Posten des Jahres (innerhalb der Transaktion) */
async function planInTx(
	tx: Tx,
	run: AnnualRun,
	mode: AnnualMode,
	contacts: MemberContact[]
): Promise<{ plan: AnnualPlan; payerOf: Map<string, AnnualPayer> }> {
	const payerRows = await rows(
		tx,
		sql`SELECT pm.member_id, p.id, p.name, p.email FROM payer_members pm JOIN payers p ON p.id = pm.payer_id`
	);
	const payerOf = new Map<string, AnnualPayer>(
		payerRows.map((r) => [
			String(r.member_id),
			{ id: String(r.id), name: String(r.name), email: str(r.email) }
		])
	);
	// Aufschlüsselung (neu) und Posten je Ebene (ältere Rechnungen mit `fee_level`)
	const refs = await rows(
		tx,
		sql`SELECT source_ref FROM invoice_lines
			WHERE source_ref LIKE ${`annual:${run.year}:%`} AND fee_level IS NOT NULL
		UNION ALL
		SELECT 'annual:' || year::text || ':' || member_id || ':' || level AS source_ref
			FROM annual_fee_items WHERE year = ${run.year}`
	);
	const plan = planAnnualInvoices({
		members: contacts.map(toAnnualMember),
		payerOf,
		year: run.year,
		rates: run.rates,
		existingRefs: new Set(refs.map((r) => String(r.source_ref))),
		mode,
		stichtag: run.createdOn
	});
	return { plan, payerOf };
}

const defaultMode = (run: AnnualRun): AnnualMode => (run.status === 'sent' ? 'catch-up' : 'run');

async function loadPlan(
	id: string,
	mode?: AnnualMode
): Promise<{
	run: AnnualRun;
	plan: AnnualPlan;
	contacts: MemberContact[];
	payerOf: Map<string, AnnualPayer>;
}> {
	const contacts = await loadContacts();
	return mdb().transaction(async (tx) => {
		const run = await loadRun(tx, id);
		const { plan, payerOf } = await planInTx(tx, run, mode ?? defaultMode(run), contacts);
		return { run, plan, contacts, payerOf };
	});
}

/** Empfänger-Adressen nur für Versand-/Bearbeitungsrechte (wie im Rechnungsdetail) */
export const canSeeAddresses = (ctx: RequestContext) =>
	core.permissions.has(ctx, 'treasury.invoice.send') ||
	core.permissions.has(ctx, 'treasury.invoice.edit');

export type AnnualPreviewWithCounts = AnnualPreview & {
	invoices: (AnnualPreview['invoices'][number] & { emailCount: number })[];
};

export async function previewRun(
	ctx: RequestContext,
	id: string,
	mode?: AnnualMode
): Promise<AnnualPreviewWithCounts> {
	const showEmails = canSeeAddresses(ctx);
	const { plan, contacts, payerOf } = await loadPlan(id, mode);
	const planned = new Set(plan.invoices.flatMap((i) => i.members.map((m) => m.memberId)));
	const free = contacts.filter((c) => planned.has(c.id));
	const suggestions = suggestPayers(free, new Set(payerOf.keys()));
	return {
		...plan,
		invoices: plan.invoices.map(({ lines: _lines, recipientEmail: _email, ...inv }) => ({
			...inv,
			emails: showEmails ? inv.emails : [],
			emailCount: inv.emails.length
		})),
		payerSuggestions: suggestions.reduce((s, g) => s + g.memberIds.length, 0)
	};
}

function pickInvoice(plan: AnnualPlan, key?: string): PlannedInvoice {
	const inv = key ? plan.invoices.find((i) => i.key === key) : plan.invoices[0];
	if (!inv) throw errors.notFound('Keine Rechnung für die Vorschau');
	return inv;
}

const PREVIEW_NUMBER = () => `R-${today().slice(0, 4)}-XXXX (Vorschau)`;

async function previewSnapshot(
	run: AnnualRun,
	inv: PlannedInvoice,
	contacts: MemberContact[]
): Promise<InvoiceSnapshot> {
	const byId = new Map(contacts.map((c) => [c.id, c]));
	const first = byId.get(inv.members[0]?.memberId ?? '');
	return {
		number: PREVIEW_NUMBER(),
		recipientName: inv.recipientName,
		address: [
			inv.recipientName,
			...(first ? [first.street, `${first.postalCode} ${first.city}`.trim()] : [])
		]
			.filter((l) => l && l.trim())
			.map((l) => l.slice(0, 60)),
		issuedOn: today(),
		dueOn: run.dueOn,
		note: null,
		actionName: null,
		cancelled: false,
		lines: inv.lines.map((l) => ({
			description: l.description,
			amountCents: l.amountCents,
			waivedCents: 0,
			waiveReason: null
		})),
		totalCents: inv.totalCents,
		paidCents: 0,
		bank: await loadBankData(),
		annual: {
			year: run.year,
			pdfText: run.pdfText,
			members: inv.members.map((m) => ({
				name: m.name,
				firstName: byId.get(m.memberId)?.firstName ?? m.name,
				adult: byId.has(m.memberId) ? isAdultOn(byId.get(m.memberId)!.birthDate, today()) : false,
				levels: Object.fromEntries(
					inv.items.filter((l) => l.memberId === m.memberId).map((l) => [l.level, l.amountCents])
				),
				totalCents: m.totalCents
			}))
		}
	};
}

export async function previewPdf(
	ctx: RequestContext,
	id: string,
	mode: AnnualMode | undefined,
	key: string | undefined
): Promise<Response> {
	const { run, plan, contacts } = await loadPlan(id, mode);
	const snapshot = await previewSnapshot(run, pickInvoice(plan, key), contacts);
	const pdf = await renderInvoicePdf(ctx, snapshot);
	return new Response(Buffer.from(pdf), {
		status: 200,
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': `inline; filename="Jahresbeitrag-${run.year}-Vorschau.pdf"`,
			'cache-control': 'private, no-store'
		}
	});
}

export async function previewMail(
	ctx: RequestContext,
	id: string,
	mode: AnnualMode | undefined,
	key: string | undefined
): Promise<AnnualMailPreview> {
	const { run, plan, contacts } = await loadPlan(id, mode);
	const inv = pickInvoice(plan, key);
	const snapshot = await previewSnapshot(run, inv, contacts);
	const vars = annualVars(snapshot, snapshot.annual!);
	const hint = (t: string) => (allAdults(snapshot.annual) ? withoutMemberHint(t) : t);
	const mail = composeMail({
		subjectTpl: hint(run.mailSubject),
		bodyTpl: hint(run.mailBody),
		invoices: [
			{
				number: snapshot.number,
				recipientName: snapshot.recipientName,
				dueOn: snapshot.dueOn,
				lines: snapshot.lines.map((l) => ({ description: l.description, cents: l.amountCents }))
			}
		],
		bank: snapshot.bank,
		mode: 'open',
		extraVars: {
			anlass: 'Rechnung',
			aenderung: `anbei die Rechnung zum Jahresbeitrag ${run.year}.`,
			jahr: vars.jahr!,
			mitglieder: vars.mitglieder!
		}
	});
	return { ...mail, to: canSeeAddresses(ctx) ? inv.emails : [] };
}

// --- Versand ---------------------------------------------------------------------------

const EMPTY_SEND = { invoices: 0, mailsSent: 0, mailErrors: 0, withoutAddress: 0 };
const SEND_CHUNK = 25;

/** Nicht stornierte Rechnungen des Laufs ohne zugestellte Fassung (Zähler und Wiederholung) */
async function unsentInvoiceIds(runId: string, only?: string[]): Promise<string[]> {
	if (only && !only.length) return [];
	const found = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT i.id FROM invoices i
			WHERE i.annual_run_id = ${runId} AND i.cancelled_at IS NULL
				${only ? sql`AND i.id IN (${idList(only)})` : sql``}
				AND NOT EXISTS (SELECT 1 FROM invoice_documents d WHERE d.invoice_id = i.id AND d.sent_at IS NOT NULL)
			ORDER BY i.number`
		)
	);
	return found.map((r) => String(r.id));
}

/**
 * Versendet Rechnungen in Paketen. Ein Fehler (z. B. PDF) bricht nicht den ganzen Versand ab:
 * nicht versendete Rechnungen des Pakets zählen als Fehler und können per `resend` nachgeholt werden.
 * `onProgress` läuft nach jedem Paket (Fortschritt im Lauf speichern).
 */
async function sendInChunks(
	ctx: RequestContext,
	runId: string,
	invoiceIds: string[],
	subjectTpl: string,
	bodyTpl: string,
	onProgress?: (total: typeof EMPTY_SEND, processed: number) => Promise<void>
) {
	const total = { ...EMPTY_SEND };
	for (let i = 0; i < invoiceIds.length; i += SEND_CHUNK) {
		const chunk = invoiceIds.slice(i, i + SEND_CHUNK);
		try {
			const r = await sendDocuments(ctx, chunk, 'annual', { subjectTpl, bodyTpl });
			total.invoices += r.invoices;
			total.mailsSent += r.mailsSent;
			total.mailErrors += r.mailErrors;
			total.withoutAddress += r.withoutAddress;
		} catch (e) {
			console.error('[treasury] Versand Jahresbeitrag (Paket) fehlgeschlagen:', e);
			total.mailErrors += (await unsentInvoiceIds(runId, chunk)).length;
		}
		if (onProgress) {
			await onProgress(total, Math.min(i + SEND_CHUNK, invoiceIds.length)).catch((e) =>
				console.error('[treasury] Fortschritt des Jahresbeitrags nicht gespeichert:', e)
			);
		}
	}
	return total;
}

async function storeResult(id: string, result: AnnualSendResult): Promise<void> {
	await mdb().transaction((tx) =>
		tx.execute(
			sql`UPDATE annual_fee_runs SET last_result = ${JSON.stringify(result)}::jsonb, updated_at = now()
			WHERE id = ${id}`
		)
	);
}

// --- Hintergrundversand (#24) -----------------------------------------------------------

/**
 * Laufende Versände dieses Prozesses (Lauf-ID → Abschluss). Ein zweiter Versand desselben Laufs
 * (Doppelklick, Job parallel zu „Jetzt senden“) bekommt 409. Zusätzlich steht der Stand mit
 * Lebenszeichen in `last_result` (`isSending`); ein Versand ohne Fortschritt seit `STALE_MS`
 * (z. B. nach Neustart mitten im Versand) gilt als abgebrochen und lässt sich per `resend` nachholen.
 */
const activeSends = new Map<string, Promise<unknown>>();
const STALE_MS = 10 * 60_000;

/** Läuft für den Lauf noch ein Versand (frisches Lebenszeichen)? */
export function isSending(r: AnnualSendResult | null | undefined, now = Date.now()): boolean {
	if (!r?.sending) return false;
	const beat = Date.parse(r.heartbeatAt ?? r.startedAt ?? '');
	return Number.isFinite(beat) && now - beat < STALE_MS;
}

/** Für Tests: wartet, bis alle Hintergrundversände dieses Prozesses fertig sind. */
export async function waitForAnnualSends(): Promise<void> {
	while (activeSends.size) await Promise.allSettled([...activeSends.values()]);
}

const CONFLICT_SENDING = 'Für diesen Beitragslauf läuft bereits ein Versand';

/**
 * Belegt den Lauf synchron (vor dem ersten `await`), damit zwei gleichzeitige Aufrufe sich sicher
 * ausschließen. Rückgabe: Freigabe, sobald `done` erledigt ist.
 */
function claimSend(id: string): (done: Promise<unknown>) => void {
	if (activeSends.has(id)) throw errors.conflict(CONFLICT_SENDING);
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	activeSends.set(id, gate);
	return (done) => {
		const tracked = done
			.catch(() => undefined)
			.finally(() => {
				if (activeSends.get(id) === tracked) activeSends.delete(id);
				release();
			});
		activeSends.set(id, tracked);
	};
}

type SendKind = 'run' | 'catch-up' | 'resend';
interface Delivery {
	ids: string[];
	invoicesCreated: number;
	mailSubject: string;
	mailBody: string;
	audit: { action: string; metadata: Record<string, unknown> };
}

function startedResult(kind: SendKind, d: Delivery): AnnualSendResult {
	const now = new Date().toISOString();
	return {
		invoicesCreated: d.invoicesCreated,
		mailsSent: 0,
		mailErrors: 0,
		withoutAddress: 0,
		sending: true,
		kind,
		processed: 0,
		total: d.ids.length,
		startedAt: now,
		heartbeatAt: now
	};
}

/** Versand + Fortschritt + Endergebnis + Audit; wirft nie (Fehler zählen als `mailErrors`). */
async function deliver(
	ctx: RequestContext,
	id: string,
	d: Delivery,
	start: AnnualSendResult
): Promise<AnnualSendResult> {
	let sent = { ...EMPTY_SEND };
	try {
		if (d.ids.length) {
			sent = await sendInChunks(ctx, id, d.ids, d.mailSubject, d.mailBody, (t, processed) =>
				storeResult(id, {
					...start,
					mailsSent: t.mailsSent,
					mailErrors: t.mailErrors,
					withoutAddress: t.withoutAddress,
					processed,
					heartbeatAt: new Date().toISOString()
				})
			);
		}
	} catch (e) {
		console.error('[treasury] Versand des Jahresbeitrags abgebrochen:', e);
		const unsent = await unsentInvoiceIds(id, d.ids).catch(() => d.ids);
		sent = { ...EMPTY_SEND, mailErrors: unsent.length };
	}
	const now = new Date().toISOString();
	const result: AnnualSendResult = {
		invoicesCreated: d.invoicesCreated,
		mailsSent: sent.mailsSent,
		mailErrors: sent.mailErrors,
		withoutAddress: sent.withoutAddress,
		sending: false,
		kind: start.kind,
		processed: d.ids.length,
		total: d.ids.length,
		startedAt: start.startedAt,
		heartbeatAt: now,
		finishedAt: now
	};
	try {
		await storeResult(id, result);
		await core.audit.logFromContext(ctx, d.audit.action, {
			target: id,
			metadata: {
				...d.audit.metadata,
				invoicesCreated: result.invoicesCreated,
				mailsSent: result.mailsSent,
				mailErrors: result.mailErrors,
				withoutAddress: result.withoutAddress
			}
		});
	} catch (e) {
		console.error('[treasury] Ergebnis des Jahresbeitrags nicht gespeichert:', e);
	}
	return result;
}

/** Nur die Zähler (Antwort des synchronen Versands, z. B. Job) */
const counters = (r: AnnualSendResult): AnnualSendResult => ({
	invoicesCreated: r.invoicesCreated,
	mailsSent: r.mailsSent,
	mailErrors: r.mailErrors,
	withoutAddress: r.withoutAddress
});

/**
 * Gemeinsamer Ablauf: Lauf belegen → vorbereiten (Rechnungen anlegen bzw. offene ermitteln) →
 * Start speichern → versenden. `background`: Antwort direkt nach dem Start (Endpunkt → 202),
 * sonst nach dem Versand (Job).
 */
async function runSend(
	ctx: RequestContext,
	id: string,
	kind: SendKind,
	prepare: () => Promise<Delivery | null>,
	background: boolean
): Promise<AnnualSendResult | null> {
	const finish = claimSend(id);
	let work: Promise<unknown> = Promise.resolve();
	try {
		const d = await prepare();
		if (!d) return null;
		const start = startedResult(kind, d);
		await storeResult(id, start);
		const delivery = deliver(ctx, id, d, start);
		work = delivery;
		if (background) return start;
		return counters(await delivery);
	} finally {
		finish(work);
	}
}

/** Lauf unter Sperre laden; läuft (laut Lebenszeichen) noch ein Versand → 409 */
async function loadRunForSend(tx: Tx, id: string): Promise<AnnualRun> {
	const run = await loadRun(tx, id, true);
	if (isSending(run.lastResult)) throw errors.conflict(CONFLICT_SENDING);
	return run;
}

/**
 * Erzeugt die Rechnungen eines Laufs (`run`) bzw. der Nachberechnung (`catch-up`) und versendet sie.
 * `run`: nur aus Entwurf/geplant (sonst 409), setzt danach `sent`. `catch-up`: nur nach dem Versand.
 * `scheduledOnly` (Job): nur, wenn der Lauf unter Sperre noch geplant und fällig ist – sonst `null`.
 * `background` (Endpunkte): Rechnungen werden sofort angelegt, der Versand läuft danach im
 * Hintergrund; Rückgabe = Startstand (`sending: true`, Fortschritt in `lastResult`).
 */
export async function sendRun(
	ctx: RequestContext,
	id: string,
	mode: AnnualMode,
	opts: { scheduledOnly?: boolean; background?: boolean } = {}
): Promise<AnnualSendResult | null> {
	if (opts.scheduledOnly && activeSends.has(id)) return null;
	return runSend(
		ctx,
		id,
		mode,
		() => createRunInvoices(ctx, id, mode, opts.scheduledOnly ?? false),
		opts.background ?? false
	);
}

async function createRunInvoices(
	ctx: RequestContext,
	id: string,
	mode: AnnualMode,
	scheduledOnly: boolean
): Promise<Delivery | null> {
	const contacts = await loadContacts();
	const todayIso = today();
	const s = await core.settings.getMany([SETTING_KEYS.minDays]);
	const minDaysRaw = Number(s[SETTING_KEYS.minDays] ?? 14);
	const minDays = Number.isFinite(minDaysRaw) ? minDaysRaw : 14;
	const created = await mdb().transaction(async (tx) => {
		const run = await loadRunForSend(tx, id);
		if (scheduledOnly && (run.status !== 'scheduled' || !run.sendOn || run.sendOn > todayIso)) {
			return null;
		}
		if (mode === 'run' && run.status === 'sent') {
			throw errors.conflict('Der Beitragslauf wurde bereits versendet');
		}
		if (mode === 'catch-up' && run.status !== 'sent') {
			throw errors.conflict('Nachberechnung erst nach dem Versand des Beitragslaufs');
		}
		const { plan } = await planInTx(tx, run, mode, contacts);
		const dueOn = annualInvoiceDueOn(run.dueOn, todayIso, minDays);
		const ids: string[] = [];
		let totalCents = 0;
		let members = 0;
		for (const inv of plan.invoices) {
			const invoiceId = crypto.randomUUID();
			const n = await nextInvoiceNumber(tx, todayIso);
			await tx.execute(
				sql`INSERT INTO invoices (id, number, year, seq, source, annual_run_id, payer_id, recipient_name,
					recipient_email, issued_on, due_on, created_by)
				VALUES (${invoiceId}, ${n.number}, ${n.year}, ${n.seq}, 'annual', ${run.id}, ${inv.payerId},
					${inv.recipientName}, ${inv.recipientEmail}, ${todayIso}, ${dueOn}, ${ctx.userId})`
			);
			// EIN offener Posten (Stammesbeitrag = Summe); die Aufschlüsselung liegt in `annual_fee_items`
			for (const [position, l] of inv.lines.entries()) {
				await tx.execute(
					sql`INSERT INTO invoice_lines (id, invoice_id, position, description, amount_cents, member_id,
						source_ref)
					VALUES (${crypto.randomUUID()}, ${invoiceId}, ${position}, ${l.description}, ${l.amountCents},
						${l.memberId}, ${`annual:${run.year}:invoice:${invoiceId}`})`
				);
			}
			for (const [position, it] of inv.items.entries()) {
				await tx.execute(
					sql`INSERT INTO annual_fee_items (id, invoice_id, year, member_id, level, amount_cents, position)
					VALUES (${crypto.randomUUID()}, ${invoiceId}, ${run.year}, ${it.memberId}, ${it.level},
						${it.amountCents}, ${position})`
				);
			}
			ids.push(invoiceId);
			totalCents += inv.totalCents;
			members += inv.members.length;
		}
		if (mode === 'run') {
			await tx.execute(
				sql`UPDATE annual_fee_runs SET status = 'sent', sent_at = now(), send_on = NULL, updated_at = now()
				WHERE id = ${id}`
			);
		}
		return { ids, totalCents, members, run };
	});
	if (!created) return null;
	// Ab hier sind die Rechnungen gespeichert: Versandfehler nur zählen (Wiederholung per `resend`)
	return {
		ids: created.ids,
		invoicesCreated: created.ids.length,
		mailSubject: created.run.mailSubject,
		mailBody: created.run.mailBody,
		audit: {
			action: mode === 'run' ? 'treasury.annual-fee.sent' : 'treasury.annual-fee.catch-up',
			metadata: {
				year: created.run.year,
				members: created.members,
				totalCents: created.totalCents
			}
		}
	};
}

/**
 * Wiederholung nach Fehlern: versendet alle nicht stornierten Rechnungen des Laufs, von denen noch
 * keine Fassung zugestellt wurde (z. B. SMTP-Ausfall). Legt keine neuen Rechnungen an.
 */
export async function resendRun(
	ctx: RequestContext,
	id: string,
	opts: { background?: boolean } = {}
): Promise<AnnualSendResult> {
	const result = await runSend(
		ctx,
		id,
		'resend',
		async () => {
			const run = await mdb().transaction((tx) => loadRunForSend(tx, id));
			if (run.status !== 'sent') {
				throw errors.conflict('Der Beitragslauf wurde noch nicht versendet');
			}
			const pending = await unsentInvoiceIds(id);
			return {
				ids: pending,
				invoicesCreated: 0,
				mailSubject: run.mailSubject,
				mailBody: run.mailBody,
				audit: {
					action: 'treasury.annual-fee.resent',
					metadata: { year: run.year, invoices: pending.length }
				}
			};
		},
		opts.background ?? false
	);
	return result!;
}

/** Job: geplante Läufe versenden, sobald `send_on` erreicht ist */
export async function runScheduledAnnualFees(ctx: RequestContext): Promise<string> {
	const due = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT id FROM annual_fee_runs WHERE status = 'scheduled' AND send_on <= ${today()} ORDER BY year`
		)
	);
	const parts: string[] = [];
	for (const r of due) {
		try {
			const res = await sendRun(ctx, String(r.id), 'run', { scheduledOnly: true });
			// Inzwischen zurueckgenommen/verschoben/versendet → nichts tun
			if (!res) continue;
			parts.push(
				`${res.invoicesCreated} Rechnungen, ${res.mailsSent} Mails, ${res.mailErrors} Fehler`
			);
		} catch (e) {
			console.error('[treasury] Versand des Jahresbeitrags fehlgeschlagen:', e);
			parts.push('Fehler beim Versand');
		}
	}
	return parts.length ? parts.join('; ') : 'Kein geplanter Versand fällig';
}
