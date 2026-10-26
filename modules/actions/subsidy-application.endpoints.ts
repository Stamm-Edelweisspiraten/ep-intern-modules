/**
 * Zuschussantrag beim Landesjugendpfarramt der BEK (Original-Formular, per Overlay befüllt):
 * `GET/PUT /actions/:id/subsidy-application` (Angaben + Geschlecht der Leitungen, Vorschau der Aufteilung),
 * `GET /actions/:id/subsidy-application.pdf` (alle Anträge in einer Datei, je Antrag zwei Seiten).
 */
import { sql } from 'drizzle-orm';
import {
	type ApiEndpoint,
	core,
	errors,
	moduleDb,
	rowsOf,
	secureFileResponse,
	type Tx
} from '$lib/sdk/server';
import templateUrl from './assets/zuschussantrag-bek.pdf?inline';
import { requireAccess } from './access';
import { loadEligibilityParticipants } from './accounting-core';
import { nightsBetween } from './calculation';
import { readSettings } from './form.endpoints';
import { safeFilename } from './form-support';
import { planSubsidyApplications } from './subsidy-application';
import { fillSubsidyApplicationPdf } from './subsidy-application-pdf';
import type { EligibilityParticipant } from './subsidy-eligibility';
import {
	DEFAULT_CALCULATION,
	MODULE_ID,
	ageAt,
	idParams,
	subsidyApplicationInput,
	type FreizeitType,
	type LeaderGender,
	type LodgingType,
	type SubsidyApplicationDto,
	type SubsidyApplicationInput
} from './schemas';

const TAGS = ['Modul: actions'];
export const PARISH_SETTING = 'actions.subsidy.parish';

let templateBytes: Uint8Array | null = null;
/** Original-Formular (als Data-URL eingebettet, siehe `assets/`) */
function template(): Uint8Array {
	templateBytes ??= Uint8Array.from(
		Buffer.from(templateUrl.slice(templateUrl.indexOf(',') + 1), 'base64')
	);
	return templateBytes;
}

interface State {
	action: SubsidyApplicationDto['action'];
	freizeitArt: string;
	topic: string;
	inclusion: boolean;
	persisted: boolean;
	participants: EligibilityParticipant[];
	genders: Map<string, LeaderGender>;
	nights: number;
	lodgingType: LodgingType;
	konfi: boolean;
	freizeitType: FreizeitType;
}

async function loadState(tx: Tx, id: string): Promise<State> {
	const [a] = await rowsOf(
		tx,
		sql`SELECT name, location, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
				to_char(ends_on, 'YYYY-MM-DD') AS ends_on
			FROM actions WHERE id = ${id}`
	);
	const action = {
		name: String(a!.name),
		location: a!.location == null ? null : String(a!.location),
		startsOn: String(a!.starts_on),
		endsOn: a!.ends_on == null ? null : String(a!.ends_on)
	};
	const [app] = await rowsOf(
		tx,
		sql`SELECT freizeit_art, topic, inclusion FROM subsidy_applications WHERE action_id = ${id}`
	);
	const [calc] = await rowsOf(
		tx,
		sql`SELECT nights, lodging_type, konfi, freizeit_type FROM action_calculations
			WHERE action_id = ${id}`
	);
	const leaders = await rowsOf(
		tx,
		sql`SELECT participant_id, gender FROM subsidy_application_leaders WHERE action_id = ${id}`
	);
	return {
		action,
		freizeitArt: app ? String(app.freizeit_art) : '',
		topic: app ? String(app.topic) : action.name,
		inclusion: app ? Boolean(app.inclusion) : false,
		persisted: !!app,
		participants: await loadEligibilityParticipants(tx, id),
		genders: new Map(
			leaders.map((r) => [String(r.participant_id), String(r.gender) as LeaderGender])
		),
		nights: calc
			? Number(calc.nights)
			: (nightsBetween(action.startsOn, action.endsOn) ?? DEFAULT_CALCULATION.nights),
		lodgingType: calc
			? (String(calc.lodging_type) as LodgingType)
			: DEFAULT_CALCULATION.lodgingType,
		konfi: calc ? Boolean(calc.konfi) : DEFAULT_CALCULATION.konfi,
		freizeitType: calc
			? (String(calc.freizeit_type) as FreizeitType)
			: DEFAULT_CALCULATION.freizeitType
	};
}

/** Gemeinde + Bankverbindung (Kasse bzw. `actions.bank.*`) – Core-Aufrufe, nie in der Transaktion */
async function loadApplicant() {
	const [s, bank] = await Promise.all([core.settings.getMany([PARISH_SETTING]), readSettings()]);
	const parish = s[PARISH_SETTING];
	return {
		parish: typeof parish === 'string' ? parish : '',
		bank: { name: bank.bank, iban: bank.iban, bic: bank.bic }
	};
}

function toDto(
	state: State,
	applicant: Awaited<ReturnType<typeof loadApplicant>>
): SubsidyApplicationDto {
	const plan = planSubsidyApplications({
		participants: state.participants,
		startsOn: state.action.startsOn,
		nights: state.nights,
		lodgingType: state.lodgingType,
		konfi: state.konfi,
		freizeitType: state.freizeitType,
		genders: state.genders
	});
	const team = state.participants
		.filter((p) => p.role === 'team')
		.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base', numeric: true }))
		.map((p) => ({
			participantId: p.id,
			name: p.name,
			age: p.birthDate ? ageAt(p.birthDate, state.action.startsOn) : null,
			juleica: p.juleica,
			gender: state.genders.get(p.id) ?? null
		}));
	return {
		freizeitArt: state.freizeitArt,
		topic: state.topic,
		inclusion: state.inclusion,
		persisted: state.persisted,
		team,
		plan,
		...applicant,
		action: state.action
	};
}

export const subsidyApplicationEndpoints: ApiEndpoint[] = [
	{
		method: 'GET',
		path: '/actions/:id/subsidy-application',
		summary: 'Zuschussantrag: Angaben, Leitungen und Aufteilung auf Anträge',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const state = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'read');
				return loadState(tx, id);
			});
			return toDto(state, await loadApplicant());
		}
	} as ApiEndpoint,
	{
		method: 'PUT',
		path: '/actions/:id/subsidy-application',
		summary: 'Zuschussantrag: Angaben und Geschlecht der Leitungen speichern',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: subsidyApplicationInput,
		handler: async ({ ctx, params, body }) => {
			const id = (params as { id: string }).id;
			const input = body as SubsidyApplicationInput;
			const state = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				const teamRows = await rowsOf(
					tx,
					sql`SELECT id FROM action_participants WHERE action_id = ${id} AND role = 'team'`
				);
				const teamIds = new Set(teamRows.map((r) => String(r.id)));
				const seen = new Set<string>();
				const problems: Record<string, string> = {};
				input.leaders.forEach((l, i) => {
					if (!teamIds.has(l.participantId)) {
						problems[`leaders.${i}.participantId`] =
							'Diese Person gehört nicht zum Team der Aktion';
					} else if (seen.has(l.participantId)) {
						problems[`leaders.${i}.participantId`] = 'Diese Person ist doppelt angegeben';
					}
					seen.add(l.participantId);
				});
				if (Object.keys(problems).length) throw errors.validation(problems);

				await tx.execute(
					sql`INSERT INTO subsidy_applications (action_id, freizeit_art, topic, inclusion, updated_by, updated_at)
						VALUES (${id}, ${input.freizeitArt}, ${input.topic}, ${input.inclusion}, ${ctx.userId ?? null}, now())
						ON CONFLICT (action_id) DO UPDATE SET freizeit_art = EXCLUDED.freizeit_art,
							topic = EXCLUDED.topic, inclusion = EXCLUDED.inclusion,
							updated_by = EXCLUDED.updated_by, updated_at = now()`
				);
				await tx.execute(sql`DELETE FROM subsidy_application_leaders WHERE action_id = ${id}`);
				for (const l of input.leaders) {
					if (!l.gender) continue;
					await tx.execute(
						sql`INSERT INTO subsidy_application_leaders (action_id, participant_id, gender)
							VALUES (${id}, ${l.participantId}, ${l.gender})`
					);
				}
				return loadState(tx, id);
			});
			const dto = toDto(state, await loadApplicant());
			await core.audit.logFromContext(ctx, 'actions.subsidy.application_updated', {
				target: id,
				metadata: {
					female: input.leaders.filter((l) => l.gender === 'female').length,
					male: input.leaders.filter((l) => l.gender === 'male').length,
					forms: dto.plan.forms.length
				}
			});
			return dto;
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/actions/:id/subsidy-application.pdf',
		summary: 'Zuschussantrag als ausgefülltes Original-Formular (PDF, bei Bedarf mehrere Anträge)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const state = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'read');
				return loadState(tx, id);
			});
			const dto = toDto(state, await loadApplicant());
			const bytes = await fillSubsidyApplicationPdf(template(), dto.plan.forms, {
				freizeitArt: dto.freizeitArt,
				parish: dto.parish,
				startsOn: dto.action.startsOn,
				endsOn: dto.action.endsOn,
				location: dto.action.location ?? '',
				topic: dto.topic,
				inclusion: dto.inclusion,
				bank: dto.bank
			});
			await core.audit.logFromContext(ctx, 'actions.subsidy.application_generated', {
				target: id,
				metadata: {
					forms: dto.plan.forms.length,
					persons: dto.plan.forms.reduce((s, f) => s + f.children.length + f.youth.length, 0),
					unassigned: dto.plan.unassigned.filter((u) => u.reason !== 'allowance-limit').length
				}
			});
			return secureFileResponse(bytes, {
				contentType: 'application/pdf',
				size: bytes.byteLength,
				name: safeFilename(`Zuschussantrag-${dto.action.name}`, '.pdf'),
				download: true,
				cache: 'private, no-store'
			});
		}
	} as ApiEndpoint
];
