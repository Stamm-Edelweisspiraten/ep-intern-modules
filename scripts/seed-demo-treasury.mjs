// Demo-Daten fuer die Kasse (idempotent, ueber die echte API). Voraussetzung: demo-server laeuft,
// `node scripts/seed-demo.mjs` und `node scripts/seed-demo-modules.mjs` wurden ausgefuehrt.
// Legt Konten, Zahler (Geschwister), Buchungen inkl. Sammelzahlung, eine ueberfaellige Rechnung
// und einen Beispiel-Kontoauszug unter .data/demo-kontoauszug.csv an.
import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';
const T = '/modules/treasury';

let cookie = '';
async function call(method, path, body, base = '/api/v1') {
	const res = await fetch(BASE + base + path, {
		method,
		headers: {
			'content-type': 'application/json',
			origin: ORIGIN,
			...(cookie ? { cookie } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const set = res.headers.getSetCookie?.() ?? [];
	if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
	const json = await res.json().catch(() => null);
	if (res.status >= 400)
		console.warn(`${method} ${path} -> ${res.status}`, JSON.stringify(json?.error ?? json));
	return { status: res.status, data: json?.data };
}

await call(
	'POST',
	'/sign-in/email',
	{ email: 'admin@demo.test', password: 'Demo-Admin-2026!' },
	'/api/auth'
);
if (!cookie) throw new Error('Login fehlgeschlagen - laeuft der Demo-Server?');
await call('POST', '/modules/treasury/enable');
// Neue Modulrechte erst nach erneutem Login wirksam
cookie = '';
await call(
	'POST',
	'/sign-in/email',
	{ email: 'admin@demo.test', password: 'Demo-Admin-2026!' },
	'/api/auth'
);

const existing = (await call('GET', `${T}/accounts`)).data ?? [];
if (existing.length) {
	console.log('Kasse hat bereits Konten – Seed übersprungen.');
	process.exit(0);
}

await call('PUT', `${T}/settings`, {
	bankHolder: 'VCP Stamm Seeadler',
	bankIban: 'DE02 1203 0000 0000 2020 51',
	bankBic: 'BYLADEM1001',
	bankName: 'Demo-Bank',
	daysBeforeStart: 14,
	minDays: 14,
	remindersEnabled: true,
	firstDays: 7,
	secondDays: 14,
	paidMailEnabled: true,
	paidSubject: 'Zahlungseingang bestätigt',
	paidBody:
		'Hallo,\n\nvielen Dank! Wir haben folgende Zahlung erhalten:\n\n{posten}\n\nSumme: {summe}\n\nGut Pfad\nDie Kasse',
	reminderSubject: 'Zahlungserinnerung ({stufe}. Erinnerung)',
	reminderBody:
		'Hallo,\n\nbei uns sind folgende Beträge noch offen:\n\n{posten}\n\nOffen insgesamt: {summe}\n\nBitte überweise den Betrag auf folgendes Konto:\n{kontodaten}\nVerwendungszweck: {verwendungszweck}\n\nFalls du schon bezahlt hast, betrachte diese Nachricht bitte als gegenstandslos.\n\nGut Pfad\nDie Kasse'
});

const giro = (
	await call('POST', `${T}/accounts`, {
		name: 'Girokonto',
		kind: 'giro',
		iban: 'DE02120300000000202051',
		openingBalanceCents: 235000,
		openingDate: '2026-01-01'
	})
).data;
const cash = (
	await call('POST', `${T}/accounts`, {
		name: 'Barkasse',
		kind: 'cash',
		openingBalanceCents: 18000,
		openingDate: '2026-01-01'
	})
).data;

// Rechnungen aus den Aktionen erzeugen
const sync = (await call('POST', `${T}/sync`)).data;
console.log('Abgleich:', sync);

// Geschwister als Zahler uebernehmen
for (const s of (await call('GET', `${T}/payers/suggestions`)).data ?? []) {
	await call('POST', `${T}/payers`, { name: s.name, memberIds: s.members.map((m) => m.id) });
	console.log('Zahler:', s.name);
}

const invoices = (await call('GET', `${T}/invoices?status=all&limit=200`)).data.items;
const inv = (name, action) =>
	invoices.find((i) => i.recipientName === name && (!action || i.action?.name === action));

async function tx(body) {
	return (await call('POST', `${T}/transactions`, body)).data;
}
async function allocateSuggested(t, notify = false) {
	const s = (await call('GET', `${T}/transactions/${t.id}/suggestion`)).data;
	if (!s) return console.log('Kein Vorschlag für', t.purpose);
	await call('PUT', `${T}/transactions/${t.id}/allocations`, {
		allocations: s.allocations,
		notify
	});
	console.log(`Zugeordnet (${s.confidence}):`, s.invoiceNumbers.join(', '));
}

const herbst = inv('Lena Müller', 'Herbstfahrt 2026');
const kopenhagenPaul = inv('Paul Schmidt', 'Kopenhagen 2026');
// Sammelzahlung der Familie Müller fuer drei Kinder (Herbstfahrt) – mit Bestaetigungs-Mail
const muellerSum = ['Lena Müller', 'Jonas Müller', 'Mia Müller']
	.map((n) => inv(n, 'Herbstfahrt 2026')?.openCents ?? 0)
	.reduce((a, b) => a + b, 0);
const t1 = await tx({
	accountId: giro.id,
	bookedOn: '2026-10-05',
	amountCents: muellerSum,
	counterparty: 'Petra Müller',
	purpose: 'Herbstfahrt Lena Jonas Mia Mueller'
});
await allocateSuggested(t1, true);

if (kopenhagenPaul) {
	const t2 = await tx({
		accountId: giro.id,
		bookedOn: '2026-10-08',
		amountCents: kopenhagenPaul.openCents,
		counterparty: 'Schmidt, Andrea',
		purpose: `${kopenhagenPaul.number} Paul Schmidt Kopenhagen`
	});
	await allocateSuggested(t2);
}
// Barzahlung (Teilbetrag) fuer Deniz ueber „bezahlt markieren“
const deniz = inv('Deniz Yılmaz', 'Kopenhagen 2026');
if (deniz) {
	await call('POST', `${T}/invoices/${deniz.id}/mark-paid`, {
		accountId: cash.id,
		bookedOn: '2026-10-10',
		amountCents: 10000,
		counterparty: 'Deniz Yılmaz (bar)',
		notify: false
	});
}

// Ausgaben, Gebuehren, Umbuchung
const categories = (await call('GET', `${T}/categories`)).data;
const cat = (name) => categories.find((c) => c.name === name)?.id ?? null;
const actions = (await call('GET', `${T}/action-refs`)).data;
const kopenhagen = actions.find((a) => a.name === 'Kopenhagen 2026');
for (const e of [
	{
		bookedOn: '2026-07-01',
		amountCents: -54000,
		counterparty: 'DB Fernverkehr',
		purpose: 'Gruppenticket Kopenhagen',
		categoryId: cat('Fahrtkosten'),
		actionId: kopenhagen?.id ?? null
	},
	{
		bookedOn: '2026-07-21',
		amountCents: -21890,
		counterparty: 'Netto',
		purpose: 'Einkauf Lager',
		categoryId: cat('Verpflegung'),
		actionId: kopenhagen?.id ?? null
	},
	{
		bookedOn: '2026-09-30',
		amountCents: -490,
		counterparty: 'Demo-Bank',
		purpose: 'Kontoführung Q3',
		categoryId: cat('Bankgebühren')
	},
	{
		bookedOn: '2026-09-12',
		amountCents: 25000,
		counterparty: 'Förderverein',
		purpose: 'Spende Zeltmaterial',
		categoryId: cat('Spenden')
	},
	{ bookedOn: '2026-10-12', amountCents: 6000, counterparty: 'M. Unbekannt', purpose: 'Beitrag' }
]) {
	await tx({ accountId: giro.id, ...e });
}
await call('POST', `${T}/transfers`, {
	fromAccountId: cash.id,
	toAccountId: giro.id,
	bookedOn: '2026-10-11',
	amountCents: 10000,
	purpose: 'Bargeld eingezahlt'
});

// Manuelle Rechnung (ueberfaellig) fuer Mitgliedsbeitraege der Familie Schmidt
const payers = (await call('GET', `${T}/payers`)).data;
const schmidt = payers.find((p) => p.name.includes('Schmidt'));
const members = (await call('GET', `${T}/members`)).data;
const m = (name) => members.find((x) => x.name === name)?.id ?? null;
await call('POST', `${T}/invoices`, {
	payerId: schmidt?.id ?? null,
	recipientName: 'Familie Schmidt',
	recipientEmail: null,
	issuedOn: '2026-09-01',
	dueOn: '2026-09-30',
	note: 'Jahresbeitrag 2026',
	lines: [
		{ description: 'Mitgliedsbeitrag 2026 – Paul', amountCents: 6000, memberId: m('Paul Schmidt') },
		{ description: 'Mitgliedsbeitrag 2026 – Emma', amountCents: 6000, memberId: m('Emma Schmidt') }
	]
});

// Beispiel-Kontoauszug (Sparkasse CSV-CAMT) zum Testen des Imports
const jonasK = inv('Jonas Müller', 'Kopenhagen 2026');
const rows = [
	[
		'Auftragskonto',
		'Buchungstag',
		'Valutadatum',
		'Buchungstext',
		'Verwendungszweck',
		'Beguenstigter/Zahlungspflichtiger',
		'Kontonummer/IBAN',
		'BIC (SWIFT-Code)',
		'Betrag',
		'Waehrung',
		'Info'
	],
	[
		'DE02120300000000202051',
		'14.10.26',
		'14.10.26',
		'GUTSCHR. UEBERWEISUNG',
		`${jonasK?.number ?? ''} Jonas Mueller`,
		'Müller, Petra',
		'DE89370400440532013000',
		'COBADEFFXXX',
		((jonasK?.openCents ?? 0) / 100).toFixed(2).replace('.', ','),
		'EUR',
		'Umsatz gebucht'
	],
	[
		'DE02120300000000202051',
		'15.10.26',
		'15.10.26',
		'GUTSCHR. UEBERWEISUNG',
		'Mitgliedsbeitrag Paul und Emma Schmidt',
		'Andrea Schmidt',
		'DE75512108001245126199',
		'SOGEDEFFXXX',
		'120,00',
		'EUR',
		'Umsatz gebucht'
	],
	[
		'DE02120300000000202051',
		'15.10.26',
		'15.10.26',
		'LASTSCHRIFT',
		'Hallenmiete Oktober',
		'Gemeinde Bremen',
		'DE12500105170648489890',
		'INGDDEFFXXX',
		'-45,00',
		'EUR',
		'Umsatz gebucht'
	]
];
const csv = rows.map((r) => r.map((c) => `"${c}"`).join(';')).join('\r\n');
writeFileSync('.data/demo-kontoauszug.csv', '\ufeff' + csv + '\r\n');
console.log('Beispiel-Kontoauszug: .data/demo-kontoauszug.csv');
// Ausbaustufe 2: Zahler-IBAN, Eingangsrechnung, Auslage
await import('./seed-demo-treasury-extras.mjs');
console.log('Seed Kasse abgeschlossen.', herbst ? '' : '(Herbstfahrt-Rechnungen fehlen?)');
