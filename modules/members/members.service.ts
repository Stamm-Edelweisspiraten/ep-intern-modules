import { sql } from 'drizzle-orm';
import {
	core,
	errors,
	isCoreError,
	logBestEffort,
	moduleDb,
	type RequestContext,
	type Row,
	rowsOf,
	toIso,
	type Tx
} from '$lib/sdk/server';
import { mergeCustom, validateCustomValues } from './fields.service';
import {
	MODULE_ID,
	type BulkInput,
	type BulkResult,
	type ConsentRecord,
	type ContactEntry,
	type GroupRef,
	FEE_LEVELS,
	type FeeLevel,
	type Member,
	type MemberInput,
	type MemberList,
	type Stage
} from './schemas';

const proof = (at: unknown, by: unknown): ConsentRecord | null =>
	at == null ? null : { at: toIso(at), by: by == null ? null : String(by) };

/** Erfassende Person für den Einwilligungsnachweis */
export function consentActor(ctx: RequestContext): string {
	return ctx.userId ?? `${ctx.actor.type}:${ctx.actor.id}`;
}

/**
 * SET-Teil für eine Einwilligung: Wert setzen und – nur bei tatsächlicher Änderung – Zeitpunkt und
 * erfassende Person (rechte Seite einer UPDATE-Zuweisung sieht den alten Wert).
 */
export function consentSet(
	column: 'consent_social_media' | 'consent_website' | 'consent_print',
	value: boolean,
	by: string
) {
	const col = sql.raw(column);
	const at = sql.raw(`${column}_at`);
	const who = sql.raw(`${column}_by`);
	return sql`${col} = ${value},
		${at} = CASE WHEN ${col} IS DISTINCT FROM ${value} THEN now() ELSE ${at} END,
		${who} = CASE WHEN ${col} IS DISTINCT FROM ${value} THEN ${by} ELSE ${who} END`;
}

const contact = (r: Row): ContactEntry => ({
	name: (r.name as string | null) ?? null,
	value: r.value as string
});

const MEMBER_COLUMNS = sql`m.id, m.first_name, m.last_name, m.scout_name,
	to_char(m.birth_date, 'YYYY-MM-DD') AS birth_date, m.street, m.postal_code, m.city, m.country, m.stage,
	m.consent_social_media, m.consent_website, m.consent_print,
	m.consent_social_media_at, m.consent_social_media_by, m.consent_website_at, m.consent_website_by,
	m.consent_print_at, m.consent_print_by, m.anonymized_at,
	m.privacy_consent_name, m.registration_name, m.created_at, m.updated_at,
		(SELECT count(*)::int FROM member_user_links l WHERE l.member_id = m.id) AS link_count, m.custom,
	to_char(m.entry_date, 'YYYY-MM-DD') AS entry_date, to_char(m.exit_date, 'YYYY-MM-DD') AS exit_date,
	m.secondary_member, array_to_string(m.fee_levels, ',') AS fee_levels`;

/** `text[]` als kommagetrennter String (treiberunabhängig) → Ebenen in fester Reihenfolge */
export function parseFeeLevels(v: unknown): FeeLevel[] {
	const list = String(v ?? '').split(',');
	return FEE_LEVELS.filter((f) => list.includes(f));
}

/** Nicht-Zweitmitglieder zahlen immer alle Ebenen bei uns */
function storedFeeLevels(input: MemberInput): FeeLevel[] {
	return input.secondaryMember ? input.feeLevels : [...FEE_LEVELS];
}

const feeLevelsSql = (levels: FeeLevel[]) =>
	sql`ARRAY[${sql.join(
		levels.map((l) => sql`${l}`),
		sql`, `
	)}]::text[]`;

/** Baut Member-DTOs für die geladenen Zeilen (Telefone, E-Mails, Gruppen in Reihenfolge). */
async function hydrate(tx: Tx, list: Row[]): Promise<Member[]> {
	if (!list.length) return [];
	const ids = sql.join(
		list.map((r) => sql`${r.id as string}`),
		sql`, `
	);
	const phones = await rowsOf(
		tx,
		sql`SELECT member_id, name, value FROM member_phones WHERE member_id IN (${ids}) ORDER BY position, id`
	);
	const emails = await rowsOf(
		tx,
		sql`SELECT member_id, name, value FROM member_emails WHERE member_id IN (${ids}) ORDER BY position, id`
	);
	const groups = await rowsOf(
		tx,
		sql`SELECT mg.member_id, g.id, g.name, g.type, g.color FROM member_groups mg
			JOIN groups g ON g.id = mg.group_id WHERE mg.member_id IN (${ids}) ORDER BY g.name`
	);
	return list.map((r) => {
		const id = r.id as string;
		return {
			id,
			firstName: r.first_name as string,
			lastName: r.last_name as string,
			scoutName: (r.scout_name as string | null) ?? null,
			birthDate: r.birth_date as string,
			street: (r.street as string | null) ?? '',
			postalCode: (r.postal_code as string | null) ?? '',
			city: (r.city as string | null) ?? '',
			country: (r.country as string | null) ?? 'DE',
			phones: phones.filter((p) => p.member_id === id).map(contact),
			emails: emails.filter((p) => p.member_id === id).map(contact),
			stage: r.stage as Stage,
			groups: groups
				.filter((g) => g.member_id === id)
				.map((g) => ({ id: g.id, name: g.name, type: g.type, color: g.color ?? null }) as GroupRef),
			consentSocialMedia: Boolean(r.consent_social_media),
			consentWebsite: Boolean(r.consent_website),
			consentPrint: Boolean(r.consent_print),
			consentProof: {
				socialMedia: proof(r.consent_social_media_at, r.consent_social_media_by),
				website: proof(r.consent_website_at, r.consent_website_by),
				print: proof(r.consent_print_at, r.consent_print_by)
			},
			anonymizedAt: r.anonymized_at == null ? null : toIso(r.anonymized_at),
			privacyConsent: r.privacy_consent_name ? { name: r.privacy_consent_name as string } : null,
			registration: r.registration_name ? { name: r.registration_name as string } : null,
			entryDate: (r.entry_date as string | null) ?? null,
			exitDate: (r.exit_date as string | null) ?? null,
			secondaryMember: Boolean(r.secondary_member),
			feeLevels: r.secondary_member ? parseFeeLevels(r.fee_levels) : [...FEE_LEVELS],
			linkCount: Number(r.link_count ?? 0),
			custom: (typeof r.custom === 'string'
				? JSON.parse(r.custom)
				: (r.custom ?? {})) as Member['custom'],
			createdAt: toIso(r.created_at),
			updatedAt: toIso(r.updated_at)
		};
	});
}

/** Lädt ein Member-DTO innerhalb einer Modul-Transaktion; null, wenn nicht vorhanden. */
export async function loadMember(tx: Tx, id: string): Promise<Member | null> {
	const found = await rowsOf(tx, sql`SELECT ${MEMBER_COLUMNS} FROM members m WHERE m.id = ${id}`);
	return (await hydrate(tx, found))[0] ?? null;
}

/** Lädt Member-DTOs zu IDs (Reihenfolge wie `ids`, unbekannte entfallen). */
export async function loadMembersByIds(tx: Tx, ids: string[]): Promise<Member[]> {
	if (!ids.length) return [];
	const list = sql.join(
		ids.map((i) => sql`${i}`),
		sql`, `
	);
	const found = await hydrate(
		tx,
		await rowsOf(tx, sql`SELECT ${MEMBER_COLUMNS} FROM members m WHERE m.id IN (${list})`)
	);
	return ids.map((i) => found.find((m) => m.id === i)).filter((m): m is Member => !!m);
}

/** Lädt ein Member-DTO in eigener Modul-Transaktion; wirft 404. */
export async function getMember(id: string): Promise<Member> {
	const m = await moduleDb(MODULE_ID).transaction((tx) => loadMember(tx, id));
	if (!m) throw errors.notFound('Mitglied nicht gefunden');
	return m;
}

export async function listMembers(query: {
	search?: string;
	stage?: Stage;
	groupId?: string;
	status?: 'active' | 'left' | 'all';
	limit: number;
	offset: number;
}): Promise<MemberList> {
	return moduleDb(MODULE_ID).transaction(async (tx) => {
		const conds = [sql`TRUE`];
		if (query.search) {
			const p = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`;
			conds.push(
				sql`(m.first_name ILIKE ${p} OR m.last_name ILIKE ${p} OR m.scout_name ILIKE ${p})`
			);
		}
		if (query.stage) conds.push(sql`m.stage = ${query.stage}`);
		if (query.groupId)
			conds.push(
				sql`EXISTS (SELECT 1 FROM member_groups mg WHERE mg.member_id = m.id AND mg.group_id = ${query.groupId})`
			);
		const status = query.status ?? 'active';
		if (status === 'active') conds.push(sql`(m.exit_date IS NULL OR m.exit_date > CURRENT_DATE)`);
		else if (status === 'left') conds.push(sql`m.exit_date <= CURRENT_DATE`);
		const where = sql.join(conds, sql` AND `);
		const total = await rowsOf(tx, sql`SELECT count(*)::int AS n FROM members m WHERE ${where}`);
		const found = await rowsOf(
			tx,
			sql`SELECT ${MEMBER_COLUMNS} FROM members m WHERE ${where}
				ORDER BY m.last_name, m.first_name, m.id LIMIT ${query.limit} OFFSET ${query.offset}`
		);
		return { items: await hydrate(tx, found), total: Number(total[0]?.n ?? 0) };
	});
}

async function checkGroups(tx: Tx, groupIds: string[]): Promise<string[]> {
	const unique = [...new Set(groupIds)];
	if (unique.length) {
		const ids = sql.join(
			unique.map((g) => sql`${g}`),
			sql`, `
		);
		const found = await rowsOf(tx, sql`SELECT id FROM groups WHERE id IN (${ids})`);
		if (found.length !== unique.length) {
			throw errors.validation({ groupIds: 'Unbekannte Gruppe' }, 'Unbekannte Gruppe');
		}
	}
	return unique;
}

async function writeRelations(tx: Tx, id: string, input: MemberInput, groupIds: string[]) {
	await tx.execute(sql`DELETE FROM member_phones WHERE member_id = ${id}`);
	await tx.execute(sql`DELETE FROM member_emails WHERE member_id = ${id}`);
	await tx.execute(sql`DELETE FROM member_groups WHERE member_id = ${id}`);
	for (const [i, p] of input.phones.entries()) {
		await tx.execute(
			sql`INSERT INTO member_phones (id, member_id, name, value, position) VALUES (${crypto.randomUUID()}, ${id}, ${p.name}, ${p.value}, ${i})`
		);
	}
	for (const [i, p] of input.emails.entries()) {
		await tx.execute(
			sql`INSERT INTO member_emails (id, member_id, name, value, position) VALUES (${crypto.randomUUID()}, ${id}, ${p.name}, ${p.value}, ${i})`
		);
	}
	for (const g of groupIds) {
		await tx.execute(sql`INSERT INTO member_groups (member_id, group_id) VALUES (${id}, ${g})`);
	}
}

export async function createMember(ctx: RequestContext, input: MemberInput): Promise<Member> {
	const id = crypto.randomUUID();
	const member = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const groupIds = await checkGroups(tx, input.groupIds);
		const custom = mergeCustom({}, await validateCustomValues(tx, input.custom));
		await tx.execute(
			sql`INSERT INTO members (id, first_name, last_name, scout_name, birth_date, street, postal_code, city, country, stage,
				consent_social_media, consent_website, consent_print, custom, entry_date, exit_date, secondary_member, fee_levels)
				VALUES (${id}, ${input.firstName}, ${input.lastName}, ${input.scoutName}, ${input.birthDate}::date,
				${input.street}, ${input.postalCode}, ${input.city}, ${input.country}, ${input.stage}, ${input.consentSocialMedia}, ${input.consentWebsite}, ${input.consentPrint}, ${JSON.stringify(custom)}::jsonb,
				${input.entryDate}::date, ${input.exitDate}::date, ${input.secondaryMember}, ${feeLevelsSql(storedFeeLevels(input))})`
		);
		await writeRelations(tx, id, input, groupIds);
		// Einwilligungsnachweis: erteilte Einwilligungen mit Zeitpunkt und erfassender Person
		const by = consentActor(ctx);
		await tx.execute(
			sql`UPDATE members SET
				consent_social_media_at = CASE WHEN consent_social_media THEN now() END,
				consent_social_media_by = CASE WHEN consent_social_media THEN ${by} END,
				consent_website_at = CASE WHEN consent_website THEN now() END,
				consent_website_by = CASE WHEN consent_website THEN ${by} END,
				consent_print_at = CASE WHEN consent_print THEN now() END,
				consent_print_by = CASE WHEN consent_print THEN ${by} END
				WHERE id = ${id}`
		);
		return (await loadMember(tx, id))!;
	});
	await core.audit.logFromContext(ctx, 'members.member.created', {
		target: id
		// Keine Klarnamen im unveränderlichen Audit (#26): die ID in `target` genügt
	});
	return member;
}

export async function updateMember(
	ctx: RequestContext,
	id: string,
	input: MemberInput
): Promise<Member> {
	const member = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const exists = await rowsOf(
			tx,
			sql`SELECT id, custom FROM members WHERE id = ${id} FOR UPDATE`
		);
		if (!exists.length) throw errors.notFound('Mitglied nicht gefunden');
		const groupIds = await checkGroups(tx, input.groupIds);
		const stored = exists[0]!.custom;
		const custom = mergeCustom(
			(typeof stored === 'string' ? JSON.parse(stored) : (stored ?? {})) as Member['custom'],
			await validateCustomValues(tx, input.custom)
		);
		await tx.execute(
			sql`UPDATE members SET first_name = ${input.firstName}, last_name = ${input.lastName},
				scout_name = ${input.scoutName}, birth_date = ${input.birthDate}::date, street = ${input.street}, postal_code = ${input.postalCode}, city = ${input.city},
					country = ${input.country}, address = NULL, custom = ${JSON.stringify(custom)}::jsonb,
				stage = ${input.stage},
				${consentSet('consent_social_media', input.consentSocialMedia, consentActor(ctx))},
				${consentSet('consent_website', input.consentWebsite, consentActor(ctx))},
				${consentSet('consent_print', input.consentPrint, consentActor(ctx))},
				entry_date = ${input.entryDate}::date, exit_date = ${input.exitDate}::date,
				secondary_member = ${input.secondaryMember}, fee_levels = ${feeLevelsSql(storedFeeLevels(input))},
				updated_at = now() WHERE id = ${id}`
		);
		await writeRelations(tx, id, input, groupIds);
		return (await loadMember(tx, id))!;
	});
	await core.audit.logFromContext(ctx, 'members.member.updated', {
		target: id
		// Keine Klarnamen im unveränderlichen Audit (#26): die ID in `target` genügt
	});
	return member;
}

/**
 * Sammelaktion auf markierten Mitgliedern. Nicht vorhandene IDs → 404 (nichts wird geändert);
 * Mitglieder, bei denen die Regeln verletzt würden (letzte Gruppe, einziger Leiter), werden
 * übersprungen und mit Grund gemeldet. Audit ohne Namen (nur Aktion und Zähler).
 */
export async function bulkUpdateMembers(
	ctx: RequestContext,
	input: BulkInput
): Promise<BulkResult> {
	if (input.action === 'delete') return bulkDelete(ctx, input.ids);

	const result = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const idList = sql.join(
			input.ids.map((i) => sql`${i}`),
			sql`, `
		);
		const found = await rowsOf(
			tx,
			sql`SELECT id, first_name, last_name FROM members WHERE id IN (${idList}) ORDER BY id FOR UPDATE`
		);
		if (found.length !== input.ids.length) throw errors.notFound('Mitglied nicht gefunden');
		const skipped: BulkResult['skipped'] = [];
		let affected = 0;

		if (input.action === 'add-groups' || input.action === 'remove-groups') {
			const groupIds = [...new Set(input.groupIds)];
			const gList = sql.join(
				groupIds.map((g) => sql`${g}`),
				sql`, `
			);
			const known = await rowsOf(tx, sql`SELECT id FROM groups WHERE id IN (${gList})`);
			if (known.length !== groupIds.length) {
				throw errors.validation({ groupIds: 'Unbekannte Gruppe' }, 'Unbekannte Gruppe');
			}
			for (const memberId of input.ids) {
				if (input.action === 'add-groups') {
					const before = Number(
						(
							await rowsOf(
								tx,
								sql`SELECT count(*)::int AS n FROM member_groups WHERE member_id = ${memberId}`
							)
						)[0]?.n ?? 0
					);
					for (const g of groupIds) {
						await tx.execute(
							sql`INSERT INTO member_groups (member_id, group_id) VALUES (${memberId}, ${g}) ON CONFLICT DO NOTHING`
						);
					}
					const after = Number(
						(
							await rowsOf(
								tx,
								sql`SELECT count(*)::int AS n FROM member_groups WHERE member_id = ${memberId}`
							)
						)[0]?.n ?? 0
					);
					if (after !== before) affected++;
					continue;
				}
				// Entfernen (Gruppen sind optional, auch die letzte darf entfallen)
				const current = (
					await rowsOf(tx, sql`SELECT group_id FROM member_groups WHERE member_id = ${memberId}`)
				).map((r) => r.group_id as string);
				const toRemove = current.filter((g) => groupIds.includes(g));
				if (!toRemove.length) continue;
				const rList = sql.join(
					toRemove.map((g) => sql`${g}`),
					sql`, `
				);
				await tx.execute(
					sql`DELETE FROM member_groups WHERE member_id = ${memberId} AND group_id IN (${rList})`
				);
				affected++;
			}
			await tx.execute(sql`UPDATE members SET updated_at = now() WHERE id IN (${idList})`);
		} else if (input.action === 'set-stage') {
			await tx.execute(
				sql`UPDATE members SET stage = ${input.stage}, updated_at = now() WHERE id IN (${idList})`
			);
			affected = input.ids.length;
		} else {
			const c = input.consent;
			const sets = [
				c.consentSocialMedia !== undefined
					? consentSet('consent_social_media', c.consentSocialMedia, consentActor(ctx))
					: null,
				c.consentWebsite !== undefined
					? consentSet('consent_website', c.consentWebsite, consentActor(ctx))
					: null,
				c.consentPrint !== undefined
					? consentSet('consent_print', c.consentPrint, consentActor(ctx))
					: null,
				sql`updated_at = now()`
			].filter((s): s is ReturnType<typeof sql> => s !== null);
			await tx.execute(sql`UPDATE members SET ${sql.join(sets, sql`, `)} WHERE id IN (${idList})`);
			affected = input.ids.length;
		}
		return { affected, skipped };
	});
	await core.audit.logFromContext(ctx, 'members.member.bulk_updated', {
		metadata: {
			action: input.action,
			requested: input.ids.length,
			affected: result.affected,
			skipped: result.skipped.length
		}
	});
	return result;
}

async function bulkDelete(ctx: RequestContext, ids: string[]): Promise<BulkResult> {
	const skipped: BulkResult['skipped'] = [];
	let affected = 0;
	for (const id of ids) {
		const existing = await moduleDb(MODULE_ID).transaction((tx) => loadMember(tx, id));
		if (!existing) throw errors.notFound('Mitglied nicht gefunden');
		try {
			await deleteMember(ctx, id);
			affected++;
		} catch (e) {
			if (isCoreError(e) && e.status === 409) {
				skipped.push({ id, name: `${existing.firstName} ${existing.lastName}`, reason: e.message });
			} else throw e;
		}
	}
	await core.audit.logFromContext(ctx, 'members.member.bulk_updated', {
		metadata: { action: 'delete', requested: ids.length, affected, skipped: skipped.length }
	});
	return { affected, skipped };
}

export async function deleteMember(ctx: RequestContext, id: string): Promise<void> {
	const { paths } = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const found = await rowsOf(
			tx,
			sql`SELECT privacy_consent_path, registration_path
				FROM members WHERE id = ${id} FOR UPDATE`
		);
		const m = found[0];
		if (!m) throw errors.notFound('Mitglied nicht gefunden');
		const sole = await rowsOf(
			tx,
			sql`SELECT g.name FROM group_leaders gl JOIN groups g ON g.id = gl.group_id
				WHERE gl.member_id = ${id}
				AND NOT EXISTS (SELECT 1 FROM group_leaders o WHERE o.group_id = gl.group_id AND o.member_id <> ${id})`
		);
		if (sole.length) {
			throw errors.conflict(
				`Mitglied ist einziger Leiter der Gruppe ${sole.map((s) => s.name).join(', ')} und kann nicht gelöscht werden`
			);
		}
		await tx.execute(sql`DELETE FROM group_leaders WHERE member_id = ${id}`);
		await tx.execute(sql`DELETE FROM members WHERE id = ${id}`);
		return {
			paths: [m.privacy_consent_path, m.registration_path].filter(
				(p): p is string => typeof p === 'string' && p.length > 0
			)
		};
	});
	await removeMemberFiles(ctx, paths);
	// Kopien in anderen Modulen aufräumen (z. B. `actions`: verknüpfte Teilnehmende anonymisieren)
	await core.modules.memberDeleted(MODULE_ID, { memberIds: [id], reason: 'deleted' });
	// Ohne Namen: gelöschte Personen sollen über das Audit nicht namentlich auffindbar bleiben (#26)
	await core.audit.logFromContext(ctx, 'members.member.deleted', { target: id });
}

/**
 * Dokumente entfernen (best-effort). Fehlschläge werden protokolliert (ohne Pfad/Name), damit
 * verwaiste Dateien auffallen; der Löschvorgang selbst scheitert daran nicht.
 */
export async function removeMemberFiles(ctx: RequestContext, paths: string[]): Promise<number> {
	let failed = 0;
	for (const path of paths) {
		try {
			await core.storage.remove(ctx, { module: MODULE_ID, path });
		} catch (err) {
			failed++;
			// Ohne Pfad/Name protokollieren (verwaiste Dateien sollen auffallen)
			logBestEffort('members.member.document-cleanup', err, { ctx });
		}
	}
	return failed;
}
