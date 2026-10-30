import { sql } from 'drizzle-orm';
import {
	core,
	errors,
	isCoreError,
	moduleDb,
	type PdfGenerateInput,
	type RequestContext,
	rowsOf,
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
import { loadMailOptOut, membersService } from './fields.service';
import { assertCanGrantLeader, syncLeaderGrantsAfterChange } from './leader.service';
import { linkTokenValues, storedToken, tokenMatchSql } from './link-tokens';
import {
	LINK_DEFAULT_ROLE,
	LINK_LOCK_MINUTES,
	LINK_MAX_FAILED_ATTEMPTS,
	MODULE_ID,
	NOTIFY_ACCOUNT_LINKED,
	SENSITIVE_FIELD_KEYS,
	type ContactEntry,
	type LinkedUser,
	type MailCategory,
	type MyFieldDefinition,
	type MemberLinks,
	type MyMember,
	type PublicLinkInfo
} from './schemas';

const crypt = () => core.crypto.forModule(MODULE_ID);

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
 * Bis zum Ablauf lässt sich ein Code beliebig oft nutzen (jede Verknüpfung informiert die bisherigen Konten).
 */
export async function ensureLinkCode(
	ctx: RequestContext,
	memberId: string,
	opts: { regenerate?: boolean } = {}
): Promise<LinkCode> {
	const result = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const m = await rowsOf(tx, sql`SELECT id FROM members WHERE id = ${memberId} FOR UPDATE`);
		if (!m.length) throw errors.notFound('Mitglied nicht gefunden');
		const cur = (
			await rowsOf(
				tx,
				sql`SELECT token, token_enc, code_enc, expires_at FROM member_link_codes WHERE member_id = ${memberId}`
			)
		)[0];
		const curToken = cur ? storedToken(cur) : null;
		// Abgelaufene und nicht entschlüsselbare Codes werden ersetzt
		if (cur && curToken && !opts.regenerate && toDate(cur.expires_at).getTime() > Date.now()) {
			return {
				token: curToken,
				code: crypt().decrypt(cur.code_enc as string),
				expiresAt: toDate(cur.expires_at),
				created: false
			};
		}
		const token = generateLinkToken();
		const stored = linkTokenValues(token);
		const code = generateLinkCode();
		const expiresAt = linkExpiry();
		await tx.execute(
			sql`INSERT INTO member_link_codes (member_id, token_hash, token_enc, code_enc, expires_at, created_by, use_count)
				VALUES (${memberId}, ${stored.hash}, ${stored.enc}, ${crypt().encrypt(code)}, ${expiresAt.toISOString()}, ${ctx.userId}, 0)
				ON CONFLICT (member_id) DO UPDATE SET token = NULL, token_hash = EXCLUDED.token_hash,
					token_enc = EXCLUDED.token_enc, code_enc = EXCLUDED.code_enc,
					expires_at = EXCLUDED.expires_at, failed_attempts = 0, locked_until = NULL,
					use_count = 0, max_uses = NULL,
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
	const members = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const idList = sql.join(
			ids.map((i) => sql`${i}`),
			sql`, `
		);
		const found = await rowsOf(
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
									'Mehrere Personen (z. B. beide Elternteile) können den Code bis zum Ablauf nutzen, jede mit einem eigenen Konto. Bereits verknüpfte Konten werden bei jeder weiteren Verknüpfung per E-Mail informiert.'
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
	const { links, code } = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const m = await rowsOf(tx, sql`SELECT id FROM members WHERE id = ${memberId}`);
		if (!m.length) throw errors.notFound('Mitglied nicht gefunden');
		return {
			links: await rowsOf(
				tx,
				sql`SELECT user_id, relation, is_self, created_at FROM member_user_links
					WHERE member_id = ${memberId} ORDER BY created_at, user_id`
			),
			code: (
				await rowsOf(
					tx,
					sql`SELECT expires_at, locked_until, use_count FROM member_link_codes WHERE member_id = ${memberId}`
				)
			)[0]
		};
	});
	const dir = links.length
		? await core.users.directory(ctx, {
				ids: links.map((l) => l.user_id as string),
				limit: 30,
				// Endpunkt verlangt members.link.view: Adresse identifiziert das verknüpfte Konto
				includeEmail: true
			})
		: [];
	const users: LinkedUser[] = links.map((l) => {
		const u = dir.find((d) => d.id === l.user_id);
		return {
			id: l.user_id as string,
			name: u?.name ?? 'Unbekannt (Konto deaktiviert)',
			email: u?.email ?? null,
			relation: (l.relation as string | null) ?? null,
			self: l.is_self === true || l.is_self === 't',
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
					locked: code.locked_until != null && toDate(code.locked_until).getTime() > now,
					uses: Number(code.use_count)
				}
			: null
	};
}

/**
 * Konto per Hand mit einem Mitglied verknüpfen (Verwaltung, ohne Brief/Code). Nur aktive Konten;
 * bereits verknüpft → 409. Rollen werden nicht verändert.
 */
export async function linkUserManually(
	ctx: RequestContext,
	memberId: string,
	input: { userId: string; relation: string | null }
): Promise<MemberLinks> {
	// Core-Aufruf vor der Transaktion (PGlite hat nur eine Sitzung)
	const [user] = await core.users.directory(ctx, { ids: [input.userId], limit: 1 });
	if (!user) {
		throw errors.validation(
			[{ path: ['userId'], message: 'Konto nicht gefunden oder deaktiviert' }],
			'Konto nicht gefunden oder deaktiviert'
		);
	}
	await moduleDb(MODULE_ID).transaction(async (tx) => {
		const m = await rowsOf(tx, sql`SELECT id FROM members WHERE id = ${memberId}`);
		if (!m.length) throw errors.notFound('Mitglied nicht gefunden');
		const inserted = await rowsOf(
			tx,
			sql`INSERT INTO member_user_links (member_id, user_id, relation, created_by)
				VALUES (${memberId}, ${user.id}, ${input.relation}, ${ctx.userId ?? ctx.actor.id})
				ON CONFLICT (member_id, user_id) DO NOTHING
				RETURNING user_id`
		);
		if (!inserted.length) throw errors.conflict('Dieses Konto ist bereits verknüpft');
	});
	await core.audit.logFromContext(ctx, 'members.link.created', {
		target: memberId,
		metadata: { memberId, userId: user.id, manual: true }
	});
	return listMemberLinks(ctx, memberId);
}

export async function unlinkUser(
	ctx: RequestContext,
	memberId: string,
	userId: string
): Promise<void> {
	const removed = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`DELETE FROM member_user_links WHERE member_id = ${memberId} AND user_id = ${userId} RETURNING user_id`
		)
	);
	if (!removed.length) throw errors.notFound('Verknüpfung nicht gefunden');
	await syncLeaderGrantsAfterChange(ctx);
	await core.audit.logFromContext(ctx, 'members.link.removed', {
		target: memberId,
		metadata: { memberId, userId }
	});
}

/**
 * Verknüpftes Konto als **eigenes Konto** des Mitglieds markieren (oder die Markierung lösen). Nur
 * eigene Konten erhalten bei einer Gruppenleitung die Rolle „Gruppenleitung“ – Eltern nicht. Je Konto
 * und je Mitglied höchstens eine Markierung (409). Leitet das Mitglied eine Gruppe, braucht die
 * handelnde Person alle Rechte der Rolle (403).
 */
export async function setLinkSelf(
	ctx: RequestContext,
	memberId: string,
	userId: string,
	self: boolean
): Promise<MemberLinks> {
	if (self) await assertCanGrantLeader(ctx, [memberId], 'becomesSelf');
	const changed = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const link = await rowsOf(
			tx,
			sql`SELECT is_self FROM member_user_links
				WHERE member_id = ${memberId} AND user_id = ${userId} FOR UPDATE`
		);
		if (!link.length) throw errors.notFound('Verknüpfung nicht gefunden');
		const before = link[0]!.is_self === true || link[0]!.is_self === 't';
		if (before === self) return false;
		if (self) {
			const taken = await rowsOf(
				tx,
				sql`SELECT member_id, user_id FROM member_user_links
					WHERE is_self AND (user_id = ${userId} OR member_id = ${memberId})`
			);
			if (taken.some((t) => t.user_id === userId)) {
				throw errors.conflict(
					'Dieses Konto ist bereits als eigenes Konto eines anderen Mitglieds markiert'
				);
			}
			if (taken.length) {
				throw errors.conflict('Für dieses Mitglied ist bereits ein anderes eigenes Konto markiert');
			}
		}
		await tx.execute(
			sql`UPDATE member_user_links SET is_self = ${self}
				WHERE member_id = ${memberId} AND user_id = ${userId}`
		);
		return true;
	});
	if (changed) {
		await syncLeaderGrantsAfterChange(ctx);
		await core.audit.logFromContext(ctx, 'members.link.self-changed', {
			target: memberId,
			metadata: { memberId, userId, self }
		});
	}
	return listMemberLinks(ctx, memberId);
}

export async function myMembers(ctx: RequestContext): Promise<MyMember[]> {
	if (!ctx.userId) throw errors.unauthenticated();
	const userId = ctx.userId;
	const found = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT m.id, l.relation FROM member_user_links l JOIN members m ON m.id = l.member_id
				WHERE l.user_id = ${userId} ORDER BY m.last_name, m.first_name, m.id`
		)
	);
	const data = await membersService.listLinkedMembers(ctx);
	return found.flatMap((r) => {
		const d = data.find((x) => x.id === r.id);
		if (!d) return [];
		return [
			{
				id: d.id,
				firstName: d.firstName,
				lastName: d.lastName,
				scoutName: d.scoutName,
				relation: (r.relation as string | null) ?? null,
				birthDate: d.birthDate,
				groups: d.groups,
				phones: d.phones,
				emails: d.emails,
				custom: d.custom,
				mailOptOut: d.mailOptOut
			}
		];
	});
}

/** Aktive Zusatzfelder; Gesundheitsfelder sind als `sensitive` markiert */
export async function myFieldDefinitions(): Promise<{ fields: MyFieldDefinition[] }> {
	const defs = await membersService.listFieldDefinitions();
	return {
		fields: defs.map((d) => ({
			key: d.key,
			field: d.field,
			sensitive: SENSITIVE_FIELD_KEYS.includes(d.key)
		}))
	};
}

const phoneKey = (v: string) => v.replace(/[^\d+]/g, '');

/**
 * Eltern ändern Telefone/E-Mails eines verknüpften Mitglieds. Der Link-JOIN mit `FOR UPDATE` ist die
 * Besitzprüfung (fremd → 404). Angefasst werden NUR `member_phones`/`member_emails`. Gab es vorher
 * mindestens eine E-Mail, muss mindestens eine bleiben (die Kasse braucht eine Adresse).
 */
export async function updateLinkedContacts(
	ctx: RequestContext,
	memberId: string,
	input: { phones: ContactEntry[]; emails: ContactEntry[] }
): Promise<{ phones: ContactEntry[]; emails: ContactEntry[] }> {
	if (!ctx.userId) throw errors.unauthenticated();
	const userId = ctx.userId;
	const counts = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const link = await rowsOf(
			tx,
			sql`SELECT m.id, m.first_name FROM member_user_links l JOIN members m ON m.id = l.member_id
				WHERE l.user_id = ${userId} AND l.member_id = ${memberId} FOR UPDATE OF m`
		);
		if (!link[0]) throw errors.notFound('Mitglied nicht gefunden');
		const oldPhones = await rowsOf(
			tx,
			sql`SELECT value FROM member_phones WHERE member_id = ${memberId}`
		);
		const oldEmails = await rowsOf(
			tx,
			sql`SELECT value FROM member_emails WHERE member_id = ${memberId}`
		);
		if (oldEmails.length > 0 && input.emails.length === 0) {
			throw errors.validation(
				{ emails: 'Mindestens eine E-Mail-Adresse muss bleiben' },
				'Mindestens eine E-Mail-Adresse muss bleiben'
			);
		}
		await tx.execute(sql`DELETE FROM member_phones WHERE member_id = ${memberId}`);
		await tx.execute(sql`DELETE FROM member_emails WHERE member_id = ${memberId}`);
		for (const [i, p] of input.phones.entries()) {
			await tx.execute(
				sql`INSERT INTO member_phones (id, member_id, name, value, position)
					VALUES (${crypto.randomUUID()}, ${memberId}, ${p.name}, ${p.value}, ${i})`
			);
		}
		for (const [i, p] of input.emails.entries()) {
			await tx.execute(
				sql`INSERT INTO member_emails (id, member_id, name, value, position)
					VALUES (${crypto.randomUUID()}, ${memberId}, ${p.name}, ${p.value}, ${i})`
			);
		}
		const diff = (before: string[], after: string[]) => ({
			added: after.filter((v) => !before.includes(v)).length,
			removed: before.filter((v) => !after.includes(v)).length
		});
		const ph = diff(
			oldPhones.map((r) => phoneKey(r.value as string)),
			input.phones.map((p) => phoneKey(p.value))
		);
		const em = diff(
			oldEmails.map((r) => r.value as string),
			input.emails.map((p) => p.value)
		);
		return {
			phonesAdded: ph.added,
			phonesRemoved: ph.removed,
			emailsAdded: em.added,
			emailsRemoved: em.removed,
			oldEmails: oldEmails.map((r) => String(r.value)),
			firstName: String(link[0].first_name ?? '')
		};
	});
	const { oldEmails, firstName, ...auditCounts } = counts;
	await core.audit.logFromContext(ctx, 'members.member.contacts_updated', {
		target: memberId,
		metadata: { memberId, ...auditCounts }
	});
	// Änderte sich die E-Mail-Liste, warnen wir die BISHERIGEN Adressen (ohne die neuen zu nennen).
	// Nach der Transaktion; Mailfehler dürfen das Speichern nie scheitern lassen.
	if (auditCounts.emailsAdded + auditCounts.emailsRemoved > 0 && oldEmails.length) {
		const systemName = String((await core.settings.get('core.system.name')) ?? 'EP Intern');
		for (const to of [...new Set(oldEmails.map((e) => e.toLowerCase()))]) {
			try {
				await core.mail.send({
					to,
					subject: `${systemName}: E-Mail-Adressen geändert`,
					text: `Die E-Mail-Adressen von ${firstName} wurden über ein verknüpftes Konto geändert. Warst du das nicht, melde dich bei der Stammesleitung.`
				});
			} catch (err) {
				console.error(
					'[members] Hinweismail zur Kontaktänderung fehlgeschlagen:',
					(err as Error)?.message
				);
			}
		}
	}
	return { phones: input.phones, emails: input.emails };
}

/**
 * Schaltet eine abschaltbare Mail-Kategorie für ein Mitglied an/aus. Nur Abwahlen werden gespeichert
 * (an = Zeile löschen). `own`: nur verknüpfte Mitglieder des Kontos (fremd → 404), sonst jedes Mitglied.
 */
export async function setMailPref(
	ctx: RequestContext,
	memberId: string,
	category: MailCategory,
	enabled: boolean,
	own: boolean
): Promise<{ mailOptOut: MailCategory[] }> {
	if (own && !ctx.userId) throw errors.unauthenticated();
	const userId = ctx.userId;
	const result = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const found = own
			? await rowsOf(
					tx,
					sql`SELECT m.id FROM member_user_links l JOIN members m ON m.id = l.member_id
						WHERE l.user_id = ${userId} AND l.member_id = ${memberId} FOR UPDATE OF m`
				)
			: await rowsOf(tx, sql`SELECT id FROM members WHERE id = ${memberId} FOR UPDATE`);
		if (!found[0]) throw errors.notFound('Mitglied nicht gefunden');
		if (enabled) {
			await tx.execute(
				sql`DELETE FROM member_mail_prefs WHERE member_id = ${memberId} AND category = ${category}`
			);
		} else {
			await tx.execute(
				sql`INSERT INTO member_mail_prefs (member_id, category, enabled, updated_at, updated_by)
					VALUES (${memberId}, ${category}, false, now(), ${userId})
					ON CONFLICT (member_id, category) DO UPDATE
					SET enabled = false, updated_at = now(), updated_by = EXCLUDED.updated_by`
			);
		}
		return (await loadMailOptOut(tx, [memberId])).get(memberId) ?? [];
	});
	await core.audit.logFromContext(ctx, 'members.member.mail_pref_updated', {
		target: memberId,
		metadata: { memberId, category, enabled }
	});
	return { mailOptOut: result };
}

// --- Öffentlicher Ablauf (Link + Code) --------------------------------------

/** Code zum Token; abgelaufen → `null` („nicht mehr gültig“). Bis zum Ablauf beliebig oft nutzbar. */
async function loadByToken(tx: Tx, token: string, lock = false) {
	const found = await rowsOf(
		tx,
		lock
			? sql`SELECT c.member_id, c.code_enc, c.expires_at, c.failed_attempts, c.locked_until,
					m.first_name, m.last_name
				FROM member_link_codes c JOIN members m ON m.id = c.member_id
				WHERE ${tokenMatchSql(token)} FOR UPDATE OF c`
			: sql`SELECT c.member_id, c.expires_at, m.first_name, m.last_name
				FROM member_link_codes c JOIN members m ON m.id = c.member_id WHERE ${tokenMatchSql(token)}`
	);
	const r = found[0];
	if (!r || toDate(r.expires_at).getTime() <= Date.now()) return null;
	return r;
}

/** Öffentliche Basisinfo zum Link (nur Vorname, nichts weiter). */
export async function publicLinkInfo(ctx: RequestContext, token: string): Promise<PublicLinkInfo> {
	const r = await moduleDb(MODULE_ID).transaction((tx) => loadByToken(tx, token));
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
 *
 * Bei Erfolg wird die Nutzung gezählt (`use_count + 1`, nur zur Anzeige) – außer das Konto `userId`
 * ist schon verknüpft (wiederholtes Einlösen bleibt idempotent). Der Link bleibt bis zum Ablauf gültig.
 */
async function verifyCode(
	token: string,
	code: string,
	userId: string | null
): Promise<{ memberId: string; firstName: string; consumed: boolean }> {
	const outcome = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const r = await loadByToken(tx, token, true);
		if (!r) return { status: 'unavailable' as const };
		if (r.locked_until != null && toDate(r.locked_until).getTime() > Date.now()) {
			return { status: 'rejected' as const };
		}
		const memberId = r.member_id as string;
		if (codesMatch(crypt().decrypt(r.code_enc as string), code)) {
			const already = userId
				? (
						await rowsOf(
							tx,
							sql`SELECT 1 FROM member_user_links WHERE member_id = ${memberId} AND user_id = ${userId}`
						)
					).length > 0
				: false;
			await tx.execute(
				sql`UPDATE member_link_codes SET failed_attempts = 0, locked_until = NULL,
					use_count = use_count + ${already ? 0 : 1} WHERE member_id = ${memberId}`
			);
			return {
				status: 'ok' as const,
				memberId,
				firstName: r.first_name as string,
				consumed: !already
			};
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
	return { memberId: outcome.memberId, firstName: outcome.firstName, consumed: outcome.consumed };
}

/** Gezählte Nutzung zurücknehmen (Registrierung scheiterte nach erfolgreicher Code-Prüfung). */
async function releaseUse(memberId: string): Promise<void> {
	await moduleDb(MODULE_ID).transaction((tx) =>
		tx.execute(
			sql`UPDATE member_link_codes SET use_count = GREATEST(use_count - 1, 0) WHERE member_id = ${memberId}`
		)
	);
}

/** Konten, die außer `exceptUserId` mit dem Mitglied verknüpft sind. */
async function otherLinkedUserIds(memberId: string, exceptUserId: string): Promise<string[]> {
	const found = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT user_id FROM member_user_links WHERE member_id = ${memberId} AND user_id <> ${exceptUserId}`
		)
	);
	return found.map((r) => String(r.user_id));
}

/**
 * Hinweis an alle bisher verknüpften Konten, dass ein weiteres Konto verknüpft wurde (nur Vorname,
 * keine Daten des neuen Kontos). Nach der Transaktion; Mailfehler brechen die Verknüpfung nie ab.
 * Liefert die Zahl der informierten Konten.
 */
async function notifyLinkedAccounts(
	memberId: string,
	firstName: string,
	newUserId: string
): Promise<number> {
	const others = await otherLinkedUserIds(memberId, newUserId);
	if (!others.length) return 0;
	const systemName = String((await core.settings.get('core.system.name')) ?? 'EP Intern');
	const r = await core.notifications.send(core.auth.systemContext('members-link'), MODULE_ID, [
		{
			type: NOTIFY_ACCOUNT_LINKED,
			userIds: others,
			title: `${systemName}: Weiteres Konto mit ${firstName} verknüpft`,
			body: `Über den Verknüpfungsbrief wurde soeben ein weiteres Konto mit ${firstName} verknüpft. Dieses Konto kann Kontakte und weitere Angaben von ${firstName} sehen und ändern.

War das nicht abgesprochen, melde dich bitte umgehend bei der Stammesleitung, damit die Verknüpfung gelöst und ein neuer Brief erstellt wird.`,
			pushBody: `Ein weiteres Konto kann jetzt die Angaben von ${firstName} sehen. Nicht abgesprochen? Bitte bei der Stammesleitung melden.`,
			link: '/profile?tab=members%3Amembers'
		}
	]);
	return r.email + r.push;
}

async function addLink(memberId: string, userId: string, relation: string | null, by: string) {
	await moduleDb(MODULE_ID).transaction((tx) =>
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
	const { memberId, firstName, consumed } = await verifyCode(token, input.code, ctx.userId);
	await addLink(memberId, ctx.userId, input.relation, ctx.userId);
	const notified = consumed ? await notifyLinkedAccounts(memberId, firstName, ctx.userId) : 0;
	await core.audit.logFromContext(ctx, 'members.link.created', {
		target: memberId,
		metadata: { memberId, viaCode: true, repeated: !consumed, notified }
	});
	return { memberFirstName: firstName };
}

/** Neues Konto (Rolle „Mitglied“) per Code anlegen und mit dem Mitglied verknüpfen. */
export async function registerWithLink(
	ctx: RequestContext,
	token: string,
	input: { code: string; name: string; email: string; password: string; relation: string | null }
): Promise<{ memberFirstName: string }> {
	const { memberId, firstName } = await verifyCode(token, input.code, null);
	let userId: string;
	try {
		// Konto mit `emailVerified = false` + Bestätigungslink: Anmeldung (und damit jeder Zugriff über
		// die Verknüpfung) erst nach Bestätigung der Adresse
		userId = await core.users.registerWithRole({
			name: input.name,
			email: input.email,
			password: input.password,
			roleName: LINK_DEFAULT_ROLE
		});
	} catch (e) {
		await releaseUse(memberId);
		if (isCoreError(e) && e.status === 409) {
			throw errors.conflict(
				'Mit dieser E-Mail-Adresse gibt es bereits ein Konto. Bitte melde dich an und verknüpfe dein Konto dann mit dem Code.'
			);
		}
		throw e;
	}
	await addLink(memberId, userId, input.relation, userId);
	const notified = await notifyLinkedAccounts(memberId, firstName, userId);
	await core.audit.log({
		action: 'members.link.registered',
		actor: { type: 'system', id: 'public-link', name: 'Verknüpfungslink' },
		target: memberId,
		ip: ctx.ip,
		requestId: ctx.requestId,
		metadata: { memberId, userId, notified, emailVerificationPending: true }
	});
	return { memberFirstName: firstName };
}
