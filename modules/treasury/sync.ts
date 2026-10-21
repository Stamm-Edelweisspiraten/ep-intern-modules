/**
 * Abgleich Aktionen → Rechnungen: Jede*r Teilnehmende einer Aktion mit übernommenem Beitrag
 * bekommt eine Rechnung mit einem Posten. Dienste von `actions`/`members` werden VOR der
 * Transaktion gelesen (PGlite), die Änderungen laufen in EINER Modul-Transaktion.
 *
 * Auslöser (Lesepfade lösen NIE einen Abgleich aus):
 * - `syncAll` – Vollabgleich inkl. Auszahlungen und Versand geänderter Rechnungen: stündlicher Job
 *   `treasury.sync` und ausdrücklich `POST /sync` („Jetzt abgleichen“). Setzt `sync_state.last_sync_at`.
 * - `syncAction` – gezielt EINE Aktion: nach schreibenden Vorgängen in `actions` (über
 *   `TreasuryService.actionChanged`) und bei der Anmeldung (`invoiceForRegistration`).
 *
 * Alle Läufe eines Prozesses sind hintereinandergeschaltet (Warteschlange); ein Lauf liest seine
 * Quellen erst beim Start, sieht also alles, was vor dem Einreihen committet war (#58). Gleiche,
 * noch nicht gestartete Läufe (gleiche Art, Aktion und auslösende Person) werden zusammengelegt.
 * Zusätzlich serialisiert `pg_advisory_xact_lock` die Schreibphase über Instanzen hinweg.
 */
import { sql } from 'drizzle-orm';
import { core, type RequestContext } from '$lib/sdk/server';
import {
	actionsService,
	mdb,
	membersService,
	nextInvoiceNumber,
	num,
	rows,
	str,
	today
} from './db';
import { refreshSentDocuments, type SendResult } from './documents';
import { notifyKasse, payableNotification, type CreatedPayableInfo } from './office-notify';
import { syncPayables } from './payables';
import { planSync, type ExistingSyncLine } from './logic';
import { SETTING_KEYS } from './schemas';

export interface SyncResult {
	created: number;
	updated: number;
	cancelled: number;
	reactivated: number;
	/** Versand geänderter/stornierter, bereits verschickter Rechnungen */
	documents?: { invoices: number; mailsSent: number; mailErrors: number };
}

const AUTO_CANCEL_REASON = 'Teilnahme oder Beitrag entfallen';
/** Schlüssel für `pg_advisory_xact_lock` (Schreibphase des Abgleichs) */
const SYNC_LOCK = sql`hashtext('treasury.sync')`;

const systemCtx = () => core.auth.systemContext('treasury-sync');

/** Rechnungen (und danach Auszahlungen) abgleichen – alle Aktionen (`null`) oder genau eine. */
async function syncDatabase(
	ctx: RequestContext | null,
	actionId: string | null
): Promise<{ result: SyncResult; createdPayables: CreatedPayableInfo[] }> {
	const sources = await (
		await actionsService()
	).listReceivableSources(actionId ? { actionIds: [actionId] } : {});
	const members = await (await membersService()).listMemberContacts({});
	const s = await core.settings.getMany([SETTING_KEYS.daysBeforeStart, SETTING_KEYS.minDays]);
	const todayIso = today();

	const result = await mdb().transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(${SYNC_LOCK})`);
		const settings = await rows(
			tx,
			sql`SELECT action_id, excluded, to_char(due_on, 'YYYY-MM-DD') AS due_on FROM action_settings
			${actionId ? sql`WHERE action_id = ${actionId}` : sql``}`
		);
		const existing = await rows(
			tx,
			sql`SELECT l.id AS line_id, l.invoice_id, l.source_ref, l.amount_cents, l.waived_cents, l.description,
				l.member_id, i.cancelled_at, i.auto_cancelled
			FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
			WHERE l.source_ref LIKE ${actionId ? `action:${actionId}:%` : 'action:%'}`
		);
		const plan = planSync({
			sources,
			excludedActionIds: new Set(
				settings.filter((r) => Boolean(r.excluded)).map((r) => String(r.action_id))
			),
			dueOverrides: new Map(
				settings.filter((r) => r.due_on).map((r) => [String(r.action_id), String(r.due_on)])
			),
			existing: existing.map((r): ExistingSyncLine => ({
				lineId: String(r.line_id),
				invoiceId: String(r.invoice_id),
				sourceRef: String(r.source_ref),
				amountCents: num(r.amount_cents),
				waivedCents: num(r.waived_cents),
				description: String(r.description),
				memberId: str(r.member_id),
				cancelled: r.cancelled_at != null,
				autoCancelled: Boolean(r.auto_cancelled)
			})),
			members,
			today: todayIso,
			daysBeforeStart: Number(s[SETTING_KEYS.daysBeforeStart] ?? 14),
			minDays: Number(s[SETTING_KEYS.minDays] ?? 14)
		});

		for (const c of plan.create) {
			const invoiceId = crypto.randomUUID();
			const n = await nextInvoiceNumber(tx, todayIso);
			await tx.execute(
				sql`INSERT INTO invoices (id, number, year, seq, source, action_id, recipient_name, recipient_email,
					issued_on, due_on, created_by)
				VALUES (${invoiceId}, ${n.number}, ${n.year}, ${n.seq}, 'action', ${c.actionId}, ${c.recipientName.slice(0, 150)},
					${c.recipientEmail}, ${todayIso}, ${c.dueOn}, ${ctx?.userId ?? null})`
			);
			await tx.execute(
				sql`INSERT INTO invoice_lines (id, invoice_id, position, description, amount_cents, member_id,
					participant_id, action_id, source_ref)
				VALUES (${crypto.randomUUID()}, ${invoiceId}, 0, ${c.description}, ${c.amountCents}, ${c.memberId},
					${c.participantId}, ${c.actionId}, ${c.sourceRef})`
			);
		}
		for (const u of plan.update) {
			await tx.execute(
				sql`UPDATE invoice_lines SET amount_cents = ${u.amountCents}, waived_cents = ${u.waivedCents},
					description = ${u.description}, member_id = ${u.memberId}
				WHERE id = ${u.lineId}`
			);
			await tx.execute(sql`UPDATE invoices SET updated_at = now() WHERE id = ${u.invoiceId}`);
		}
		for (const r of plan.reactivate) {
			await tx.execute(
				sql`UPDATE invoices SET cancelled_at = NULL, cancel_reason = NULL, auto_cancelled = false,
					updated_at = now() WHERE id = ${r.invoiceId}`
			);
		}
		for (const c of plan.cancel) {
			await tx.execute(
				sql`UPDATE invoices SET cancelled_at = now(), cancel_reason = ${AUTO_CANCEL_REASON},
					auto_cancelled = true, updated_at = now() WHERE id = ${c.invoiceId} AND cancelled_at IS NULL`
			);
		}
		if (!actionId) await tx.execute(sql`UPDATE sync_state SET last_sync_at = now() WHERE id = 1`);
		return {
			created: plan.create.length,
			updated: plan.update.length,
			cancelled: plan.cancel.length,
			reactivated: plan.reactivate.length
		};
	});

	// Auszahlungen (Auslagen, Rückzahlungen, Guthaben) nachziehen – gezielt nur für die Aktion
	let createdPayables: CreatedPayableInfo[] = [];
	try {
		const payables = await syncPayables(members, actionId ? { actionIds: [actionId] } : undefined);
		createdPayables = payables.createdItems;
	} catch (e) {
		console.error('[treasury] Abgleich der Auszahlungen fehlgeschlagen:', e);
	}
	return { result, createdPayables };
}

/** Benachrichtigung, Versand geänderter Rechnungen und Audit – NACH der Schreibphase, außerhalb der Warteschlange */
async function finish(
	ctx: RequestContext | null,
	actionId: string | null,
	db: { result: SyncResult; createdPayables: CreatedPayableInfo[] }
): Promise<SyncResult> {
	const actor = ctx ?? systemCtx();
	// Amt „Kasse“: je neu angelegter Auszahlung ein Ereignis (Fehler werden in `notifyKasse` geloggt)
	await notifyKasse(ctx, db.createdPayables.map(payableNotification));
	// Bereits versendete Rechnungen mit Änderungen (Betrag, Rolle, Storno …) neu verschicken –
	// nur Rechnungen, die seit ihrer letzten Fassung geändert wurden
	let documents: SendResult | null = null;
	try {
		documents = await refreshSentDocuments(actor, {
			changedSince: 'latest-document',
			...(actionId ? { actionId } : {})
		});
	} catch (e) {
		console.error('[treasury] Versand geänderter Rechnungen fehlgeschlagen:', e);
	}
	const r = db.result;
	if (r.created || r.updated || r.cancelled || r.reactivated) {
		await core.audit.logFromContext(actor, 'treasury.sync.completed', {
			...(actionId ? { target: actionId } : {}),
			metadata: { ...r, scope: actionId ? 'action' : 'all' }
		});
	}
	return {
		...r,
		...(documents
			? {
					documents: {
						invoices: documents.invoices,
						mailsSent: documents.mailsSent,
						mailErrors: documents.mailErrors
					}
				}
			: {})
	};
}

// --- Warteschlange --------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();
/** Eingereihte, noch NICHT gestartete Läufe je Schlüssel (werden zusammengelegt) */
const queued = new Map<
	string,
	Promise<{ result: SyncResult; createdPayables: CreatedPayableInfo[] }>
>();

function enqueue(
	key: string,
	run: () => Promise<{ result: SyncResult; createdPayables: CreatedPayableInfo[] }>
) {
	const pending = queued.get(key);
	if (pending) return pending;
	const p = chain.then(() => {
		// Ab jetzt liest der Lauf frische Daten – spätere Aufrufer reihen einen neuen Lauf ein
		queued.delete(key);
		return run();
	});
	queued.set(key, p);
	chain = p.catch(() => undefined);
	return p;
}

const actorKey = (ctx: RequestContext | null) => ctx?.userId ?? ctx?.actor.id ?? 'system';

/**
 * Vollabgleich aller Aktionen inkl. Auszahlungen und Versand geänderter Rechnungen (Job, „Jetzt
 * abgleichen“). `ctx = null` → Systemkontext. Nie in einem Lesepfad aufrufen.
 */
export async function syncAll(ctx: RequestContext | null): Promise<SyncResult> {
	const db = await enqueue(`all:${actorKey(ctx)}`, () => syncDatabase(ctx, null));
	return finish(ctx, null, db);
}

/**
 * Gezielter Abgleich EINER Aktion (Rechnungen der Teilnehmenden, Auszahlungen der Aktion, Versand
 * geänderter Rechnungen dieser Aktion). Für Aufrufe nach Schreibvorgängen in `actions`; der Lauf
 * startet nach allen bereits laufenden und sieht daher den Commit des Aufrufers.
 */
export async function syncAction(
	ctx: RequestContext | null,
	actionId: string
): Promise<SyncResult> {
	const db = await enqueue(`action:${actionId}:${actorKey(ctx)}`, () =>
		syncDatabase(ctx, actionId)
	);
	return finish(ctx, actionId, db);
}

/** Nur für Tests: wartet, bis alle eingereihten Abgleiche (Schreibphase) fertig sind */
export function syncIdleForTests(): Promise<unknown> {
	return chain;
}
