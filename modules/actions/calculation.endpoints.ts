import { sql } from 'drizzle-orm';
import { core, errors, type ApiEndpoint, type RequestContext, type Tx } from '$lib/sdk/server';
import { requireAccess, rowsOf } from './access';
import { calculate, nightsBetween } from './calculation';
import { computeSubsidy } from './subsidy';
import { loadEligibilityParticipants } from './accounting-core';
import { deriveSubsidyCounts } from './subsidy-eligibility';
import {
	CHECKLIST_ITEMS,
	DEFAULT_CALCULATION,
	DEFAULT_CALC_ITEMS,
	MODULE_ID,
	calculationInput,
	idParams,
	type CalcBasis,
	type CalcCategory,
	type AppliedFee,
	type CalcItem,
	type CalculationDto,
	type CalculationInput,
	type CalculationSuggestions,
	type FreizeitType,
	type LodgingType
} from './schemas';

const mdb = () => core.database.forModule(MODULE_ID);
const TAGS = ['Modul: actions'];

interface ActionDates {
	startsOn: string;
	endsOn: string | null;
}

async function loadDates(tx: Tx, id: string): Promise<ActionDates> {
	const [row] = await rowsOf(
		tx,
		sql`SELECT to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
				to_char(ends_on, 'YYYY-MM-DD') AS ends_on
			FROM actions WHERE id = ${id}`
	);
	return {
		startsOn: String(row!.starts_on),
		endsOn: row!.ends_on == null ? null : String(row!.ends_on)
	};
}

interface LoadedCalculation {
	dto: CalculationDto;
	appliedById: string | null;
}

/** Benutzernamen werden NACH der Modul-Transaktion aufgelöst (siehe actions.endpoints.ts). */
async function finalize(ctx: RequestContext, loaded: LoadedCalculation): Promise<CalculationDto> {
	const { dto, appliedById } = loaded;
	if (dto.applied && appliedById) {
		const found = await core.users.directory(ctx, { ids: [appliedById], limit: 30 });
		const u = found.find((x) => x.id === appliedById);
		dto.applied.appliedBy = u
			? { userId: u.id, name: u.name, email: u.email }
			: { userId: appliedById, name: 'Unbekannt', email: null };
	}
	return dto;
}

async function loadCalculation(tx: Tx, id: string): Promise<LoadedCalculation> {
	const dates = await loadDates(tx, id);
	const [row] = await rowsOf(tx, sql`SELECT * FROM action_calculations WHERE action_id = ${id}`);

	let settings: CalculationInput;
	let persisted = false;
	let updatedAt: string | null = null;

	if (row) {
		persisted = true;
		updatedAt = new Date(String(row.updated_at)).toISOString();
		const itemRows = await rowsOf(
			tx,
			sql`SELECT id, category, label, amount_cents, basis FROM calc_items
				WHERE action_id = ${id} ORDER BY position`
		);
		const items: CalcItem[] = itemRows.map((r) => ({
			id: String(r.id),
			category: String(r.category) as CalcCategory,
			label: String(r.label),
			amountCents: Number(r.amount_cents),
			basis: String(r.basis) as CalcBasis
		}));
		const rawChecklist =
			typeof row.checklist === 'string' ? JSON.parse(row.checklist) : (row.checklist ?? {});
		settings = {
			participants: Number(row.participants),
			team: Number(row.team),
			teamPercent: Number(row.team_percent),
			nights: Number(row.nights),
			bufferPercent: Number(row.buffer_percent),
			includeSubsidy: Boolean(row.include_subsidy),
			lodgingType: String(row.lodging_type) as LodgingType,
			konfi: Boolean(row.konfi),
			freizeitType: String(row.freizeit_type) as FreizeitType,
			bremenChildren: Number(row.bremen_children),
			bremenYouth: Number(row.bremen_youth),
			teamWithJuleica: Number(row.team_with_juleica),
			teamWithoutJuleica: Number(row.team_without_juleica),
			teamYouth: Number(row.team_youth),
			checklist: rawChecklist as Record<string, boolean>,
			items
		};
	} else {
		settings = {
			...DEFAULT_CALCULATION,
			nights: nightsBetween(dates.startsOn, dates.endsOn) ?? DEFAULT_CALCULATION.nights,
			checklist: {},
			items: DEFAULT_CALC_ITEMS.map((i) => ({ ...i, id: crypto.randomUUID() }))
		};
	}

	const subsidy = settings.includeSubsidy
		? computeSubsidy({
				nights: settings.nights,
				lodgingType: settings.lodgingType,
				konfi: settings.konfi,
				freizeitType: settings.freizeitType,
				children: settings.bremenChildren,
				youth: settings.bremenYouth,
				teamWithJuleica: settings.teamWithJuleica,
				teamWithoutJuleica: settings.teamWithoutJuleica,
				teamYouth: settings.teamYouth
			})
		: null;
	const result = calculate({
		participants: settings.participants,
		team: settings.team,
		teamPercent: settings.teamPercent,
		nights: settings.nights,
		items: settings.items,
		bufferPercent: settings.bufferPercent,
		subsidyCents: subsidy?.subsidyCents ?? 0
	});
	const [fee] = await rowsOf(
		tx,
		sql`SELECT fee_cents, team_fee_cents, fee_applied_at, fee_applied_by
			FROM actions WHERE id = ${id}`
	);
	let applied: AppliedFee | null = null;
	let appliedById: string | null = null;
	if (fee && fee.fee_cents != null) {
		appliedById = fee.fee_applied_by == null ? null : String(fee.fee_applied_by);
		applied = {
			participantCents: Number(fee.fee_cents),
			teamCents: Number(fee.team_fee_cents ?? 0),
			appliedAt: new Date(String(fee.fee_applied_at)).toISOString(),
			appliedBy: null
		};
	}
	const outdated =
		!!applied &&
		(applied.participantCents !== result.recommendedPerPersonCents ||
			applied.teamCents !== result.recommendedTeamPerPersonCents);
	return {
		dto: { settings, applied, outdated, persisted, updatedAt, subsidy, result },
		appliedById
	};
}

export const calculationEndpoints: ApiEndpoint[] = [
	{
		method: 'GET',
		path: '/actions/:id/calculation',
		summary: 'Kalkulation einer Aktion lesen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const loaded = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'read');
				return loadCalculation(tx, id);
			});
			return finalize(ctx, loaded);
		}
	} as ApiEndpoint,
	{
		method: 'PUT',
		path: '/actions/:id/calculation',
		summary: 'Kalkulation einer Aktion speichern',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: calculationInput,
		handler: async ({ ctx, params, body }) => {
			const id = (params as { id: string }).id;
			const input = body as CalculationInput;
			const validKeys = new Set<string>(CHECKLIST_ITEMS.map((c) => c.key));
			const checklist: Record<string, boolean> = {};
			for (const [k, v] of Object.entries(input.checklist ?? {})) {
				if (validKeys.has(k)) checklist[k] = Boolean(v);
			}
			const loaded = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await tx.execute(
					sql`INSERT INTO action_calculations (action_id, participants, team, team_percent, nights,
								buffer_percent, include_subsidy, lodging_type, konfi, freizeit_type, bremen_children,
								bremen_youth, team_with_juleica, team_without_juleica, team_youth, checklist,
								updated_by, updated_at)
							VALUES (${id}, ${input.participants}, ${input.team}, ${input.teamPercent}, ${input.nights},
								${input.bufferPercent},
							${input.includeSubsidy}, ${input.lodgingType}, ${input.konfi}, ${input.freizeitType},
							${input.bremenChildren}, ${input.bremenYouth}, ${input.teamWithJuleica},
							${input.teamWithoutJuleica}, ${input.teamYouth}, ${JSON.stringify(checklist)}::jsonb, ${ctx.userId ?? null}, now())
						ON CONFLICT (action_id) DO UPDATE SET
							participants = EXCLUDED.participants, team = EXCLUDED.team,
								team_percent = EXCLUDED.team_percent, team_youth = EXCLUDED.team_youth, nights = EXCLUDED.nights,
							buffer_percent = EXCLUDED.buffer_percent, include_subsidy = EXCLUDED.include_subsidy,
							lodging_type = EXCLUDED.lodging_type, konfi = EXCLUDED.konfi,
							freizeit_type = EXCLUDED.freizeit_type, bremen_children = EXCLUDED.bremen_children,
							bremen_youth = EXCLUDED.bremen_youth, team_with_juleica = EXCLUDED.team_with_juleica,
							team_without_juleica = EXCLUDED.team_without_juleica, checklist = EXCLUDED.checklist,
							updated_by = EXCLUDED.updated_by, updated_at = now()`
				);
				await tx.execute(sql`DELETE FROM calc_items WHERE action_id = ${id}`);
				for (const [position, item] of input.items.entries()) {
					await tx.execute(
						sql`INSERT INTO calc_items (id, action_id, category, label, amount_cents, basis, position)
							VALUES (${crypto.randomUUID()}, ${id}, ${item.category}, ${item.label},
								${item.amountCents}, ${item.basis}, ${position})`
					);
				}
				return loadCalculation(tx, id);
			});
			const dto = await finalize(ctx, loaded);
			await core.audit.logFromContext(ctx, 'actions.calculation.updated', {
				target: id,
				metadata: {
					participants: input.participants,
					nights: input.nights,
					includeSubsidy: input.includeSubsidy,
					items: input.items.length
				}
			});
			return dto;
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/actions/:id/calculation/suggestions',
		summary: 'Kalkulationsvorschläge aus der Teilnehmerliste',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			return mdb().transaction(async (tx): Promise<CalculationSuggestions> => {
				await requireAccess(tx, ctx, id, 'read');
				const dates = await loadDates(tx, id);
				const people = await loadEligibilityParticipants(tx, id);
				const counts = deriveSubsidyCounts(people, dates.startsOn);
				const out: CalculationSuggestions = {
					participants: people.filter((p) => p.role !== 'team').length,
					team: people.filter((p) => p.role === 'team').length,
					children: counts.bremenChildren,
					youth: counts.bremenYouth,
					teamWithJuleica: counts.teamWithJuleica,
					teamWithoutJuleica: counts.teamWithoutJuleica,
					teamYouth: counts.teamYouth,
					nights: nightsBetween(dates.startsOn, dates.endsOn),
					incomplete: counts.incomplete
				};
				return out;
			});
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/calculation/apply',
		summary: 'Empfohlenen Beitrag in die Aktion übernehmen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const loaded = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				const current = await loadCalculation(tx, id);
				if (!current.dto.persisted) {
					throw errors.badRequest('Bitte die Kalkulation zuerst speichern');
				}
				if (current.dto.settings.participants <= 0) {
					throw errors.validation({
						participants: 'Für die Übernahme wird mindestens eine teilnehmende Person benötigt'
					});
				}
				await tx.execute(
					sql`UPDATE actions SET fee_cents = ${current.dto.result.recommendedPerPersonCents},
								team_fee_cents = ${current.dto.result.recommendedTeamPerPersonCents},
								fee_applied_at = now(), fee_applied_by = ${ctx.userId ?? null}, updated_at = now()
							WHERE id = ${id}`
				);
				return loadCalculation(tx, id);
			});
			const dto = await finalize(ctx, loaded);
			await core.audit.logFromContext(ctx, 'actions.fee.applied', {
				target: id,
				metadata: {
					participantCents: dto.applied?.participantCents,
					teamCents: dto.applied?.teamCents
				}
			});
			return dto;
		}
	} as ApiEndpoint,
	{
		method: 'DELETE',
		path: '/actions/:id/calculation/apply',
		summary: 'Übernommenen Beitrag zurücknehmen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const loaded = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await tx.execute(
					sql`UPDATE actions SET fee_cents = NULL, team_fee_cents = NULL, fee_applied_at = NULL,
								fee_applied_by = NULL, updated_at = now()
							WHERE id = ${id}`
				);
				return loadCalculation(tx, id);
			});
			const dto = await finalize(ctx, loaded);
			await core.audit.logFromContext(ctx, 'actions.fee.cleared', { target: id });
			return dto;
		}
	} as ApiEndpoint
];
