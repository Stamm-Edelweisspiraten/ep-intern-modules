/**
 * Endpunkte „Rückzahlung spenden“ (siehe `refund-donation.ts`): Spende je Person intern setzen, Link je Person
 * (Token nur als Hash + Chiffrat), Briefe mit QR-Code als PDF und die öffentliche Wahl-Seite.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { formatEuro } from '$lib/components/layout/money';
import { formatDateDe, todayBerlin } from '$lib/sdk/dates';
import {
	type ApiEndpoint,
	core,
	errors,
	moduleDb,
	type PdfGenerateInput,
	rowsOf,
	str,
	type Tx
} from '$lib/sdk/server';
import type { MemberContact, MembersService } from '$lib/modules/members/contract';
import { requireAccess } from './access';
import { assertOpen, closedInfo } from './accounting-core';
import { hashLinkToken, linkTokenValues, storedToken } from './link-tokens';
import { choiceOf, donationForChoice } from './refund';
import {
	applyDonation,
	lockRefundItem,
	TREASURY_PAID_TEXT,
	treasuryPaidByItem
} from './refund-donation';
import { notifyTreasury } from './treasury-sync';
import {
	idParams,
	MODULE_ID,
	type PublicRefundChoice,
	type PublicRefundChoiceInput,
	publicRefundChoiceInput,
	publicTokenParams,
	REFUND_PUBLIC_PREFIX,
	type RefundDeadlineInput,
	refundDeadlineInput,
	refundDonationInput,
	refundItemParams,
	refundLettersInput
} from './schemas';

const TAGS = ['Modul: actions'];
const NOT_AVAILABLE = 'Dieser Link ist nicht mehr gültig.';
const NOT_BOOKED = 'Es ist keine Rückzahlung gebucht.';
const ITEM_UNKNOWN = 'Person nicht in der Rückzahlung gefunden.';

const newToken = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
const refundUrl = (token: string) => `${core.app.origin()}${REFUND_PUBLIC_PREFIX}/${token}`;

const linkBody = z.object({ rotate: z.boolean().optional() }).strict().optional();

async function assertBooked(tx: Tx, actionId: string): Promise<void> {
	const [b] = await rowsOf(
		tx,
		sql`SELECT 1 AS x FROM action_refund_booking WHERE action_id = ${actionId}`
	);
	if (!b) throw errors.notFound(NOT_BOOKED);
}

/** Tokens für die Posten sicherstellen (fehlende anlegen, `rotate` = neu) → Posten-ID → Klartext */
async function ensureTokens(
	tx: Tx,
	actionId: string,
	itemIds: string[],
	rotate = false
): Promise<Map<string, string>> {
	const rows = await rowsOf(
		tx,
		sql`SELECT id, token_enc FROM accounting_refunds
			WHERE action_id = ${actionId} AND id IN (${sql.join(
				itemIds.map((i) => sql`${i}`),
				sql`, `
			)}) FOR UPDATE`
	);
	if (rows.length !== new Set(itemIds).size) throw errors.notFound(ITEM_UNKNOWN);
	const out = new Map<string, string>();
	for (const r of rows) {
		const id = String(r.id);
		let token = rotate ? null : storedToken(r);
		if (!token) {
			token = newToken();
			const { hash, enc } = linkTokenValues(token);
			await tx.execute(
				sql`UPDATE accounting_refunds SET token_hash = ${hash}, token_enc = ${enc} WHERE id = ${id}`
			);
		}
		out.set(id, token);
	}
	return out;
}

interface PublicItem {
	itemId: string;
	actionId: string;
	actionName: string;
	startsOn: string;
	endsOn: string | null;
	name: string;
	amountCents: number;
	donatedCents: number;
	decided: boolean;
	deadline: string | null;
}

/** Posten zum öffentlichen Token; `null` = unbekannt oder Abrechnung abgeschlossen */
async function loadByToken(tx: Tx, token: string, lock = false): Promise<PublicItem | null> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT r.id, r.action_id, r.name, r.amount_cents, r.donated_cents, r.decided_at,
				a.name AS action_name, to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on,
				to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on,
				to_char(b.choice_deadline, 'YYYY-MM-DD') AS choice_deadline
			FROM accounting_refunds r JOIN actions a ON a.id = r.action_id
				JOIN action_refund_booking b ON b.action_id = r.action_id
			WHERE r.token_hash = ${hashLinkToken(token)} ${lock ? sql`FOR UPDATE OF r` : sql``}`
	);
	if (!r) return null;
	const actionId = String(r.action_id);
	if (await closedInfo(tx, actionId)) return null;
	return {
		itemId: String(r.id),
		actionId,
		actionName: String(r.action_name),
		startsOn: String(r.starts_on),
		endsOn: str(r.ends_on),
		name: String(r.name),
		amountCents: Number(r.amount_cents),
		donatedCents: Number(r.donated_cents ?? 0),
		decided: r.decided_at != null,
		deadline: str(r.choice_deadline)
	};
}

/** Frist abgelaufen (die Kasse zahlt aus, die Wahl über den Link ist zu) */
const deadlinePassed = (deadline: string | null): boolean =>
	deadline != null && deadline < todayBerlin();

const DEADLINE_PASSED_TEXT =
	'Die Frist für die Rückmeldung ist abgelaufen – die Rückzahlung wird ausgezahlt bzw. wie gewählt behandelt.';

function publicView(item: PublicItem, paid: boolean): PublicRefundChoice {
	const lockedReason = paid ? 'paid' : deadlinePassed(item.deadline) ? 'deadline' : null;
	return {
		actionName: item.actionName,
		startsOn: item.startsOn,
		endsOn: item.endsOn,
		name: item.name,
		amountCents: item.amountCents,
		donatedCents: item.donatedCents,
		choice: choiceOf(item),
		decided: item.decided,
		locked: lockedReason != null,
		lockedReason,
		deadline: item.deadline
	};
}

// --- Briefe ---------------------------------------------------------------------

interface LetterRow {
	itemId: string;
	name: string;
	amountCents: number;
	memberId: string | null;
}

function addressLines(name: string, contact: MemberContact | undefined): string[] {
	if (!contact) return [name];
	const lines = [name];
	if (contact.street) lines.push(contact.street);
	const place = [contact.postalCode, contact.city].filter(Boolean).join(' ');
	if (place) lines.push(place);
	return lines;
}

function dateRange(startsOn: string, endsOn: string | null): string {
	return endsOn && endsOn !== startsOn
		? `${formatDateDe(startsOn)} – ${formatDateDe(endsOn)}`
		: formatDateDe(startsOn);
}

async function letterInput(
	action: { name: string; startsOn: string; endsOn: string | null; deadline: string | null },
	row: LetterRow,
	token: string,
	contact: MemberContact | undefined,
	note: string | null = null
): Promise<PdfGenerateInput> {
	const url = refundUrl(token);
	const amount = formatEuro(row.amountCents);
	return {
		template: 'stamm-brief',
		title: `Rückzahlung – ${action.name}`,
		recipient: addressLines(row.name, contact),
		content: [
			{ type: 'paragraph', text: 'Guten Tag,' },
			{
				type: 'paragraph',
				text: `die Aktion „${action.name}“ (${dateRange(action.startsOn, action.endsOn)}) ist abgerechnet und hat einen Überschuss ergeben. Für ${row.name} stehen ${amount} zur Rückzahlung bereit.`
			},
			...(note ? [{ type: 'paragraph' as const, text: note }] : []),
			{
				type: 'paragraph',
				text: action.deadline
					? `Sie können den Betrag ganz oder teilweise dem Stamm spenden – damit unterstützen Sie Material, Fahrten und Zuschüsse für Familien. Bitte geben Sie uns bis zum ${formatDateDe(action.deadline)} Bescheid; ohne Rückmeldung zahlen wir den Betrag danach aus.`
					: 'Sie können den Betrag ganz oder teilweise dem Stamm spenden – damit unterstützen Sie Material, Fahrten und Zuschüsse für Familien. Ohne Rückmeldung zahlen wir den Betrag aus.'
			},
			{
				type: 'box',
				image: {
					dataUrl: await core.qr.dataUrl(url, { widthPx: 500 }),
					widthMm: 36,
					alt: 'QR-Code zur Auswahl Spende oder Auszahlung'
				},
				label: 'Ihre Rückzahlung',
				value: amount,
				lines: action.deadline
					? ['Spenden oder auszahlen lassen', `Rückmeldung bis ${formatDateDe(action.deadline)}`]
					: ['Spenden oder auszahlen lassen'],
				linkLabel: 'Ohne Kamera: diese Adresse im Browser öffnen',
				link: { href: url, text: url.replace(/^https?:\/\//, '') }
			},
			{ type: 'heading', level: 3, text: 'So geht’s' },
			{
				type: 'list',
				ordered: true,
				items: [
					'QR-Code mit der Handykamera scannen oder die Adresse im Browser öffnen.',
					'Auswählen: alles auszahlen, alles spenden oder einen Teil spenden.',
					action.deadline
						? `Fertig – die Wahl lässt sich bis zum ${formatDateDe(action.deadline)} ändern.`
						: 'Fertig – die Wahl lässt sich ändern, solange noch nicht überwiesen wurde.'
				]
			},
			{
				type: 'paragraph',
				text: 'Die Auszahlung erfolgt in der Regel auf das Konto, von dem der Beitrag überwiesen wurde.'
			},
			{ type: 'paragraph', text: 'Viele Grüße und Gut Pfad!' }
		]
	};
}

export const refundDonationEndpoints: ApiEndpoint[] = [
	{
		method: 'PUT',
		path: '/actions/:id/accounting/refund/deadline',
		summary:
			'Frist für die Rückmeldung setzen (bis dahin Link offen, Kasse zahlt erst danach aus) oder entfernen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: refundDeadlineInput,
		handler: async ({ ctx, params, body }) => {
			const id = (params as { id: string }).id;
			const { deadline } = body as RefundDeadlineInput;
			if (deadline != null && deadline < todayBerlin()) {
				throw errors.validation([
					{ path: ['deadline'], message: 'Die Frist darf nicht in der Vergangenheit liegen.' }
				]);
			}
			await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				await assertBooked(tx, id);
				await tx.execute(
					sql`UPDATE action_refund_booking SET choice_deadline = ${deadline}
						WHERE action_id = ${id}`
				);
			});
			await core.audit.logFromContext(ctx, 'actions.accounting.refund-deadline-set', {
				target: id,
				metadata: { actionId: id, deadline }
			});
			return { deadline };
		}
	} as ApiEndpoint,
	{
		method: 'PUT',
		path: '/actions/:id/accounting/refund/items/:itemId/donation',
		summary: 'Spende einer Person an den Stamm festlegen (0 = alles auszahlen)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: refundItemParams,
		body: refundDonationInput,
		handler: async ({ ctx, params, body }) => {
			const { id, itemId } = params as { id: string; itemId: string };
			const { donatedCents } = body as { donatedCents: number };
			await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
			});
			const paid = (await treasuryPaidByItem(id, [itemId])).get(itemId) ?? 0;
			const result = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				await assertBooked(tx, id);
				const item = await lockRefundItem(tx, id, itemId);
				if (!item) throw errors.notFound(ITEM_UNKNOWN);
				return applyDonation(tx, item, {
					donatedCents,
					via: 'internal',
					by: ctx.userId ?? null,
					paidCents: paid
				});
			});
			await core.audit.logFromContext(ctx, 'actions.accounting.refund-donation-set', {
				target: id,
				metadata: { actionId: id, itemId, donatedCents, via: 'internal', changed: result.changed }
			});
			return { itemId, donatedCents };
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/accounting/refund/items/:itemId/link',
		summary: 'Link zur Wahl Spende/Auszahlung einer Person abrufen bzw. erneuern',
		tags: TAGS,
		permission: 'actions.action.view',
		params: refundItemParams,
		body: linkBody,
		handler: async ({ ctx, params, body }) => {
			const { id, itemId } = params as { id: string; itemId: string };
			const rotate = (body as { rotate?: boolean } | undefined)?.rotate === true;
			const token = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				await assertBooked(tx, id);
				return (await ensureTokens(tx, id, [itemId], rotate)).get(itemId)!;
			});
			if (rotate) {
				await core.audit.logFromContext(ctx, 'actions.accounting.refund-link-rotated', {
					target: id,
					metadata: { actionId: id, itemId }
				});
			}
			return { url: refundUrl(token) };
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/accounting/refund/letters.pdf',
		summary: 'Briefe mit QR-Code (Spende oder Auszahlung) als ein PDF',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: refundLettersInput,
		handler: async ({ ctx, params, body }) => {
			const id = (params as { id: string }).id;
			const wanted = (body as { itemIds?: string[] } | undefined)?.itemIds;
			const note = (body as { note?: string } | undefined)?.note?.trim() || null;
			const data = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				await assertBooked(tx, id);
				const [a] = await rowsOf(
					tx,
					sql`SELECT a.name, to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on,
							to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on,
							to_char(b.choice_deadline, 'YYYY-MM-DD') AS choice_deadline
						FROM actions a JOIN action_refund_booking b ON b.action_id = a.id
						WHERE a.id = ${id}`
				);
				const all = await rowsOf(
					tx,
					sql`SELECT r.id, r.name, r.amount_cents, p.member_id
						FROM accounting_refunds r LEFT JOIN action_participants p ON p.id = r.participant_id
						WHERE r.action_id = ${id} ORDER BY r.position, r.name, r.id`
				);
				const rows: LetterRow[] = all.map((r) => ({
					itemId: String(r.id),
					name: String(r.name),
					amountCents: Number(r.amount_cents),
					memberId: str(r.member_id)
				}));
				const selected = wanted
					? wanted.map((w) => {
							const row = rows.find((r) => r.itemId === w);
							if (!row) throw errors.notFound(ITEM_UNKNOWN);
							return row;
						})
					: rows;
				if (!selected.length) throw errors.conflict('Es gibt keine Personen in der Rückzahlung.');
				const tokens = await ensureTokens(
					tx,
					id,
					selected.map((r) => r.itemId)
				);
				return {
					action: {
						name: String(a!.name),
						startsOn: String(a!.starts_on),
						endsOn: str(a!.ends_on),
						deadline: str(a!.choice_deadline)
					},
					selected,
					tokens
				};
			});
			const memberIds = [
				...new Set(data.selected.map((r) => r.memberId).filter((m): m is string => !!m))
			];
			const contacts = new Map<string, MemberContact>();
			if (memberIds.length) {
				const members = await core.modules.use<MembersService>('members', MODULE_ID);
				for (const c of await members.listMemberContacts({ ids: memberIds })) contacts.set(c.id, c);
			}
			const inputs: PdfGenerateInput[] = [];
			for (const row of data.selected) {
				inputs.push(
					await letterInput(
						data.action,
						row,
						data.tokens.get(row.itemId)!,
						row.memberId ? contacts.get(row.memberId) : undefined,
						note
					)
				);
			}
			const title = `Rückzahlung – ${data.action.name}`;
			const pdf =
				inputs.length === 1
					? await core.pdf.generate(ctx, { ...inputs[0]!, title })
					: await core.pdf.generateMany(ctx, inputs, title);
			await core.audit.logFromContext(ctx, 'actions.accounting.refund-letters-generated', {
				target: id,
				metadata: { actionId: id, count: inputs.length }
			});
			return new Response(Buffer.from(pdf.buffer), {
				status: 200,
				headers: {
					'content-type': 'application/pdf',
					'content-disposition': `inline; filename="${pdf.fileName}"`,
					'cache-control': 'private, no-store'
				}
			});
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/public/refund-choices/:token',
		summary: 'Öffentliche Wahl Spende/Auszahlung lesen',
		tags: TAGS,
		permission: null,
		public: true,
		rateLimit: { limit: 60, windowSec: 60 },
		params: publicTokenParams,
		handler: async ({ params }) => {
			const { token } = params as { token: string };
			const item = await moduleDb(MODULE_ID).transaction((tx) => loadByToken(tx, token));
			if (!item) throw errors.notFound(NOT_AVAILABLE);
			const paid = (await treasuryPaidByItem(item.actionId, [item.itemId])).get(item.itemId) ?? 0;
			return publicView(item, paid > 0);
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/public/refund-choices/:token',
		summary: 'Öffentlich wählen: Rückzahlung auszahlen, ganz oder teilweise spenden',
		tags: TAGS,
		permission: null,
		public: true,
		rateLimit: { limit: 10, windowSec: 600 },
		params: publicTokenParams,
		body: publicRefundChoiceInput,
		handler: async ({ ctx, params, body }) => {
			const { token } = params as { token: string };
			const input = body as PublicRefundChoiceInput;
			const found = await moduleDb(MODULE_ID).transaction((tx) => loadByToken(tx, token));
			if (!found) throw errors.notFound(NOT_AVAILABLE);
			const paid =
				(await treasuryPaidByItem(found.actionId, [found.itemId])).get(found.itemId) ?? 0;
			// Honeypot: wie Erfolg antworten, nichts speichern
			if (input.website) return publicView(found, paid > 0);
			if (paid > 0) throw errors.conflict(TREASURY_PAID_TEXT);
			if (deadlinePassed(found.deadline)) throw errors.conflict(DEADLINE_PASSED_TEXT);
			if (input.choice === 'partial' && input.donatedCents == null) {
				throw errors.validation([
					{ path: ['donatedCents'], message: 'Bitte den Spendenbetrag angeben.' }
				]);
			}
			const donatedCents = donationForChoice(found.amountCents, input.choice, input.donatedCents);
			const updated = await moduleDb(MODULE_ID).transaction(async (tx) => {
				const item = await loadByToken(tx, token, true);
				if (!item) throw errors.notFound(NOT_AVAILABLE);
				if (deadlinePassed(item.deadline)) throw errors.conflict(DEADLINE_PASSED_TEXT);
				const row = await lockRefundItem(tx, item.actionId, item.itemId);
				if (!row) throw errors.notFound(NOT_AVAILABLE);
				await applyDonation(tx, row, {
					donatedCents,
					via: 'link',
					by: null,
					note: input.note ?? null,
					paidCents: paid
				});
				return (await loadByToken(tx, token))!;
			});
			await core.audit.log({
				action: 'actions.accounting.refund-donation-set',
				actor: { type: 'system', id: 'public-refund', name: 'Rückzahlungs-Link' },
				target: updated.actionId,
				ip: ctx.ip,
				requestId: ctx.requestId,
				metadata: {
					actionId: updated.actionId,
					itemId: updated.itemId,
					donatedCents,
					via: 'link'
				}
			});
			await notifyTreasury(null, updated.actionId);
			return publicView(updated, false);
		}
	} as ApiEndpoint
];
