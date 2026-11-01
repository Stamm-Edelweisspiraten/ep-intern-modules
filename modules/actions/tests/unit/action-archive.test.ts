import { describe, expect, it } from 'vitest';
import { strToU8, zipSync, type Zippable } from 'fflate';
import {
	ARCHIVE_FORMAT,
	ArchiveError,
	archiveDocumentSchema,
	archiveFilename,
	assertSafeArchivePath,
	buildArchive,
	detectReceiptType,
	parseArchive,
	sanitizeName,
	slugify,
	unpackArchive,
	type ArchiveDocument,
	type ArchiveManifest
} from '$modules/actions/action-archive';

const PDF = strToU8('%PDF-1.4\n%test');

function doc(over: Partial<ArchiveDocument> = {}): ArchiveDocument {
	return {
		action: {
			name: 'Sommerlager',
			description: null,
			location: 'Wald',
			startsOn: '2026-07-10',
			startsTime: null,
			endsOn: '2026-07-17',
			endsTime: null,
			feeCents: null,
			teamFeeCents: null
		},
		calculation: null,
		participants: [],
		form: null,
		payees: [],
		entries: [],
		refund: null,
		accounting: { closed: false, closedAt: null },
		...over
	};
}

const manifest: ArchiveManifest = {
	format: ARCHIVE_FORMAT,
	formatVersion: 1,
	exportedAt: '2026-10-15T10:00:00.000Z',
	contents: { participants: 0, entries: 0, receipts: 0, payees: 0, includesBank: false }
};

const entry = (over: Record<string, unknown> = {}) => ({
	id: 'e1',
	type: 'expense',
	category: 'food',
	description: 'Einkauf',
	amountCents: 1250,
	entryDate: '2026-07-11',
	paidBy: 'club',
	payeeRef: null,
	receipt: null,
	reimbursedAt: null,
	...over
});

const zipOf = (d: unknown, m: unknown = manifest) =>
	zipSync({
		'manifest.json': strToU8(JSON.stringify(m)),
		'action.json': strToU8(JSON.stringify(d))
	});

describe('slug und Dateiname', () => {
	it('transliteriert Umlaute und kürzt', () => {
		expect(slugify('Sommerlager Nörd & Süd!')).toBe('sommerlager-noerd-sued');
		expect(slugify('   ')).toBe('aktion');
		expect(slugify('x'.repeat(100)).length).toBe(40);
		expect(archiveFilename('Kopenhagen 2026', '2026-10-15')).toBe(
			'aktion-kopenhagen-2026-2026-10-15.zip'
		);
	});
	it('sanitizeName entfernt Pfadteile', () => {
		expect(sanitizeName('../../etc/passwd')).not.toContain('/');
		expect(sanitizeName('Rechnung Müller.pdf')).toBe('Rechnung_Muller.pdf');
		expect(sanitizeName('...')).toBe('beleg');
	});
});

describe('Pfadschutz', () => {
	it('erlaubt nur bekannte Pfade', () => {
		for (const ok of ['manifest.json', 'action.json', 'receipts/', 'receipts/e1-beleg.pdf']) {
			expect(() => assertSafeArchivePath(ok)).not.toThrow();
		}
		for (const bad of [
			'../evil.json',
			'/etc/passwd',
			'receipts/../../x',
			'receipts/a/b.pdf',
			'C:/x.pdf',
			'receipts\\x.pdf',
			'other.txt',
			'receipts//x.pdf',
			'a\u0000b',
			''
		]) {
			expect(() => assertSafeArchivePath(bad), bad).toThrow(ArchiveError);
		}
	});
});

describe('Magic Bytes', () => {
	it('erkennt PDF/PNG/JPEG/WebP und lehnt sonst ab', () => {
		expect(detectReceiptType(PDF)).toBe('application/pdf');
		expect(
			detectReceiptType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))
		).toBe('image/png');
		expect(detectReceiptType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
		expect(detectReceiptType(strToU8('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
		expect(detectReceiptType(strToU8('<html>'))).toBeNull();
		expect(detectReceiptType(new Uint8Array())).toBeNull();
	});
});

describe('Archiv lesen/schreiben', () => {
	it('Round-Trip von Dokument und Beleg', () => {
		const d = doc({
			entries: [
				entry({
					receipt: {
						file: 'receipts/e1-beleg.pdf',
						name: 'Beleg.pdf',
						contentType: 'application/pdf'
					}
				})
			] as ArchiveDocument['entries']
		});
		const zip = buildArchive({
			manifest,
			document: d,
			receipts: new Map([['receipts/e1-beleg.pdf', PDF]])
		});
		const parsed = parseArchive(zip);
		expect(parsed.document).toEqual(d);
		expect(parsed.files.get('receipts/e1-beleg.pdf')).toEqual(PDF);
	});

	it('lehnt Müll, falsches Format und falsche Version ab', () => {
		expect(() => parseArchive(strToU8('hallo welt, kein zip, nur Text mit genug Länge'))).toThrow(
			/kein gültiges ZIP/
		);
		expect(() => parseArchive(zipOf(doc(), { format: 'x' }))).toThrow(/kein Aktions-Export/);
		expect(() => parseArchive(zipOf(doc(), { ...manifest, formatVersion: 2 }))).toThrow(
			/Archivversion/
		);
		expect(parseArchive(zipOf(doc())).document.action.name).toBe('Sommerlager');
	});

	it('verlangt manifest.json und action.json', () => {
		expect(() => parseArchive(zipSync({ 'action.json': strToU8('{}') }))).toThrow(/manifest/);
		expect(() =>
			parseArchive(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) }))
		).toThrow(/action.json fehlt/);
	});

	it('Zip-Slip, absolute Pfade und unbekannte Dateien', () => {
		for (const name of ['../evil.txt', '/abs.txt', 'receipts/../../x.pdf', 'extra.txt']) {
			const zip = zipSync({
				'manifest.json': strToU8(JSON.stringify(manifest)),
				'action.json': strToU8(JSON.stringify(doc())),
				[name]: strToU8('x')
			});
			expect(() => unpackArchive(zip), name).toThrow(ArchiveError);
		}
	});

	it('Zip-Bomb-Grenzen: Einträge, Einzelgröße, Summe', () => {
		const many: Zippable = {};
		for (let i = 0; i < 2001; i++) many[`receipts/f${i}.pdf`] = new Uint8Array(1);
		expect(() => unpackArchive(zipSync(many))).toThrow(/mehr als 2000/);

		const big = new Uint8Array(11 * 1024 * 1024);
		expect(() => unpackArchive(zipSync({ 'receipts/big.pdf': [big, { level: 1 }] }))).toThrow(
			/zu große Datei/
		);

		const ten = new Uint8Array(10 * 1024 * 1024);
		const sum: Zippable = {};
		for (let i = 0; i < 31; i++) sum[`receipts/f${i}.pdf`] = [ten, { level: 1 }];
		expect(() => unpackArchive(zipSync(sum))).toThrow(/entpackt zu groß/);
	});
});

describe('Dokument-Schema', () => {
	const parse = (d: unknown) => archiveDocumentSchema.safeParse(d);

	it('isPast ist optional (alte Archive) und muss ein Boolean sein', () => {
		expect(parse(doc()).success).toBe(true);
		const withPast = (isPast: unknown) =>
			parse({ ...doc(), action: { ...doc().action, isPast } }).success;
		expect(withPast(true)).toBe(true);
		expect(withPast(false)).toBe(true);
		expect(withPast('ja')).toBe(false);
		const parsed = parseArchive(zipOf({ ...doc(), action: { ...doc().action, isPast: true } }));
		expect(parsed.document.action.isPast).toBe(true);
		expect(parseArchive(zipOf(doc())).document.action.isPast).toBeUndefined();
	});

	it('reimbursedUpfront ist optional und nur mit reimbursedAt gültig', () => {
		const base = { paidBy: 'person', payeeRef: 'y1', reimbursedAt: '2026-07-12T10:00:00.000Z' };
		const ok = (e: unknown) => parse({ ...doc(), entries: [e] }).success;
		expect(ok(entry(base))).toBe(true);
		expect(ok(entry({ ...base, reimbursedUpfront: true }))).toBe(true);
		expect(ok(entry({ ...base, reimbursedUpfront: false }))).toBe(true);
		expect(ok(entry({ ...base, reimbursedUpfront: 'ja' }))).toBe(false);
		expect(ok(entry({ ...base, reimbursedAt: null, reimbursedUpfront: true }))).toBe(false);
		expect(ok(entry({ reimbursedUpfront: true }))).toBe(false);
	});

	it('ist strikt (unbekannte Schlüssel)', () => {
		expect(parse(doc()).success).toBe(true);
		expect(parse({ ...doc(), owner: 'x' }).success).toBe(false);
		expect(parse({ ...doc(), action: { ...doc().action, ownerId: 'x' } }).success).toBe(false);
	});

	it('prüft Beträge, Kategorien und Regeln', () => {
		const withEntry = (e: unknown) => parse({ ...doc(), entries: [e] }).success;
		expect(withEntry(entry())).toBe(true);
		expect(withEntry(entry({ amountCents: 0 }))).toBe(false);
		expect(withEntry(entry({ amountCents: 100_000_001 }))).toBe(false);
		expect(withEntry(entry({ amountCents: 1.5 }))).toBe(false);
		expect(withEntry(entry({ category: 'unbekannt' }))).toBe(false);
		expect(withEntry(entry({ type: 'income', category: 'food' }))).toBe(false);
		expect(withEntry(entry({ paidBy: 'person' }))).toBe(false);
		expect(withEntry(entry({ payeeRef: 'y1' }))).toBe(false);
		expect(withEntry(entry({ category: 'refund' }))).toBe(true);
		expect(withEntry(entry({ type: 'income', category: 'refund' }))).toBe(false);
		expect(withEntry(entry({ entryDate: '2026-02-30' }))).toBe(false);
		expect(
			withEntry(entry({ receipt: { file: '../x', name: 'a', contentType: 'application/pdf' } }))
		).toBe(false);
		expect(
			withEntry(
				entry({
					receipt: { file: 'receipts/e1-a.exe', name: 'a', contentType: 'application/x-msdownload' }
				})
			)
		).toBe(false);
	});

	it('Querprüfungen: Referenzen und doppelte IDs per parseArchive', () => {
		const run = (d: unknown) => parseArchive(zipOf(d));
		expect(() => run({ ...doc(), entries: [entry({ paidBy: 'person', payeeRef: 'y9' })] })).toThrow(
			/unbekannten Empfänger/
		);
		expect(() => run({ ...doc(), entries: [entry(), entry()] })).toThrow(/doppelte/);
		expect(() => run({ ...doc(), entries: [entry({ category: 'refund' })], refund: null })).toThrow(
			/Rückzahlungs-Buchung ohne/
		);
		expect(() =>
			run({
				...doc(),
				entries: [entry({ category: 'refund' })],
				refund: {
					entryRef: 'e1',
					mode: 'auto',
					bookedAt: '2026-07-20T10:00:00.000Z',
					surplusCents: 1000,
					perHeadCents: 500,
					payingCount: 1,
					remainderCents: 0,
					items: [{ participantRef: 'p9', name: 'X', amountCents: 500 }]
				}
			})
		).toThrow(/unbekannte Teilnehmende/);
		expect(() =>
			run({
				...doc(),
				entries: [
					entry({
						receipt: { file: 'receipts/e1-a.pdf', name: 'a', contentType: 'application/pdf' }
					})
				]
			})
		).toThrow(/Beleg fehlt/);
		expect(() => run({ ...doc(), action: { ...doc().action, endsOn: '2026-07-01' } })).toThrow(
			/Aktion ist ungültig/
		);
	});
});
