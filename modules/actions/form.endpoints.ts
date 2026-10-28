import { sanitizeFormHtml } from './form-html';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { notifyRegistration } from './notify';
import { todayBerlin } from '$lib/sdk/dates';
import { sql } from 'drizzle-orm';
import {
	type ApiEndpoint,
	core,
	errors,
	isUniqueViolation,
	logBestEffort,
	moduleDb,
	type RequestContext,
	rowsOf,
	toIsoOrNull,
	type Tx
} from '$lib/sdk/server';
import { formDefinitionSchema, validateFormValues } from '$lib/forms/schema';
import type { FormDefinition, FormValues } from '$lib/forms/types';
import type { LinkedMemberData, MembersService } from '$lib/modules/members/contract';
import type { TreasuryService } from '$lib/modules/treasury/contract';
import { requireAccess } from './access';
import { linkTokenValues, storedToken, tokenMatchSql } from './link-tokens';
import { notifyTreasury } from './treasury-sync';
import { canSeeHealth, healthColumns, readHealth } from './health';
import { globalPrivacyUrl, purgeMailCounters, takeMailQuota } from './public-mail';
import {
	OPTIN_VALID_DAYS,
	STATUS_CONFLICT_MESSAGES,
	buildConfirmationMail,
	buildOptInMail,
	buildDefaultFormDefinition,
	computeFormStatus,
	identityValues,
	memberUpdates,
	prefillValues,
	withoutIdentityFields,
	isPlausibleBirthDate,
	mapStandardAnswers,
	mergeStandardFields,
	normalizeDedupeKey,
	renderDisclaimer,
	safeFilename,
	toCsv,
	toPublicDefinition,
	type CsvColumn
} from './form-support';
import {
	DEFAULT_DISCLAIMER_TEMPLATE,
	DIET_LABELS,
	FORM_CONFIRM_PREFIX,
	FORM_PUBLIC_PREFIX,
	MODULE_ID,
	PARTICIPANT_ROLE_LABELS,
	STANDARD_FORM_KEYS as K,
	formConfigInput,
	idParams,
	publicConfirmInput,
	publicSubmitInput,
	publicTokenParams,
	type AppliedFee,
	type Diet,
	type FormConfig,
	type FormConfigInput,
	type ParticipantRole,
	type PublicConfirmResult,
	type PublicForm,
	type PublicMemberOption,
	type PublicSubmitInput,
	type PublicSubmitResult
} from './schemas';

const TAGS = ['Modul: actions'];

const SETTING_KEYS = [
	'actions.bank.holder',
	'actions.bank.iban',
	'actions.bank.bic',
	'actions.bank.name',
	'actions.payment.purposeTemplate'
];

const str = (v: unknown): string | null => (v == null ? null : String(v));
const newToken = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

// --- Laden ------------------------------------------------------------------

interface FormRow {
	token: string;
	enabled: boolean;
	opensAt: string | null;
	closesAt: string | null;
	maxParticipants: number | null;
	intro: string | null;
	disclaimerTemplate: string;
	privacyUrl: string | null;
	requireLogin: boolean;
	definition: FormDefinition;
}

interface ActionRow {
	name: string;
	location: string | null;
	startsOn: string;
	endsOn: string | null;
	feeCents: number | null;
	teamFeeCents: number | null;
	feeAppliedAt: string | null;
}

interface Loaded {
	form: FormRow | null;
	action: ActionRow;
	participantCount: number;
	submissions: number;
}

function parseDefinition(raw: unknown): FormDefinition {
	let v = raw;
	if (typeof v === 'string') {
		try {
			v = JSON.parse(v);
		} catch {
			v = null;
		}
	}
	const parsed = formDefinitionSchema.safeParse(v);
	return mergeStandardFields(parsed.success ? parsed.data : buildDefaultFormDefinition());
}

async function loadAction(tx: Tx, id: string): Promise<ActionRow> {
	const [a] = await rowsOf(
		tx,
		sql`SELECT name, location, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
				to_char(ends_on, 'YYYY-MM-DD') AS ends_on, fee_cents, team_fee_cents, fee_applied_at
			FROM actions WHERE id = ${id}`
	);
	if (!a) throw errors.notFound('Aktion nicht gefunden');
	return {
		name: String(a.name),
		location: str(a.location),
		startsOn: String(a.starts_on),
		endsOn: str(a.ends_on),
		feeCents: a.fee_cents == null ? null : Number(a.fee_cents),
		teamFeeCents: a.team_fee_cents == null ? null : Number(a.team_fee_cents),
		feeAppliedAt: toIsoOrNull(a.fee_applied_at)
	};
}

function toFormRow(r: Record<string, unknown>): FormRow {
	return {
		token: storedToken(r) ?? '',
		enabled: Boolean(r.enabled),
		opensAt: toIsoOrNull(r.opens_at),
		closesAt: toIsoOrNull(r.closes_at),
		maxParticipants: r.max_participants == null ? null : Number(r.max_participants),
		intro: str(r.intro),
		disclaimerTemplate: String(r.disclaimer_template ?? ''),
		privacyUrl: str(r.privacy_url),
		requireLogin: Boolean(r.require_login),
		definition: parseDefinition(r.definition)
	};
}

async function counts(tx: Tx, id: string) {
	const [c] = await rowsOf(
		tx,
		sql`SELECT
				COUNT(*) FILTER (WHERE role = 'participant') AS participants,
				COUNT(*) FILTER (WHERE source = 'link') AS submissions
			FROM action_participants WHERE action_id = ${id}`
	);
	return {
		participantCount: Number(c?.participants ?? 0),
		submissions: Number(c?.submissions ?? 0)
	};
}

async function loadById(tx: Tx, id: string): Promise<Loaded> {
	const action = await loadAction(tx, id);
	const [row] = await rowsOf(tx, sql`SELECT * FROM action_forms WHERE action_id = ${id}`);
	return { form: row ? toFormRow(row) : null, action, ...(await counts(tx, id)) };
}

/** Kontodaten für Anmeldetexte: bei aktiver Kasse aus deren Einstellungen, sonst aus `actions.bank.*` */
export async function readSettings() {
	const s = await core.settings.getMany(SETTING_KEYS);
	const s1 = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : '');
	let treasuryBank: Awaited<ReturnType<TreasuryService['bankData']>> | null;
	try {
		const treasury = await core.modules.useOptional<TreasuryService>('treasury', MODULE_ID);
		treasuryBank = treasury ? await treasury.bankData() : null;
	} catch (e) {
		logBestEffort('actions.form.treasury-bank-data', e);
		treasuryBank = null;
	}
	return {
		kontoinhaber: treasuryBank ? treasuryBank.holder : s1('actions.bank.holder'),
		iban: treasuryBank ? treasuryBank.iban : s1('actions.bank.iban'),
		bic: treasuryBank ? treasuryBank.bic : s1('actions.bank.bic'),
		bank: treasuryBank ? treasuryBank.name : s1('actions.bank.name'),
		purposeTemplate: s1('actions.payment.purposeTemplate')
	};
}

type BankSettings = Awaited<ReturnType<typeof readSettings>>;

const PRIVACY_URL_REQUIRED =
	'Für ein aktives Anmeldeformular ist ein Link zur Datenschutzerklärung Pflicht.';

const disclaimerFor = (a: ActionRow, template: string, bank: BankSettings) =>
	renderDisclaimer(template, { aktion: a.name, feeCents: a.feeCents, ...bank });

function toConfig(l: Loaded, bank: BankSettings): FormConfig {
	const f = l.form;
	const template = f?.disclaimerTemplate || DEFAULT_DISCLAIMER_TEMPLATE;
	const fee: AppliedFee | null =
		l.action.feeCents != null
			? {
					participantCents: l.action.feeCents,
					teamCents: l.action.teamFeeCents ?? 0,
					appliedAt: l.action.feeAppliedAt ?? new Date(0).toISOString(),
					appliedBy: null
				}
			: null;
	const base = {
		enabled: f?.enabled ?? false,
		opensAt: f?.opensAt ?? null,
		closesAt: f?.closesAt ?? null,
		maxParticipants: f?.maxParticipants ?? null
	};
	return {
		persisted: !!f,
		token: f?.token || null,
		publicPath: f?.token ? `${FORM_PUBLIC_PREFIX}/${f.token}` : null,
		...base,
		intro: f?.intro ?? null,
		disclaimerTemplate: template,
		privacyUrl: f?.privacyUrl ?? null,
		requireLogin: f?.requireLogin ?? false,
		definition: f?.definition ?? buildDefaultFormDefinition(),
		status: computeFormStatus(base, l.participantCount),
		submissions: l.submissions,
		fee,
		disclaimerPreview: disclaimerFor(l.action, template, bank)
	};
}

async function configFor(
	ctx: RequestContext,
	id: string,
	need: 'read' | 'edit',
	mutate?: (tx: Tx) => Promise<void>
) {
	const loaded = await moduleDb(MODULE_ID).transaction(async (tx) => {
		await requireAccess(tx, ctx, id, need);
		if (mutate) await mutate(tx);
		return loadById(tx, id);
	});
	return toConfig(loaded, await readSettings());
}

// --- Öffentlich ------------------------------------------------------------

const NOT_AVAILABLE = 'Anmeldung nicht verfügbar';

async function loadByToken(
	tx: Tx,
	token: string
): Promise<(Loaded & { form: FormRow; id: string }) | null> {
	const [row] = await rowsOf(tx, sql`SELECT * FROM action_forms WHERE ${tokenMatchSql(token)}`);
	if (!row || !row.enabled) return null;
	const id = String(row.action_id);
	const action = await loadAction(tx, id);
	return { id, form: toFormRow(row), action, ...(await counts(tx, id)) };
}

function toPublicForm(
	l: Loaded & { form: FormRow },
	bank: BankSettings,
	viewer: PublicForm['viewer'] = null,
	members: PublicMemberOption[] = [],
	fallbackPrivacyUrl: string | null = null
): PublicForm {
	const disclaimer = disclaimerFor(
		l.action,
		l.form.disclaimerTemplate || DEFAULT_DISCLAIMER_TEMPLATE,
		bank
	);
	const privacyUrl = l.form.privacyUrl ?? fallbackPrivacyUrl;
	return {
		actionName: l.action.name,
		location: l.action.location,
		startsOn: l.action.startsOn,
		endsOn: l.action.endsOn,
		intro: l.form.intro,
		status: computeFormStatus(l.form, l.participantCount),
		opensAt: l.form.opensAt,
		closesAt: l.form.closesAt,
		definition: toPublicDefinition(l.form.definition, { privacyUrl, disclaimer }),
		disclaimer,
		privacyUrl,
		requireLogin: l.form.requireLogin,
		viewer,
		members
	};
}

const MEMBERS_MODULE = 'members';
/** Dienste des Moduls `members` (harte Abhängigkeit); Aufruf immer AUSSERHALB von Transaktionen */
const membersService = () => core.modules.use<MembersService>(MEMBERS_MODULE, MODULE_ID);

const MEMBER_REQUIRED = 'Bitte wähle das Mitglied, das angemeldet werden soll.';
const LOGIN_REQUIRED = 'Bitte melde dich an, um dich anzumelden.';

async function accountEmail(ctx: RequestContext): Promise<string | null> {
	if (!ctx.userId) return null;
	const [u] = await core.users.directory(ctx, { ids: [ctx.userId], limit: 1 });
	return u?.email ?? null;
}

/** Mit dem Konto verknüpfte Mitglieder inkl. Vorbelegung (leer ohne Session). */
async function memberOptions(
	ctx: RequestContext,
	actionId: string,
	def: FormDefinition
): Promise<PublicMemberOption[]> {
	if (!ctx.userId) return [];
	const linked = await (await membersService()).listLinkedMembers(ctx);
	if (!linked.length) return [];
	const registered = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT member_id FROM action_participants WHERE action_id = ${actionId}
				AND member_id IN (${sql.join(
					linked.map((m) => sql`${m.id}`),
					sql`, `
				)})`
		)
	);
	const done = new Set(registered.map((r) => String(r.member_id)));
	return linked.map((m) => ({
		id: m.id,
		name: `${m.firstName} ${m.lastName}`,
		registered: done.has(m.id),
		prefill: prefillValues(def, m.custom)
	}));
}

const DUPLICATE = 'Für diese Person liegt bereits eine Anmeldung vor.';
const DAILY_LIMIT =
	'Über diesen Link sind heute sehr viele Anmeldungen eingegangen. Bitte versuche es morgen erneut oder wende dich an die Leitung.';
const OPTIN_MAIL_FAILED =
	'Die Bestätigungs-E-Mail konnte nicht versendet werden. Bitte versuche es später erneut oder wende dich an die Leitung.';
const CONFIRM_INVALID =
	'Der Bestätigungslink ist ungültig, abgelaufen oder wurde bereits verwendet.';

/** Spaltenwerte einer neuen Teilnehmer*in (Anmeldelink; bei Double-Opt-in verschlüsselt zwischengespeichert) */
interface ParticipantInsert {
	id: string;
	name: string;
	groupLabel: string | null;
	birthDate: string | null;
	bremenResident: boolean | null;
	juleica: boolean;
	diet: string | null;
	allergies: string | null;
	notes: string | null;
	answers: string;
	healthAnswers: string | null;
	consentAt: string;
	email: string | null;
	dedupeKey: string | null;
	memberId: string | null;
	userId: string | null;
}

const crypt = () => core.crypto.forModule(MODULE_ID);
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function hasDuplicate(tx: Tx, actionId: string, dedupeKey: string): Promise<boolean> {
	const dup = await rowsOf(
		tx,
		sql`SELECT 1 AS x FROM action_participants WHERE action_id = ${actionId}
			AND birth_date IS NOT NULL
			AND lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) || '|' ||
				to_char(birth_date, 'YYYY-MM-DD') = ${dedupeKey}
			LIMIT 1`
	);
	return dup.length > 0;
}

/** Plätze und Duplikate unter Sperre der Aktion prüfen (gleichzeitige Anmeldungen serialisiert) */
async function lockAndCheck(
	tx: Tx,
	actionId: string,
	maxParticipants: number | null,
	dedupeKey: string | null
): Promise<void> {
	await tx.execute(sql`SELECT id FROM actions WHERE id = ${actionId} FOR UPDATE`);
	const { participantCount } = await counts(tx, actionId);
	if (maxParticipants != null && participantCount >= maxParticipants) {
		throw errors.conflict(STATUS_CONFLICT_MESSAGES.full);
	}
	if (dedupeKey && (await hasDuplicate(tx, actionId, dedupeKey))) {
		throw errors.conflict(DUPLICATE);
	}
}

/** Teilnehmer*in anlegen (mit Plätze-/Duplikatprüfung); `extra` läuft in derselben Transaktion */
async function insertParticipant(
	actionId: string,
	maxParticipants: number | null,
	p: ParticipantInsert,
	extra?: (tx: Tx) => Promise<void>
): Promise<void> {
	try {
		await moduleDb(MODULE_ID).transaction(async (tx) => {
			await lockAndCheck(tx, actionId, maxParticipants, p.dedupeKey);
			await tx.execute(
				sql`INSERT INTO action_participants (id, action_id, name, group_label, birth_date,
						bremen_resident, role, juleica, diet, allergies, notes, answers, source,
						consent_accepted_at, contact_email, dedupe_key, member_id, user_id, health_answers)
					VALUES (${p.id}, ${actionId}, ${p.name}, ${p.groupLabel}, ${p.birthDate},
						${p.bremenResident}, 'participant', ${p.juleica}, ${p.diet}, ${p.allergies}, ${p.notes},
						${p.answers}::jsonb, 'link', ${p.consentAt}, ${p.email}, ${p.dedupeKey},
						${p.memberId}, ${p.userId}, ${p.healthAnswers})`
			);
			if (extra) await extra(tx);
		});
	} catch (e) {
		if (isUniqueViolation(e)) throw errors.conflict(DUPLICATE);
		throw e;
	}
}

/**
 * Anmeldebestätigung nach dem Anlegen (an bestätigte bzw. aus dem Konto/Mitglied stammende
 * Adressen). Kasse aktiv: Rechnung als PDF anhängen. Ohne Adresse: Kasse nur abgleichen.
 */
async function sendConfirmation(
	actionId: string,
	action: ActionRow,
	p: ParticipantInsert,
	disclaimer: string
): Promise<boolean> {
	if (!p.email) {
		await notifyTreasury(null, actionId);
		return false;
	}
	let invoice: Awaited<ReturnType<TreasuryService['invoiceForRegistration']>> = null;
	try {
		const treasury = await core.modules.useOptional<TreasuryService>('treasury', MODULE_ID);
		invoice = treasury ? await treasury.invoiceForRegistration(actionId, p.id) : null;
	} catch (e) {
		logBestEffort('actions.form.registration-invoice', e, { target: actionId });
	}
	try {
		const mail = buildConfirmationMail({
			actionName: action.name,
			name: p.name,
			groupLabel: p.groupLabel,
			birthDate: p.birthDate,
			disclaimer,
			invoice
		});
		await core.mail.send({
			to: p.email,
			...mail,
			...(invoice
				? {
						attachments: [
							{ filename: invoice.filename, contentType: invoice.contentType, data: invoice.data }
						]
					}
				: {})
		});
		return true;
	} catch (e) {
		logBestEffort('actions.form.confirmation-mail', e, { target: actionId });
		return false;
	}
}

async function auditPublic(
	ctx: RequestContext,
	action: string,
	target: string,
	metadata: Record<string, unknown>
): Promise<void> {
	try {
		await core.audit.log({
			action,
			actor: { type: 'system', id: 'public-form', name: 'Anmeldeformular' },
			target,
			ip: ctx.ip,
			requestId: ctx.requestId,
			metadata
		});
	} catch (e) {
		// Audit-Fehler dürfen die Anmeldung nicht verwerfen
		logBestEffort('actions.form.audit', e, { ctx, target });
	}
}

/**
 * Anmeldung ohne Konto (Double-Opt-in, Issue #17): Angaben verschlüsselt zwischenspeichern und nur
 * eine Bitte um Bestätigung ohne Formularinhalte an die angegebene Adresse senden. Teilnehmer*in,
 * Rechnung und Anmeldebestätigung entstehen erst mit der Bestätigung (`confirmRegistration`).
 */
async function submitPending(
	ctx: RequestContext,
	loaded: Loaded & { form: FormRow; id: string },
	p: ParticipantInsert,
	disclaimer: string
): Promise<PublicSubmitResult> {
	if (!p.email) throw errors.validation({ [K.email]: 'Bitte eine E-Mail-Adresse angeben' });
	const token = randomBytes(32).toString('hex');
	const pendingId = randomUUID();
	const payload = crypt().encrypt(JSON.stringify(p));
	await moduleDb(MODULE_ID).transaction(async (tx) => {
		await lockAndCheck(tx, loaded.id, loaded.form.maxParticipants, p.dedupeKey);
		if (!(await takeMailQuota(tx, loaded.id, 'registration-optin'))) {
			throw errors.conflict(DAILY_LIMIT);
		}
		await tx.execute(
			sql`INSERT INTO pending_registrations (id, action_id, token_hash, payload, dedupe_key, expires_at)
				VALUES (${pendingId}, ${loaded.id}, ${hashToken(token)}, ${payload}, ${p.dedupeKey},
					now() + (${OPTIN_VALID_DAYS} * interval '1 day'))`
		);
	});
	try {
		await core.mail.send({
			to: p.email,
			...buildOptInMail({
				actionName: loaded.action.name,
				startsOn: loaded.action.startsOn,
				endsOn: loaded.action.endsOn,
				confirmUrl: `${core.app.origin()}${FORM_CONFIRM_PREFIX}/${token}`
			})
		});
	} catch (e) {
		logBestEffort('actions.form.optin-mail', e, { ctx, target: loaded.id });
		// Ohne Mail lässt sich die Anmeldung nie bestätigen → verwerfen und ehrlich melden
		await moduleDb(MODULE_ID)
			.transaction((tx) =>
				tx.execute(sql`DELETE FROM pending_registrations WHERE id = ${pendingId}`)
			)
			.catch((err) => logBestEffort('actions.form.pending-drop', err, { ctx, target: pendingId }));
		throw errors.unavailable(OPTIN_MAIL_FAILED);
	}
	await auditPublic(ctx, 'actions.registration.pending', pendingId, {
		actionId: loaded.id,
		pendingId
	});
	return { name: p.name, emailSent: true, disclaimer, confirmationRequired: true };
}

/** Bestätigung über den Link aus der Mail: Teilnehmer*in anlegen, dann Anmeldebestätigung senden */
async function confirmRegistration(
	ctx: RequestContext,
	token: string
): Promise<PublicConfirmResult> {
	const found = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const [r] = await rowsOf(
			tx,
			sql`SELECT p.id, p.action_id, p.payload, f.max_participants, f.disclaimer_template
				FROM pending_registrations p LEFT JOIN action_forms f ON f.action_id = p.action_id
				WHERE p.token_hash = ${hashToken(token)} AND p.expires_at > now()`
		);
		if (!r) return null;
		return {
			pendingId: String(r.id),
			actionId: String(r.action_id),
			payload: String(r.payload),
			maxParticipants: r.max_participants == null ? null : Number(r.max_participants),
			template: String(r.disclaimer_template ?? ''),
			action: await loadAction(tx, String(r.action_id))
		};
	});
	if (!found) throw errors.notFound(CONFIRM_INVALID);
	const drop = () =>
		moduleDb(MODULE_ID)
			.transaction((tx) =>
				tx.execute(sql`DELETE FROM pending_registrations WHERE id = ${found.pendingId}`)
			)
			.catch((err) =>
				logBestEffort('actions.form.pending-drop', err, { ctx, target: found.pendingId })
			);
	let p: ParticipantInsert;
	try {
		p = JSON.parse(crypt().decrypt(found.payload)) as ParticipantInsert;
	} catch {
		await drop();
		throw errors.notFound(CONFIRM_INVALID);
	}
	try {
		await insertParticipant(found.actionId, found.maxParticipants, p, async (tx) => {
			await tx.execute(sql`DELETE FROM pending_registrations WHERE id = ${found.pendingId}`);
		});
	} catch (e) {
		// Voll oder bereits angemeldet: Bestätigung kann nie mehr gelingen → Zwischenstand löschen
		if ((e as { status?: number }).status === 409) await drop();
		throw e;
	}
	const disclaimer = disclaimerFor(
		found.action,
		found.template || DEFAULT_DISCLAIMER_TEMPLATE,
		await readSettings()
	);
	const emailSent = await sendConfirmation(found.actionId, found.action, p, disclaimer);
	await auditPublic(ctx, 'actions.registration.submitted', p.id, {
		actionId: found.actionId,
		participantId: p.id,
		emailSent,
		memberLinked: false,
		confirmed: true
	});
	await notifyRegistration(ctx, {
		actionId: found.actionId,
		actionName: found.action.name,
		participantName: p.name,
		memberId: null
	});
	return { actionName: found.action.name, name: p.name, emailSent, disclaimer };
}

/** Abgelaufene unbestätigte Anmeldungen und alte Mail-Zähler löschen (stündlicher Job) */
export async function purgeExpiredRegistrations(): Promise<{ deleted: number }> {
	return moduleDb(MODULE_ID).transaction(async (tx) => {
		const res = (await tx.execute(
			sql`DELETE FROM pending_registrations WHERE expires_at <= now() RETURNING id`
		)) as unknown as { rows: unknown[] };
		await purgeMailCounters(tx);
		return { deleted: res.rows.length };
	});
}

async function submit(ctx: RequestContext, token: string, input: PublicSubmitInput) {
	const loaded = await moduleDb(MODULE_ID).transaction((tx) => loadByToken(tx, token));
	if (!loaded) throw errors.notFound(NOT_AVAILABLE);
	const bank = await readSettings();
	const { form, action } = loaded;
	const disclaimer = disclaimerFor(
		action,
		form.disclaimerTemplate || DEFAULT_DISCLAIMER_TEMPLATE,
		bank
	);

	// Honeypot: gleiche Antwort wie bei Erfolg, nichts speichern
	if (input.website && input.website.trim() !== '') {
		const n = input.values[K.name];
		const fake: PublicSubmitResult = {
			name: typeof n === 'string' ? n.trim().slice(0, 150) : '',
			emailSent: true,
			disclaimer,
			...(input.memberId ? {} : { confirmationRequired: true })
		};
		return fake;
	}

	const status = computeFormStatus(form, loaded.participantCount);
	if (status !== 'open') throw errors.conflict(STATUS_CONFLICT_MESSAGES[status]);

	// Anmeldung mit Mitglied: Konto und Verknüpfung prüfen (Core-/Modul-Dienste vor der Transaktion)
	let member: LinkedMemberData | null = null;
	let accountMail: string | null = null;
	if (input.memberId) {
		if (!ctx.userId) throw errors.unauthenticated(LOGIN_REQUIRED);
		member = await (await membersService()).getLinkedMember(ctx, input.memberId);
		accountMail = await accountEmail(ctx);
	} else if (form.requireLogin) {
		if (!ctx.userId) throw errors.unauthenticated(LOGIN_REQUIRED);
		throw errors.validation({ memberId: MEMBER_REQUIRED }, MEMBER_REQUIRED);
	}

	const def: FormDefinition = {
		...form.definition,
		fields: form.definition.fields.filter((f) => !f.hidden)
	};
	// Mit Mitglied kommen Stammdaten vom Server (Client-Werte dafür werden nicht gelesen)
	const validated = validateFormValues(member ? withoutIdentityFields(def) : def, input.values);
	if (!validated.ok) throw errors.validation(validated.errors);
	const values: FormValues = member
		? { ...validated.values, ...identityValues(member, accountMail) }
		: validated.values;

	const m = mapStandardAnswers(def, values);
	const errs: Record<string, string> = {};
	const has = (key: string) => def.fields.some((f) => f.key === key);
	if (has(K.name) && !m.name) errs[K.name] = 'Bitte einen Namen angeben';
	if (has(K.birthDate) && m.birthDate) {
		const today = todayBerlin();
		if (!isPlausibleBirthDate(m.birthDate, today))
			errs[K.birthDate] = 'Bitte ein gültiges Geburtsdatum angeben';
	}
	// Datenschutz-Einwilligung und Disclaimer sind immer Pflicht (nicht abschaltbar, Issue #28)
	if (values[K.privacy] !== true) errs[K.privacy] = 'Bitte zustimmen';
	if (values[K.disclaimer] !== true) errs[K.disclaimer] = 'Bitte zustimmen';
	if (Object.keys(errs).length) throw errors.validation(errs);

	const dedupeKey = m.birthDate ? normalizeDedupeKey(m.name, m.birthDate) : null;
	// Gesundheitsdaten verschlüsselt, gesundheitsbezogene Antworten getrennt (`health.ts`)
	const h = healthColumns(m, def.fields);
	const p: ParticipantInsert = {
		id: randomUUID(),
		name: m.name,
		groupLabel: m.groupLabel,
		birthDate: m.birthDate,
		bremenResident: m.bremenResident,
		juleica: member?.custom.juleica === true,
		diet: h.diet,
		allergies: h.allergies,
		notes: h.notes,
		answers: h.answers,
		healthAnswers: h.healthAnswers,
		consentAt: new Date().toISOString(),
		email: m.email,
		dedupeKey,
		memberId: member?.id ?? null,
		userId: member ? ctx.userId : null
	};

	// Ohne Konto/Mitglied: unbestätigte Adresse → Double-Opt-in (keine Rechnung, kein Freitext)
	if (!member) return submitPending(ctx, loaded, p, disclaimer);

	await insertParticipant(loaded.id, form.maxParticipants, p);
	const participantId = p.id;

	// Core-/Modul-Dienste erst nach der Transaktion
	let memberUpdated: boolean | undefined;
	if (member) {
		try {
			const svc = await membersService();
			const active = new Set((await svc.listFieldDefinitions()).map((d) => d.key));
			const updates = Object.fromEntries(
				Object.entries(memberUpdates(def, values)).filter(([k]) => active.has(k))
			);
			const changed = Object.keys(updates).length
				? await svc.updateMemberFields(ctx, member.id, updates)
				: [];
			memberUpdated = changed.length > 0;
		} catch (e) {
			logBestEffort('actions.form.member-writeback', e, { ctx, target: member.id });
			memberUpdated = false;
		}
	}
	// Adresse aus Mitglied/Konto: Anmeldebestätigung (ggf. mit Rechnung) direkt
	const emailSent = await sendConfirmation(loaded.id, action, p, disclaimer);
	await auditPublic(ctx, 'actions.registration.submitted', participantId, {
		actionId: loaded.id,
		participantId,
		emailSent,
		memberLinked: true
	});
	await notifyRegistration(ctx, {
		actionId: loaded.id,
		actionName: action.name,
		participantName: m.name,
		memberId: member.id
	});
	const result: PublicSubmitResult = { name: m.name, emailSent, disclaimer, memberUpdated };
	return result;
}

// --- CSV --------------------------------------------------------------------

const CSV_COLUMNS: CsvColumn[] = [
	{ key: 'name', label: 'Name' },
	{ key: 'group', label: 'Gruppe' },
	{ key: 'birthDate', label: 'Geburtsdatum' },
	{ key: 'bremen', label: 'Wohnort Bremen/Bremerhaven' },
	{ key: 'role', label: 'Rolle' },
	{ key: 'juleica', label: 'Juleica' },
	{ key: 'diet', label: 'Ernährung' },
	{ key: 'allergies', label: 'Allergien/Unverträglichkeiten' },
	{ key: 'notes', label: 'Sonstiges' },
	{ key: 'email', label: 'E-Mail' },
	{ key: 'source', label: 'Quelle' },
	{ key: 'createdAt', label: 'Angemeldet am' }
];

const CSV_HEALTH_KEYS = new Set(['diet', 'allergies', 'notes']);

const yesNo = (v: unknown) => (v == null ? '' : v ? 'Ja' : 'Nein');

export const formEndpoints: ApiEndpoint[] = [
	{
		method: 'GET',
		path: '/actions/:id/form',
		summary: 'Anmeldeformular einer Aktion lesen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => configFor(ctx, (params as { id: string }).id, 'read')
	} as ApiEndpoint,
	{
		method: 'PUT',
		path: '/actions/:id/form',
		summary: 'Anmeldeformular einer Aktion speichern',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: formConfigInput,
		handler: async ({ ctx, params, body }) => {
			const id = (params as { id: string }).id;
			const input = body as FormConfigInput;
			const definition = sanitizeFormHtml(mergeStandardFields(input.definition));
			// Aktives Formular nur mit Datenschutzhinweis (eigener Link oder globale Einstellung)
			if (input.enabled && !input.privacyUrl && !(await globalPrivacyUrl())) {
				throw errors.validation({ privacyUrl: PRIVACY_URL_REQUIRED }, PRIVACY_URL_REQUIRED);
			}
			const fresh = linkTokenValues(newToken());
			const config = await configFor(ctx, id, 'edit', async (tx) => {
				await tx.execute(
					sql`INSERT INTO action_forms (action_id, token_hash, token_enc, enabled, opens_at, closes_at,
							max_participants, definition, intro, disclaimer_template, privacy_url,
							require_login, updated_by, updated_at)
						VALUES (${id}, ${fresh.hash}, ${fresh.enc}, ${input.enabled}, ${input.opensAt}, ${input.closesAt},
							${input.maxParticipants}, ${JSON.stringify(definition)}::jsonb, ${input.intro},
							${input.disclaimerTemplate}, ${input.privacyUrl}, ${input.requireLogin}, ${ctx.userId}, now())
						ON CONFLICT (action_id) DO UPDATE SET enabled = EXCLUDED.enabled,
							opens_at = EXCLUDED.opens_at, closes_at = EXCLUDED.closes_at,
							max_participants = EXCLUDED.max_participants, definition = EXCLUDED.definition,
							intro = EXCLUDED.intro, disclaimer_template = EXCLUDED.disclaimer_template,
							privacy_url = EXCLUDED.privacy_url, require_login = EXCLUDED.require_login, updated_by = EXCLUDED.updated_by,
							updated_at = now()`
				);
			});
			await core.audit.logFromContext(ctx, 'actions.form.updated', {
				target: id,
				metadata: {
					actionId: id,
					enabled: input.enabled,
					requireLogin: input.requireLogin,
					fields: definition.fields.length
				}
			});
			return config;
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/form/rotate-token',
		summary: 'Anmeldelink erneuern (alter Link wird ungültig)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const fresh = linkTokenValues(newToken());
			const config = await configFor(ctx, id, 'edit', async (tx) => {
				const res = (await tx.execute(
					sql`UPDATE action_forms SET token = NULL, token_hash = ${fresh.hash},
							token_enc = ${fresh.enc}, updated_by = ${ctx.userId},
							updated_at = now() WHERE action_id = ${id} RETURNING action_id`
				)) as unknown as { rows: unknown[] };
				if (!res.rows.length)
					throw errors.notFound('Das Anmeldeformular wurde noch nicht gespeichert');
			});
			await core.audit.logFromContext(ctx, 'actions.form.token_rotated', {
				target: id,
				metadata: { actionId: id }
			});
			return config;
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/actions/:id/form/member-fields',
		summary: 'Zusatzfelder der Mitglieder (zum Einbinden in das Anmeldeformular)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			await moduleDb(MODULE_ID).transaction((tx) =>
				requireAccess(tx, ctx, (params as { id: string }).id, 'edit')
			);
			return { fields: await (await membersService()).listFieldDefinitions() };
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/actions/:id/participants.csv',
		summary: 'Teilnehmende als CSV exportieren',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			// Gesundheitsspalten nur mit Sonderrecht (sonst fehlen sie ganz)
			const withHealth = canSeeHealth(ctx);
			const { name, rows } = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'read');
				const action = await loadAction(tx, id);
				const list = await rowsOf(
					tx,
					sql`SELECT name, group_label, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
							bremen_resident, role, juleica, diet, allergies, notes, contact_email, source,
							created_at
						FROM action_participants WHERE action_id = ${id} ORDER BY created_at, name`
				);
				return { name: action.name, rows: list };
			});
			const columns = withHealth
				? CSV_COLUMNS
				: CSV_COLUMNS.filter((c) => !CSV_HEALTH_KEYS.has(c.key));
			const csv = toCsv(
				rows.map((r) => {
					const h = withHealth ? readHealth(r) : null;
					return {
						name: r.name,
						group: r.group_label,
						birthDate: r.birth_date,
						bremen: yesNo(r.bremen_resident),
						role: PARTICIPANT_ROLE_LABELS[String(r.role) as ParticipantRole] ?? String(r.role),
						juleica: yesNo(r.juleica),
						...(h
							? {
									diet: h.diet ? (DIET_LABELS[h.diet as Diet] ?? h.diet) : '',
									allergies: h.allergies,
									notes: h.notes
								}
							: {}),
						email: r.contact_email,
						source: String(r.source) === 'link' ? 'Link' : 'Manuell',
						createdAt: toIsoOrNull(r.created_at)?.slice(0, 16).replace('T', ' ')
					};
				}),
				columns
			);
			await core.audit.logFromContext(ctx, 'actions.participants.exported', {
				target: id,
				metadata: { actionId: id, count: rows.length, withHealth }
			});
			return new Response(csv, {
				status: 200,
				headers: {
					'content-type': 'text/csv; charset=utf-8',
					'content-disposition': `attachment; filename="${safeFilename(name, '-teilnehmende.csv')}"`,
					'cache-control': 'no-store'
				}
			});
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/public/forms/:token',
		summary: 'Öffentliches Anmeldeformular lesen',
		tags: TAGS,
		permission: null,
		public: true,
		rateLimit: { limit: 60, windowSec: 60 },
		params: publicTokenParams,
		handler: async ({ ctx, params }) => {
			const { token } = params as { token: string };
			const loaded = await moduleDb(MODULE_ID).transaction((tx) => loadByToken(tx, token));
			if (!loaded) throw errors.notFound(NOT_AVAILABLE);
			const viewer = ctx.userId ? { name: ctx.actor.name } : null;
			const members = await memberOptions(ctx, loaded.id, loaded.form.definition);
			return toPublicForm(loaded, await readSettings(), viewer, members, await globalPrivacyUrl());
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/public/forms/:token/submit',
		summary: 'Anmeldung über den öffentlichen Link absenden',
		tags: TAGS,
		permission: null,
		public: true,
		rateLimit: { limit: 5, windowSec: 600 },
		params: publicTokenParams,
		body: publicSubmitInput,
		handler: async ({ ctx, params, body }) =>
			submit(ctx, (params as { token: string }).token, body as PublicSubmitInput)
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/public/registrations/:token/confirm',
		summary: 'Anmeldung über den Link aus der Bestätigungs-E-Mail bestätigen',
		tags: TAGS,
		permission: null,
		public: true,
		rateLimit: { limit: 10, windowSec: 600 },
		params: publicTokenParams,
		body: publicConfirmInput,
		handler: async ({ ctx, params }) =>
			confirmRegistration(ctx, (params as { token: string }).token)
	} as ApiEndpoint
];
