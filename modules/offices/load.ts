/**
 * Lese-Hilfen des Moduls `offices`: Rohdaten in der Transaktion laden (`loadOffices`) und danach –
 * außerhalb der Transaktion – Namen von Rollen und Personen über den Core auflösen (`buildOffices`).
 */
import { sql } from 'drizzle-orm';
import {
	core,
	errors,
	inList,
	moduleDb,
	rowsOf,
	str as textOrNull,
	toIso as iso,
	type RequestContext,
	type Row,
	type Tx
} from '$lib/sdk/server';
import { registeredTemplates } from './templates';
import { MODULE_ID, type Office, type OfficeEmail, type OfficeNotificationInfo } from './schemas';

/** Grundhelfer aus dem SDK (`$lib/sdk/server/db.ts`), unter den im Modul üblichen Namen */
export { inList, iso, rowsOf, textOrNull, type Row };

/** Höchstzahl je Verzeichnis-Aufruf (`core.users.directory` / `core.roles.directory` liefern max. 30) */
const DIRECTORY_CHUNK = 30;

export const mdb = () => moduleDb(MODULE_ID);

export interface HolderData {
	userId: string;
	since: string | null;
}

/** Amt ohne aufgelöste Namen (Ergebnis der Transaktion) */
export interface OfficeData {
	id: string;
	name: string;
	description: string | null;
	position: number;
	emails: OfficeEmail[];
	roleIds: string[];
	holders: HolderData[];
	/** Herkunft aus einer Modul-Vorlage (`null` bei selbst angelegten Ämtern) */
	sourceModule: string | null;
	sourceKey: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface OfficesData {
	offices: OfficeData[];
	/** Persönliche Beschreibungen der Inhaber*innen (`user_id` → Text) */
	bios: Map<string, string | null>;
	/** Inhaber*innen mit Zustimmung zur Anzeige auf der Stammeswebsite (Opt-in) */
	websiteOptIn: Set<string>;
}

/** Ämter (alle oder die angegebenen IDs) mit E-Mails, Rollen, Inhaber*innen und Beschreibungen */
export async function loadOffices(tx: Tx, ids?: readonly string[]): Promise<OfficesData> {
	if (ids && ids.length === 0) return { offices: [], bios: new Map(), websiteOptIn: new Set() };
	const filter = ids ? sql`WHERE id IN (${inList(ids)})` : sql``;
	const officeRows = await rowsOf(
		tx,
		sql`SELECT id, name, description, position, source_module, source_key, created_at, updated_at
			FROM offices
			${filter} ORDER BY position, name, id`
	);
	if (officeRows.length === 0) return { offices: [], bios: new Map(), websiteOptIn: new Set() };
	const officeIds = officeRows.map((r) => String(r.id));
	const where = sql`office_id IN (${inList(officeIds)})`;
	const [emailRows, roleRows, holderRows] = [
		await rowsOf(
			tx,
			sql`SELECT id, office_id, email, label FROM office_emails WHERE ${where}
				ORDER BY office_id, position, id`
		),
		await rowsOf(
			tx,
			sql`SELECT office_id, role_id FROM office_roles WHERE ${where} ORDER BY office_id, role_id`
		),
		await rowsOf(
			tx,
			sql`SELECT office_id, user_id, to_char(since, 'YYYY-MM-DD') AS since FROM office_holders
				WHERE ${where} ORDER BY office_id, position, created_at, user_id`
		)
	];
	const userIds = [...new Set(holderRows.map((r) => String(r.user_id)))];
	const bios = new Map<string, string | null>();
	const websiteOptIn = new Set<string>();
	if (userIds.length) {
		const bioRows = await rowsOf(
			tx,
			sql`SELECT user_id, bio, show_on_website FROM holder_profiles
				WHERE user_id IN (${inList(userIds)})`
		);
		for (const r of bioRows) {
			bios.set(String(r.user_id), textOrNull(r.bio));
			if (r.show_on_website === true) websiteOptIn.add(String(r.user_id));
		}
	}

	const offices = officeRows.map((r): OfficeData => ({
		id: String(r.id),
		name: String(r.name),
		description: textOrNull(r.description),
		position: Number(r.position ?? 0),
		emails: [],
		roleIds: [],
		holders: [],
		sourceModule: textOrNull(r.source_module),
		sourceKey: textOrNull(r.source_key),
		createdAt: iso(r.created_at),
		updatedAt: iso(r.updated_at)
	}));
	const byId = new Map(offices.map((o) => [o.id, o]));
	for (const r of emailRows) {
		byId.get(String(r.office_id))?.emails.push({
			id: String(r.id),
			label: textOrNull(r.label),
			email: String(r.email)
		});
	}
	for (const r of roleRows) byId.get(String(r.office_id))?.roleIds.push(String(r.role_id));
	for (const r of holderRows) {
		byId.get(String(r.office_id))?.holders.push({
			userId: String(r.user_id),
			since: textOrNull(r.since)
		});
	}
	return { offices, bios, websiteOptIn };
}

/** Ein Amt laden oder 404 */
export async function loadOfficeOr404(tx: Tx, id: string): Promise<OfficesData> {
	const data = await loadOffices(tx, [id]);
	if (data.offices.length === 0) throw errors.notFound('Amt nicht gefunden');
	return data;
}

function chunks<T>(list: readonly T[], size = DIRECTORY_CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

export interface DirectoryUserInfo {
	id: string;
	name: string;
	email: string;
	image: string | null;
}

/** Aktive Benutzer zu den IDs (über `core.users.byIds`) */
export async function usersByIds(
	ctx: RequestContext,
	ids: readonly string[]
): Promise<Map<string, DirectoryUserInfo>> {
	const map = new Map<string, DirectoryUserInfo>();
	for (const u of (await core.users.byIds(ctx, ids)).values()) {
		map.set(u.id, { id: u.id, name: u.name, email: u.email, image: u.image ?? null });
	}
	return map;
}

/** Rollen zu den IDs (über `core.roles.directory`, gestückelt) */
export async function rolesByIds(
	ctx: RequestContext,
	ids: readonly string[]
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	for (const part of chunks([...new Set(ids)])) {
		const found = await core.roles.directory(ctx, { ids: part, limit: DIRECTORY_CHUNK });
		for (const r of found) map.set(r.id, r.name);
	}
	return map;
}

/** Rohdaten zu DTOs: Rollen- und Personennamen auflösen (außerhalb der Transaktion) */
export async function buildOffices(ctx: RequestContext, data: OfficesData): Promise<Office[]> {
	const roleIds = data.offices.flatMap((o) => o.roleIds);
	const userIds = data.offices.flatMap((o) => o.holders.map((h) => h.userId));
	const [roles, users] = [await rolesByIds(ctx, roleIds), await usersByIds(ctx, userIds)];
	const templates = registeredTemplates();
	const enabled = new Map<string, boolean>();
	for (const m of new Set(data.offices.map((o) => o.sourceModule).filter((m) => m !== null))) {
		enabled.set(m, templates.has(m) && (await core.modules.isEnabled(m)));
	}
	const sourceOf = (o: OfficeData) => {
		if (!o.sourceModule || !o.sourceKey) return { source: null, notifications: [] };
		const info = templates.get(o.sourceModule);
		const notifications: OfficeNotificationInfo[] = enabled.get(o.sourceModule)
			? (info?.templates.get(o.sourceKey)?.notifications ?? []).map((n) => ({
					key: n.key,
					label: n.label,
					description: n.description ?? null
				}))
			: [];
		return {
			source: {
				module: o.sourceModule,
				moduleName: info?.moduleName ?? o.sourceModule,
				key: o.sourceKey
			},
			notifications
		};
	};
	return data.offices.map((o): Office => ({
		id: o.id,
		name: o.name,
		description: o.description,
		position: o.position,
		emails: o.emails,
		roles: o.roleIds
			.map((id) => ({ id, name: roles.get(id) ?? 'Unbekannte Rolle' }))
			.sort((a, b) => a.name.localeCompare(b.name, 'de')),
		holders: o.holders.map((h) => {
			const u = users.get(h.userId);
			return {
				userId: h.userId,
				name: u?.name ?? 'Unbekannt',
				image: u?.image ?? null,
				since: h.since,
				bio: data.bios.get(h.userId) ?? null
			};
		}),
		...sourceOf(o),
		createdAt: o.createdAt,
		updatedAt: o.updatedAt
	}));
}

export async function buildOffice(ctx: RequestContext, data: OfficesData): Promise<Office> {
	const [office] = await buildOffices(ctx, data);
	if (!office) throw errors.notFound('Amt nicht gefunden');
	return office;
}
