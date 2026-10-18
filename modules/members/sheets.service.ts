/**
 * Mitgliedsdaten-PDF: Datenblätter für ausgewählte Mitglieder bzw. je Gruppe alle Mitglieder.
 * Alle Core-Aufrufe (Felddefinitionen, PDF, Audit) laufen NACH den Modul-Transaktionen (PGlite).
 */
import { sql } from 'drizzle-orm';
import { core, errors, type RequestContext, type Tx } from '$lib/sdk/server';
import type { MemberSheetData } from './contract';
import { listFieldDefinitions } from './fields.service';
import type { ListCatalog, ListSection, ListSelection } from '$lib/pdf-lists';
import { composeListBlocks, listTemplateInput, todayIso } from './member-list';
import { buildMemberCatalog, rowFromMember } from './sheet-columns';
import { loadMembersByIds } from './members.service';
import { MODULE_ID, STAGE_LABELS, type Member } from './schemas';

type Row = Record<string, unknown>;
const mdb = () => core.database.forModule(MODULE_ID);
const rows = async (tx: Tx, q: ReturnType<typeof sql>): Promise<Row[]> =>
	((await tx.execute(q)) as unknown as { rows: Row[] }).rows;

export function toSheetData(m: Member): MemberSheetData {
	return {
		id: m.id,
		firstName: m.firstName,
		lastName: m.lastName,
		scoutName: m.scoutName,
		birthDate: m.birthDate,
		stage: STAGE_LABELS[m.stage] ?? m.stage,
		street: m.street,
		postalCode: m.postalCode,
		city: m.city,
		country: m.country,
		phones: m.phones.map((p) => ({ name: p.name, value: p.value })),
		emails: m.emails.map((e) => ({ name: e.name, value: e.value })),
		groups: m.groups.map((g) => ({ id: g.id, name: g.name })),
		consentSocialMedia: m.consentSocialMedia,
		consentWebsite: m.consentWebsite,
		consentPrint: m.consentPrint,
		entryDate: m.entryDate,
		exitDate: m.exitDate,
		custom: m.custom
	};
}

/** Dienst für andere Module (Reihenfolge wie `ids`, unbekannte entfallen) */
export async function listMemberSheets(ids: string[]): Promise<MemberSheetData[]> {
	const found = await mdb().transaction((tx) => loadMembersByIds(tx, [...new Set(ids)]));
	return found.map(toSheetData);
}

/** Spalten-Katalog und Voreinstellungen (Basisfelder + aktive Zusatzfelder) */
export async function getMemberCatalog(): Promise<ListCatalog> {
	return buildMemberCatalog(await listFieldDefinitions());
}

type ListResult = { buffer: Uint8Array; fileName: string; columns: number };

async function renderList(
	ctx: RequestContext,
	catalog: ListCatalog,
	sections: ListSection[],
	selection: Partial<ListSelection> | undefined,
	title: string,
	generatedOn: string
): Promise<ListResult> {
	const { blocks, columns } = composeListBlocks({ catalog, selection, sections, generatedOn });
	const result = await core.pdf.generate(ctx, {
		...listTemplateInput(core.pdf.listTemplates().map((t) => t.id)),
		title,
		content: blocks
	});
	return { buffer: result.buffer, fileName: result.fileName, columns: columns.length };
}

/** Liste ausgewählter Mitglieder (Reihenfolge der IDs); unbekannte ID → 404 */
export async function buildMemberSheets(
	ctx: RequestContext,
	ids: string[],
	selection?: Partial<ListSelection>
): Promise<{ buffer: Uint8Array; fileName: string }> {
	const members = await mdb().transaction((tx) => loadMembersByIds(tx, ids));
	if (members.length !== ids.length) throw errors.notFound('Mitglied nicht gefunden');
	const defs = await listFieldDefinitions();
	const catalog = buildMemberCatalog(defs);
	const today = todayIso();
	const out = await renderList(
		ctx,
		catalog,
		[
			{
				title: 'Mitgliedsliste',
				rows: members.map((m) => rowFromMember(toSheetData(m), defs, today))
			}
		],
		selection,
		'Mitgliedsliste',
		today
	);
	await core.audit.logFromContext(ctx, 'members.member.sheet_generated', {
		metadata: { count: members.length, columns: out.columns }
	});
	return { buffer: out.buffer, fileName: out.fileName };
}

/** Je Gruppe ein Abschnitt (neue Seite) mit allen aktuellen Mitgliedern; unbekannte Gruppe → 404 */
export async function buildGroupSheets(
	ctx: RequestContext,
	groupIds: string[],
	selection?: Partial<ListSelection>
): Promise<{ buffer: Uint8Array; fileName: string }> {
	const { groups, memberIdsByGroup, members } = await mdb().transaction(async (tx) => {
		const idList = sql.join(
			groupIds.map((g) => sql`${g}`),
			sql`, `
		);
		const found = await rows(tx, sql`SELECT id, name, type FROM groups WHERE id IN (${idList})`);
		if (found.length !== groupIds.length) throw errors.notFound('Gruppe nicht gefunden');
		const links = await rows(
			tx,
			sql`SELECT mg.group_id, m.id FROM member_groups mg JOIN members m ON m.id = mg.member_id
				WHERE mg.group_id IN (${idList}) AND (m.exit_date IS NULL OR m.exit_date > current_date)
				ORDER BY lower(m.last_name), lower(m.first_name), m.id`
		);
		const byGroup = new Map<string, string[]>();
		for (const l of links) {
			const g = String(l.group_id);
			byGroup.set(g, [...(byGroup.get(g) ?? []), String(l.id)]);
		}
		const all = [...new Set(links.map((l) => String(l.id)))];
		return {
			groups: groupIds.map((g) => found.find((f) => f.id === g)!),
			memberIdsByGroup: byGroup,
			members: new Map((await loadMembersByIds(tx, all)).map((m) => [m.id, m]))
		};
	});
	const defs = await listFieldDefinitions();
	const catalog = buildMemberCatalog(defs);
	const today = todayIso();
	const sections: ListSection[] = groups.map((g) => ({
		title: String(g.name),
		subtitle: g.type === 'meute' ? 'Meute' : 'Sippe',
		rows: (memberIdsByGroup.get(String(g.id)) ?? []).map((id) =>
			rowFromMember(toSheetData(members.get(id)!), defs, today)
		)
	}));
	const out = await renderList(
		ctx,
		catalog,
		sections,
		selection,
		groups.length === 1 ? `Gruppe ${String(groups[0]!.name)}` : 'Gruppen',
		today
	);
	await core.audit.logFromContext(ctx, 'members.group.sheet_generated', {
		metadata: {
			groups: groups.length,
			count: [...memberIdsByGroup.values()].reduce((s, l) => s + l.length, 0),
			columns: out.columns
		}
	});
	return { buffer: out.buffer, fileName: out.fileName };
}
