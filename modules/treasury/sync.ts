/**
 * Abgleich Aktionen → Rechnungen: Jede*r Teilnehmende einer Aktion mit übernommenem Beitrag
 * bekommt eine Rechnung mit einem Posten. Dienste von `actions`/`members` werden VOR der
 * Transaktion gelesen (PGlite), die Änderungen laufen in EINER Modul-Transaktion.
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
import { refreshSentDocuments } from './documents';
import { notifyKasse, payableNotification } from './office-notify';
import { syncPayables } from './payables';
import { planSync, type ExistingSyncLine } from './logic';
import { SETTING_KEYS } from './schemas';

export interface SyncResult {
	created: number;
	updated: number;
	cancelled: number;
	reactivated: number;
}

const AUTO_CANCEL_REASON = 'Teilnahme oder Beitrag entfallen';

async function runSync(ctx: RequestContext | null): Promise<SyncResult> {
	const sources = await (await actionsService()).listReceivableSources();
	const members = await (await membersService()).listMemberContacts({});
	const s = await core.settings.getMany([SETTING_KEYS.daysBeforeStart, SETTING_KEYS.minDays]);
	const todayIso = today();

	const result = await mdb().transaction(async (tx) => {
		const settings = await rows(
			tx,
			sql`SELECT action_id, excluded, to_char(due_on, 'YYYY-MM-DD') AS due_on FROM action_settings`
		);
		const existing = await rows(
			tx,
			sql`SELECT l.id AS line_id, l.invoice_id, l.source_ref, l.amount_cents, l.waived_cents, l.description,
				l.member_id, i.cancelled_at, i.auto_cancelled
			FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
			WHERE l.source_ref LIKE 'action:%'`
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
		await tx.execute(sql`UPDATE sync_state SET last_sync_at = now() WHERE id = 1`);
		return {
			created: plan.create.length,
			updated: plan.update.length,
			cancelled: plan.cancel.length,
			reactivated: plan.reactivate.length
		};
	});

	// Auszahlungen (Auslagen, Rückzahlungen, Guthaben) nachziehen
	try {
		const payables = await syncPayables(members);
		// Amt „Kasse“: je neu angelegter Auszahlung ein Ereignis (Fehler werden in `notifyKasse` geloggt)
		await notifyKasse(ctx, payables.createdItems.map(payableNotification));
	} catch (e) {
		console.error('[treasury] Abgleich der Auszahlungen fehlgeschlagen:', e);
	}
	// Bereits versendete Rechnungen mit Änderungen (Betrag, Rolle, Storno …) neu verschicken
	try {
		await refreshSentDocuments(ctx ?? core.auth.systemContext('treasury-sync'));
	} catch (e) {
		console.error('[treasury] Versand geänderter Rechnungen fehlgeschlagen:', e);
	}
	if (result.created || result.updated || result.cancelled || result.reactivated) {
		await core.audit.logFromContext(
			ctx ?? core.auth.systemContext('treasury-sync'),
			'treasury.sync.completed',
			{
				metadata: { ...result }
			}
		);
	}
	return result;
}

let inFlight: Promise<SyncResult> | null = null;
let lastRun = 0;
const STALE_MS = 60_000;

/** Abgleich ausführen (parallele Aufrufe teilen sich einen Lauf). */
export function syncActions(ctx: RequestContext | null): Promise<SyncResult> {
	inFlight ??= runSync(ctx).finally(() => {
		inFlight = null;
		lastRun = Date.now();
	});
	return inFlight;
}

/** Beim Öffnen von Kassenseiten: nur, wenn der letzte Lauf länger als eine Minute her ist. */
export async function syncIfStale(ctx: RequestContext): Promise<void> {
	if (Date.now() - lastRun < STALE_MS && !inFlight) return;
	try {
		await syncActions(ctx);
	} catch (e) {
		// Anzeige soll auch ohne erfolgreichen Abgleich funktionieren
		console.error('[treasury] Abgleich mit Aktionen fehlgeschlagen:', e);
	}
}

/** Nur für Tests: nächster `syncIfStale` läuft sofort */
export function resetSyncThrottleForTests(): void {
	lastRun = 0;
}
