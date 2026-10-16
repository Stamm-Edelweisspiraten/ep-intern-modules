import { sql } from 'drizzle-orm';
import {
	core,
	errors,
	isCoreError,
	type PdfGenerateInput,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import {
	codesMatch,
	isAdult,
	formatLinkCode,
	generateLinkCode,
	generateLinkToken,
	linkExpiry,
	linkUrl,
	recipientLines
} from './link';
import {
	LINK_DEFAULT_ROLE,
	LINK_LOCK_MINUTES,
	LINK_MAX_FAILED_ATTEMPTS,
	MODULE_ID,
	type LinkedUser,
	type MemberLinks,
	type MyMember,
	type PublicLinkInfo
} from './schemas';

type Row = Record<string, unknown>;
const mdb = () => core.database.forModule(MODULE_ID);
const crypt = () => core.crypto.forModule(MODULE_ID);

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Row[]> {
	return ((await tx.execute(query)) as unknown as { rows: Row[] }).rows;
}
/** pg liefert Date, PGlite Strings */
const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

export const LINK_NOT_AVAILABLE = 'Dieser Link ist nicht mehr gültig.';
export const LINK_CODE_REJECTED = 'Der Code ist ungültig oder vorübergehend gesperrt.';

// --- Code und Brief (angemeldet) ---------------------------------------------

export interface LinkCode {
	token: string;
	code: string;
	expiresAt: Date;
	created: boolean;
}

/**
 * Liefert den gültigen Code eines Mitglieds. Fehlt er, ist er abgelaufen oder wird `regenerate`
 * verlangt, entsteht ein neuer (neues Token, alter Link/QR wird ungültig, Zähler zurückgesetzt).
 */
export async function ensureLinkCode(
	ctx: RequestContext,
	memberId: string,
	opts: { regenerate?: boolean } = {}
): Promise<LinkCode> {
	const result = await mdb().transaction(async (tx) => {
		const m = await rows(tx, sql`SELECT id FROM members WHERE id = ${memberId} FOR UPDATE`);
		if (!m.length) throw errors.notFound('Mitglied nicht gefunden');
		const cur = (
			await rows(
				tx,
				sql`SELECT token, code_enc, expires_at FROM member_link_codes WHERE member_id = ${memberId}`
			)
		)[0];
		if (cur && !opts.regenerate && toDate(cur.expires_at).getTime() > Date.now()) {
			return {
				token: cur.token as string,
				code: crypt().decrypt(cur.code_enc as string),
				expiresAt: toDate(cur.expires_at),
				created: false
			};
		}
		const token = generateLinkToken();
		const code = generateLinkCode();
		const expiresAt = linkExpiry();
		await tx.execute(
			sql`INSERT INTO member_link_codes (member_id, token, code_enc, expires_at, created_by)
				VALUES (${memberId}, ${token}, ${crypt().encrypt(code)}, ${expiresAt.toISOString()}, ${ctx.userId})
				ON CONFLICT (member_id) DO UPDATE SET token = EXCLUDED.token, code_enc = EXCLUDED.code_enc,
					expires_at = EXCLUDED.expires_at, failed_attempts = 0, locked_until = NULL,
					created_at = now(), created_by = EXCLUDED.created_by`
		);
		return { token, code, expiresAt, created: true };
	});
	if (result.created) {
		await core.audit.logFromContext(ctx, 'members.link.code_created', {
			target: memberId,
			metadata: { memberId, regenerate: Boolean(opts.regenerate) }
		});
	}
	return result;
}

/**
 * Baut den Brief je Mitglied (Vorlage mit Adressfeld, QR-Code, Link, Code) und liefert ein PDF;
 * bei mehreren Mitgliedern ein zusammengeführtes PDF in der Reihenfolge der IDs.
 */
export async function buildLinkLetters(
	ctx: RequestContext,
	ids: string[]
): Promise<{ buffer: Uint8Array; fileName: string }> {
	const members = await mdb().transaction(async (tx) => {
		const idList = sql.join(
			ids.map((i) => sql`${i}`),
			sql`, `
		);
		const found = await rows(
			tx,
			sql`SELECT id, first_name, last_name, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
				street, postal_code, city, country FROM members WHERE id IN (${idList})`
		);
		if (found.length !== ids.length) throw errors.notFound('Mitglied nicht gefunden');
		return ids.map((i) => found.find((m) => m.id === i)!);
	});
	const systemName = String((await core.settings.get('core.system.name')) ?? 'EP Intern');
	const origin = core.app.origin();

	const inputs: PdfGenerateInput[] = [];
	for (const m of members) {
		const link = await ensureLinkCode(ctx, m.id as string);
		const first = m.first_name as string;
		const adult = isAdult(m.birth_date as string);
		const url = linkUrl(origin, link.token);
		const validUntil = link.expiresAt.toLocaleDateString('de-DE', {
			day: '2-digit',
			month: '2-digit',
			year: 'numeric'
		});
		inputs.push({
			template: 'stamm-brief',
			title: 'Konto verknüpfen',
			recipient: recipientLines({
				firstName: first,
				lastName: m.last_name as string,
				birthDate: m.birth_date as string,
				street: (m.street as string | null) ?? '',
				postalCode: (m.postal_code as string | null) ?? '',
				city: (m.city as string | null) ?? '',
				country: (m.country as string | null) ?? 'DE'
			}),
			content: [
				{ type: 'paragraph', text: 'Guten Tag,' },
				{
					type: 'paragraph',
					text: adult
						? `Mit einem Benutzerkonto in ${systemName} können Sie Ihre Mitgliedschaft künftig online verwalten, z. B. bei Anmeldungen zu Aktionen. Dazu verknüpfen Sie Ihr Konto einmalig mit Ihrem Mitgliedsprofil.`
						: `Mit einem Benutzerkonto in ${systemName} können Sie ${first} ${m.last_name} künftig online verwalten, z. B. bei Anmeldungen zu Aktionen. Dazu verknüpfen Sie Ihr Konto einmalig mit dem Mitglied.`
				},
				{
					type: 'box',
					image: {
						dataUrl: await core.qr.dataUrl(url, { widthPx: 500 }),
						widthMm: 36,
						alt: 'QR-Code zur Verknüpfung'
					},
					label: 'Ihr Verknüpfungscode',
					value: formatLinkCode(link.code),
					lines: [`gültig bis ${validUntil}`],
					linkLabel: 'Ohne Kamera: diese Adresse im Browser öffnen',
					link: { href: url, text: url.replace(/^https?:\/\//, '') }
				},
				{ type: 'heading', level: 3, text: 'So geht’s' },
				{
					type: 'list',
					ordered: true,
					items: [
						'QR-Code mit der Handykamera scannen oder die Adresse im Browser öffnen.',
						'Den Verknüpfungscode eingeben.',
						'Mit Ihrem Konto anmelden oder ein neues Konto anlegen – fertig.'
					]
				},
				{ type: 'heading', level: 3, text: 'Gut zu wissen' },
				{
					type: 'list',
					items: [
						...(adult
							? []
							: [
									'Mehrere Personen (z. B. beide Elternteile) können den Code nutzen, jede mit einem eigenen Konto.'
								]),
						'Bitte geben Sie den Code nicht an Dritte weiter.'
					]
				},
				{ type: 'paragraph', text: 'Viele Grüße und Gut Pfad!' }
			]
		});
	}
	const title = 'Konto verknüpfen';
	const result =
		inputs.length === 1
			? await core.pdf.generate(ctx, { ...inputs[0]!, title })
			: await core.pdf.generateMany(ctx, inputs, title);
	await core.audit.logFromContext(ctx, 'members.link.letters_generated', {
		metadata: { count: ids.length }
	});
	return { buffer: result.buffer, fileName: result.fileName };
}

// --- Verknüpfungen verwalten -------------------------------------------------

export async function listMemberLinks(ctx: RequestContext, memberId: string): Promise<MemberLinks> {
	const { links, code } = await mdb().transaction(async (tx) => {
		const m = await rows(tx, sql`SELECT id FROM members WHERE id = ${memberId}`);
		if (!m.length) throw errors.notFound('Mitglied nicht gefunden');
		return {
			links: await rows(
				tx,
				sql`SELECT user_id, relation, created_at FROM member_user_links
					WHERE member_id = ${memberId} ORDER BY created_at, user_id`
			),
			code: (
				await rows(
					tx,
					sql`SELECT expires_at, locked_until FROM member_link_codes WHERE member_id = ${memberId}`
				)
			)[0]
		};
	});
	const dir = links.length
		? await core.users.directory(ctx, { ids: links.map((l) => l.user_id as string), limit: 30 })
		: [];
	const users: LinkedUser[] = links.map((l) => {
		const u = dir.find((d) => d.id === l.user_id);
		return {
			id: l.user_id as string,
			name: u?.name ?? 'Unbekannt (Konto deaktiviert)',
			email: u?.email ?? null,
			relation: (l.relation as string | null) ?? null,
			linkedAt: toDate(l.created_at).toISOString()
		};
	});
	const now = Date.now();
	return {
		users,
		code: code
			? {
					expiresAt: toDate(code.expires_at).toISOString(),
					expired: toDate(code.expires_at).getTime() <= now,
					locked: code.locked_until != null && toDate(code.locked_until).getTime() > now
				}
			: null
	};
}

export async function unlinkUser(
	ctx: RequestContext,
	memberId: string,
	userId: string
): Promise<void> {
	const removed = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`DELETE FROM member_user_links WHERE member_id = ${memberId} AND user_id = ${userId} RETURNING user_id`
		)
	);
	if (!removed.length) throw errors.notFound('Verknüpfung nicht gefunden');
	await core.audit.logFromContext(ctx, 'members.link.removed', {
		target: memberId,
		metadata: { memberId, userId }
	});
}

export async function myMembers(ctx: RequestContext): Promise<MyMember[]> {
	if (!ctx.userId) throw errors.unauthenticated();
	const userId = ctx.userId;
	const found = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT m.id, m.first_name, m.last_name, m.scout_name, l.relation
				FROM member_user_links l JOIN members m ON m.id = l.member_id
				WHERE l.user_id = ${userId} ORDER BY m.last_name, m.first_name, m.id`
		)
	);
	return found.map((r) => ({
		id: r.id as string,
		firstName: r.first_name as string,
		lastName: r.last_name as string,
		scoutName: (r.scout_name as string | null) ?? null,
		relation: (r.relation as string | null) ?? null
	}));
}

// --- Öffentlicher Ablauf (Link + Code) --------------------------------------

async function loadByToken(tx: Tx, token: string, lock = false) {
	const found = await rows(
		tx,
		lock
			? sql`SELECT c.member_id, c.code_enc, c.expires_at, c.failed_attempts, c.locked_until,
					m.first_name, m.last_name
				FROM member_link_codes c JOIN members m ON m.id = c.member_id
				WHERE c.token = ${token} FOR UPDATE OF c`
			: sql`SELECT c.member_id, c.expires_at, m.first_name, m.last_name
				FROM member_link_codes c JOIN members m ON m.id = c.member_id WHERE c.token = ${token}`
	);
	const r = found[0];
	if (!r || toDate(r.expires_at).getTime() <= Date.now()) return null;
	return r;
}

/** Öffentliche Basisinfo zum Link (nur Vorname, nichts weiter). */
export async function publicLinkInfo(ctx: RequestContext, token: string): Promise<PublicLinkInfo> {
	const r = await mdb().transaction((tx) => loadByToken(tx, token));
	if (!r) throw errors.notFound(LINK_NOT_AVAILABLE);
	return {
		memberFirstName: r.first_name as string,
		viewer: ctx.userId ? { name: ctx.actor.name } : null
	};
}

/**
 * Prüft den Code gegen den Link. Falsche Eingaben zählen je Mitglied; nach
 * `LINK_MAX_FAILED_ATTEMPTS` ist der Code `LINK_LOCK_MINUTES` Minuten gesperrt. Der Zähler wird
 * VOR dem Werfen committet (Fehler außerhalb der Transaktion).
 */
async function verifyCode(
	token: string,
	code: string
): Promise<{ memberId: string; firstName: string }> {
	const outcome = await mdb().transaction(async (tx) => {
		const r = await loadByToken(tx, token, true);
		if (!r) return { status: 'unavailable' as const };
		if (r.locked_until != null && toDate(r.locked_until).getTime() > Date.now()) {
			return { status: 'rejected' as const };
		}
		const memberId = r.member_id as string;
		if (codesMatch(crypt().decrypt(r.code_enc as string), code)) {
			if (Number(r.failed_attempts) > 0 || r.locked_until != null) {
				await tx.execute(
					sql`UPDATE member_link_codes SET failed_attempts = 0, locked_until = NULL WHERE member_id = ${memberId}`
				);
			}
			return { status: 'ok' as const, memberId, firstName: r.first_name as string };
		}
		const failed = Number(r.failed_attempts) + 1;
		if (failed >= LINK_MAX_FAILED_ATTEMPTS) {
			const until = new Date(Date.now() + LINK_LOCK_MINUTES * 60_000).toISOString();
			await tx.execute(
				sql`UPDATE member_link_codes SET failed_attempts = 0, locked_until = ${until} WHERE member_id = ${memberId}`
			);
		} else {
			await tx.execute(
				sql`UPDATE member_link_codes SET failed_attempts = ${failed} WHERE member_id = ${memberId}`
			);
		}
		return { status: 'rejected' as const };
	});
	if (outcome.status === 'unavailable') throw errors.notFound(LINK_NOT_AVAILABLE);
	if (outcome.status === 'rejected') throw errors.forbidden(LINK_CODE_REJECTED);
	return { memberId: outcome.memberId, firstName: outcome.firstName };
}

async function addLink(memberId: string, userId: string, relation: string | null, by: string) {
	await mdb().transaction((tx) =>
		tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation, created_by)
				VALUES (${memberId}, ${userId}, ${relation}, ${by})
				ON CONFLICT (member_id, user_id) DO UPDATE
				SET relation = COALESCE(EXCLUDED.relation, member_user_links.relation)`
		)
	);
}

/** Angemeldetes Konto per Code mit dem Mitglied verknüpfen (idempotent). */
export async function claimLink(
	ctx: RequestContext,
	token: string,
	input: { code: string; relation: string | null }
): Promise<{ memberFirstName: string }> {
	if (!ctx.userId) throw errors.unauthenticated('Bitte melde dich zuerst an.');
	const { memberId, firstName } = await verifyCode(token, input.code);
	await addLink(memberId, ctx.userId, input.relation, ctx.userId);
	await core.audit.logFromContext(ctx, 'members.link.created', {
		target: memberId,
		metadata: { memberId }
	});
	return { memberFirstName: firstName };
}

/** Neues Konto (Rolle „Mitglied“) per Code anlegen und mit dem Mitglied verknüpfen. */
export async function registerWithLink(
	ctx: RequestContext,
	token: string,
	input: { code: string; name: string; email: string; password: string; relation: string | null }
): Promise<{ memberFirstName: string }> {
	const { memberId, firstName } = await verifyCode(token, input.code);
	let userId: string;
	try {
		userId = await core.users.registerWithRole({
			name: input.name,
			email: input.email,
			password: input.password,
			roleName: LINK_DEFAULT_ROLE
		});
	} catch (e) {
		if (isCoreError(e) && e.status === 409) {
			throw errors.conflict(
				'Mit dieser E-Mail-Adresse gibt es bereits ein Konto. Bitte melde dich an und verknüpfe dein Konto dann mit dem Code.'
			);
		}
		throw e;
	}
	await addLink(memberId, userId, input.relation, userId);
	await core.audit.log({
		action: 'members.link.registered',
		actor: { type: 'system', id: 'public-link', name: 'Verknüpfungslink' },
		target: memberId,
		ip: ctx.ip,
		requestId: ctx.requestId,
		metadata: { memberId, userId }
	});
	return { memberFirstName: firstName };
}
