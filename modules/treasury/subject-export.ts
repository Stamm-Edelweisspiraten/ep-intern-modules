/**
 * Datenauskunft (Art. 15/20 DSGVO, Core `/admin/privacy`): Daten einer Person in der Kasse – über die
 * Mitglieder der Person (bei einem Konto: die verknüpften Mitglieder, ergänzt vom Modul `members`).
 * - Rechnungen mit Posten der Person; bei Sammelrechnungen (Geschwister, Jahresbeitrag) NUR die
 *   eigenen Posten bzw. die eigene Jahresbeitrags-Aufschlüsselung, Summen nur über diese Posten.
 * - Zahlungen/Zuordnungen auf diese Posten, Guthaben, Erinnerungen, Versandstand der Fassungen (PDFs
 *   nur als Liste, keine Inhalte).
 * - Zahler/Familien, denen ein Mitglied der Person angehört (andere Mitglieder nur als Anzahl).
 * - Auszahlungen an die Person bzw. ihren Zahler (Rückzahlungen, Guthaben).
 * IBAN nur maskiert (`•••• 1234`), nie Hash oder verschlüsselter Wert. Eigene Modul-Transaktion,
 * keine Core-Services darin. Benachrichtigungs-Einstellungen führt die Kasse nicht (siehe `members`).
 */
import { sql } from 'drizzle-orm';
import type { DataSubject, ModuleSubjectExport } from '$lib/sdk/server';
import { idList, iso, isoOrNull, mdb, num, rows, str } from './db';
import { maskIban } from './iban';
import { groupBy } from './logic';

async function run({ memberIds }: DataSubject): Promise<Record<string, unknown> | null> {
	if (!memberIds.length) return null;
	const ids = idList(memberIds);
	const data = await mdb().transaction(async (tx) => {
		const lines = await rows(
			tx,
			sql`SELECT l.id, l.invoice_id, l.member_id, l.description, l.amount_cents, l.waived_cents, l.waive_reason,
				l.action_id, l.fee_level,
				coalesce((SELECT sum(a.amount_cents) FROM allocations a WHERE a.line_id = l.id), 0) AS paid_cents
			FROM invoice_lines l WHERE l.member_id IN (${ids}) ORDER BY l.invoice_id, l.position, l.id`
		);
		const annualItems = await rows(
			tx,
			sql`SELECT invoice_id, member_id, year, level, amount_cents FROM annual_fee_items
			WHERE member_id IN (${ids}) ORDER BY year, position, id`
		);
		const invoiceIds = [...new Set([...lines, ...annualItems].map((r) => String(r.invoice_id)))];
		const invIds = invoiceIds.length ? idList(invoiceIds) : null;
		const invoices = invIds
			? await rows(
					tx,
					sql`SELECT id, number, source, recipient_name, recipient_email, note,
						to_char(issued_on, 'YYYY-MM-DD') AS issued_on, to_char(due_on, 'YYYY-MM-DD') AS due_on,
						cancelled_at, cancel_reason, paid_notified_at, reminders_paused, created_at
					FROM invoices WHERE id IN (${invIds}) ORDER BY issued_on, number`
				)
			: [];
		const lineIds = lines.map((l) => String(l.id));
		const payments = lineIds.length
			? await rows(
					tx,
					sql`SELECT a.line_id, a.amount_cents, to_char(t.booked_on, 'YYYY-MM-DD') AS booked_on,
						ac.name AS account_name
					FROM allocations a JOIN transactions t ON t.id = a.transaction_id
					JOIN accounts ac ON ac.id = t.account_id
					WHERE a.line_id IN (${idList(lineIds)}) ORDER BY t.booked_on, a.id`
				)
			: [];
		const reminders = invIds
			? await rows(
					tx,
					sql`SELECT invoice_id, level, to_char(sent_on, 'YYYY-MM-DD') AS sent_on, manual, status, recipients
					FROM reminders WHERE invoice_id IN (${invIds}) ORDER BY sent_on, level`
				)
			: [];
		const documents = invIds
			? await rows(
					tx,
					sql`SELECT invoice_id, version, reason, created_at, sent_at, recipients
					FROM invoice_documents WHERE invoice_id IN (${invIds}) ORDER BY invoice_id, version`
				)
			: [];
		const payers = await rows(
			tx,
			sql`SELECT p.id, p.name, p.email, p.note, p.account_holder, p.iban_last4, p.bic, p.created_at,
				(SELECT count(*) FROM payer_members x WHERE x.payer_id = p.id) AS member_count
			FROM payers p WHERE EXISTS (SELECT 1 FROM payer_members pm WHERE pm.payer_id = p.id AND pm.member_id IN (${ids}))
			ORDER BY p.name, p.id`
		);
		const payerIds = payers.map((p) => String(p.id));
		const payables = await rows(
			tx,
			sql`SELECT p.id, p.source, p.description, p.recipient_name, p.amount_cents, p.iban_last4,
				to_char(p.due_on, 'YYYY-MM-DD') AS due_on, p.cancelled_at, p.created_at,
				coalesce((SELECT sum(pp.amount_cents) FROM payable_payments pp WHERE pp.payable_id = p.id), 0) AS paid_cents
			FROM payables p
			WHERE p.member_id IN (${ids}) ${payerIds.length ? sql`OR p.payer_id IN (${idList(payerIds)})` : sql``}
			ORDER BY p.created_at, p.id`
		);
		return { lines, annualItems, invoices, payments, reminders, documents, payers, payables };
	});
	if (!data.invoices.length && !data.payers.length && !data.payables.length) return null;

	const linesBy = groupBy(data.lines, (l) => String(l.invoice_id));
	const itemsBy = groupBy(data.annualItems, (i) => String(i.invoice_id));
	const paymentsBy = groupBy(data.payments, (p) => String(p.line_id));
	const remindersBy = groupBy(data.reminders, (r) => String(r.invoice_id));
	const docsBy = groupBy(data.documents, (d) => String(d.invoice_id));

	return {
		invoices: data.invoices.map((inv) => {
			const id = String(inv.id);
			const cancelled = inv.cancelled_at != null;
			const own = (linesBy.get(id) ?? []).map((l) => {
				const amount = num(l.amount_cents);
				const waived = num(l.waived_cents);
				const paid = num(l.paid_cents);
				const due = Math.max(0, amount - waived);
				return {
					memberId: String(l.member_id),
					description: String(l.description),
					amountCents: amount,
					waivedCents: waived,
					waiveReason: str(l.waive_reason),
					feeLevel: str(l.fee_level),
					paidCents: paid,
					openCents: cancelled ? 0 : Math.max(0, due - paid),
					creditCents: cancelled ? paid : Math.max(0, paid - due),
					payments: (paymentsBy.get(String(l.id)) ?? []).map((p) => ({
						bookedOn: String(p.booked_on),
						amountCents: num(p.amount_cents),
						account: String(p.account_name)
					}))
				};
			});
			return {
				number: String(inv.number),
				source: String(inv.source),
				recipientName: String(inv.recipient_name),
				recipientEmail: str(inv.recipient_email),
				note: str(inv.note),
				issuedOn: String(inv.issued_on),
				dueOn: String(inv.due_on),
				cancelledAt: isoOrNull(inv.cancelled_at),
				cancelReason: str(inv.cancel_reason),
				paymentConfirmedAt: isoOrNull(inv.paid_notified_at),
				remindersPaused: Boolean(inv.reminders_paused),
				createdAt: iso(inv.created_at),
				/** Nur die Posten der Person (bei Sammelrechnungen nicht die der Geschwister) */
				lines: own,
				annualFee: (itemsBy.get(id) ?? []).map((i) => ({
					memberId: String(i.member_id),
					year: num(i.year),
					level: String(i.level),
					amountCents: num(i.amount_cents)
				})),
				reminders: (remindersBy.get(id) ?? []).map((r) => ({
					level: num(r.level),
					sentOn: String(r.sent_on),
					manual: Boolean(r.manual),
					status: String(r.status),
					recipients: num(r.recipients)
				})),
				/** Versendete Fassungen (PDF nur als Eintrag, kein Inhalt) */
				documents: (docsBy.get(id) ?? []).map((d) => ({
					version: num(d.version),
					reason: String(d.reason),
					createdAt: iso(d.created_at),
					sentAt: isoOrNull(d.sent_at),
					recipients: num(d.recipients)
				}))
			};
		}),
		payers: data.payers.map((p) => ({
			name: String(p.name),
			email: str(p.email),
			note: str(p.note),
			accountHolder: str(p.account_holder),
			iban: maskIban(str(p.iban_last4)),
			bic: str(p.bic),
			/** Anzahl der Mitglieder dieses Zahlers (keine Daten der anderen) */
			memberCount: num(p.member_count),
			createdAt: iso(p.created_at)
		})),
		payouts: data.payables.map((p) => ({
			source: String(p.source),
			description: String(p.description),
			recipientName: String(p.recipient_name),
			amountCents: num(p.amount_cents),
			paidCents: num(p.paid_cents),
			iban: maskIban(str(p.iban_last4)),
			dueOn: str(p.due_on),
			cancelledAt: isoOrNull(p.cancelled_at),
			createdAt: iso(p.created_at)
		}))
	};
}

export const subjectExport: ModuleSubjectExport = { run };
