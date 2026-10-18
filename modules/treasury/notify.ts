/**
 * Zahlungsbestaetigungen und Zahlungserinnerungen. Mails gehen gesammelt je Empfaengeradresse
 * (Geschwister bekommen EINE Mail). Versand immer NACH der Modul-Transaktion.
 */
import { sql } from 'drizzle-orm';
import { core, type RequestContext } from '$lib/sdk/server';
import {
	collectIds,
	idList,
	invoiceAddresses,
	loadPayerNames,
	loadRawInvoices,
	mdb,
	resolveNames,
	today,
	type NameMaps,
	type RawInvoice
} from './db';
import {
	groupByAddress,
	invoiceTotals,
	lineOpen,
	reminderLevelDue,
	type BankData,
	type MailInvoice
} from './logic';
import { composeMail } from './mail-compose';
import {
	DEFAULT_PAID_BODY,
	DEFAULT_PAID_SUBJECT,
	DEFAULT_REMINDER_BODY,
	DEFAULT_REMINDER_SUBJECT,
	SETTING_KEYS
} from './schemas';

const num = (v: unknown) => Number(v ?? 0);

/** Bankdaten fuer Rechnungen und Mails – ausschliesslich aus den Kassen-Einstellungen */
export async function loadBankData(): Promise<BankData> {
	const s = await core.settings.getMany([
		SETTING_KEYS.bankHolder,
		SETTING_KEYS.bankIban,
		SETTING_KEYS.bankBic,
		SETTING_KEYS.bankName
	]);
	const v = (k: string) => String(s[k] ?? '').trim();
	return {
		holder: v(SETTING_KEYS.bankHolder),
		iban: v(SETTING_KEYS.bankIban),
		bic: v(SETTING_KEYS.bankBic),
		name: v(SETTING_KEYS.bankName)
	};
}

async function loadWithNames(where: ReturnType<typeof sql>) {
	const { invoices, payers } = await mdb().transaction(async (tx) => ({
		invoices: await loadRawInvoices(tx, where),
		payers: await loadPayerNames(tx)
	}));
	const names = await resolveNames({ ...collectIds(invoices), payers });
	return { invoices, names };
}

function mailInvoice(inv: RawInvoice, mode: 'paid' | 'open'): MailInvoice {
	return {
		number: String(inv.row.number),
		recipientName: String(inv.row.recipient_name),
		dueOn: String(inv.row.due_on),
		lines: inv.lines
			.map((l) => {
				const amounts = {
					amountCents: num(l.amount_cents),
					waivedCents: num(l.waived_cents),
					paidCents: num(l.paid_cents)
				};
				return {
					description: String(l.description),
					cents: mode === 'paid' ? amounts.paidCents : lineOpen(amounts)
				};
			})
			.filter((l) => l.cents > 0)
	};
}

interface SendStats {
	sent: number;
	failed: number;
	/** Rechnungen, fuer die mindestens eine Mail rausging bzw. fuer die keine Adresse existiert */
	delivered: Set<string>;
	recipientsByInvoice: Map<string, number>;
}

async function sendGrouped(
	items: { inv: RawInvoice; addresses: string[] }[],
	build: (invoices: RawInvoice[]) => { subject: string; text: string; html?: string }
): Promise<SendStats> {
	const stats: SendStats = {
		sent: 0,
		failed: 0,
		delivered: new Set(),
		recipientsByInvoice: new Map()
	};
	for (const [address, group] of groupByAddress(items)) {
		const mail = build(group.map((g) => g.inv));
		try {
			await core.mail.send({ to: address, ...mail });
			stats.sent++;
			for (const g of group) {
				const id = String(g.inv.row.id);
				stats.delivered.add(id);
				stats.recipientsByInvoice.set(id, (stats.recipientsByInvoice.get(id) ?? 0) + 1);
			}
		} catch (e) {
			stats.failed++;
			console.warn('[treasury] Mailversand fehlgeschlagen:', e instanceof Error ? e.message : e);
		}
	}
	return stats;
}

const addressesOf = (inv: RawInvoice, names: NameMaps, category?: string) =>
	invoiceAddresses(inv, names, category);

/**
 * Bestaetigung fuer vollstaendig bezahlte Rechnungen (einmalig, `paid_notified_at`). Mit
 * `notify=false` oder ausgeschalteter Einstellung werden sie nur als „erledigt“ markiert.
 */
export async function notifyPaid(
	invoiceIds: string[],
	notify: boolean
): Promise<{ paidInvoices: number; mailsSent: number; mailErrors: number }> {
	if (!invoiceIds.length) return { paidInvoices: 0, mailsSent: 0, mailErrors: 0 };
	const { invoices, names } = await loadWithNames(
		sql`i.id IN (${idList(invoiceIds)}) AND i.cancelled_at IS NULL AND i.paid_notified_at IS NULL`
	);
	const paid = invoices.filter((inv) => {
		const t = invoiceTotals(
			inv.lines.map((l) => ({
				amountCents: num(l.amount_cents),
				waivedCents: num(l.waived_cents),
				paidCents: num(l.paid_cents)
			})),
			false
		);
		return t.status === 'paid' && t.paidCents > 0;
	});
	if (!paid.length) return { paidInvoices: 0, mailsSent: 0, mailErrors: 0 };

	const s = await core.settings.getMany([
		SETTING_KEYS.paidMailEnabled,
		SETTING_KEYS.paidSubject,
		SETTING_KEYS.paidBody
	]);
	let stats: SendStats | null = null;
	// Nur die Zahlungsbestaetigung ist abschaltbar (Abwahl je Mitglied); ohne Adresse gilt sie als erledigt
	const items = paid.map((inv) => ({
		inv,
		addresses: addressesOf(inv, names, 'payment-confirmation')
	}));
	if (notify && s[SETTING_KEYS.paidMailEnabled] !== false) {
		const bank = await loadBankData();
		stats = await sendGrouped(items, (group) =>
			composeMail({
				subjectTpl: String(s[SETTING_KEYS.paidSubject] || DEFAULT_PAID_SUBJECT),
				bodyTpl: String(s[SETTING_KEYS.paidBody] || DEFAULT_PAID_BODY),
				invoices: group.map((g) => mailInvoice(g, 'paid')),
				bank,
				mode: 'paid'
			})
		);
	}
	// Erledigt: Mail raus, keine Adresse vorhanden oder Versand bewusst abgeschaltet
	const done = items
		.filter(
			(it) => !stats || stats.delivered.has(String(it.inv.row.id)) || it.addresses.length === 0
		)
		.map((it) => String(it.inv.row.id));
	if (done.length) {
		await mdb().transaction((tx) =>
			tx.execute(
				sql`UPDATE invoices SET paid_notified_at = now() WHERE id IN (${idList(done)}) AND paid_notified_at IS NULL`
			)
		);
	}
	return { paidInvoices: paid.length, mailsSent: stats?.sent ?? 0, mailErrors: stats?.failed ?? 0 };
}

export interface ReminderRun {
	invoices: number;
	mailsSent: number;
	mailErrors: number;
	withoutAddress: number;
}

async function sendReminderMails(
	ctx: RequestContext,
	due: { inv: RawInvoice; level: number }[],
	names: NameMaps,
	manual: boolean
): Promise<ReminderRun> {
	if (!due.length) return { invoices: 0, mailsSent: 0, mailErrors: 0, withoutAddress: 0 };
	const s = await core.settings.getMany([SETTING_KEYS.reminderSubject, SETTING_KEYS.reminderBody]);
	const bank = await loadBankData();
	const levelOf = new Map(due.map((d) => [String(d.inv.row.id), d.level]));
	const items = due.map((d) => ({ inv: d.inv, addresses: addressesOf(d.inv, names) }));
	const stats = await sendGrouped(items, (group) => {
		const level = Math.max(...group.map((g) => levelOf.get(String(g.row.id)) ?? 1));
		return composeMail({
			subjectTpl: String(s[SETTING_KEYS.reminderSubject] || DEFAULT_REMINDER_SUBJECT),
			bodyTpl: String(s[SETTING_KEYS.reminderBody] || DEFAULT_REMINDER_BODY),
			invoices: group.map((g) => mailInvoice(g, 'open')),
			bank,
			mode: 'open',
			level
		});
	});
	const sent = due.filter((d) => stats.delivered.has(String(d.inv.row.id)));
	if (sent.length) {
		await mdb().transaction(async (tx) => {
			for (const d of sent) {
				const id = String(d.inv.row.id);
				await tx.execute(
					sql`INSERT INTO reminders (id, invoice_id, level, sent_on, recipients, manual, created_by)
					VALUES (${crypto.randomUUID()}, ${id}, ${d.level}, ${today()}, ${stats.recipientsByInvoice.get(id) ?? 0},
						${manual}, ${ctx.userId})`
				);
			}
		});
	}
	const result = {
		invoices: sent.length,
		mailsSent: stats.sent,
		mailErrors: stats.failed,
		withoutAddress: items.filter((i) => i.addresses.length === 0).length
	};
	if (sent.length || stats.failed) {
		await core.audit.logFromContext(ctx, 'treasury.reminder.sent', {
			metadata: { manual, ...result }
		});
	}
	return result;
}

/** Taeglicher Lauf: faellige Erinnerungsstufen fuer alle offenen Rechnungen. */
export async function runReminderJob(ctx: RequestContext): Promise<ReminderRun> {
	const s = await core.settings.getMany([
		SETTING_KEYS.remindersEnabled,
		SETTING_KEYS.firstDays,
		SETTING_KEYS.secondDays
	]);
	if (s[SETTING_KEYS.remindersEnabled] === false) {
		return { invoices: 0, mailsSent: 0, mailErrors: 0, withoutAddress: 0 };
	}
	const todayIso = today();
	const { invoices, names } = await loadWithNames(
		sql`i.cancelled_at IS NULL AND i.reminders_paused = false AND i.due_on < ${todayIso}`
	);
	const due = invoices.flatMap((inv) => {
		const open = inv.lines.reduce(
			(sum, l) =>
				sum +
				lineOpen({
					amountCents: num(l.amount_cents),
					waivedCents: num(l.waived_cents),
					paidCents: num(l.paid_cents)
				}),
			0
		);
		const level = reminderLevelDue({
			dueOn: String(inv.row.due_on),
			today: todayIso,
			openCents: open,
			cancelled: false,
			paused: false,
			sentLevel: inv.reminderLevel,
			lastReminderOn: inv.lastReminderOn,
			firstDays: Number(s[SETTING_KEYS.firstDays] ?? 7),
			secondDays: Number(s[SETTING_KEYS.secondDays] ?? 14)
		});
		return level ? [{ inv, level }] : [];
	});
	return sendReminderMails(ctx, due, names, false);
}

/** Manuell: Erinnerung fuer bestimmte offene Rechnungen (naechste Stufe, ohne Fristpruefung). */
export async function sendManualReminders(
	ctx: RequestContext,
	invoiceIds: string[]
): Promise<ReminderRun> {
	const { invoices, names } = await loadWithNames(
		sql`i.id IN (${idList(invoiceIds)}) AND i.cancelled_at IS NULL`
	);
	const due = invoices
		.filter((inv) =>
			inv.lines.some(
				(l) =>
					lineOpen({
						amountCents: num(l.amount_cents),
						waivedCents: num(l.waived_cents),
						paidCents: num(l.paid_cents)
					}) > 0
			)
		)
		.map((inv) => ({ inv, level: inv.reminderLevel + 1 }));
	return sendReminderMails(ctx, due, names, true);
}
