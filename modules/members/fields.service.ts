import { sql } from 'drizzle-orm';
import { core, errors, type RequestContext, type Tx } from '$lib/sdk/server';
import {
	formDefinitionSchema,
	validateFormValues,
	type FieldDefinition,
	type FormValue
} from '$lib/forms';
import type {
	LinkedMemberData,
	MemberContact,
	MemberFieldDefinition,
	MembersService
} from './contract';
import {
	FEE_LEVELS,
	MEMBER_FIELDS_MAX,
	MEMBER_FIELD_PRESETS,
	MEMBER_FIELD_TYPES,
	MODULE_ID,
	type MailCategory,
	type MemberFieldDef
} from './schemas';

type Row = Record<string, unknown>;
const mdb = () => core.database.forModule(MODULE_ID);

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Row[]> {
	return ((await tx.execute(query)) as unknown as { rows: Row[] }).rows;
}

const parseJson = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : (v as T));

// --- Definitionen -------------------------------------------------------------

export async function loadFieldDefs(tx: Tx): Promise<MemberFieldDef[]> {
	const found = await rows(
		tx,
		sql`SELECT key, active, preset, definition FROM member_field_defs ORDER BY position, key`
	);
	return found.map((r) => ({
		key: r.key as string,
		active: Boolean(r.active),
		preset: Boolean(r.preset),
		field: parseJson<FieldDefinition>(r.definition)
	}));
}

export const listFieldDefs = (): Promise<MemberFieldDef[]> => mdb().transaction(loadFieldDefs);

export async function listFieldDefinitions(): Promise<MemberFieldDefinition[]> {
	return (await listFieldDefs())
		.filter((d) => d.active)
		.map((d) => ({ key: d.key, field: d.field }));
}

/** Ersetzt die Liste der Zusatzfelder. Vorlagen bleiben erhalten (Schlüssel/Typ fest), eigene Felder sind frei. */
export async function putFieldDefs(
	ctx: RequestContext,
	input: { active: boolean; field: Record<string, unknown> }[]
): Promise<MemberFieldDef[]> {
	const parsed = formDefinitionSchema.safeParse({
		version: 1,
		fields: input.map((i) => i.field)
	});
	if (!parsed.success) {
		throw errors.validation(
			parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message }))
		);
	}
	const fields = parsed.data.fields as FieldDefinition[];
	const keys = new Set<string>();
	fields.forEach((f, i) => {
		if (!(MEMBER_FIELD_TYPES as readonly string[]).includes(f.type)) {
			throw errors.validation(
				{ [`fields.${i}.type`]: 'Feldtyp nicht erlaubt' },
				'Feldtyp nicht erlaubt'
			);
		}
		if (keys.has(f.key)) {
			throw errors.validation({ [`fields.${i}.key`]: 'Schlüssel doppelt' }, 'Schlüssel doppelt');
		}
		keys.add(f.key);
	});
	for (const p of MEMBER_FIELD_PRESETS) {
		if (!keys.has(p)) {
			throw errors.validation(
				{ fields: `Vordefiniertes Feld "${p}" darf nicht entfernt werden` },
				'Vordefinierte Felder dürfen nicht entfernt werden'
			);
		}
	}
	if (fields.length > MEMBER_FIELDS_MAX) throw errors.validation({ fields: 'Zu viele Felder' });

	const result = await mdb().transaction(async (tx) => {
		const current = await loadFieldDefs(tx);
		for (const d of current.filter((c) => c.preset)) {
			const next = fields.find((f) => f.key === d.key)!;
			if (next.type !== d.field.type) {
				throw errors.validation(
					{ fields: `Typ von "${d.key}" kann nicht geändert werden` },
					'Typ eines vordefinierten Feldes kann nicht geändert werden'
				);
			}
		}
		const keep = [...keys];
		await tx.execute(
			sql`DELETE FROM member_field_defs WHERE preset = false AND key NOT IN (${sql.join(
				keep.map((k) => sql`${k}`),
				sql`, `
			)})`
		);
		for (const [i, f] of fields.entries()) {
			// Antworten auf Zusatzfelder sind immer freiwillig; die Schlüsselfeld-ID entspricht dem Schlüssel
			const def = { ...f, id: f.key, required: false, locked: undefined, hidden: undefined };
			await tx.execute(
				sql`INSERT INTO member_field_defs (key, position, active, preset, definition)
					VALUES (${f.key}, ${i}, ${input[i]!.active}, ${(MEMBER_FIELD_PRESETS as readonly string[]).includes(f.key)}, ${JSON.stringify(def)}::jsonb)
					ON CONFLICT (key) DO UPDATE SET position = EXCLUDED.position, active = EXCLUDED.active,
						definition = EXCLUDED.definition`
			);
		}
		return loadFieldDefs(tx);
	});
	await core.audit.logFromContext(ctx, 'members.field.updated', {
		metadata: { count: fields.length }
	});
	return result;
}

// --- Werte ---------------------------------------------------------------------

/**
 * Prüft Werte gegen die AKTIVEN Zusatzfelder (unbekannte/inaktive Schlüssel → 422) und liefert die
 * bereinigten Werte (leere Eingaben → `null`).
 */
export async function validateCustomValues(
	tx: Tx,
	values: Record<string, unknown>
): Promise<Record<string, FormValue>> {
	const defs = (await loadFieldDefs(tx)).filter((d) => d.active);
	const unknown = Object.keys(values).filter((k) => !defs.some((d) => d.key === k));
	if (unknown.length) {
		throw errors.validation(
			Object.fromEntries(unknown.map((k) => [`custom.${k}`, 'Unbekanntes Feld'])),
			'Unbekanntes Zusatzfeld'
		);
	}
	const present = defs.filter((d) => d.key in values);
	const result = validateFormValues(
		{ version: 1, fields: present.map((d) => d.field) },
		values as Record<string, FormValue>
	);
	if (!result.ok) {
		throw errors.validation(
			Object.fromEntries(Object.entries(result.errors).map(([k, m]) => [`custom.${k}`, m])),
			'Ungültige Angaben in den Zusatzfeldern'
		);
	}
	return result.values;
}

/** Führt gespeicherte und neue Werte zusammen (neue überschreiben; `null` löscht). */
export function mergeCustom(
	stored: Record<string, FormValue>,
	next: Record<string, FormValue>
): Record<string, FormValue> {
	const out: Record<string, FormValue> = { ...stored };
	for (const [k, v] of Object.entries(next)) {
		if (v === null || v === '' || (Array.isArray(v) && v.length === 0)) delete out[k];
		else out[k] = v;
	}
	return out;
}

// --- Dienst für abhängige Module (Aktionen) ---------------------------------

async function linkedRows(tx: Tx, userId: string, memberId?: string): Promise<Row[]> {
	return rows(
		tx,
		memberId
			? sql`SELECT m.id, m.first_name, m.last_name, m.scout_name, to_char(m.birth_date, 'YYYY-MM-DD') AS birth_date,
					m.city, m.country, m.custom
				FROM member_user_links l JOIN members m ON m.id = l.member_id
				WHERE l.user_id = ${userId} AND l.member_id = ${memberId}`
			: sql`SELECT m.id, m.first_name, m.last_name, m.scout_name, to_char(m.birth_date, 'YYYY-MM-DD') AS birth_date,
					m.city, m.country, m.custom
				FROM member_user_links l JOIN members m ON m.id = l.member_id
				WHERE l.user_id = ${userId} ORDER BY m.last_name, m.first_name, m.id`
	);
}

/** Abgewählte Mail-Kategorien je Mitglied (nur Mitglieder mit mindestens einer Abwahl im Ergebnis) */
export async function loadMailOptOut(
	tx: Tx,
	memberIds: string[]
): Promise<Map<string, MailCategory[]>> {
	const out = new Map<string, MailCategory[]>();
	if (!memberIds.length) return out;
	const found = await rows(
		tx,
		sql`SELECT member_id, category FROM member_mail_prefs
			WHERE enabled = false AND member_id IN (${sql.join(
				memberIds.map((v) => sql`${v}`),
				sql`, `
			)}) ORDER BY category`
	);
	for (const r of found) {
		const id = r.member_id as string;
		out.set(id, [...(out.get(id) ?? []), r.category as MailCategory]);
	}
	return out;
}

async function toLinked(tx: Tx, list: Row[]): Promise<LinkedMemberData[]> {
	if (!list.length) return [];
	const ids = sql.join(
		list.map((r) => sql`${r.id as string}`),
		sql`, `
	);
	const groups = await rows(
		tx,
		sql`SELECT mg.member_id, g.id, g.name FROM member_groups mg JOIN groups g ON g.id = mg.group_id
			WHERE mg.member_id IN (${ids}) ORDER BY g.name`
	);
	const emails = await rows(
		tx,
		sql`SELECT member_id, name, value FROM member_emails WHERE member_id IN (${ids}) ORDER BY position, id`
	);
	const phones = await rows(
		tx,
		sql`SELECT member_id, name, value FROM member_phones WHERE member_id IN (${ids}) ORDER BY position, id`
	);
	const optOut = await loadMailOptOut(
		tx,
		list.map((r) => r.id as string)
	);
	const entries = (src: Row[], memberId: unknown) =>
		src
			.filter((e) => e.member_id === memberId)
			.map((e) => ({ name: (e.name as string | null) ?? null, value: e.value as string }));
	return list.map((r) => ({
		phones: entries(phones, r.id),
		emails: entries(emails, r.id),
		mailOptOut: optOut.get(r.id as string) ?? [],
		id: r.id as string,
		firstName: r.first_name as string,
		lastName: r.last_name as string,
		scoutName: (r.scout_name as string | null) ?? null,
		birthDate: r.birth_date as string,
		groups: groups
			.filter((g) => g.member_id === r.id)
			.map((g) => ({ id: g.id as string, name: g.name as string })),
		email: (emails.find((e) => e.member_id === r.id)?.value as string | undefined) ?? null,
		city: (r.city as string | null) ?? '',
		country: (r.country as string | null) ?? 'DE',
		custom: parseJson<Record<string, FormValue>>(r.custom ?? '{}')
	}));
}

async function memberContacts(
	tx: Tx,
	query: { ids?: string[]; search?: string; limit?: number }
): Promise<MemberContact[]> {
	const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 1000)), 1000);
	if (query.ids && !query.ids.length) return [];
	const search = query.search?.trim();
	const p = search ? `%${search.replace(/[\\%_]/g, '\\$&')}%` : '';
	const where = query.ids
		? sql`m.id IN (${sql.join(
				query.ids.slice(0, 1000).map((v) => sql`${v}`),
				sql`, `
			)})`
		: search
			? sql`(m.first_name ILIKE ${p} OR m.last_name ILIKE ${p} OR m.scout_name ILIKE ${p}
				OR (m.first_name || ' ' || m.last_name) ILIKE ${p})`
			: sql`TRUE`;
	const list = await rows(
		tx,
		sql`SELECT m.id, m.first_name, m.last_name, to_char(m.birth_date, 'YYYY-MM-DD') AS birth_date,
			m.street, m.postal_code, m.city,
			to_char(m.entry_date, 'YYYY-MM-DD') AS entry_date, to_char(m.exit_date, 'YYYY-MM-DD') AS exit_date,
			m.secondary_member, array_to_string(m.fee_levels, ',') AS fee_levels
			FROM members m WHERE ${where}
			ORDER BY m.last_name, m.first_name, m.id LIMIT ${limit}`
	);
	if (!list.length) return [];
	const emails = await rows(
		tx,
		sql`SELECT member_id, value FROM member_emails WHERE member_id IN (${sql.join(
			list.map((r) => sql`${r.id as string}`),
			sql`, `
		)}) ORDER BY position, id`
	);
	const optOut = await loadMailOptOut(
		tx,
		list.map((r) => r.id as string)
	);
	return list.map((r) => ({
		mailOptOut: optOut.get(r.id as string) ?? [],
		id: r.id as string,
		firstName: r.first_name as string,
		lastName: r.last_name as string,
		birthDate: r.birth_date as string,
		emails: emails.filter((e) => e.member_id === r.id).map((e) => e.value as string),
		street: (r.street as string | null) ?? '',
		postalCode: (r.postal_code as string | null) ?? '',
		city: (r.city as string | null) ?? '',
		entryDate: (r.entry_date as string | null) ?? null,
		exitDate: (r.exit_date as string | null) ?? null,
		secondaryMember: Boolean(r.secondary_member),
		feeLevels: r.secondary_member
			? FEE_LEVELS.filter((f) =>
					String(r.fee_levels ?? '')
						.split(',')
						.includes(f)
				)
			: [...FEE_LEVELS]
	}));
}

/**
 * `listMemberSheets` (`sheets.service.ts`, Importzyklus vermeiden) und die Freigabe-Dienste
 * (`principals.service.ts`) ergänzt `module.ts`.
 */
export const membersService: Omit<
	MembersService,
	'listMemberSheets' | 'listGroups' | 'principalIdsForUser' | 'searchMembers'
> = {
	listMemberContacts(query) {
		return mdb().transaction((tx) => memberContacts(tx, query));
	},

	async listLinkedMembers(ctx) {
		if (!ctx.userId) throw errors.unauthenticated();
		const userId = ctx.userId;
		return mdb().transaction(async (tx) => toLinked(tx, await linkedRows(tx, userId)));
	},

	async getLinkedMember(ctx, memberId) {
		if (!ctx.userId) throw errors.unauthenticated();
		const userId = ctx.userId;
		const found = await mdb().transaction(async (tx) =>
			toLinked(tx, await linkedRows(tx, userId, memberId))
		);
		if (!found[0]) throw errors.notFound('Mitglied nicht gefunden');
		return found[0];
	},

	async updateMemberFields(ctx, memberId, values) {
		if (!ctx.userId) throw errors.unauthenticated();
		const userId = ctx.userId;
		const changed = await mdb().transaction(async (tx) => {
			const link = await rows(
				tx,
				sql`SELECT m.custom FROM member_user_links l JOIN members m ON m.id = l.member_id
					WHERE l.user_id = ${userId} AND l.member_id = ${memberId} FOR UPDATE OF m`
			);
			if (!link[0]) throw errors.notFound('Mitglied nicht gefunden');
			const stored = parseJson<Record<string, FormValue>>(link[0].custom ?? '{}');
			const clean = await validateCustomValues(tx, values);
			const next = mergeCustom(stored, clean);
			const keys = Object.keys(clean).filter(
				(k) => JSON.stringify(stored[k] ?? null) !== JSON.stringify(next[k] ?? null)
			);
			if (keys.length) {
				await tx.execute(
					sql`UPDATE members SET custom = ${JSON.stringify(next)}::jsonb, updated_at = now() WHERE id = ${memberId}`
				);
			}
			return keys;
		});
		if (changed.length) {
			await core.audit.logFromContext(ctx, 'members.member.fields_updated', {
				target: memberId,
				metadata: { memberId, keys: changed }
			});
		}
		return changed;
	},

	listFieldDefinitions
};
