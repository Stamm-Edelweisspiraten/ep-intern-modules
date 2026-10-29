/**
 * KI-Schreibhilfe in Aktionen: Textstellen (Beschreibung, Anmeldung, Formular, Zuschussantrag, Packliste,
 * Rückblick) und Kontext `actions:action` für alle Module (z. B. Info-Mail in Nachrichten).
 * Der Kontext enthält nur Eckdaten der Aktion – nie Teilnehmende, Gesundheitsdaten oder Bankdaten.
 */
import { sql } from 'drizzle-orm';
import { formatEuro } from '$lib/components/layout/money';
import { formatDateDe, formatDateTimeDe } from '$lib/sdk/dates';
import { moduleDb, rowsOf, type ModuleAssist, type RequestContext } from '$lib/sdk/server';
import { ASSIST_TEXT_TASKS } from '$lib/sdk/types/assist';
import { loadActionKeys, resolveAccess } from './access';
import { DISCLAIMER_PLACEHOLDERS, MODULE_ID } from './schemas';

export const PERM_AI = 'actions.ai.use';

const ACTION_CONTEXT = ['actions:action'];
const ACTION_EXTRA = {
	name: 'Name (Formular)',
	location: 'Ort (Formular)',
	startsOn: 'Beginn (Formular)',
	endsOn: 'Ende (Formular)'
};

function range(r: Record<string, unknown>): string {
	const start = formatDateDe(String(r.starts_on ?? ''));
	const end = formatDateDe(String(r.ends_on ?? ''));
	const st = r.starts_time ? ` ${String(r.starts_time)} Uhr` : '';
	const et = r.ends_time ? ` ${String(r.ends_time)} Uhr` : '';
	if (!end || end === start) return `${start}${st}${et ? ` bis${et}` : ''}`;
	return `${start}${st} bis ${end}${et}`;
}

/** Eckdaten einer Aktion, die die Person sehen darf (sonst `null` → 404) */
async function actionContext(ctx: RequestContext, id: string) {
	if (!ctx.permissions.has('actions.action.view')) return null;
	await loadActionKeys(ctx);
	return moduleDb(MODULE_ID).transaction(async (tx) => {
		if (!(await resolveAccess(tx, ctx, id))) return null;
		const [r] = await rowsOf(
			tx,
			sql`SELECT a.name, a.description, a.location,
					to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on, a.starts_time,
					to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on, a.ends_time,
					a.fee_cents, a.team_fee_cents,
					f.enabled AS form_enabled, f.closes_at, f.max_participants
				FROM actions a LEFT JOIN action_forms f ON f.action_id = a.id
				WHERE a.id = ${id}`
		);
		if (!r) return null;
		const facts: Record<string, string> = {
			Aktion: String(r.name ?? ''),
			Zeitraum: range(r),
			Ort: String(r.location ?? '')
		};
		if (r.fee_cents != null) facts['Beitrag Teilnehmende'] = formatEuro(Number(r.fee_cents));
		if (r.team_fee_cents != null) facts['Beitrag Team'] = formatEuro(Number(r.team_fee_cents));
		if (r.form_enabled && r.closes_at) {
			facts['Anmeldung bis'] = formatDateTimeDe(String(r.closes_at));
		}
		if (r.form_enabled && r.max_participants) facts['Plätze'] = String(r.max_participants);
		if (r.description) facts['Beschreibung'] = String(r.description).slice(0, 1500);
		return { facts };
	});
}

export const actionsAssist: ModuleAssist = {
	purposes: {
		'action-description': {
			label: 'Beschreibung einer Aktion (Fahrt, Lager, Tagesaktion)',
			description:
				'Ausschreibung für Kinder, Jugendliche und Eltern: was passiert, wann, wo, was es kostet. Steht intern und auf dem Anmeldelink.',
			format: 'plain',
			maxChars: 5000,
			tasks: ASSIST_TEXT_TASKS,
			contexts: ACTION_CONTEXT,
			extraKeys: ACTION_EXTRA
		},
		'registration-intro': {
			label: 'Einleitung des Anmeldeformulars',
			description:
				'Kurzer Text über dem Anmeldeformular: worum es geht, bis wann man sich anmelden kann, was danach passiert.',
			format: 'plain',
			maxChars: 2000,
			tasks: ASSIST_TEXT_TASKS,
			contexts: ACTION_CONTEXT
		},
		'registration-disclaimer': {
			label: 'Hinweise und Zahlungsinformationen der Anmeldung',
			description:
				'Text unter dem Anmeldeformular und in der Bestätigung (Zahlung, Verbindlichkeit). Keine neuen Rechtsbedingungen erfinden.',
			format: 'plain',
			maxChars: 5000,
			tasks: ['rewrite', 'friendly', 'shorter', 'simple', 'spelling', 'english'],
			placeholders: DISCLAIMER_PLACEHOLDERS.map((p) => `{{${p.key}}}`),
			contexts: ACTION_CONTEXT
		},
		'form-info': {
			label: 'Infotext im Anmeldeformular',
			description:
				'Hinweis zwischen den Feldern des Formulars, z. B. warum nach Allergien gefragt wird oder was mitzubringen ist.',
			format: 'rich',
			maxChars: 5000,
			tasks: ASSIST_TEXT_TASKS,
			contexts: ACTION_CONTEXT
		},
		'form-label': {
			label: 'Beschriftung eines Formularfelds',
			description: 'Kurze, eindeutige Frage bzw. Feldbezeichnung (höchstens 80 Zeichen).',
			format: 'plain',
			maxChars: 200,
			tasks: ['title'],
			contexts: ACTION_CONTEXT
		},
		'subsidy-topic': {
			label: 'Thema der Freizeit im Zuschussantrag',
			description:
				'Kurzes Thema für das Antragsformular des Landesjugendpfarramts (höchstens 150 Zeichen), sachlich.',
			format: 'plain',
			maxChars: 150,
			tasks: ['title'],
			contexts: ACTION_CONTEXT
		},
		'packing-list': {
			label: 'Packliste für eine Aktion',
			description: 'Packliste für Kinder und Jugendliche passend zur Aktion.',
			format: 'plain',
			maxChars: 200,
			tasks: ['packing-list'],
			contexts: ACTION_CONTEXT
		},
		'action-recap': {
			label: 'Rückblick als Blogbeitrag für die Website',
			description:
				'Öffentlicher Bericht über eine vergangene Aktion für die Stammeswebsite: lebendig, ohne Namen von Kindern, ohne private Details.',
			format: 'rich',
			maxChars: 20_000,
			tasks: ['draft', 'rewrite', 'friendly', 'shorter', 'spelling'],
			contexts: ACTION_CONTEXT
		},
		'refund-letter': {
			label: 'Begleittext im Brief zur Rückzahlung',
			description:
				'Kurzer, herzlicher Text im Brief an die Familien: Die Aktion war günstiger, das Geld kommt zurück oder kann gespendet werden. Beträge nicht nennen.',
			format: 'plain',
			maxChars: 1500,
			tasks: ASSIST_TEXT_TASKS,
			contexts: ACTION_CONTEXT
		}
	},
	contexts: { action: actionContext }
};
