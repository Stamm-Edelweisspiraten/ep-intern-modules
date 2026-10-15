import { sql } from 'drizzle-orm';
import { core, errors, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import { requireAccess, rowsOf } from './access';
import { effectiveSubsidyEligible } from './subsidy-eligibility';
import {
	MODULE_ID,
	idParams,
	participantInput,
	participantParams,
	type Diet,
	type Participant,
	type ParticipantInput,
	type ParticipantRole
} from './schemas';

const mdb = () => core.database.forModule(MODULE_ID);
const TAGS = ['Modul: actions'];

const COLUMNS = sql`id, action_id, contact_email, name, group_label, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
	bremen_resident, role, juleica, subsidy_eligible, diet, allergies, notes, source, created_at, updated_at`;

const iso = (v: unknown): string => new Date(String(v)).toISOString();
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
			return mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'read');
				const rows = await rowsOf(
					tx,
					sql`SELECT ${COLUMNS} FROM action_participants WHERE action_id = ${id}
						ORDER BY created_at, name`
				);
				const startsOn = await startsOnOf(tx, id);
				return rows.map((r) => toParticipant(r, startsOn));
			});
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/participants',
		summary: 'Teilnehmer*in hinzufuegen',
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
		method: 'PUT',
		path: '/actions/:id/participants/:participantId',
		summary: 'Teilnehmer*in aendern',
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
