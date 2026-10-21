/**
 * Export-/Import-Archiv einer Aktion (reine Logik; nur reine SDK-Helfer für Namen und Magic Bytes).
 *
 * Aufbau des ZIP:
 *   manifest.json   Format, Version, Zähler, Hinweise
 *   action.json     alle Daten der Aktion (siehe `archiveDocumentSchema`)
 *   receipts/<exportId>-<name>   Belegdateien (nur wenn exportiert)
 *
 * Sicherheit beim Lesen: nur drei erlaubte Pfadformen, keine absoluten/`..`-Pfade, keine Duplikate,
 * höchstens 2000 Einträge, höchstens 300 MB entpackt (über die Header-Angaben VOR dem
 * Entpacken geprüft), Belege <= 10 MB. Archivnamen werden nie als Dateisystem-/Storage-Pfad benutzt.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import { safeFileName } from '$lib/sdk/file-names';
import { detectContentType } from '$lib/sdk/server/file-response';
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

/** Dateiname für Storage-Pfade/Archiv: nur `[A-Za-z0-9._-]`, höchstens 100 Zeichen (zentral `safeFileName`). */
export const sanitizeName = (name: string): string => safeFileName(name, { fallback: 'beleg' });

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
 * Prüft einen Archiv-Eintragsnamen. Erlaubt: `manifest.json`, `action.json`, `receipts/`
 * (Verzeichniseintrag) und `receipts/<name>`. Alles andere wirft einen `ArchiveError`.
 */
export function assertSafeArchivePath(name: string): void {
	// eslint-disable-next-line no-control-regex
	if (!name || name.length > 255 || /[\u0000-\u001f\u007f\\:]/.test(name)) {
		throw new ArchiveError('Archiv enthält einen ungültigen Dateinamen');
	}
	if (name.startsWith('/')) throw new ArchiveError('Archiv enthält einen absoluten Pfad');
	const segments = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
	for (const seg of segments) {
		if (!seg || seg === '.' || seg === '..') {
			throw new ArchiveError('Archiv enthält einen unzulässigen Pfad');
		}
	}
	if (name === 'manifest.json' || name === 'action.json' || name === 'receipts/') return;
	if (RECEIPT_FILE_RE.test(name)) return;
	throw new ArchiveError('Archiv enthält eine unerwartete Datei');
}

// --- Inhaltstyp per Magic Bytes ----------------------------------------------

export type ReceiptType = (typeof RECEIPT_CONTENT_TYPES)[number];

/** Belegtyp am Inhalt (zentral `detectContentType`); nur PDF/JPEG/PNG/WebP, sonst `null`. */
export function detectReceiptType(bytes: Uint8Array): ReceiptType | null {
	const type = detectContentType(bytes);
	return (RECEIPT_CONTENT_TYPES as readonly string[]).includes(type ?? '')
		? (type as ReceiptType)
		: null;
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
	/** Fehlt bei älteren Archiven (= false) */
	isPast: z.boolean().optional(),
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
		reimbursedAt: isoStamp.nullable(),
		/** Beim Erfassen bereits erstattet (fehlt = false); nur zusammen mit `reimbursedAt`. */
		reimbursedUpfront: z.boolean().optional(),
		/**
		 * Nur Ausgaben des Stammes: Empfänger der Überweisung und Zahlstatus. Fehlt das Feld (ältere
		 * Archive), gilt die Ausgabe als bezahlt. `iban` nur mit `actions.payout.view` beim Export.
		 */
		transfer: z
			.strictObject({
				recipientName: entryInput.shape.recipientName,
				iban: z.string().max(50).nullable().optional(),
				bic: entryInput.shape.bic,
				purpose: entryInput.shape.purpose,
				paidAt: isoStamp.nullable()
			})
			.nullable()
			.optional()
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
		if (e.reimbursedUpfront && !e.reimbursedAt) {
			bad('reimbursedUpfront', 'Nur bei erstatteten Auslagen');
		}
		if (e.transfer && (e.type !== 'expense' || e.paidBy !== 'club')) {
			bad('transfer', 'Nur bei Ausgaben des Stammes');
		}
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
		includesBank: z.boolean(),
		/** Gesundheitsdaten enthalten (Export mit `members.data.export`); fehlt bei älteren Archiven */
		includesHealth: z.boolean().optional()
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

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

/**
 * Sucht das End-of-Central-Directory und weist ZIP64-Archive ab, bevor fflate sie liest
 * (präparierte ZIP64-Header können `unzipSync` endlos laufen lassen, Issue #21). Eigene Exporte
 * sind nie ZIP64 (≤ 2000 Einträge, < 4 GB).
 */
export function assertNoZip64(data: Uint8Array): void {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	// EOCD steht in den letzten 22 + 65 535 (Kommentar) Bytes
	const min = Math.max(0, data.byteLength - 22 - 0xffff);
	let eocd = -1;
	for (let i = data.byteLength - 22; i >= min; i--) {
		if (view.getUint32(i, true) === EOCD_SIGNATURE) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ArchiveError('Datei ist kein gültiges ZIP-Archiv');
	if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE) {
		throw new ArchiveError('ZIP64-Archive werden nicht unterstützt');
	}
	const entries = view.getUint16(eocd + 10, true);
	const cdSize = view.getUint32(eocd + 12, true);
	const cdOffset = view.getUint32(eocd + 16, true);
	if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
		throw new ArchiveError('ZIP64-Archive werden nicht unterstützt');
	}
}

/** Entpackt das Archiv unter Einhaltung aller Grenzen; wirft `ArchiveError`. */
export function unpackArchive(data: Uint8Array): Map<string, Uint8Array> {
	if (data.byteLength > MAX_ARCHIVE_BYTES) throw new ArchiveError('Archiv ist zu groß');
	if (data.byteLength < 22 || data[0] !== 0x50 || data[1] !== 0x4b) {
		throw new ArchiveError('Datei ist kein gültiges ZIP-Archiv');
	}
	assertNoZip64(data);
	const seen = new Set<string>();
	let count = 0;
	let total = 0;
	let out: Record<string, Uint8Array>;
	try {
		out = unzipSync(data, {
			filter(file) {
				count += 1;
				if (count > MAX_ARCHIVE_ENTRIES) {
					throw new ArchiveError(`Archiv enthält mehr als ${MAX_ARCHIVE_ENTRIES} Einträge`);
				}
				assertSafeArchivePath(file.name);
				if (file.name.endsWith('/')) return false;
				if (seen.has(file.name)) throw new ArchiveError('Archiv enthält doppelte Einträge');
				seen.add(file.name);
				const limit = file.name.startsWith('receipts/') ? MAX_RECEIPT_BYTES : MAX_JSON_BYTES;
				if (file.originalSize > limit) {
					throw new ArchiveError('Archiv enthält eine zu große Datei');
				}
				total += file.originalSize;
				if (total > MAX_UNPACKED_BYTES) {
					throw new ArchiveError('Archiv ist entpackt zu groß (höchstens 300 MB)');
				}
				return true;
			}
		});
	} catch (e) {
		if (e instanceof ArchiveError) throw e;
		throw new ArchiveError('Archiv ist beschädigt und kann nicht gelesen werden');
	}
	const files = new Map<string, Uint8Array>();
	let actual = 0;
	for (const [name, bytes] of Object.entries(out)) {
		actual += bytes.byteLength;
		if (actual > MAX_UNPACKED_BYTES) throw new ArchiveError('Archiv ist entpackt zu groß');
		files.set(name, bytes);
	}
	return files;
}

function parseJson(bytes: Uint8Array | undefined, what: string): unknown {
	if (!bytes) throw new ArchiveError(`${what} fehlt im Archiv`);
	try {
		return JSON.parse(strFromU8(bytes));
	} catch {
		throw new ArchiveError(`${what} ist kein gültiges JSON`);
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
		throw new ArchiveError('Archivversion wird nicht unterstützt');
	}
	const manifest = archiveManifestSchema.safeParse(rawManifest);
	if (!manifest.success) {
		throw new ArchiveError(`manifest.json ist ungültig (${issueText(manifest.error)})`);
	}
	const rawDoc = parseJson(files.get('action.json'), 'action.json');
	const doc = archiveDocumentSchema.safeParse(rawDoc);
	if (!doc.success) {
		throw new ArchiveError(`action.json ist ungültig (${issueText(doc.error)})`);
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

/** Querprüfungen, die ein einzelnes Schema nicht kann. */
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
	if (!a.success) throw new ArchiveError(`Aktion ist ungültig (${issueText(a.error)})`);

	const participants = unique(
		doc.participants.map((p) => p.id),
		'Teilnehmende'
	);
	const payees = unique(
		doc.payees.map((p) => p.id),
		'Empfänger'
	);
	unique(
		doc.entries.map((e) => e.id),
		'Buchungen'
	);
	const receiptFiles = new Set<string>();
	for (const e of doc.entries) {
		if (e.payeeRef && !payees.has(e.payeeRef)) {
			throw new ArchiveError('Eine Buchung verweist auf einen unbekannten Empfänger');
		}
		if (e.receipt) {
			if (receiptFiles.has(e.receipt.file)) {
				throw new ArchiveError('Ein Beleg wird von mehreren Buchungen verwendet');
			}
			receiptFiles.add(e.receipt.file);
		}
	}
	const refundEntries = doc.entries.filter((e) => e.category === REFUND_CATEGORY);
	if (refundEntries.length > 1) throw new ArchiveError('Mehr als eine Rückzahlungs-Buchung');
	if (doc.refund) {
		if (refundEntries[0]?.id !== doc.refund.entryRef) {
			throw new ArchiveError('Rückzahlung verweist auf keine passende Buchung');
		}
		for (const item of doc.refund.items) {
			if (item.participantRef && !participants.has(item.participantRef)) {
				throw new ArchiveError('Rückzahlung verweist auf unbekannte Teilnehmende');
			}
		}
	} else if (refundEntries.length) {
		throw new ArchiveError('Rückzahlungs-Buchung ohne Rückzahlungsdaten');
	}
}
