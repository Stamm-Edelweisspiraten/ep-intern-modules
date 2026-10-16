import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { core, errors, type ApiEndpoint, type RequestContext, type Tx } from '$lib/sdk/server';
import { formDefinitionSchema, validateFormValues } from '$lib/forms/schema';
import type { FormDefinition, FormValues } from '$lib/forms/types';
import type { LinkedMemberData, MembersService } from '$lib/modules/members/contract';
import { requireAccess, rowsOf } from './access';
import {
	STATUS_CONFLICT_MESSAGES,
	buildConfirmationMail,
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
	FORM_PUBLIC_PREFIX,
	MODULE_ID,
	PARTICIPANT_ROLE_LABELS,
	STANDARD_FORM_KEYS as K,
	formConfigInput,
	idParams,
	publicSubmitInput,
	publicTokenParams,
	type AppliedFee,
	type Diet,
	type FormConfig,
	type FormConfigInput,
	type ParticipantRole,
	type PublicForm,
	type PublicMemberOption,
	type PublicSubmitInput,
	type PublicSubmitResult
} from './schemas';

const mdb = () => core.database.forModule(MODULE_ID);
const TAGS = ['Modul: actions'];

const SETTING_KEYS = [
	'actions.bank.holder',
	'actions.bank.iban',
	'actions.bank.bic',
	'actions.bank.name',
	'actions.payment.purposeTemplate'
];

const str = (v: unknown): string | null => (v == null ? null : String(v));
const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());
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
		feeAppliedAt: iso(a.fee_applied_at)
	};
}

function toFormRow(r: Record<string, unknown>): FormRow {
	return {
		token: String(r.token),
		enabled: Boolean(r.enabled),
		opensAt: iso(r.opens_at),
		closesAt: iso(r.closes_at),
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

async function readSettings() {
	const s = await core.settings.getMany(SETTING_KEYS);
	const s1 = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : '');
	return {
		kontoinhaber: s1('actions.bank.holder'),
		iban: s1('actions.bank.iban'),
		bic: s1('actions.bank.bic'),
		bank: s1('actions.bank.name'),
		purposeTemplate: s1('actions.payment.purposeTemplate')
	};
}

type BankSettings = Awaited<ReturnType<typeof readSettings>>;

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
		token: f?.token ?? null,
		publicPath: f ? `${FORM_PUBLIC_PREFIX}/${f.token}` : null,
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
	const loaded = await mdb().transaction(async (tx) => {
		await requireAccess(tx, ctx, id, need);
		if (mutate) await mutate(tx);
		return loadById(tx, id);
	});
	return toConfig(loaded, await readSettings());
}

// --- Oeffentlich ------------------------------------------------------------

const NOT_AVAILABLE = 'Anmeldung nicht verfügbar';

async function loadByToken(
	tx: Tx,
	token: string
): Promise<(Loaded & { form: FormRow; id: string }) | null> {
	const [row] = await rowsOf(tx, sql`SELECT * FROM action_forms WHERE token = ${token}`);
	if (!row || !row.enabled) return null;
	const id = String(row.action_id);
	const action = await loadAction(tx, id);
	return { id, form: toFormRow(row), action, ...(await counts(tx, id)) };
}

function toPublicForm(
	l: Loaded & { form: FormRow },
	bank: BankSettings,
	viewer: PublicForm['viewer'] = null,
	members: PublicMemberOption[] = []
): PublicForm {
	const disclaimer = disclaimerFor(
		l.action,
		l.form.disclaimerTemplate || DEFAULT_DISCLAIMER_TEMPLATE,
		bank
	);
	return {
		actionName: l.action.name,
		location: l.action.location,
		startsOn: l.action.startsOn,
		endsOn: l.action.endsOn,
		intro: l.form.intro,
		status: computeFormStatus(l.form, l.participantCount),
		opensAt: l.form.opensAt,
		closesAt: l.form.closesAt,
		definition: toPublicDefinition(l.form.definition, {
			privacyUrl: l.form.privacyUrl,
			disclaimer
		}),
		disclaimer,
		privacyUrl: l.form.privacyUrl,
		requireLogin: l.form.requireLogin,
		viewer,
		members
	};
}

const MEMBERS_MODULE = 'members';
/** Dienste des Moduls `members` (harte Abhaengigkeit); Aufruf immer AUSSERHALB von Transaktionen */
const membersService = () => core.modules.use<MembersService>(MEMBERS_MODULE, MODULE_ID);

const MEMBER_REQUIRED = 'Bitte wähle das Mitglied, das angemeldet werden soll.';
const LOGIN_REQUIRED = 'Bitte melde dich an, um dich anzumelden.';

async function accountEmail(ctx: RequestContext): Promise<string | null> {
	if (!ctx.userId) return null;
	const [u] = await core.users.directory(ctx, { ids: [ctx.userId], limit: 1 });
	return u?.email ?? null;
}

/** Mit dem Konto verknuepfte Mitglieder inkl. Vorbelegung (leer ohne Session). */
async function memberOptions(
	ctx: RequestContext,
	actionId: string,
	def: FormDefinition
): Promise<PublicMemberOption[]> {
	if (!ctx.userId) return [];
	const linked = await (await membersService()).listLinkedMembers(ctx);
	if (!linked.length) return [];
	const registered = await mdb().transaction((tx) =>
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

function isUniqueViolation(e: unknown): boolean {
	const err = e as { code?: string; cause?: { code?: string }; message?: string };
	return (
		err?.code === '23505' ||
		err?.cause?.code === '23505' ||
		/duplicate key|unique constraint/i.test(String(err?.message ?? ''))
	);
}

async function submit(ctx: RequestContext, token: string, input: PublicSubmitInput) {
	const loaded = await mdb().transaction((tx) => loadByToken(tx, token));
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
			disclaimer
		};
		return fake;
	}

	const status = computeFormStatus(form, loaded.participantCount);
	if (status !== 'open') throw errors.conflict(STATUS_CONFLICT_MESSAGES[status]);

	// Anmeldung mit Mitglied: Konto und Verknuepfung pruefen (Core-/Modul-Dienste vor der Transaktion)
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
	// Mit Mitglied kommen Stammdaten vom Server (Client-Werte dafuer werden nicht gelesen)
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
		const today = new Date().toISOString().slice(0, 10);
		if (!isPlausibleBirthDate(m.birthDate, today))
			errs[K.birthDate] = 'Bitte ein gültiges Geburtsdatum angeben';
	}
	if (has(K.privacy) && values[K.privacy] !== true) errs[K.privacy] = 'Bitte zustimmen';
	if (has(K.disclaimer) && values[K.disclaimer] !== true) errs[K.disclaimer] = 'Bitte zustimmen';
	if (Object.keys(errs).length) throw errors.validation(errs);
	const consent = has(K.privacy) || has(K.disclaimer);

	const dedupeKey = m.birthDate ? normalizeDedupeKey(m.name, m.birthDate) : null;
	const participantId = randomUUID();

	try {
		await mdb().transaction(async (tx) => {
			// Serialisiert gleichzeitige Anmeldungen derselben Aktion (Plaetze + Duplikate)
			await tx.execute(sql`SELECT id FROM actions WHERE id = ${loaded.id} FOR UPDATE`);
			const { participantCount } = await counts(tx, loaded.id);
			if (form.maxParticipants != null && participantCount >= form.maxParticipants) {
				throw errors.conflict(STATUS_CONFLICT_MESSAGES.full);
			}
			if (dedupeKey) {
				const dup = await rowsOf(
					tx,
					sql`SELECT 1 AS x FROM action_participants WHERE action_id = ${loaded.id}
						AND birth_date IS NOT NULL
						AND lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) || '|' ||
							to_char(birth_date, 'YYYY-MM-DD') = ${dedupeKey}
						LIMIT 1`
				);
				if (dup.length) throw errors.conflict(DUPLICATE);
			}
			await tx.execute(
				sql`INSERT INTO action_participants (id, action_id, name, group_label, birth_date,
						bremen_resident, role, juleica, diet, allergies, notes, answers, source,
						consent_accepted_at, contact_email, dedupe_key, member_id, user_id)
					VALUES (${participantId}, ${loaded.id}, ${m.name}, ${m.groupLabel}, ${m.birthDate},
						${m.bremenResident}, 'participant', ${member?.custom.juleica === true}, ${m.diet}, ${m.allergies}, ${m.notes},
						${JSON.stringify(m.answers)}::jsonb, 'link',
						${consent ? new Date().toISOString() : null}, ${m.email}, ${dedupeKey},
						${member?.id ?? null}, ${member ? ctx.userId : null})`
			);
		});
	} catch (e) {
		if (isUniqueViolation(e)) throw errors.conflict(DUPLICATE);
		throw e;
	}

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
		} catch {
			memberUpdated = false;
		}
	}
	let emailSent = false;
	if (m.email) {
		try {
			const mail = buildConfirmationMail({
				actionName: action.name,
				name: m.name,
				groupLabel: m.groupLabel,
				birthDate: m.birthDate,
				disclaimer
			});
			await core.mail.send({ to: m.email, ...mail });
			emailSent = true;
		} catch {
			emailSent = false;
		}
	}
	try {
		await core.audit.log({
			action: 'actions.registration.submitted',
			actor: { type: 'system', id: 'public-form', name: 'Anmeldeformular' },
			target: participantId,
			ip: ctx.ip,
			requestId: ctx.requestId,
			metadata: { actionId: loaded.id, participantId, emailSent, memberLinked: !!member }
		});
	} catch {
		/* Audit-Fehler duerfen die Anmeldung nicht verwerfen */
	}
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
			const definition = mergeStandardFields(input.definition);
			const config = await configFor(ctx, id, 'edit', async (tx) => {
				await tx.execute(
					sql`INSERT INTO action_forms (action_id, token, enabled, opens_at, closes_at,
							max_participants, definition, intro, disclaimer_template, privacy_url,
							require_login, updated_by, updated_at)
						VALUES (${id}, ${newToken()}, ${input.enabled}, ${input.opensAt}, ${input.closesAt},
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
		summary: 'Anmeldelink erneuern (alter Link wird ungueltig)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const config = await configFor(ctx, id, 'edit', async (tx) => {
				const res = (await tx.execute(
					sql`UPDATE action_forms SET token = ${newToken()}, updated_by = ${ctx.userId},
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
			await mdb().transaction((tx) =>
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
			const { name, rows } = await mdb().transaction(async (tx) => {
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
			const csv = toCsv(
				rows.map((r) => ({
					name: r.name,
					group: r.group_label,
					birthDate: r.birth_date,
					bremen: yesNo(r.bremen_resident),
					role: PARTICIPANT_ROLE_LABELS[String(r.role) as ParticipantRole] ?? String(r.role),
					juleica: yesNo(r.juleica),
					diet: r.diet ? (DIET_LABELS[String(r.diet) as Diet] ?? String(r.diet)) : '',
					allergies: r.allergies,
					notes: r.notes,
					email: r.contact_email,
					source: String(r.source) === 'link' ? 'Link' : 'Manuell',
					createdAt: iso(r.created_at)?.slice(0, 16).replace('T', ' ')
				})),
				CSV_COLUMNS
			);
			await core.audit.logFromContext(ctx, 'actions.participants.exported', {
				target: id,
				metadata: { actionId: id, count: rows.length }
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
		summary: 'Oeffentliches Anmeldeformular lesen',
		tags: TAGS,
		permission: null,
		public: true,
		rateLimit: { limit: 60, windowSec: 60 },
		params: publicTokenParams,
		handler: async ({ ctx, params }) => {
			const { token } = params as { token: string };
			const loaded = await mdb().transaction((tx) => loadByToken(tx, token));
			if (!loaded) throw errors.notFound(NOT_AVAILABLE);
			const viewer = ctx.userId ? { name: ctx.actor.name } : null;
			const members = await memberOptions(ctx, loaded.id, loaded.form.definition);
			return toPublicForm(loaded, await readSettings(), viewer, members);
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/public/forms/:token/submit',
		summary: 'Anmeldung ueber den oeffentlichen Link absenden',
		tags: TAGS,
		permission: null,
		public: true,
		rateLimit: { limit: 5, windowSec: 600 },
		params: publicTokenParams,
		body: publicSubmitInput,
		handler: async ({ ctx, params, body }) =>
			submit(ctx, (params as { token: string }).token, body as PublicSubmitInput)
	} as ApiEndpoint
];
