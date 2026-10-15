/**
 * Export-/Import-Archiv einer Aktion (reine Logik, keine Server-Imports).
 *
 * Aufbau des ZIP:
 *   manifest.json   Format, Version, Zaehler, Hinweise
 *   action.json     alle Daten der Aktion (siehe `archiveDocumentSchema`)
 *   receipts/<exportId>-<name>   Belegdateien (nur wenn exportiert)
 *
 * Sicherheit beim Lesen: nur drei erlaubte Pfadformen, keine absoluten/`..`-Pfade, keine Duplikate,
 * hoechstens 2000 Eintraege, hoechstens 300 MB entpackt (ueber die Header-Angaben VOR dem
 * Entpacken geprueft), Belege <= 10 MB. Archivnamen werden nie als Dateisystem-/Storage-Pfad benutzt.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import {
	ACCOUNTING_CATEGORIES,
	CALC_CATEGORIES,
	ENTRY_TYPES,
	MAX_AMOUNT_CENTS,
	MAX_CALC_ITEMS,
	MAX_RECEIPT_BYTES,
	PAID_BY,
	PARTICIPANT_ROLES,
	RECEIPT_CONTENT_TYPES,
	actionInput,
	calcItemInput,
	calculationInput,
	entryInput,
	formConfigInput,
	isIncomeCategory,
	participantInput,
	payeeInput,
	REFUND_CATEGORY
} from './schemas';

export const ARCHIVE_FORMAT = 'ep-intern-action';
export const ARCHIVE_VERSION = 1;
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 2000;
export const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;
export const MAX_JSON_BYTES = 20 * 1024 * 1024;
/** Beim Export: Summe der Belege, damit das Archiv importierbar bleibt */
export const MAX_EXPORT_RECEIPT_BYTES = 250 * 1024 * 1024;

export const ARCHIVE_ZIP_TYPES = [
	'application/zip',
	'application/x-zip-compressed',
	'application/octet-stream'
];

/** Fehler im Archiv; der Endpoint macht daraus 422. Texte deutsch, ASCII. */
export class ArchiveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ArchiveError';
	}
}

// --- Namen und Pfade --------------------------------------------------------

/** Dateiname fuer Storage-Pfade/Archiv: nur `[A-Za-z0-9._-]`, hoechstens 100 Zeichen. */
export function sanitizeName(name: string): string {
	const cleaned = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^A-Za-z0-9._-]+/g, '_')
		.replace(/^[._]+/, '')
		.slice(-100);
	return cleaned || 'beleg';
}

/** `Sommerlager Nord` -> `sommerlager-nord` (Umlaute transliteriert, max. 40 Zeichen). */
export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/ä/g, 'ae')
		.replace(/ö/g, 'oe')
		.replace(/ü/g, 'ue')
		.replace(/ß/g, 'ss')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/g, '');
	return slug || 'aktion';
}

export function archiveFilename(actionName: string, today: string): string {
	return `aktion-${slugify(actionName)}-${today}.zip`;
}

const RECEIPT_FILE_RE = /^receipts\/[A-Za-z0-9._-]{1,200}$/;

/**
 * Prueft einen Archiv-Eintragsnamen. Erlaubt: `manifest.json`, `action.json`, `receipts/`
 * (Verzeichniseintrag) und `receipts/<name>`. Alles andere wirft einen `ArchiveError`.
 */
export function assertSafeArchivePath(name: string): void {
	// eslint-disable-next-line no-control-regex
	if (!name || name.length > 255 || /[\u0000-\u001f\u007f\\:]/.test(name)) {
		throw new ArchiveError('Archiv enthaelt einen ungueltigen Dateinamen');
	}
	if (name.startsWith('/')) throw new ArchiveError('Archiv enthaelt einen absoluten Pfad');
	const segments = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
	for (const seg of segments) {
		if (!seg || seg === '.' || seg === '..') {
			throw new ArchiveError('Archiv enthaelt einen unzulaessigen Pfad');
		}
	}
	if (name === 'manifest.json' || name === 'action.json' || name === 'receipts/') return;
	if (RECEIPT_FILE_RE.test(name)) return;
	throw new ArchiveError('Archiv enthaelt eine unerwartete Datei');
}

// --- Inhaltstyp per Magic Bytes ----------------------------------------------

export type ReceiptType = (typeof RECEIPT_CONTENT_TYPES)[number];

export function detectReceiptType(bytes: Uint8Array): ReceiptType | null {
	const at = (i: number) => bytes[i];
	if (bytes.length >= 5 && strFromU8(bytes.subarray(0, 5)) === '%PDF-') return 'application/pdf';
	if (
		bytes.length >= 8 &&
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)
	) {
		return 'image/png';
	}
	if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
	if (
		bytes.length >= 12 &&
		strFromU8(bytes.subarray(0, 4)) === 'RIFF' &&
		strFromU8(bytes.subarray(8, 12)) === 'WEBP'
	) {
		return 'image/webp';
	}
	return null;
}

// --- Zod-Schemas ------------------------------------------------------------

const exportId = z.string().regex(/^[a-z][a-z0-9]{0,15}$/, 'Ungültige Export-ID');
const isoStamp = z
	.string()
	.max(40)
	.refine((v) => !Number.isNaN(new Date(v).getTime()), 'Ungültiges Datum')
	.transform((v) => new Date(v).toISOString());
const cents = (min: number, max: number) => z.number().int().min(min).max(max);

const actionSchema = z.strictObject({
	name: actionInput.shape.name,
	description: actionInput.shape.description,
	location: actionInput.shape.location,
	startsOn: actionInput.shape.startsOn,
	startsTime: actionInput.shape.startsTime,
	endsOn: actionInput.shape.endsOn,
	endsTime: actionInput.shape.endsTime,
	feeCents: cents(0, MAX_AMOUNT_CENTS).nullable(),
	teamFeeCents: cents(0, MAX_AMOUNT_CENTS).nullable()
});

const calculationSchema = z.strictObject({
	...calculationInput.shape,
	items: z
		.array(
			z.strictObject({
				category: z.enum(CALC_CATEGORIES),
				label: calcItemInput.shape.label,
				amountCents: calcItemInput.shape.amountCents,
				basis: calcItemInput.shape.basis
			})
		)
		.max(MAX_CALC_ITEMS)
});

const answerValue = z.union([
	z.string().max(5000),
	z.number(),
	z.boolean(),
	z.array(z.string().max(500)).max(200),
	z.null()
]);

const participantSchema = z.strictObject({
	id: exportId,
	name: participantInput.shape.name,
	groupLabel: participantInput.shape.groupLabel,
	birthDate: participantInput.shape.birthDate,
	bremenResident: participantInput.shape.bremenResident,
	role: z.enum(PARTICIPANT_ROLES),
	juleica: z.boolean(),
	subsidyEligible: z.boolean().nullable(),
	diet: participantInput.shape.diet,
	allergies: participantInput.shape.allergies,
	notes: participantInput.shape.notes,
	contactEmail: z.string().trim().max(254).nullable(),
	source: z.enum(['manual', 'link']),
	consentAcceptedAt: isoStamp.nullable(),
	answers: z.record(z.string().max(60), answerValue).refine((a) => Object.keys(a).length <= 100)
});

const formSchema = z
	.strictObject({
		opensAt: formConfigInput.shape.opensAt,
		closesAt: formConfigInput.shape.closesAt,
		maxParticipants: formConfigInput.shape.maxParticipants,
		intro: formConfigInput.shape.intro,
		disclaimerTemplate: formConfigInput.shape.disclaimerTemplate,
		privacyUrl: formConfigInput.shape.privacyUrl,
		definition: formConfigInput.shape.definition
	})
	.superRefine((f, ctx) => {
		if (f.opensAt && f.closesAt && f.closesAt < f.opensAt) {
			ctx.addIssue({
				code: 'custom',
				path: ['closesAt'],
				message: 'Das Ende liegt vor dem Beginn'
			});
		}
	});

const payeeSchema = z.strictObject({
	id: exportId,
	name: payeeInput.shape.name,
	bic: payeeInput.shape.bic,
	note: payeeInput.shape.note,
	/** Klartext-IBAN; nur wenn der Exportierende `actions.payout.view` hatte */
	iban: z.string().max(50).nullable().optional()
});

const entrySchema = z
	.strictObject({
		id: exportId,
		type: z.enum(ENTRY_TYPES),
		category: z.enum(ACCOUNTING_CATEGORIES),
		description: entryInput.shape.description,
		amountCents: entryInput.shape.amountCents,
		entryDate: entryInput.shape.entryDate,
		paidBy: z.enum(PAID_BY),
		payeeRef: exportId.nullable(),
		receipt: z
			.strictObject({
				file: z.string().regex(RECEIPT_FILE_RE, 'Ungültiger Belegpfad'),
				name: z
					.string()
					.trim()
					.min(1)
					.max(200)
					// eslint-disable-next-line no-control-regex
					.refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'Enthält ungültige Zeichen'),
				contentType: z.enum(RECEIPT_CONTENT_TYPES)
			})
			.nullable(),
		reimbursedAt: isoStamp.nullable()
	})
	.superRefine((e, ctx) => {
		const bad = (path: string, message: string) =>
			ctx.addIssue({ code: 'custom', path: [path], message });
		const income = isIncomeCategory(e.category);
		if (e.category === REFUND_CATEGORY) {
			if (e.type !== 'expense') bad('type', 'Rückzahlung muss eine Ausgabe sein');
			if (e.receipt) bad('receipt', 'Rückzahlung hat keinen Beleg');
		} else if (e.type === 'income' && !income) {
			bad('category', 'Kategorie passt nicht zu Einnahmen');
		} else if (e.type === 'expense' && income) {
			bad('category', 'Kategorie gilt nur für Einnahmen');
		}
		if (e.type === 'income' && (e.paidBy !== 'club' || e.payeeRef)) {
			bad('paidBy', 'Einnahmen gehen an den Stamm');
		}
		if (e.paidBy === 'person' && !e.payeeRef) bad('payeeRef', 'Person fehlt');
		if (e.paidBy === 'club' && e.payeeRef) bad('payeeRef', 'Nur bei Person angeben');
		if (e.category === REFUND_CATEGORY && (e.paidBy !== 'club' || e.payeeRef)) {
			bad('paidBy', 'Rückzahlung geht vom Stamm');
		}
		if (e.receipt && e.type !== 'expense') bad('receipt', 'Belege gibt es nur bei Ausgaben');
		if (e.reimbursedAt && e.paidBy !== 'person') bad('reimbursedAt', 'Nur bei Auslagen');
	});

const refundSchema = z.strictObject({
	entryRef: exportId,
	mode: z.enum(['auto', 'manual']),
	bookedAt: isoStamp,
	surplusCents: cents(0, 2_000_000_000),
	perHeadCents: cents(0, 2_000_000_000),
	payingCount: cents(0, 10_000),
	remainderCents: cents(0, 2_000_000_000),
	items: z
		.array(
			z.strictObject({
				participantRef: exportId.nullable(),
				name: participantInput.shape.name,
				amountCents: cents(1, MAX_AMOUNT_CENTS)
			})
		)
		.max(1000)
});

export const archiveDocumentSchema = z.strictObject({
	action: actionSchema,
	calculation: calculationSchema.nullable(),
	participants: z.array(participantSchema).max(5000),
	form: formSchema.nullable(),
	payees: z.array(payeeSchema).max(1000),
	entries: z.array(entrySchema).max(5000),
	refund: refundSchema.nullable(),
	accounting: z.strictObject({ closed: z.boolean(), closedAt: isoStamp.nullable() })
});
export type ArchiveDocument = z.output<typeof archiveDocumentSchema>;
export type ArchiveEntry = ArchiveDocument['entries'][number];
export type ArchiveParticipant = ArchiveDocument['participants'][number];
export type ArchivePayee = ArchiveDocument['payees'][number];

export const archiveManifestSchema = z.strictObject({
	format: z.literal(ARCHIVE_FORMAT),
	formatVersion: z.literal(ARCHIVE_VERSION),
	exportedAt: isoStamp,
	appVersion: z.string().max(60).optional(),
	receiptsOmitted: z.boolean().optional(),
	receiptsMissing: cents(0, 100_000).optional(),
	contents: z.strictObject({
		participants: cents(0, 100_000),
		entries: cents(0, 100_000),
		receipts: cents(0, 100_000),
		payees: cents(0, 100_000),
		includesBank: z.boolean()
	})
});
export type ArchiveManifest = z.output<typeof archiveManifestSchema>;

// --- Schreiben --------------------------------------------------------------

export function buildArchive(input: {
	manifest: ArchiveManifest;
	document: ArchiveDocument;
	receipts: Map<string, Uint8Array>;
}): Uint8Array {
	const files: Zippable = {
		'manifest.json': [strToU8(JSON.stringify(input.manifest, null, 2)), { level: 6 }],
		'action.json': [strToU8(JSON.stringify(input.document, null, 2)), { level: 6 }]
	};
	// Belege sind bereits komprimiert
	for (const [name, bytes] of input.receipts) files[name] = [bytes, { level: 0 }];
	return zipSync(files);
}

// --- Lesen ------------------------------------------------------------------

/** Entpackt das Archiv unter Einhaltung aller Grenzen; wirft `ArchiveError`. */
export function unpackArchive(data: Uint8Array): Map<string, Uint8Array> {
	if (data.byteLength > MAX_ARCHIVE_BYTES) throw new ArchiveError('Archiv ist zu gross');
	if (data.byteLength < 22 || data[0] !== 0x50 || data[1] !== 0x4b) {
		throw new ArchiveError('Datei ist kein gueltiges ZIP-Archiv');
	}
	const seen = new Set<string>();
	let count = 0;
	let total = 0;
	let out: Record<string, Uint8Array>;
	try {
		out = unzipSync(data, {
			filter(file) {
				count += 1;
				if (count > MAX_ARCHIVE_ENTRIES) {
					throw new ArchiveError(`Archiv enthaelt mehr als ${MAX_ARCHIVE_ENTRIES} Eintraege`);
				}
				assertSafeArchivePath(file.name);
				if (file.name.endsWith('/')) return false;
				if (seen.has(file.name)) throw new ArchiveError('Archiv enthaelt doppelte Eintraege');
				seen.add(file.name);
				const limit = file.name.startsWith('receipts/') ? MAX_RECEIPT_BYTES : MAX_JSON_BYTES;
				if (file.originalSize > limit) {
					throw new ArchiveError('Archiv enthaelt eine zu grosse Datei');
				}
				total += file.originalSize;
				if (total > MAX_UNPACKED_BYTES) {
					throw new ArchiveError('Archiv ist entpackt zu gross (hoechstens 300 MB)');
				}
				return true;
			}
		});
	} catch (e) {
		if (e instanceof ArchiveError) throw e;
		throw new ArchiveError('Archiv ist beschaedigt und kann nicht gelesen werden');
	}
	const files = new Map<string, Uint8Array>();
	let actual = 0;
	for (const [name, bytes] of Object.entries(out)) {
		actual += bytes.byteLength;
		if (actual > MAX_UNPACKED_BYTES) throw new ArchiveError('Archiv ist entpackt zu gross');
		files.set(name, bytes);
	}
	return files;
}

function parseJson(bytes: Uint8Array | undefined, what: string): unknown {
	if (!bytes) throw new ArchiveError(`${what} fehlt im Archiv`);
	try {
		return JSON.parse(strFromU8(bytes));
	} catch {
		throw new ArchiveError(`${what} ist kein gueltiges JSON`);
	}
}

function issueText(error: z.ZodError): string {
	return error.issues
		.slice(0, 3)
		.map((i) => `${i.path.join('.') || '(Wurzel)'}: ${i.message}`)
		.join('; ');
}

export interface ParsedArchive {
	manifest: ArchiveManifest;
	document: ArchiveDocument;
	files: Map<string, Uint8Array>;
}

/** Liest und validiert das ganze Archiv (inkl. Referenzen). Wirft `ArchiveError`. */
export function parseArchive(data: Uint8Array): ParsedArchive {
	const files = unpackArchive(data);
	const rawManifest = parseJson(files.get('manifest.json'), 'manifest.json');
	if (
		typeof rawManifest !== 'object' ||
		rawManifest === null ||
		(rawManifest as { format?: unknown }).format !== ARCHIVE_FORMAT
	) {
		throw new ArchiveError('Archiv ist kein Aktions-Export dieses Systems');
	}
	if ((rawManifest as { formatVersion?: unknown }).formatVersion !== ARCHIVE_VERSION) {
		throw new ArchiveError('Archivversion wird nicht unterstuetzt');
	}
	const manifest = archiveManifestSchema.safeParse(rawManifest);
	if (!manifest.success) {
		throw new ArchiveError(`manifest.json ist ungueltig (${issueText(manifest.error)})`);
	}
	const rawDoc = parseJson(files.get('action.json'), 'action.json');
	const doc = archiveDocumentSchema.safeParse(rawDoc);
	if (!doc.success) {
		throw new ArchiveError(`action.json ist ungueltig (${issueText(doc.error)})`);
	}
	validateReferences(doc.data);
	for (const e of doc.data.entries) {
		if (e.receipt && !files.has(e.receipt.file)) {
			throw new ArchiveError('Ein referenzierter Beleg fehlt im Archiv');
		}
	}
	return { manifest: manifest.data, document: doc.data, files };
}

function unique(ids: string[], what: string): Set<string> {
	const set = new Set(ids);
	if (set.size !== ids.length) throw new ArchiveError(`${what}: doppelte Export-IDs`);
	return set;
}

/** Querpruefungen, die ein einzelnes Schema nicht kann. */
export function validateReferences(doc: ArchiveDocument): void {
	const a = actionInput.safeParse({
		name: doc.action.name,
		description: doc.action.description,
		location: doc.action.location,
		startsOn: doc.action.startsOn,
		startsTime: doc.action.startsTime,
		endsOn: doc.action.endsOn,
		endsTime: doc.action.endsTime
	});
	if (!a.success) throw new ArchiveError(`Aktion ist ungueltig (${issueText(a.error)})`);

	const participants = unique(
		doc.participants.map((p) => p.id),
		'Teilnehmende'
	);
	const payees = unique(
		doc.payees.map((p) => p.id),
		'Empfaenger'
	);
	unique(
		doc.entries.map((e) => e.id),
		'Buchungen'
	);
	const receiptFiles = new Set<string>();
	for (const e of doc.entries) {
		if (e.payeeRef && !payees.has(e.payeeRef)) {
			throw new ArchiveError('Eine Buchung verweist auf einen unbekannten Empfaenger');
		}
		if (e.receipt) {
			if (receiptFiles.has(e.receipt.file)) {
				throw new ArchiveError('Ein Beleg wird von mehreren Buchungen verwendet');
			}
			receiptFiles.add(e.receipt.file);
		}
	}
	const refundEntries = doc.entries.filter((e) => e.category === REFUND_CATEGORY);
	if (refundEntries.length > 1) throw new ArchiveError('Mehr als eine Rueckzahlungs-Buchung');
	if (doc.refund) {
		if (refundEntries[0]?.id !== doc.refund.entryRef) {
			throw new ArchiveError('Rueckzahlung verweist auf keine passende Buchung');
		}
		for (const item of doc.refund.items) {
			if (item.participantRef && !participants.has(item.participantRef)) {
				throw new ArchiveError('Rueckzahlung verweist auf unbekannte Teilnehmende');
			}
		}
	} else if (refundEntries.length) {
		throw new ArchiveError('Rueckzahlungs-Buchung ohne Rueckzahlungsdaten');
	}
}
