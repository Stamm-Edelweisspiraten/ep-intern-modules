// Demo-Daten fuer die Ausbaustufe 2 der Kasse (idempotent): Bankverbindung der Familie Mueller,
// Eingangsrechnung (Zeltplatz) und eine Auslage in „Kopenhagen 2026“ (erscheint unter „Auszahlungen“).
// Wird von seed-demo-treasury.mjs aufgerufen, laesst sich aber auch einzeln starten.
const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';

let cookie = '';
async function call(method, path, body, base = '/api/v1') {
	const res = await fetch(BASE + base + path, {
		method,
		headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
		body: body ? JSON.stringify(body) : undefined
	});
	const set = res.headers.getSetCookie?.() ?? [];
	if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
	const json = await res.json().catch(() => null);
	if (res.status >= 400) {
		console.warn(`${method} ${path} -> ${res.status}`, JSON.stringify(json?.error ?? json));
	}
	return { status: res.status, data: json?.data };
}

await call(
	'POST',
	'/sign-in/email',
	{ email: 'admin@demo.test', password: 'Demo-Admin-2026!' },
	'/api/auth'
);
if (!cookie) throw new Error('Login fehlgeschlagen - laeuft der Demo-Server?');
const T = '/modules/treasury';

// Bankverbindung der Familie Mueller (Zahlungen von dieser IBAN werden der Familie vorgeschlagen)
const payers = (await call('GET', `${T}/payers`)).data ?? [];
const mueller = payers.find((p) => p.name === 'Familie Müller');
if (mueller && !mueller.ibanMasked) {
	await call('PUT', `${T}/payers/${mueller.id}`, {
		name: mueller.name,
		email: mueller.email,
		note: mueller.note,
		memberIds: mueller.members.map((m) => m.id),
		accountHolder: 'Petra Müller',
		iban: 'DE89 3704 0044 0532 0130 00',
		bic: 'COBADEFFXXX'
	});
	console.log('IBAN für Familie Müller hinterlegt');
}

// Eingangsrechnung
const payables = (await call('GET', `${T}/payables?status=all`)).data?.items ?? [];
const actions = (await call('GET', `${T}/action-refs`)).data ?? [];
const herbst = actions.find((a) => a.name === 'Herbstfahrt 2026');
if (!payables.some((p) => p.recipientName === 'Pfadfinderheim Worpswede')) {
	await call('POST', `${T}/payables`, {
		recipientName: 'Pfadfinderheim Worpswede',
		description: 'Hausmiete Herbstfahrt 2026',
		amountCents: 32000,
		dueOn: '2026-10-30',
		iban: 'DE75 5121 0800 1245 1261 99',
		bic: 'SOGEDEFFXXX',
		actionId: herbst?.id ?? null
	});
	console.log('Eingangsrechnung angelegt');
}

// Auslage in der Abrechnung „Kopenhagen 2026“ (Tim hat Proviant vorgestreckt)
const list = (await call('GET', '/modules/actions/actions?search=Kopenhagen')).data?.items ?? [];
const kop = list.find((a) => a.name === 'Kopenhagen 2026');
if (kop) {
	const acc = (await call('GET', `/modules/actions/actions/${kop.id}/accounting`)).data;
	if (!(acc?.payees ?? []).some((p) => p.name === 'Tim Becker')) {
		const payee = (
			await call('POST', `/modules/actions/actions/${kop.id}/accounting/payees`, {
				name: 'Tim Becker',
				iban: 'DE02 1203 0000 0000 2020 51',
				bic: null,
				note: null
			})
		).data;
		if (payee) {
			await call('POST', `/modules/actions/actions/${kop.id}/accounting/entries`, {
				type: 'expense',
				category: 'food',
				description: 'Proviant Rückfahrt',
				amountCents: 6380,
				entryDate: '2026-07-26',
				paidBy: 'person',
				payeeId: payee.id
			});
			console.log('Auslage Tim Becker angelegt');
		}
	}
}
await call('POST', `${T}/sync`);
console.log('Seed Kasse (Ausbaustufe 2) abgeschlossen.');
