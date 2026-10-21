/**
 * Teilnehmenden-Liste als PDF (A4 quer, eine Zeile je Person, wählbare Spalten):
 * `GET /actions/:id/participants.pdf` (Voreinstellung „Fahrt“), `POST …` mit `{ selection }`,
 * `GET /actions/:id/participants/pdf-columns` (Katalog für den Auswahl-Dialog).
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	type ApiEndpoint,
	core,
	errors,
	moduleDb,
	type RequestContext,
	rowsOf
} from '$lib/sdk/server';
import type { FieldDefinition, FormValue } from '$lib/forms';
import {
	ageOn,
	composeListBlocks,
	formatDateDe,
	formatFieldValue,
	listSelectionInput,
	listTemplateInput,
	todayIso,
	type ListCatalog,
	type ListColumn,
	type ListRow,
	type ListSection,
	type ListSelection
} from '$lib/pdf-lists';
import {
	buildMemberCatalog,
	buildPresets,
	fieldColumnKey,
	rowFromMember
} from '$lib/pdf-lists/member-columns';
import type { MemberSheetData, MembersService } from '$lib/modules/members/contract';
import { requireAccess } from './access';
import { canSeeHealth, readHealth } from './health';
import { formatEuro } from '$lib/components/layout/money';
import { safeFilename } from './form-support';
import {
	DIET_LABELS,
	MODULE_ID,
	PARTICIPANT_ROLE_LABELS,
	idParams,
	type Diet,
	type ParticipantRole
} from './schemas';

const TAGS = ['Modul: actions'];

const parseJson = <T>(v: unknown, fallback: T): T => {
	if (v == null) return fallback;
	try {
		return (typeof v === 'string' ? JSON.parse(v) : v) as T;
	} catch {
		return fallback;
	}
};
const text = (v: unknown): string => (v == null ? '' : String(v).trim());

/** Spalten, die nur Aktionen kennen (Teilnehmerliste) */
export const ACTION_LIST_COLUMNS: ListColumn[] = [
	{ key: 'role', label: 'Rolle', group: 'action', weight: 1.4 },
	{ key: 'fee', label: 'Beitrag', group: 'action', weight: 1.2, align: 'right' },
	{ key: 'juleica', label: 'Juleica', group: 'action', weight: 1, align: 'center' },
	{ key: 'notes', label: 'Hinweise', group: 'action', weight: 3, sensitive: true }
];

/** Mitglieder-Katalog + Aktionsspalten (Rolle direkt hinter dem Namen); „Fahrt“/„Gesundheit“ zeigen zusätzlich die Hinweise */
export function buildActionCatalog(member: ListCatalog): ListCatalog {
	const [role, ...rest] = ACTION_LIST_COLUMNS;
	const columns = [...member.columns];
	const at = columns.findIndex((c) => c.key === 'name') + 1;
	columns.splice(at, 0, role!);
	columns.push(...rest);
	return {
		columns,
		presets: buildPresets(columns, { fahrt: ['notes'], gesundheit: ['notes'] })
	};
}

/** Antworten des Anmeldeformulars mit Beschriftung (Felder ohne Antwort, Info und Einwilligungen entfallen) */
function answerNotes(
	answers: Record<string, unknown>,
	fields: FieldDefinition[],
	skipMemberFields: boolean
): string[] {
	const out: string[] = [];
	for (const [key, raw] of Object.entries(answers)) {
		if (skipMemberFields && key.startsWith('mf_')) continue;
		const field = fields.find((f) => f.key === key);
		if (field && (field.type === 'info' || field.type === 'consent')) continue;
		const value = formatFieldValue(field, raw as FormValue);
		if (value) out.push(`${field?.label ?? key}: ${value}`);
	}
	return out;
}

/** Werte zusammenführen: leere entfallen, gleiche nur einmal, getrennt durch Zeilenumbruch */
const merge = (...values: string[]): string =>
	[...new Set(values.filter((v) => v.trim()))].join('\n');
const euro = formatEuro;

async function loadMembersService(): Promise<MembersService> {
	return core.modules.use<MembersService>('members', MODULE_ID);
}

interface Loaded {
	name: string;
	participants: Record<string, unknown>[];
	formFields: FieldDefinition[];
	feeCents: number | null;
	teamFeeCents: number | null;
}

/** Zugriff (404 für fremde Aktion), dann das Sonderrecht (403); Daten nur innerhalb der Transaktion */
async function loadAction(ctx: RequestContext, id: string): Promise<Loaded> {
	const data = await moduleDb(MODULE_ID).transaction(async (tx) => {
		await requireAccess(tx, ctx, id, 'read');
		const [action] = await rowsOf(
			tx,
			sql`SELECT name, fee_cents, team_fee_cents FROM actions WHERE id = ${id}`
		);
		const participants = await rowsOf(
			tx,
			sql`SELECT id, name, group_label, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, role,
					juleica, diet, allergies, notes, contact_email, answers, health_answers, member_id
				FROM action_participants WHERE action_id = ${id}
				ORDER BY (role = 'team'), lower(name), id`
		);
		const [form] = await rowsOf(
			tx,
			sql`SELECT definition FROM action_forms WHERE action_id = ${id}`
		);
		return { action, participants, definition: form?.definition };
	});
	// Sonderrecht für Gesundheitsdaten (gleiche Prüfung wie CSV/JSON/ZIP, `health.ts`)
	if (!canSeeHealth(ctx)) {
		throw errors.forbidden('Keine Berechtigung, Mitgliedsdaten zu exportieren');
	}
	const num = (v: unknown) => (v == null ? null : Number(v));
	return {
		name: String(data.action?.name ?? 'Aktion'),
		// Gesundheitsfelder entschlüsseln, gesundheitsbezogene Antworten wieder zusammenführen
		participants: data.participants.map((p) => {
			const h = readHealth(p);
			return { ...p, diet: h.diet, allergies: h.allergies, notes: h.notes, answers: h.answers };
		}),
		formFields: parseJson<{ fields?: FieldDefinition[] }>(data.definition, {}).fields ?? [],
		feeCents: num(data.action?.fee_cents),
		teamFeeCents: num(data.action?.team_fee_cents)
	};
}

/** Katalog (Mitglieder-Spalten + Aktionsspalten); Core-Dienst außerhalb der Transaktion */
async function loadCatalog(): Promise<{
	catalog: ListCatalog;
	defs: Awaited<ReturnType<MembersService['listFieldDefinitions']>>;
	svc: MembersService;
}> {
	const svc = await loadMembersService();
	const defs = await svc.listFieldDefinitions();
	return { catalog: buildActionCatalog(buildMemberCatalog(defs)), defs, svc };
}

function rowOf(
	p: Record<string, unknown>,
	a: Loaded,
	member: MemberSheetData | undefined,
	defs: Awaited<ReturnType<MembersService['listFieldDefinitions']>>,
	today: string
): ListRow {
	const role = String(p.role) as ParticipantRole;
	const diet = p.diet ? (DIET_LABELS[String(p.diet) as Diet] ?? String(p.diet)) : '';
	const birth = text(p.birth_date);
	const age = ageOn(birth, today);
	const base: ListRow = member
		? rowFromMember(member, defs, today)
		: {
				name: '',
				groups: text(p.group_label),
				age: age !== null ? String(age) : '',
				birthDate: formatDateDe(birth),
				email: text(p.contact_email)
			};
	const fee = role === 'team' ? (a.teamFeeCents ?? a.feeCents) : a.feeCents;
	return {
		...base,
		name: String(p.name),
		email: merge(base.email ?? '', text(p.contact_email)),
		[fieldColumnKey('ernaehrung')]: merge(base[fieldColumnKey('ernaehrung')] ?? '', diet),
		[fieldColumnKey('allergien')]: merge(
			base[fieldColumnKey('allergien')] ?? '',
			text(p.allergies)
		),
		role: PARTICIPANT_ROLE_LABELS[role] ?? String(p.role),
		fee: fee == null ? '' : euro(fee),
		juleica: p.juleica ? 'ja' : '',
		notes: merge(
			text(p.notes),
			...answerNotes(parseJson<Record<string, unknown>>(p.answers, {}), a.formFields, !!member)
		)
	};
}

async function buildParticipantsPdf(
	ctx: RequestContext,
	id: string,
	selection: Partial<ListSelection> | undefined
): Promise<Response> {
	const a = await loadAction(ctx, id);
	const memberIds = [...new Set(a.participants.map((p) => text(p.member_id)).filter(Boolean))];
	const { catalog, defs, svc } = await loadCatalog();
	const sheets = new Map<string, MemberSheetData>(
		memberIds.length ? (await svc.listMemberSheets(memberIds)).map((m) => [m.id, m]) : []
	);
	const today = todayIso();
	const rows = a.participants.map((p) => ({
		team: String(p.role) === 'team',
		row: rowOf(p, a, sheets.get(text(p.member_id)), defs, today)
	}));
	const sections: ListSection[] = [
		{ title: `Teilnehmende – ${a.name}`, rows: rows.filter((r) => !r.team).map((r) => r.row) },
		{ title: `Team – ${a.name}`, rows: rows.filter((r) => r.team).map((r) => r.row) }
	].filter((s) => s.rows.length);
	if (!sections.length) sections.push({ title: `Teilnehmende – ${a.name}`, rows: [] });

	const { blocks, columns } = composeListBlocks({
		catalog,
		selection,
		sections,
		generatedOn: today
	});
	const result = await core.pdf.generate(ctx, {
		...listTemplateInput(core.pdf.listTemplates().map((t) => t.id)),
		title: `Teilnehmende ${a.name}`,
		content: blocks
	});
	await core.audit.logFromContext(ctx, 'actions.participants.sheet_generated', {
		target: id,
		metadata: { actionId: id, count: a.participants.length, columns: columns.length }
	});
	return new Response(Buffer.from(result.buffer), {
		status: 200,
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': `attachment; filename="${safeFilename(a.name, '-teilnehmende.pdf')}"`,
			'cache-control': 'private, no-store'
		}
	});
}

const selectionBody = z.object({ selection: listSelectionInput.optional() }).strict();

export const participantSheetEndpoints: ApiEndpoint[] = [
	{
		method: 'GET',
		path: '/actions/:id/participants.pdf',
		summary: 'Teilnehmendenliste als PDF (A4 quer, Voreinstellung „Fahrt“)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) =>
			buildParticipantsPdf(ctx, (params as { id: string }).id, undefined)
	},
	{
		method: 'POST',
		path: '/actions/:id/participants.pdf',
		summary: 'Teilnehmendenliste als PDF mit gewählten Spalten (A4 quer)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: selectionBody,
		handler: async ({ ctx, params, body }) =>
			buildParticipantsPdf(
				ctx,
				(params as { id: string }).id,
				(body as z.infer<typeof selectionBody>).selection
			)
	},
	{
		method: 'GET',
		path: '/actions/:id/participants/pdf-columns',
		summary: 'Spalten und Voreinstellungen der Teilnehmendenliste (PDF)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			await moduleDb(MODULE_ID).transaction((tx) => requireAccess(tx, ctx, id, 'read'));
			if (!canSeeHealth(ctx)) {
				throw errors.forbidden('Keine Berechtigung, Mitgliedsdaten zu exportieren');
			}
			return (await loadCatalog()).catalog;
		}
	}
] as ApiEndpoint[];
