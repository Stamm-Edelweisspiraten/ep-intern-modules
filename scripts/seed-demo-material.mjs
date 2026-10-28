// Demo-Daten für das Modul `material` (Materialverwaltung; idempotent, über die echte API).
// Voraussetzung: demo-server läuft (`seed-demo.mjs`, für die Aktions-Verknüpfung `seed-demo-modules.mjs`).
// Legt Kategorien (Icon/Farbe), Lagerorte (Kisten, Regale), Typen mit nummerierten Artikeln (Kohten-/Jurtenbahnen),
// Artikel mit Anzahl (Tampen, Heringe), einen beschädigten Artikel, Reservierungen (Aktion „Kopenhagen 2026“, Gruppe,
// Sonstiges) und vier Etikett-Layouts an.
//   node scripts/seed-demo-material.mjs

const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';
const M = '/modules/material';

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
	return { status: res.status, data: json?.data };
}

const EMAIL = process.env.DEMO_EMAIL ?? 'admin@demo.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Admin-2026!';

async function login() {
	for (let attempt = 0; attempt < 6; attempt++) {
		cookie = '';
		const r = await call(
			'POST',
			'/sign-in/email',
			{ email: EMAIL, password: PASSWORD },
			'/api/auth'
		);
		if (cookie && r.status < 400) return true;
		if (r.status === 401) return false;
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
	return false;
}

const iso = (d) => d.toISOString().slice(0, 10);
const inDays = (n) => iso(new Date(Date.now() + n * 86_400_000));

if (!(await login())) throw new Error(`Login als ${EMAIL} fehlgeschlagen - läuft der Demo-Server?`);
for (const id of ['offices', 'members', 'material']) {
	const r = await call('POST', `/modules/${id}/enable`);
	console.log(`Modul ${id} aktivieren:`, r.status);
}
await login();

const existing = (await call('GET', `${M}/types`)).data ?? [];
if (existing.some((t) => t.name === 'Kohtenbahn')) {
	console.log('Material-Demodaten sind schon vorhanden – nichts zu tun.');
	process.exit(0);
}

// --- Kategorien und Lagerorte ---------------------------------------------------------
const cat = async (name, color, icon) =>
	(await call('POST', `${M}/categories`, { name, color, icon })).data;
const zelte = await cat('Zelte', '#92400e', 'tent');
const kueche = await cat('Küche', '#ea580c', 'cooking-pot');
const werkzeug = await cat('Werkzeug', '#52525b', 'hammer');
const seile = await cat('Seile & Heringe', '#0d9488', 'cable');
const spiel = await cat('Spiel & Programm', '#7c3aed', 'puzzle');

const loc = async (name, description = '') =>
	(await call('POST', `${M}/locations`, { name, description })).data;
const regalZelte = await loc('Regal Zelte', 'Materialraum, links');
const kiste1 = await loc('Kiste 1', 'Kochkiste groß');
const kiste2 = await loc('Kiste 2', 'Kochkiste klein');
const kiste3 = await loc('Kiste 3', 'Seile und Heringe');
const werkbank = await loc('Werkzeugschrank', 'Materialraum, hinten');
const garage = await loc('Garage Hänger', 'Hinter dem Gemeindehaus');

// --- Typen und Artikel ----------------------------------------------------------------
const type = async (name, categoryId, description = '') =>
	(await call('POST', `${M}/types`, { name, categoryId, description })).data;
const items = async (body) => (await call('POST', `${M}/items`, body)).data ?? [];

const kohte = await type(
	'Kohtenbahn',
	zelte.id,
	'Schwarze Kohtenbahn, Baumwolle. 4 Bahnen = 1 Kohte.'
);
const kohtenBahnen = [
	...(await items({ typeId: kohte.id, name: 'K1.', count: 4, locationId: regalZelte.id })),
	...(await items({ typeId: kohte.id, name: 'K2.', count: 4, locationId: regalZelte.id })),
	...(await items({ typeId: kohte.id, name: 'K3.', count: 4, locationId: garage.id }))
];
const jurte = await type('Jurtenbahn', zelte.id, 'Dachbahnen und Seitenbahnen für die Jurte.');
await items({ typeId: jurte.id, name: 'J1.', count: 8, locationId: regalZelte.id });
const kreuz = await type('Kohtenkreuz', zelte.id);
await items({ typeId: kreuz.id, name: 'Kohtenkreuz ', count: 3, locationId: garage.id });
const topf = await type('Kochtopf 20 l', kueche.id);
await items({ typeId: topf.id, name: 'Topf ', count: 2, locationId: kiste1.id });
const kocher = await type('Gaskocher', kueche.id, 'Zweiflammig, mit Schlauch und Druckminderer.');
await items({ typeId: kocher.id, name: 'Kocher ', count: 3, locationId: kiste1.id });

await items({ name: 'Emaille-Tassen', categoryId: kueche.id, quantity: 40, locationId: kiste2.id });
await items({ name: 'Tampen 10 m', categoryId: seile.id, quantity: 21, locationId: kiste3.id });
await items({ name: 'Heringe Stahl', categoryId: seile.id, quantity: 120, locationId: kiste3.id });
await items({ name: 'Axt', categoryId: werkzeug.id, quantity: 2, locationId: werkbank.id });
await items({ name: 'Klappspaten', categoryId: werkzeug.id, quantity: 3, locationId: werkbank.id });
await items({
	name: 'Wikingerschach',
	categoryId: spiel.id,
	quantity: 1,
	locationId: regalZelte.id
});

// Ein beschädigter Artikel
if (kohtenBahnen[9]) {
	await call('POST', `${M}/items/${kohtenBahnen[9].id}/condition`, {
		condition: 'damaged',
		note: 'Kleiner Riss an der Öse'
	});
}

// --- Reservierungen -------------------------------------------------------------------
const actions = (await call('GET', '/modules/actions/actions?search=Kopenhagen')).data;
const kopenhagen = actions?.items?.[0] ?? null;
const groups = (await call('GET', `${M}/purpose-options`)).data?.groups ?? [];
const tassen = (await call('GET', `${M}/inventory?search=Tassen`)).data?.items?.[0];
const tampen = (await call('GET', `${M}/inventory?search=Tampen`)).data?.items?.[0];

await call('POST', `${M}/reservations`, {
	title: kopenhagen ? `Material ${kopenhagen.name}` : 'Sommerfahrt',
	purpose: kopenhagen ? 'action' : 'other',
	actionId: kopenhagen?.id ?? null,
	startsOn: kopenhagen?.startsOn ?? inDays(30),
	endsOn: kopenhagen?.endsOn ?? inDays(37),
	notes: 'Bitte vorher imprägnieren.',
	lines: [
		{ kind: 'type', typeId: kohte.id, quantity: 8 },
		{ kind: 'type', typeId: kocher.id, quantity: 2 },
		...(tassen ? [{ kind: 'item', itemId: tassen.id, quantity: 20 }] : [])
	]
});
if (groups[0]) {
	await call('POST', `${M}/reservations`, {
		title: `Gruppenstunde ${groups[0].name}`,
		purpose: 'group',
		groupId: groups[0].id,
		startsOn: inDays(3),
		endsOn: inDays(3),
		lines: [
			{ kind: 'item', itemId: kohtenBahnen[0].id, quantity: 1 },
			...(tampen ? [{ kind: 'item', itemId: tampen.id, quantity: 5 }] : [])
		]
	});
}
await call('POST', `${M}/reservations`, {
	title: 'Stammesfest',
	purpose: 'other',
	startsOn: inDays(10),
	endsOn: inDays(11),
	lines: [
		{ kind: 'type', typeId: jurte.id, quantity: 8 },
		{ kind: 'type', typeId: topf.id, quantity: 1 }
	]
});

// --- Etikett-Layouts ------------------------------------------------------------------
const text = (id, x, y, w, h, value, fontSizePt, bold = false, align = 'left', maxLines = 1) => ({
	id,
	type: 'text',
	x,
	y,
	w,
	h,
	text: value,
	fontSizePt,
	bold,
	align,
	valign: 'top',
	maxLines
});
await call('POST', `${M}/label-templates`, {
	name: 'Kiste groß',
	target: 'location',
	formatKey: 'zweckform-3427',
	layout: {
		widthMm: 105,
		heightMm: 74,
		elements: [
			{ id: 'logo', type: 'image', x: 5, y: 5, w: 14, h: 14, logo: 'wappen' },
			text('name', 22, 5, 50, 14, '{name}', 18, true, 'left', 2),
			{ id: 'qr', type: 'barcode', x: 75, y: 5, w: 25, h: 25, symbology: 'qrcode', value: '{url}' },
			text('code', 75, 31, 25, 5, '{code}', 9, true, 'center'),
			{ id: 'l1', type: 'line', x: 5, y: 37, w: 95, h: 1, stroke: 0.3, orientation: 'horizontal' },
			text('inhalt', 5, 40, 95, 22, '{description}', 10, false, 'left', 4),
			text('ort', 5, 65, 95, 5, '{count} Artikel', 8)
		]
	}
});
await call('POST', `${M}/label-templates`, {
	name: 'Zeltbahn (Etikettendrucker)',
	target: 'item',
	formatKey: 'brother-62x29',
	layout: {
		widthMm: 62,
		heightMm: 29,
		elements: [
			text('name', 2, 2, 58, 6, '{name}', 11, true),
			{
				id: 'bc',
				type: 'barcode',
				x: 2,
				y: 9,
				w: 58,
				h: 12,
				symbology: 'code128',
				value: '{code}'
			},
			text('code', 2, 22, 40, 5, '{code}', 8),
			text('org', 30, 22, 30, 5, '{org}', 7, false, 'right')
		]
	}
});
await call('POST', `${M}/label-templates`, {
	name: 'Lagerort',
	target: 'location',
	formatKey: 'avery-l7163',
	layout: {
		widthMm: 99.1,
		heightMm: 38.1,
		elements: [
			text('name', 4, 4, 65, 12, '{name}', 20, true),
			text('path', 4, 20, 65, 10, '{description}', 9, false, 'left', 2),
			{ id: 'qr', type: 'barcode', x: 70, y: 4, w: 25, h: 25, symbology: 'qrcode', value: '{url}' },
			text('code', 70, 30, 25, 5, '{code}', 8, false, 'center')
		]
	}
});
await call('POST', `${M}/label-templates`, {
	name: 'Artikel (Standard)',
	target: 'item',
	formatKey: 'avery-l7159',
	layout: {
		widthMm: 63.5,
		heightMm: 33.9,
		elements: [
			{ id: 'logo', type: 'image', x: 3, y: 3, w: 7, h: 7, logo: 'wappen', monochrome: true },
			text('name', 12, 3, 30, 8, '{name}', 12, true),
			text('cat', 12, 11, 30, 5, '{type} · {category}', 8),
			{ id: 'v', type: 'line', x: 43, y: 3, w: 1, h: 27, stroke: 0.3, orientation: 'vertical' },
			{
				id: 'qr',
				type: 'barcode',
				x: 45.5,
				y: 3,
				w: 15,
				h: 15,
				symbology: 'qrcode',
				value: '{url}'
			},
			text('code', 44, 19, 18, 4, '{code}', 7, false, 'center'),
			text('ort', 3, 24, 39, 7, '{location} · {quantity} Stück', 7, false, 'left', 2)
		]
	}
});
console.log('Material-Demodaten angelegt.');
