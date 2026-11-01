/**
 * Gesundheitsdaten der Teilnehmenden (Art. 9 DSGVO) – EINE Stelle für Sonderrecht, Bereinigung und
 * Verschlüsselung.
 *
 * - Sonderrecht: `members.data.export` (dasselbe Recht wie Mitglieder-Datenblätter und das
 *   Teilnehmenden-PDF). Ohne Recht liefert kein Weg (JSON-Liste, CSV, ZIP, PDF) Ernährung, Allergien,
 *   „Sonstiges (Medikamente, Mitteilungen)“ oder gesundheitsbezogene Formularantworten.
 * - Speicherung: `action_participants.diet|allergies|notes` und `health_answers` (JSON der
 *   gesundheitsbezogenen Antworten) als `core.crypto.forModule('actions')`-Chiffrat (`enc:v1:`).
 *   Die Datensicherung entschlüsselt/verschlüsselt solche Textspalten automatisch (Schlüsselwechsel).
 * - Gesundheitsbezogene Antworten: Felder mit dem Kennzeichen `health` (Formular-Builder, Schalter
 *   „Gesundheitsdaten“) und zusätzlich per Erkennung: an Mitgliedsfelder gebundene
 *   Felder (`memberKey`/`mf_*`, außer Juleica), Schlüssel der Gesundheits-Vorlagen des Moduls
 *   `members` und Felder mit Gesundheitsbegriffen in Beschriftung oder Hilfetext. Freie Felder ohne
 *   Kennzeichen und ohne solche Begriffe gelten NICHT als Gesundheitsdaten.
 */
import { sql } from 'drizzle-orm';
import { core, moduleDb, type RequestContext, type Tx } from '$lib/sdk/server';
import type { FieldDefinition } from '$lib/forms/types';
import { DIETS, MODULE_ID, STANDARD_FORM_KEYS, type Diet } from './schemas';

/** Sonderrecht für Gesundheitsdaten (kein eigenes Recht, damit Rollen nicht angepasst werden müssen) */
export const HEALTH_PERMISSION = 'members.data.export';

export function canSeeHealth(ctx: RequestContext): boolean {
	return core.permissions.has(ctx, HEALTH_PERMISSION);
}

const crypt = () => core.crypto.forModule(MODULE_ID);

// --- Erkennung gesundheitsbezogener Antworten ---------------------------------------------------

/**
 * Zusatzfelder der Mitglieder mit Gesundheitsbezug – Kopie von `MEMBER_HEALTH_FIELD_KEYS` aus `members/sheet-columns.ts`
 * (synchron gebraucht, Module importieren einander nicht); Gleichheit prüft `tests/unit/member-list.test.ts`.
 */
export const MEMBER_HEALTH_FIELD_KEYS: readonly string[] = [
	'ernaehrung',
	'allergien',
	'medikamente',
	'gesundheit',
	'zecken',
	'tetanus',
	'krankenkasse'
];

/** Mitgliedsfelder ohne Gesundheitsbezug (wie `members/sheet-columns.ts`) */
const NOT_SENSITIVE_MEMBER_FIELDS = new Set(['juleica']);
const HEALTH_WORDS =
	/allerg|medikament|arznei|medizin|gesundheit|krank|unverträglich|intoleranz|impf|tetanus|zecke|ernährung|diät|vegetar|vegan|diagnose|behinder|beeinträchtig|asthma|diabet|epilep|therapie|schwimm|notfall/i;
const STANDARD_HEALTH_KEYS = new Set<string>([
	STANDARD_FORM_KEYS.diet,
	STANDARD_FORM_KEYS.allergies,
	STANDARD_FORM_KEYS.notes
]);

/** Gehört die Antwort `key` zu den Gesundheitsdaten? `fields` = Felder des Anmeldeformulars. */
export function isHealthAnswerKey(key: string, fields: readonly FieldDefinition[] = []): boolean {
	if (STANDARD_HEALTH_KEYS.has(key)) return true;
	const field = fields.find((f) => f.key === key);
	// Ausdrückliches Kennzeichen im Formular-Builder (zusätzlich zur Erkennung unten)
	if (field?.health === true) return true;
	const memberKey = field?.memberKey ?? (key.startsWith('mf_') ? key.slice(3) : null);
	if (memberKey && !NOT_SENSITIVE_MEMBER_FIELDS.has(memberKey)) return true;
	if (MEMBER_HEALTH_FIELD_KEYS.includes(key.toLowerCase())) return true;
	if (field && HEALTH_WORDS.test(`${field.label} ${field.help ?? ''}`)) return true;
	return false;
}

/** Antworten in unkritische (`plain`, jsonb) und gesundheitsbezogene (`health`, verschlüsselt) trennen */
export function splitAnswers(
	answers: Record<string, unknown>,
	fields: readonly FieldDefinition[] = []
): { plain: Record<string, unknown>; health: Record<string, unknown> } {
	const plain: Record<string, unknown> = {};
	const health: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(answers)) {
		if (isHealthAnswerKey(k, fields)) health[k] = v;
		else plain[k] = v;
	}
	return { plain, health };
}

// --- Verschlüsselung ----------------------------------------------------------------------------

/** Text verschlüsseln (leer/`null` bleibt `null`, bereits verschlüsselt bleibt unverändert) */
export function encryptHealthText(value: string | null | undefined): string | null {
	if (value == null || value === '') return null;
	if (crypt().isEncrypted(value)) return value;
	return crypt().encrypt(value);
}

/**
 * Gespeicherten Wert lesen: Chiffrat entschlüsseln, Altbestand im Klartext unverändert (bis der Job
 * `actions.encrypt-health` ihn verschlüsselt hat); nicht entschlüsselbar → `null`.
 */
export function decryptHealthText(value: unknown): string | null {
	if (value == null || value === '') return null;
	const s = String(value);
	if (!crypt().isEncrypted(s)) return s;
	try {
		return crypt().decrypt(s);
	} catch {
		return null;
	}
}

export function decryptDiet(value: unknown): Diet | null {
	const v = decryptHealthText(value);
	return v && (DIETS as readonly string[]).includes(v) ? (v as Diet) : null;
}

/** Gesundheitsbezogene Antworten als ein Chiffrat (leer → `null`) */
export function encryptHealthAnswers(health: Record<string, unknown>): string | null {
	return Object.keys(health).length ? crypt().encrypt(JSON.stringify(health)) : null;
}

export function decryptHealthAnswers(value: unknown): Record<string, unknown> {
	const s = decryptHealthText(value);
	if (!s) return {};
	try {
		const o = JSON.parse(s) as unknown;
		return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const jsonObject = (v: unknown): Record<string, unknown> => {
	let o = v;
	if (typeof v === 'string') {
		try {
			o = JSON.parse(v);
		} catch {
			return {};
		}
	}
	return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
};

/** Spaltenwerte für INSERT/UPDATE: Gesundheitsfelder verschlüsselt, Antworten getrennt */
export function healthColumns(
	input: {
		diet: string | null;
		allergies: string | null;
		notes: string | null;
		answers?: Record<string, unknown>;
	},
	fields: readonly FieldDefinition[] = []
): {
	diet: string | null;
	allergies: string | null;
	notes: string | null;
	answers: string;
	healthAnswers: string | null;
} {
	const { plain, health } = splitAnswers(input.answers ?? {}, fields);
	return {
		diet: encryptHealthText(input.diet),
		allergies: encryptHealthText(input.allergies),
		notes: encryptHealthText(input.notes),
		answers: JSON.stringify(plain),
		healthAnswers: encryptHealthAnswers(health)
	};
}

/** Gespeicherte Zeile lesen: Gesundheitsfelder entschlüsselt, Antworten wieder zusammengeführt */
export function readHealth(row: Record<string, unknown>): {
	diet: Diet | null;
	allergies: string | null;
	notes: string | null;
	answers: Record<string, unknown>;
	healthAnswers: Record<string, unknown>;
} {
	const healthAnswers = decryptHealthAnswers(row.health_answers);
	return {
		diet: decryptDiet(row.diet),
		allergies: decryptHealthText(row.allergies),
		notes: decryptHealthText(row.notes),
		answers: { ...jsonObject(row.answers), ...healthAnswers },
		healthAnswers
	};
}

/**
 * Wie `readHealth`, aber ohne Sonderrecht bereinigt: Gesundheitsfelder `null`, Antworten ohne
 * gesundheitsbezogene Schlüssel (auch Altbestand, der noch im jsonb steht).
 */
export function readHealthFor(
	ctx: RequestContext,
	row: Record<string, unknown>,
	fields: readonly FieldDefinition[] = []
): ReturnType<typeof readHealth> & { hidden: boolean } {
	if (canSeeHealth(ctx)) return { ...readHealth(row), hidden: false };
	return {
		diet: null,
		allergies: null,
		notes: null,
		answers: splitAnswers(jsonObject(row.answers), fields).plain,
		healthAnswers: {},
		hidden: true
	};
}

// --- Bestand verschlüsseln ----------------------------------------------------------------------

/**
 * Altbestand verschlüsseln (idempotent): Klartext in `diet`/`allergies`/`notes` → Chiffrat,
 * gesundheitsbezogene Antworten aus `answers` → `health_answers`. Läuft in einer Modul-Transaktion
 * (nur reine Krypto, keine Core-Dienste). Aufruf: `onEnable` und stündlicher Job `actions.encrypt-health`.
 */
export async function encryptStoredHealthData(): Promise<{ updated: number }> {
	return moduleDb(MODULE_ID).transaction(async (tx) => encryptHealthInTx(tx));
}

export async function encryptHealthInTx(tx: Tx): Promise<{ updated: number }> {
	const res = (await tx.execute(
		sql`SELECT p.id, p.diet, p.allergies, p.notes, p.answers, p.health_answers, f.definition
			FROM action_participants p LEFT JOIN action_forms f ON f.action_id = p.action_id
			WHERE (p.diet IS NOT NULL AND p.diet NOT LIKE 'enc:v1:%')
				OR (p.allergies IS NOT NULL AND p.allergies NOT LIKE 'enc:v1:%')
				OR (p.notes IS NOT NULL AND p.notes NOT LIKE 'enc:v1:%')
				OR (p.health_answers IS NOT NULL AND p.health_answers NOT LIKE 'enc:v1:%')
				OR p.answers <> '{}'::jsonb
			FOR UPDATE OF p`
	)) as unknown as { rows: Record<string, unknown>[] };
	let updated = 0;
	for (const r of res.rows) {
		const fields = (jsonObject(r.definition).fields ?? []) as FieldDefinition[];
		const answers = jsonObject(r.answers);
		const { plain, health } = splitAnswers(answers, Array.isArray(fields) ? fields : []);
		const movedAnswers = Object.keys(health).length > 0;
		const plainText = (v: unknown) => v != null && v !== '' && !crypt().isEncrypted(String(v));
		const needs =
			movedAnswers ||
			plainText(r.diet) ||
			plainText(r.allergies) ||
			plainText(r.notes) ||
			plainText(r.health_answers);
		if (!needs) continue;
		const existing = decryptHealthAnswers(r.health_answers);
		const s = (v: unknown) => (v == null ? null : String(v));
		await tx.execute(
			sql`UPDATE action_participants SET
					diet = ${encryptHealthText(s(r.diet))},
					allergies = ${encryptHealthText(s(r.allergies))},
					notes = ${encryptHealthText(s(r.notes))},
					answers = ${JSON.stringify(plain)}::jsonb,
					health_answers = ${encryptHealthAnswers({ ...existing, ...health })}
				WHERE id = ${String(r.id)}`
		);
		updated++;
	}
	return { updated };
}
