// Legt Demo-Daten fuer die Module `members` und `actions` an (idempotent, ueber die echte API).
// Voraussetzung: demo-server laeuft, `node scripts/seed-demo.mjs` wurde ausgefuehrt.
// Enthaelt Geschwister (gleiche Anschrift/E-Mail), damit Sammelzahlungen in der Kasse getestet werden koennen.
const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';

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
	if (res.status >= 400 && res.status !== 409) {
		console.warn(`${method} ${path} -> ${res.status}`, JSON.stringify(json?.error ?? json));
	}
	return { status: res.status, json };
}

await call(
	'POST',
	'/sign-in/email',
	{ email: 'admin@demo.test', password: 'Demo-Admin-2026!' },
	'/api/auth'
);
if (!cookie) throw new Error('Login fehlgeschlagen - laeuft der Demo-Server?');

for (const id of ['members', 'actions', 'treasury']) {
	const r = await call('POST', `/modules/${id}/enable`);
	console.log(`Modul ${id} aktivieren:`, r.status);
}
// Neue Modulrechte sind erst nach erneutem Login in der Sitzung wirksam
cookie = '';
await call(
	'POST',
	'/sign-in/email',
	{ email: 'admin@demo.test', password: 'Demo-Admin-2026!' },
	'/api/auth'
);

// --- Mitglieder ---------------------------------------------------------------
const M = '/modules/members';
const families = [
	{
		lastName: 'Müller',
		street: 'Lindenweg 4',
		email: 'familie.mueller@demo.test',
		kids: [
			['Lena', '2015-03-12', 'woelfling'],
			['Jonas', '2013-08-02', 'pfadfinder'],
			['Mia', '2017-11-23', 'neuling-woelfling']
		]
	},
	{
		lastName: 'Schmidt',
		street: 'Am Deich 17',
		email: 'schmidt.eltern@demo.test',
		kids: [
			['Paul', '2014-01-30', 'pfadfinder'],
			['Emma', '2016-06-14', 'woelfling']
		]
	},
	{
		lastName: 'Yılmaz',
		street: 'Hafenstraße 88',
		email: 'yilmaz@demo.test',
		kids: [['Deniz', '2012-09-09', 'spaeher']]
	},
	{
		lastName: 'Becker',
		street: 'Wiesenstraße 2',
		email: 'tim.becker@demo.test',
		kids: [['Tim', '2008-04-18', 'kreuzpfadfinder']]
	},
	{
		lastName: 'Neumann',
		street: 'Kirchplatz 1',
		email: 'sophie.neumann@demo.test',
		kids: [['Sophie', '2005-12-01', 'kreuzpfadfinder']]
	}
];

const existing = (await call('GET', `${M}/members?limit=200`)).json?.data?.items ?? [];
const memberByName = new Map(existing.map((m) => [`${m.firstName} ${m.lastName}`, m]));
for (const f of families) {
	for (const [firstName, birthDate, stage] of f.kids) {
		const key = `${firstName} ${f.lastName}`;
		if (memberByName.has(key)) continue;
		const r = await call('POST', `${M}/members`, {
			firstName,
			lastName: f.lastName,
			birthDate,
			street: f.street,
			postalCode: '28195',
			city: 'Bremen',
			country: 'DE',
			stage,
			emails: [{ name: 'Eltern', value: f.email }],
			phones: [{ name: 'Mobil', value: '+49170' + String(1000000 + memberByName.size) }]
		});
		if (r.json?.data) memberByName.set(key, r.json.data);
	}
}
console.log('Mitglieder:', memberByName.size);

// Mitgliedschaft: Eintritt, ein Zweitmitglied (zahlt nur Stamm) und ein Eintritt nach dem 28.02.
const membership = {
	'Lena Müller': { entryDate: '2022-09-01' },
	'Jonas Müller': { entryDate: '2020-03-15' },
	'Mia Müller': { entryDate: '2026-05-10' },
	'Paul Schmidt': { entryDate: '2021-01-20' },
	'Emma Schmidt': { entryDate: '2023-02-14' },
	'Deniz Yılmaz': { entryDate: '2019-10-01', secondaryMember: true, feeLevels: ['stamm'] },
	'Tim Becker': { entryDate: '2016-04-01' },
	'Sophie Neumann': { entryDate: '2012-06-01' }
};
for (const [name, extra] of Object.entries(membership)) {
	const m = memberByName.get(name);
	if (!m || m.entryDate) continue;
	const full = (await call('GET', `${M}/members/${m.id}`)).json?.data;
	if (!full) continue;
	const r = await call('PUT', `${M}/members/${m.id}`, {
		firstName: full.firstName,
		lastName: full.lastName,
		scoutName: full.scoutName,
		birthDate: full.birthDate,
		street: full.street,
		postalCode: full.postalCode,
		city: full.city,
		country: full.country,
		phones: full.phones,
		emails: full.emails,
		stage: full.stage,
		groupIds: full.groups.map((g) => g.id),
		consentSocialMedia: full.consentSocialMedia,
		consentWebsite: full.consentWebsite,
		consentPrint: full.consentPrint,
		...extra
	});
	if (r.json?.data) memberByName.set(name, r.json.data);
}

const groups = (await call('GET', `${M}/groups`)).json?.data ?? [];
const groupList = Array.isArray(groups) ? groups : (groups.items ?? []);
if (!groupList.some((g) => g.name === 'Meute Seeadler')) {
	const leader = memberByName.get('Sophie Neumann');
	await call('POST', `${M}/groups`, {
		name: 'Meute Seeadler',
		type: 'meute',
		leaderIds: [leader.id],
		meetingWeekday: 3,
		meetingTime: '17:00',
		color: '#0f766e'
	});
}

// --- Aktionen ------------------------------------------------------------------
const A = '/modules/actions';
const actionList = (await call('GET', `${A}/actions?limit=200`)).json?.data?.items ?? [];
const memberPerson = (name, role = 'participant') => {
	const m = memberByName.get(name);
	return {
		name,
		birthDate: m.birthDate,
		bremenResident: true,
		role,
		juleica: role === 'team',
		groupLabel: 'Meute Seeadler'
	};
};
const demoActions = [
	{
		input: {
			name: 'Kopenhagen 2026',
			description: 'Sommerfahrt nach Kopenhagen',
			location: 'Kopenhagen',
			startsOn: '2026-07-20',
			endsOn: '2026-07-26'
		},
		people: [
			memberPerson('Jonas Müller'),
			memberPerson('Paul Schmidt'),
			memberPerson('Deniz Yılmaz'),
			memberPerson('Tim Becker', 'team'),
			memberPerson('Sophie Neumann', 'team'),
			{ name: 'Lukas Weber', birthDate: '2013-02-11', bremenResident: false, role: 'participant' }
		],
		items: [
			{ category: 'travel', label: 'Bahnfahrt', amountCents: 9000, basis: 'per_person' },
			{ category: 'lodging', label: 'Zeltplatz', amountCents: 1200, basis: 'per_person_night' },
			{ category: 'food', label: 'Verpflegung', amountCents: 900, basis: 'per_person_night' },
			{ category: 'program', label: 'Museen', amountCents: 15000, basis: 'flat' }
		],
		entries: [
			{
				type: 'expense',
				category: 'travel',
				description: 'DB Gruppenticket',
				amountCents: 54000,
				entryDate: '2026-07-01'
			},
			{
				type: 'expense',
				category: 'lodging',
				description: 'Zeltplatz Kopenhagen',
				amountCents: 43200,
				entryDate: '2026-07-26'
			},
			{
				type: 'expense',
				category: 'food',
				description: 'Einkauf Netto',
				amountCents: 21890,
				entryDate: '2026-07-21'
			}
		]
	},
	{
		input: {
			name: 'Herbstfahrt 2026',
			description: 'Wochenende im Pfadfinderheim',
			location: 'Worpswede',
			startsOn: '2026-11-06',
			endsOn: '2026-11-08'
		},
		people: [
			memberPerson('Lena Müller'),
			memberPerson('Jonas Müller'),
			memberPerson('Mia Müller'),
			memberPerson('Paul Schmidt'),
			memberPerson('Emma Schmidt'),
			memberPerson('Sophie Neumann', 'team')
		],
		items: [
			{ category: 'lodging', label: 'Heim', amountCents: 800, basis: 'per_person_night' },
			{ category: 'food', label: 'Verpflegung', amountCents: 700, basis: 'per_person_night' },
			{ category: 'materials', label: 'Bastelmaterial', amountCents: 4000, basis: 'flat' }
		],
		entries: []
	}
];

for (const def of demoActions) {
	let action = actionList.find((a) => a.name === def.input.name);
	if (action) {
		console.log('Aktion vorhanden:', def.input.name);
		continue;
	}
	action = (await call('POST', `${A}/actions`, def.input)).json?.data;
	if (!action) continue;
	for (const p of def.people) await call('POST', `${A}/actions/${action.id}/participants`, p);
	const sug = (await call('GET', `${A}/actions/${action.id}/calculation/suggestions`)).json?.data;
	const calc = (await call('GET', `${A}/actions/${action.id}/calculation`)).json?.data;
	const base = calc?.calculation ?? calc ?? {};
	await call('PUT', `${A}/actions/${action.id}/calculation`, {
		participants: def.people.filter((p) => p.role !== 'team').length,
		team: def.people.filter((p) => p.role === 'team').length,
		teamPercent: 50,
		nights: sug?.nights ?? 2,
		bufferPercent: 5,
		includeSubsidy: true,
		lodgingType: base.lodgingType ?? 'external',
		konfi: false,
		freizeitType: base.freizeitType ?? 'kids',
		bremenChildren: sug?.bremenChildren ?? 0,
		bremenYouth: sug?.bremenYouth ?? 0,
		teamWithJuleica: sug?.teamWithJuleica ?? 0,
		teamWithoutJuleica: sug?.teamWithoutJuleica ?? 0,
		teamYouth: sug?.teamYouth ?? 0,
		checklist: {},
		items: def.items.map((it, i) => ({ id: `seed-${i}`, ...it }))
	});
	await call('POST', `${A}/actions/${action.id}/calculation/apply`);
	for (const e of def.entries)
		await call('POST', `${A}/actions/${action.id}/accounting/entries`, e);
	console.log('Aktion angelegt:', def.input.name);
}
console.log('Seed Module abgeschlossen.');
