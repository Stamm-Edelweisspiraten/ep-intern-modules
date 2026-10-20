import { sql } from 'drizzle-orm';
import { core, errors, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import type { ParticipantPayment, TreasuryService } from '$lib/modules/treasury/contract';
import { requireAccess, rowsOf } from './access';
import { effectiveSubsidyEligible } from './subsidy-eligibility';
import {
	MODULE_ID,
	idParams,
	participantBulkInput,
	participantInput,
	participantParams,
	type Diet,
	type Participant,
	type ParticipantBulkInput,
	type ParticipantInput,
	type ParticipantRole
} from './schemas';

const mdb = () => core.database.forModule(MODULE_ID);
const TAGS = ['Modul: actions'];

const COLUMNS = sql`id, action_id, contact_email, name, group_label, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
	bremen_resident, role, juleica, subsidy_eligible, diet, allergies, notes, source, created_at, updated_at`;

const iso = (v: unknown): string => new Date(String(v)).toISOString();

/** Zahlstand aus der Kasse; `null`, wenn die Kasse nicht aktiv bzw. nicht erreichbar ist. */
async function loadPayments(actionId: string): Promise<Map<string, ParticipantPayment> | null> {
	const svc = await core.modules.useOptional<TreasuryService>('treasury', MODULE_ID);
	if (!svc) return null;
	try {
		return new Map((await svc.participantPayments(actionId)).map((p) => [p.participantId, p]));
	} catch (e) {
		console.error('[actions] Kasse nicht erreichbar:', e);
		return null;
	}
}
const str = (v: unknown): string | null => (v == null ? null : String(v));

function toParticipant(r: Record<string, unknown>, startsOn: string): Participant {
	const birthDate = str(r.birth_date);
	const bremenResident = r.bremen_resident == null ? null : Boolean(r.bremen_resident);
	const subsidyEligible = r.subsidy_eligible == null ? null : Boolean(r.subsidy_eligible);
	return {
		id: String(r.id),
		actionId: String(r.action_id),
		contactEmail: str(r.contact_email),
		name: String(r.name),
		groupLabel: str(r.group_label),
		birthDate: str(r.birth_date),
		bremenResident: r.bremen_resident == null ? null : Boolean(r.bremen_resident),
		role: String(r.role) as ParticipantRole,
		juleica: Boolean(r.juleica),
		subsidyEligible,
		subsidyEffective: effectiveSubsidyEligible(
			{
				id: String(r.id),
				name: String(r.name),
				role: String(r.role) as ParticipantRole,
				birthDate,
				bremenResident,
				juleica: Boolean(r.juleica),
				subsidyEligible
			},
			startsOn
		),
		diet: r.diet == null ? null : (String(r.diet) as Diet),
		allergies: str(r.allergies),
		notes: str(r.notes),
		source: String(r.source) === 'link' ? 'link' : 'manual',
		createdAt: iso(r.created_at),
		updatedAt: iso(r.updated_at)
	};
}

async function startsOnOf(tx: Tx, actionId: string): Promise<string> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM actions WHERE id = ${actionId}`
	);
	return String(r?.starts_on ?? '');
}

async function loadOne(tx: Tx, actionId: string, participantId: string): Promise<Participant> {
	const [row] = await rowsOf(
		tx,
		sql`SELECT ${COLUMNS} FROM action_participants WHERE id = ${participantId} AND action_id = ${actionId}`
	);
	if (!row) throw errors.notFound('Teilnehmer*in nicht gefunden');
	return toParticipant(row, await startsOnOf(tx, actionId));
}

export const participantEndpoints: ApiEndpoint[] = [
	{
		method: 'GET',
		path: '/actions/:id/participants',
		summary: 'Teilnehmende einer Aktion auflisten',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const list = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'read');
				const rows = await rowsOf(
					tx,
					sql`SELECT ${COLUMNS} FROM action_participants WHERE action_id = ${id}
						ORDER BY created_at, name`
				);
				const startsOn = await startsOnOf(tx, id);
				return rows.map((r) => toParticipant(r, startsOn));
			});
			// Kasse erst nach der Transaktion (PGlite: keine verschachtelten Modul-Transaktionen)
			const payments = await loadPayments(id);
			if (!payments) return list;
			return list.map((p) => ({ ...p, payment: payments.get(p.id) ?? null }));
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/participants',
		summary: 'Teilnehmer*in hinzufügen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: participantInput,
		handler: async ({ ctx, params, body }) => {
			const id = (params as { id: string }).id;
			const input = body as ParticipantInput;
			const participant = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				const pid = crypto.randomUUID();
				await tx.execute(
					sql`INSERT INTO action_participants (id, action_id, name, group_label, birth_date,
							bremen_resident, role, juleica, diet, allergies, notes, source)
						VALUES (${pid}, ${id}, ${input.name}, ${input.groupLabel}, ${input.birthDate},
							${input.bremenResident}, ${input.role}, ${input.juleica}, ${input.diet},
							${input.allergies}, ${input.notes}, 'manual')`
				);
				if (input.subsidyEligible != null) {
					await tx.execute(
						sql`UPDATE action_participants SET subsidy_eligible = ${input.subsidyEligible}
							WHERE id = ${pid}`
					);
				}
				return loadOne(tx, id, pid);
			});
			await core.audit.logFromContext(ctx, 'actions.participant.created', {
				target: participant.id,
				metadata: { actionId: id, name: participant.name }
			});
			return participant;
		}
	} as ApiEndpoint,
	{
		method: 'PATCH',
		path: '/actions/:id/participants',
		summary: 'Mehrere Teilnehmende auf einmal ändern (Zuschuss, Rolle)',
		description:
			'Setzt für alle `ids` die angegebenen Felder (`subsidyEligible`: true/false/null = automatisch, ' +
			'`role`). Alle IDs müssen zu dieser Aktion gehören, sonst 404 und es wird nichts geändert.',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: participantBulkInput,
		handler: async ({ ctx, params, body }) => {
			const id = (params as { id: string }).id;
			const input = body as ParticipantBulkInput;
			const ids = [...new Set(input.ids)];
			const updated = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				const idList = sql.join(
					ids.map((v) => sql`${v}`),
					sql`, `
				);
				const found = await rowsOf(
					tx,
					sql`SELECT id FROM action_participants WHERE action_id = ${id} AND id IN (${idList})
						FOR UPDATE`
				);
				// Fremde oder unbekannte IDs: alles oder nichts (Existenz anderer Aktionen nicht verraten)
				if (found.length !== ids.length) throw errors.notFound('Teilnehmer*in nicht gefunden');
				const sets = [];
				if (input.subsidyEligible !== undefined) {
					sets.push(sql`subsidy_eligible = ${input.subsidyEligible}`);
				}
				if (input.role !== undefined) sets.push(sql`role = ${input.role}`);
				sets.push(sql`updated_at = now()`);
				await tx.execute(
					sql`UPDATE action_participants SET ${sql.join(sets, sql`, `)}
						WHERE action_id = ${id} AND id IN (${idList})`
				);
				return found.length;
			});
			const fields = [
				...(input.subsidyEligible !== undefined ? ['subsidyEligible'] : []),
				...(input.role !== undefined ? ['role'] : [])
			];
			await core.audit.logFromContext(ctx, 'actions.participant.bulk_updated', {
				target: id,
				metadata: {
					actionId: id,
					count: updated,
					fields,
					...(input.subsidyEligible !== undefined
						? { subsidyEligible: input.subsidyEligible }
						: {}),
					...(input.role !== undefined ? { role: input.role } : {})
				}
			});
			return { updated };
		}
	} as ApiEndpoint,
	{
		method: 'PUT',
		path: '/actions/:id/participants/:participantId',
		summary: 'Teilnehmer*in ändern',
		tags: TAGS,
		permission: 'actions.action.view',
		params: participantParams,
		body: participantInput,
		handler: async ({ ctx, params, body }) => {
			const { id, participantId } = params as { id: string; participantId: string };
			const input = body as ParticipantInput;
			const participant = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await loadOne(tx, id, participantId);
				await tx.execute(
					sql`UPDATE action_participants SET name = ${input.name}, group_label = ${input.groupLabel},
							birth_date = ${input.birthDate}, bremen_resident = ${input.bremenResident},
							role = ${input.role}, juleica = ${input.juleica}, diet = ${input.diet},
							allergies = ${input.allergies}, notes = ${input.notes}, updated_at = now()
						WHERE id = ${participantId} AND action_id = ${id}`
				);
				if (input.subsidyEligible !== undefined) {
					await tx.execute(
						sql`UPDATE action_participants SET subsidy_eligible = ${input.subsidyEligible}
							WHERE id = ${participantId} AND action_id = ${id}`
					);
				}
				return loadOne(tx, id, participantId);
			});
			await core.audit.logFromContext(ctx, 'actions.participant.updated', {
				target: participant.id,
				metadata: { actionId: id, name: participant.name }
			});
			return participant;
		}
	} as ApiEndpoint,
	{
		method: 'DELETE',
		path: '/actions/:id/participants/:participantId',
		summary: 'Teilnehmer*in entfernen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: participantParams,
		handler: async ({ ctx, params }) => {
			const { id, participantId } = params as { id: string; participantId: string };
			const name = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				const existing = await loadOne(tx, id, participantId);
				await tx.execute(
					sql`DELETE FROM action_participants WHERE id = ${participantId} AND action_id = ${id}`
				);
				return existing.name;
			});
			await core.audit.logFromContext(ctx, 'actions.participant.deleted', {
				target: participantId,
				metadata: { actionId: id, name }
			});
			return { id: participantId };
		}
	} as ApiEndpoint
];
