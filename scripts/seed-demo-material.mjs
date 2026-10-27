// Demo-Daten für das Modul `material` (Materialverwaltung; idempotent, über die echte API).
// Voraussetzung: demo-server läuft (`seed-demo.mjs`, für die Aktions-Verknüpfung `seed-demo-modules.mjs`).
// Legt Lagerorte, Kategorien, Artikel, Zeltbahnen mit Kohten-/Jurten-Sets (eins unvollständig), Kochkisten mit
// Inhalt und Packliste, Mengenbestand, Reservierungen (für „Kopenhagen 2026“, eine überfällige Ausgabe) und
// drei Etikett-Layouts an.
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
for (const id of ['offices', 'material']) {
	const r = await call('POST', `/modules/${id}/enable`);
	console.log(`Modul ${id} aktivieren:`, r.status);
}
await login();

const existing = (await call('GET', `${M}/articles`)).data ?? [];
if (existing.some((a) => a.name === 'Kohtenbahn')) {
	console.log('Material-Demodaten sind schon vorhanden – nichts zu tun.');
	process.exit(0);
}

// --- Orte und Kategorien --------------------------------------------------------------
const loc = async (name, parentId = null, description = '') =>
	(await call('POST', `${M}/locations`, { name, parentId, description })).data;
const raum = await loc('Materialraum', null, 'Gemeindehaus, Keller links');
const regalA = await loc('Regal A – Zelte', raum.id);
const regalB = await loc('Regal B – Küche', raum.id);
const werkbank = await loc('Werkzeugschrank', raum.id);
const garage = await loc('Garage Hänger', null, 'Hinter dem Gemeindehaus');

const cat = async (name, color, icon) =>
	(await call('POST', `${M}/categories`, { name, color, icon })).data;
const zelte = await cat('Zelte', '#7c5c3b', 'tent');
const kueche = await cat('Küche', '#d9480f', 'cooking-pot');
const werkzeug = await cat('Werkzeug', '#495057', 'hammer');
const spiel = await cat('Spiel & Sport', '#2f9e44', 'volleyball');

const art = async (name, kind, categoryId, extra = {}) =>
	(await call('POST', `${M}/articles`, { name, kind, categoryId, ...extra })).data;
const kohtenbahn = await art('Kohtenbahn', 'unit', zelte.id, {
	description: 'Schwarzzeltbahn, 4 Bahnen je Kohte'
});
const kohtenkreuz = await art('Kohtenkreuz', 'unit', zelte.id);
const jurtenbahn = await art('Jurtenbahn', 'unit', zelte.id);
const jurtendach = await art('Jurtendach', 'unit', zelte.id);
const kochkiste = await art('Kochkiste', 'unit', kueche.id, { description: 'Alukiste 80 l' });
const topf = await art('Kochtopf 20 l', 'unit', kueche.id);
const kocher = await art('Gaskocher', 'unit', kueche.id);
const tasse = await art('Emaille-Tasse', 'bulk', kueche.id, { minQuantity: 40 });
const teller = await art('Teller', 'bulk', kueche.id, { minQuantity: 40 });
const hering = await art('Hering', 'bulk', zelte.id, { unitLabel: 'Stück', minQuantity: 150 });
const axt = await art('Axt', 'unit', werkzeug.id);
const saege = await art('Bügelsäge', 'unit', werkzeug.id);
const ball = await art('Volleyball', 'bulk', spiel.id);

const units = async (articleId, count, place, extra = {}) =>
	(await call('POST', `${M}/units`, { articleId, count, numbered: count > 1, ...place, ...extra }))
		.data ?? [];
const kBahnen = await units(kohtenbahn.id, 14, { locationId: regalA.id });
const kKreuze = await units(kohtenkreuz.id, 3, { locationId: regalA.id });
const jBahnen = await units(jurtenbahn.id, 16, { locationId: regalA.id });
const jDaecher = await units(jurtendach.id, 2, { locationId: regalA.id });
const [kiste1] = await units(
	kochkiste.id,
	1,
	{ locationId: regalB.id },
	{ label: 'Kochkiste 1', isContainer: true }
);
const [kiste2] = await units(
	kochkiste.id,
	1,
	{ locationId: garage.id },
	{ label: 'Kochkiste 2', isContainer: true }
);
await units(topf.id, 1, { containerId: kiste1.id }, { label: 'Kochtopf groß' });
await units(kocher.id, 1, { containerId: kiste1.id });
await units(
	topf.id,
	1,
	{ containerId: kiste2.id },
	{ label: 'Kochtopf (Delle)', condition: 'damaged', conditionNote: 'Delle am Boden' }
);
await units(axt.id, 2, { locationId: werkbank.id });
await units(saege.id, 1, { locationId: werkbank.id });
// eine Bahn ist defekt
await call('POST', `${M}/units/${kBahnen[13].id}/condition`, {
	condition: 'defect',
	note: 'Großer Riss an der Naht'
});

const stock = (articleId, holder, quantity) =>
	call('POST', `${M}/stock/set`, { articleId, holder, quantity, note: 'Inventur' });
await stock(tasse.id, { locationId: regalB.id }, 30);
await stock(tasse.id, { containerId: kiste1.id }, 12);
await stock(teller.id, { locationId: regalB.id }, 25);
await stock(hering.id, { locationId: regalA.id }, 180);
await stock(ball.id, { locationId: raum.id }, 3);
await call('PUT', `${M}/units/${kiste1.id}/targets`, {
	targets: [
		{ articleId: tasse.id, quantity: 15 },
		{ articleId: topf.id, quantity: 1 },
		{ articleId: kocher.id, quantity: 1 }
	]
});

// --- Sets -----------------------------------------------------------------------------
const kohteTpl = (
	await call('POST', `${M}/set-templates`, {
		name: 'Kohte',
		description: '4 Bahnen, Kreuz und 10 Heringe',
		parts: [
			{ articleId: kohtenbahn.id, quantity: 4 },
			{ articleId: kohtenkreuz.id, quantity: 1 },
			{ articleId: hering.id, quantity: 10 }
		]
	})
).data;
const jurteTpl = (
	await call('POST', `${M}/set-templates`, {
		name: 'Jurte (8er)',
		description: '8 Bahnen + Dach',
		parts: [
			{ articleId: jurtenbahn.id, quantity: 8 },
			{ articleId: jurtendach.id, quantity: 1 }
		]
	})
).data;
const set = (templateId, name, unitIds) => call('POST', `${M}/sets`, { templateId, name, unitIds });
await set(
	kohteTpl.id,
	'Kohte 1',
	[...kBahnen.slice(0, 4), kKreuze[0]].map((u) => u.id)
);
await set(
	kohteTpl.id,
	'Kohte 2',
	[...kBahnen.slice(4, 8), kKreuze[1]].map((u) => u.id)
);
// unvollständig: defekte Bahn + nur 3 gute
await set(
	kohteTpl.id,
	'Kohte 3',
	[...kBahnen.slice(8, 11), kBahnen[13], kKreuze[2]].map((u) => u.id)
);
await set(
	jurteTpl.id,
	'Jurte 1',
	[...jBahnen.slice(0, 8), jDaecher[0]].map((u) => u.id)
);
// Jurte 2 ohne Dach → unvollständig
await set(
	jurteTpl.id,
	'Jurte 2',
	jBahnen.slice(8, 16).map((u) => u.id)
);

// --- Reservierungen -------------------------------------------------------------------
const actions = (await call('GET', '/modules/actions/actions?search=Kopenhagen')).data;
const kopenhagen = actions?.items?.[0] ?? null;
const sommer = (
	await call('POST', `${M}/reservations`, {
		title: kopenhagen ? `Material ${kopenhagen.name}` : 'Sommerlager',
		actionId: kopenhagen?.id ?? null,
		startsOn: kopenhagen?.startsOn ?? inDays(30),
		endsOn: kopenhagen?.endsOn ?? inDays(40),
		notes: 'Zelte bitte vorher auf Löcher prüfen.',
		lines: [
			{ kind: 'article', articleId: kohtenbahn.id, quantity: 8 },
			{ kind: 'article', articleId: kohtenkreuz.id, quantity: 2 },
			{ kind: 'unit', unitId: kiste1.id },
			{ kind: 'article', articleId: tasse.id, quantity: 20 },
			{ kind: 'article', articleId: hering.id, quantity: 60 }
		]
	})
).data;
console.log('Reservierung angelegt:', sommer?.title);

// überfällig: Wochenendfahrt, ausgegeben, nicht zurück
const fahrt = (
	await call('POST', `${M}/reservations`, {
		title: 'Wochenendfahrt Sippe Falken',
		startsOn: inDays(-6),
		endsOn: inDays(-4),
		lines: [
			{ kind: 'unit', unitId: kiste2.id },
			{ kind: 'unit', unitId: kBahnen[11].id },
			{ kind: 'unit', unitId: kBahnen[12].id }
		]
	})
).data;
if (fahrt) {
	await call('POST', `${M}/reservations/${fahrt.id}/issue`, {
		unitIds: [kiste2.id, kBahnen[11].id, kBahnen[12].id]
	});
}

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
	target: 'unit',
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
			text('inhalt', 5, 40, 95, 22, 'Inhalt: {contents}', 10, false, 'left', 4),
			text('ort', 5, 65, 95, 5, '{location}', 8)
		]
	}
});
await call('POST', `${M}/label-templates`, {
	name: 'Zeltbahn (Etikettendrucker)',
	target: 'unit',
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
			text('path', 4, 20, 65, 10, '{path}', 9, false, 'left', 2),
			{ id: 'qr', type: 'barcode', x: 70, y: 4, w: 25, h: 25, symbology: 'qrcode', value: '{url}' },
			text('code', 70, 30, 25, 5, '{code}', 8, false, 'center')
		]
	}
});
await call('POST', `${M}/label-templates`, {
	name: 'Regalfach (Artikel)',
	target: 'article',
	formatKey: 'avery-l7159',
	layout: {
		widthMm: 63.5,
		heightMm: 33.9,
		elements: [
			{ id: 'logo', type: 'image', x: 3, y: 3, w: 7, h: 7, logo: 'wappen', monochrome: true },
			text('name', 12, 3, 30, 8, '{name}', 12, true),
			text('cat', 12, 11, 30, 5, '{category}', 8),
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
			text('ort', 3, 24, 39, 7, '{locations}', 7, false, 'left', 2)
		]
	}
});
console.log('Material-Demodaten angelegt.');
