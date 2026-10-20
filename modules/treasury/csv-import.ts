/**
 * Kontoauszug-Import (CSV), rein: Parser, Spaltenerkennung (Sparkasse CSV-CAMT und gängige
 * deutsche Exporte), Betrags-/Datumsformate und Duplikat-Schlüssel.
 */
import type { ImportMapping } from './schemas';

/** CSV nach RFC 4180 (Anführungszeichen, doppelte Quotes, Zeilenumbrüche in Feldern). */
export function parseCsv(text: string, delimiter: string): string[][] {
	const s = text.replace(/^\ufeff/, '');
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (quoted) {
			if (c === '"') {
				if (s[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += c;
			continue;
		}
		if (c === '"' && field === '') quoted = true;
		else if (c === delimiter) {
			row.push(field);
			field = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && s[i + 1] === '\n') i++;
			row.push(field);
			field = '';
			if (row.some((f) => f.trim() !== '')) rows.push(row);
			row = [];
		} else field += c;
	}
	row.push(field);
	if (row.some((f) => f.trim() !== '')) rows.push(row);
	return rows.map((r) => r.map((f) => f.trim()));
}

export function detectDelimiter(text: string): ImportMapping['delimiter'] {
	const first = text.replace(/^\ufeff/, '').split(/\r?\n/, 1)[0] ?? '';
	const counts = ([';', ',', '\t'] as const).map((d) => [d, first.split(d).length - 1] as const);
	counts.sort((a, b) => b[1] - a[1]);
	return counts[0]![1] > 0 ? counts[0]![0] : ';';
}

const norm = (h: string) =>
	h
		.toLowerCase()
		.replace(/ä/g, 'ae')
		.replace(/ö/g, 'oe')
		.replace(/ü/g, 'ue')
		.replace(/ß/g, 'ss')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

function pick(headers: string[], patterns: RegExp[]): string | null {
	for (const p of patterns) {
		const hit = headers.find((h) => p.test(norm(h)));
		if (hit) return hit;
	}
	return null;
}

/** Schlägt eine Spaltenzuordnung vor; `null`, wenn Datum oder Betrag fehlen. */
export function guessMapping(
	headers: string[],
	sample: string[] | undefined,
	delimiter: ImportMapping['delimiter']
): ImportMapping | null {
	const date = pick(headers, [
		/^buchungstag$/,
		/^buchungsdatum$/,
		/^datum$/,
		/buchung/,
		/valuta/,
		/date/
	]);
	const amount = pick(headers, [/^betrag( eur)?$/, /^umsatz/, /^betrag/, /amount/]);
	if (!date || !amount) return null;
	const counterparty = pick(headers, [
		/beguenstigter zahlungspflichtiger/,
		/zahlungspflichtiger/,
		/auftraggeber/,
		/empfaenger/,
		/^name/,
		/gegenpartei/,
		/payee|counterparty/
	]);
	const purpose = pick(headers, [/verwendungszweck/, /^zweck/, /purpose|reference|memo/]);
	const iban = pick(headers, [
		/kontonummer iban/,
		/iban (zahlungspflichtiger|beguenstigter|gegenkonto)/,
		/gegenkonto/,
		/^iban$/
	]);
	const sampleDate = sample?.[headers.indexOf(date)] ?? '';
	const dateFormat: ImportMapping['dateFormat'] = /^\d{4}-\d{2}-\d{2}$/.test(sampleDate)
		? 'YYYY-MM-DD'
		: /^\d{1,2}\.\d{1,2}\.\d{2}$/.test(sampleDate)
			? 'DD.MM.YY'
			: 'DD.MM.YYYY';
	const sampleAmount = sample?.[headers.indexOf(amount)] ?? '';
	const decimal: ImportMapping['decimal'] =
		/^-?[\d.]*,\d{1,2}$/.test(sampleAmount) || !/\.\d{1,2}$/.test(sampleAmount) ? ',' : '.';
	return { delimiter, date, amount, counterparty, purpose, iban, dateFormat, decimal };
}

/** Betrag in Cent; `null`, wenn unlesbar. Erlaubt Vorzeichen, Tausendertrenner, Währung. */
export function parseAmount(raw: string, decimal: ImportMapping['decimal']): number | null {
	let s = raw.replace(/[\s€]|EUR/gi, '');
	let sign = 1;
	if (/^[-−]/.test(s)) {
		sign = -1;
		s = s.slice(1);
	} else if (s.startsWith('+')) s = s.slice(1);
	if (/[-−]$/.test(s)) {
		sign = -1;
		s = s.slice(0, -1);
	}
	const thousands = decimal === ',' ? '.' : ',';
	s = s.split(thousands).join('');
	if (decimal === ',') s = s.replace(',', '.');
	if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
	const cents = Math.round(Number(s) * 100);
	return Number.isSafeInteger(cents) ? sign * cents : null;
}

export function parseDate(raw: string, format: ImportMapping['dateFormat']): string | null {
	const s = raw.trim();
	let y: number, m: number, d: number;
	if (format === 'YYYY-MM-DD') {
		const r = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
		if (!r) return null;
		[y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
	} else {
		const r = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(s);
		if (!r) return null;
		d = Number(r[1]);
		m = Number(r[2]);
		y = Number(r[3]);
		if (r[3]!.length === 2) y += 2000;
	}
	const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
	const t = new Date(`${iso}T00:00:00Z`);
	return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

export interface ParsedRow {
	line: number;
	bookedOn: string | null;
	amountCents: number | null;
	counterparty: string | null;
	purpose: string | null;
	/** IBAN der Gegenpartei (Rohwert, nur zum Hashen) */
	iban: string | null;
	error: string | null;
	/** Fachlicher Schlüssel für Duplikate (vor dem Hashen) */
	key: string | null;
}

const clip = (v: string | undefined, max: number) => {
	const s = (v ?? '').replace(/\s+/g, ' ').trim();
	return s ? s.slice(0, max) : null;
};

/** Wendet die Zuordnung an. Gleiche Zeilen in einer Datei erhalten fortlaufende Schlüssel. */
export function applyMapping(rows: string[][], mapping: ImportMapping): ParsedRow[] {
	const [header, ...data] = rows;
	if (!header) return [];
	const col = (name: string | null | undefined) => (name ? header.indexOf(name) : -1);
	const iDate = col(mapping.date);
	const iAmount = col(mapping.amount);
	const iCounter = col(mapping.counterparty);
	const iPurpose = col(mapping.purpose);
	const iIban = col(mapping.iban);
	const seen = new Map<string, number>();
	return data.map((r, idx) => {
		const bookedOn = iDate >= 0 ? parseDate(r[iDate] ?? '', mapping.dateFormat) : null;
		const amountCents = iAmount >= 0 ? parseAmount(r[iAmount] ?? '', mapping.decimal) : null;
		const counterparty = iCounter >= 0 ? clip(r[iCounter], 140) : null;
		const purpose = iPurpose >= 0 ? clip(r[iPurpose], 300) : null;
		const iban = iIban >= 0 ? clip(r[iIban], 50) : null;
		let error: string | null = null;
		if (!bookedOn) error = 'Datum nicht lesbar';
		else if (amountCents === null) error = 'Betrag nicht lesbar';
		else if (amountCents === 0) error = 'Betrag ist 0';
		let key: string | null = null;
		if (!error) {
			const base = [
				bookedOn,
				amountCents,
				(counterparty ?? '').toLowerCase(),
				(purpose ?? '').toLowerCase()
			].join('|');
			const n = (seen.get(base) ?? 0) + 1;
			seen.set(base, n);
			key = `${base}#${n}`;
		}
		return { line: idx + 2, bookedOn, amountCents, counterparty, purpose, iban, error, key };
	});
}
