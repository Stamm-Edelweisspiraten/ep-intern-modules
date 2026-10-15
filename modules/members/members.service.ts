import { sql } from 'drizzle-orm';
import { core, errors, type RequestContext, type Tx } from '$lib/sdk/server';
import {
	MODULE_ID,
	type ContactEntry,
	type GroupRef,
	type Member,
	type MemberInput,
	type MemberList,
	type Stage
} from './schemas';

type Row = Record<string, unknown>;

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Row[]> {
	const res = (await tx.execute(query)) as unknown as { rows: Row[] };
	return res.rows;
}

/** pg liefert Date, PGlite Strings: immer als ISO-String ausgeben */
const iso = (v: unknown): string => {
	const d = v instanceof Date ? v : new Date(String(v));
	return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

const contact = (r: Row): ContactEntry => ({
	name: (r.name as string | null) ?? null,
	value: r.value as string
});

const MEMBER_COLUMNS = sql`m.id, m.first_name, m.last_name, m.scout_name,
	to_char(m.birth_date, 'YYYY-MM-DD') AS birth_date, m.address, m.stage,
	m.consent_social_media, m.consent_website, m.consent_print,
	m.privacy_consent_name, m.registration_name, m.created_at, m.updated_at`;

/** Baut Member-DTOs fuer die geladenen Zeilen (Telefone, E-Mails, Gruppen in Reihenfolge). */
async function hydrate(tx: Tx, list: Row[]): Promise<Member[]> {
	if (!list.length) return [];
	const ids = sql.join(
		list.map((r) => sql`${r.id as string}`),
		sql`, `
	);
	const phones = await rows(
		tx,
		sql`SELECT member_id, name, value FROM member_phones WHERE member_id IN (${ids}) ORDER BY position, id`
	);
	const emails = await rows(
		tx,
		sql`SELECT member_id, name, value FROM member_emails WHERE member_id IN (${ids}) ORDER BY position, id`
	);
	const groups = await rows(
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
			address: r.address as string,
			phones: phones.filter((p) => p.member_id === id).map(contact),
			emails: emails.filter((p) => p.member_id === id).map(contact),
			stage: r.stage as Stage,
			groups: groups
				.filter((g) => g.member_id === id)
				.map((g) => ({ id: g.id, name: g.name, type: g.type, color: g.color ?? null }) as GroupRef),
			consentSocialMedia: Boolean(r.consent_social_media),
			consentWebsite: Boolean(r.consent_website),
			consentPrint: Boolean(r.consent_print),
			privacyConsent: r.privacy_consent_name ? { name: r.privacy_consent_name as string } : null,
			registration: r.registration_name ? { name: r.registration_name as string } : null,
			createdAt: iso(r.created_at),
			updatedAt: iso(r.updated_at)
		};
	});
}

/** Laedt ein Member-DTO innerhalb einer Modul-Transaktion; null, wenn nicht vorhanden. */
export async function loadMember(tx: Tx, id: string): Promise<Member | null> {
	const found = await rows(tx, sql`SELECT ${MEMBER_COLUMNS} FROM members m WHERE m.id = ${id}`);
	return (await hydrate(tx, found))[0] ?? null;
}

/** Laedt ein Member-DTO in eigener Modul-Transaktion; wirft 404. */
export async function getMember(id: string): Promise<Member> {
	const m = await core.database.forModule(MODULE_ID).transaction((tx) => loadMember(tx, id));
	if (!m) throw errors.notFound('Mitglied nicht gefunden');
	return m;
}

export async function listMembers(query: {
	search?: string;
	stage?: Stage;
	groupId?: string;
	limit: number;
	offset: number;
}): Promise<MemberList> {
	return core.database.forModule(MODULE_ID).transaction(async (tx) => {
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
		const where = sql.join(conds, sql` AND `);
		const total = await rows(tx, sql`SELECT count(*)::int AS n FROM members m WHERE ${where}`);
		const found = await rows(
			tx,
			sql`SELECT ${MEMBER_COLUMNS} FROM members m WHERE ${where}
				ORDER BY m.last_name, m.first_name, m.id LIMIT ${query.limit} OFFSET ${query.offset}`
		);
		return { items: await hydrate(tx, found), total: Number(total[0]?.n ?? 0) };
	});
}

async function checkGroups(tx: Tx, groupIds: string[]): Promise<string[]> {
	const unique = [...new Set(groupIds)];
	const count = Number((await rows(tx, sql`SELECT count(*)::int AS n FROM groups`))[0]?.n ?? 0);
	if (count > 0 && unique.length === 0) {
		throw errors.validation(
			{ groupIds: 'Mindestens eine Gruppe ist erforderlich' },
			'Mindestens eine Gruppe ist erforderlich'
		);
	}
	if (unique.length) {
		const ids = sql.join(
			unique.map((g) => sql`${g}`),
			sql`, `
		);
		const found = await rows(tx, sql`SELECT id FROM groups WHERE id IN (${ids})`);
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
	const member = await core.database.forModule(MODULE_ID).transaction(async (tx) => {
		const groupIds = await checkGroups(tx, input.groupIds);
		await tx.execute(
			sql`INSERT INTO members (id, first_name, last_name, scout_name, birth_date, address, stage,
				consent_social_media, consent_website, consent_print)
				VALUES (${id}, ${input.firstName}, ${input.lastName}, ${input.scoutName}, ${input.birthDate}::date,
				${input.address}, ${input.stage}, ${input.consentSocialMedia}, ${input.consentWebsite}, ${input.consentPrint})`
		);
		await writeRelations(tx, id, input, groupIds);
		return (await loadMember(tx, id))!;
	});
	await core.audit.logFromContext(ctx, 'members.member.created', {
		target: id,
		metadata: { name: `${member.firstName} ${member.lastName}` }
	});
	return member;
}

export async function updateMember(
	ctx: RequestContext,
	id: string,
	input: MemberInput
): Promise<Member> {
	const member = await core.database.forModule(MODULE_ID).transaction(async (tx) => {
		const exists = await rows(tx, sql`SELECT id FROM members WHERE id = ${id} FOR UPDATE`);
		if (!exists.length) throw errors.notFound('Mitglied nicht gefunden');
		const groupIds = await checkGroups(tx, input.groupIds);
		await tx.execute(
			sql`UPDATE members SET first_name = ${input.firstName}, last_name = ${input.lastName},
				scout_name = ${input.scoutName}, birth_date = ${input.birthDate}::date, address = ${input.address},
				stage = ${input.stage}, consent_social_media = ${input.consentSocialMedia},
				consent_website = ${input.consentWebsite}, consent_print = ${input.consentPrint},
				updated_at = now() WHERE id = ${id}`
		);
		await writeRelations(tx, id, input, groupIds);
		return (await loadMember(tx, id))!;
	});
	await core.audit.logFromContext(ctx, 'members.member.updated', {
		target: id,
		metadata: { name: `${member.firstName} ${member.lastName}` }
	});
	return member;
}

export async function deleteMember(ctx: RequestContext, id: string): Promise<void> {
	const { name, paths } = await core.database.forModule(MODULE_ID).transaction(async (tx) => {
		const found = await rows(
			tx,
			sql`SELECT first_name, last_name, privacy_consent_path, registration_path
				FROM members WHERE id = ${id} FOR UPDATE`
		);
		const m = found[0];
		if (!m) throw errors.notFound('Mitglied nicht gefunden');
		const sole = await rows(
			tx,
			sql`SELECT g.name FROM group_leaders gl JOIN groups g ON g.id = gl.group_id
				WHERE gl.member_id = ${id}
				AND NOT EXISTS (SELECT 1 FROM group_leaders o WHERE o.group_id = gl.group_id AND o.member_id <> ${id})`
		);
		if (sole.length) {
			throw errors.conflict(
				`Mitglied ist einziger Leiter der Gruppe ${sole.map((s) => s.name).join(', ')} und kann nicht geloescht werden`
			);
		}
		await tx.execute(sql`DELETE FROM group_leaders WHERE member_id = ${id}`);
		await tx.execute(sql`DELETE FROM members WHERE id = ${id}`);
		return {
			name: `${m.first_name} ${m.last_name}`,
			paths: [m.privacy_consent_path, m.registration_path].filter(
				(p): p is string => typeof p === 'string' && p.length > 0
			)
		};
	});
	for (const path of paths) {
		try {
			await core.storage.remove(ctx, { module: MODULE_ID, path });
		} catch {
			// best-effort
		}
	}
	await core.audit.logFromContext(ctx, 'members.member.deleted', {
		target: id,
		metadata: { name }
	});
}
