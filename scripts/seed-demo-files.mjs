// Demo-Daten für das Modul `files` (Dateien / Cloud-Ablage; idempotent, über die echte API).
// Voraussetzung: demo-server läuft (http://localhost:4300), `node scripts/seed-demo.mjs` wurde ausgeführt,
// Storage ist konfiguriert (MinIO per `docker compose -f docker-compose.demo.yml up -d` +
// `node scripts/setup-demo-storage.mjs`).
// Aktiviert `members` und `files`, legt in „Meine Dateien“ den Ordner „Fotos Sommerlager“ (erzeugte Bilder,
// Packliste) und im Stammesordner „Elternbriefe“ (PDF, Freigabe an „Stamm“ zum Lesen) sowie
// „Satzung und Protokolle“ (PDF, Textdatei) an und erzeugt einen öffentlichen Link auf die Fotos.
// Vorhandene Ordner und Dateien gleichen Namens werden wiederverwendet, nicht doppelt angelegt.
import sharp from 'sharp';

const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';
const F = '/modules/files';

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
	if (res.status >= 400 && res.status !== 409 && res.status !== 503) {
		console.warn(`${method} ${path} -> ${res.status}`, JSON.stringify(json?.error ?? json));
	}
	return { status: res.status, json };
}

// Zugangsdaten überschreibbar, falls die Admin-Adresse in der Demo-DB geändert wurde:
//   DEMO_EMAIL=… DEMO_PASSWORD=… node scripts/seed-demo-files.mjs
const EMAIL = process.env.DEMO_EMAIL ?? 'admin@demo.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Admin-2026!';

async function login() {
	// Better Auth begrenzt Anmeldungen (gemeinsamer Bucket ohne Client-IP): bei 401/429 kurz warten
	for (let attempt = 0; attempt < 6; attempt++) {
		cookie = '';
		const r = await call(
			'POST',
			'/sign-in/email',
			{ email: EMAIL, password: PASSWORD },
			'/api/auth'
		);
		if (cookie && r.status < 400) return;
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
	throw new Error(`Login als ${EMAIL} fehlgeschlagen – läuft der Demo-Server?`);
}

function storageMissing() {
	console.error(
		'\nDer Dateispeicher (S3) ist nicht konfiguriert oder nicht erreichbar (503).\n' +
			'Bitte zuerst MinIO starten und hinterlegen:\n' +
			'  docker compose -f docker-compose.demo.yml up -d\n' +
			'  node scripts/setup-demo-storage.mjs\n'
	);
	process.exit(1);
}

await login();
for (const id of ['members', 'files']) {
	const r = await call('POST', `/modules/${id}/enable`);
	console.log(`Modul ${id} aktivieren:`, r.status);
	if (r.status >= 400 && r.status !== 409)
		throw new Error(`Modul ${id} konnte nicht aktiviert werden`);
}
// Neue Modulrechte sind erst nach erneutem Login in der Sitzung wirksam
await login();

// Speicher vorab prüfen (genaue Prüfung beim ersten Upload)
const storage = await call('GET', '/settings?group=storage');
const bucket = storage.json?.data?.find?.((s) => s.key === 'core.storage.bucket');
if (bucket && !bucket.value) storageMissing();

// --- Ordner ---------------------------------------------------------------------------

async function list(space, parentId) {
	const q = new URLSearchParams({ space, ...(parentId ? { parent: parentId } : {}) });
	const r = await call('GET', `${F}/nodes?${q}`);
	if (r.status >= 400) throw new Error(`Ordnerinhalt nicht lesbar (${r.status})`);
	return r.json.data.items;
}

async function ensureFolder(space, parentId, name) {
	const found = (await list(space, parentId)).find((n) => n.kind === 'folder' && n.name === name);
	if (found) {
		console.log(`Ordner „${name}“ vorhanden`);
		return found;
	}
	const r = await call('POST', `${F}/folders`, { space, parentId, name });
	if (r.status >= 400)
		throw new Error(`Ordner „${name}“ konnte nicht angelegt werden (${r.status})`);
	console.log(`Ordner „${name}“ angelegt`);
	return r.json.data;
}

// --- Upload ---------------------------------------------------------------------------

async function upload(space, parentId, name, bytes, type) {
	const existing = (await list(space, parentId)).find((n) => n.kind === 'file' && n.name === name);
	if (existing) {
		console.log(`  ${name} vorhanden`);
		return existing;
	}
	const fd = new FormData();
	fd.set('space', space);
	fd.set('file', new Blob([bytes], { type }), name);
	// Der Endpoint verlangt Content-Length → Formular vorher in einen Puffer umwandeln
	const req = new Response(fd);
	const body = Buffer.from(await req.arrayBuffer());
	const res = await fetch(`${BASE}/api/v1${F}/nodes/${parentId ?? 'root'}/upload`, {
		method: 'POST',
		headers: { origin: ORIGIN, cookie, 'content-type': req.headers.get('content-type') },
		body
	});
	if (res.status === 503) storageMissing();
	const json = await res.json().catch(() => null);
	if (!res.ok) {
		throw new Error(
			`Upload ${name} fehlgeschlagen (${res.status}): ${JSON.stringify(json?.error)}`
		);
	}
	console.log(`  ${name} hochgeladen`);
	return json.data;
}

// --- Beispielinhalte ------------------------------------------------------------------

const palette = [
	['#2563eb', '#93c5fd'],
	['#16a34a', '#bbf7d0'],
	['#ea580c', '#fed7aa'],
	['#9333ea', '#e9d5ff'],
	['#0891b2', '#a5f3fc'],
	['#be123c', '#fecdd3']
];
const captions = [
	'Lagerplatz am See',
	'Jurtenaufbau',
	'Singerunde am Feuer',
	'Geländespiel',
	'Kanutour',
	'Abschlusskreis'
];

/** JPEG mit Farbverlauf, Kreis und Beschriftung (keine echten Fotos, keine Personen) */
async function picture(i) {
	const [a, b] = palette[i % palette.length];
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="1600" height="1067" fill="url(#g)"/>
<circle cx="${380 + i * 170}" cy="460" r="${180 + (i % 3) * 30}" fill="#ffffff" fill-opacity="0.3"/>
<rect x="0" y="900" width="1600" height="167" fill="#000000" fill-opacity="0.25"/>
<text x="64" y="1010" font-size="84" font-family="Arial, sans-serif" fill="#ffffff">${captions[i % captions.length]}</text>
</svg>`;
	return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

/** Kleines gültiges PDF (eine Seite, Helvetica) mit korrekter xref-Tabelle */
function pdf(lines) {
	const esc = (s) =>
		s
			.replace(/[\\()]/g, (c) => `\\${c}`)
			.replace(
				/[^\x20-\x7e]/g,
				(c) =>
					({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', '–': '-' })[c] ?? '?'
			);
	const [title, ...rest] = lines;
	let content = `BT /F1 22 Tf 72 770 Td (${esc(title)}) Tj /F1 12 Tf`;
	for (const l of rest) content += ` 0 -22 Td (${esc(l)}) Tj`;
	content += ' ET';
	const objects = [
		'<</Type/Catalog/Pages 2 0 R>>',
		'<</Type/Pages/Kids[3 0 R]/Count 1>>',
		'<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
		`<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}\nendstream`,
		'<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
	];
	let out = '%PDF-1.4\n';
	const offsets = [];
	objects.forEach((o, i) => {
		offsets.push(Buffer.byteLength(out, 'latin1'));
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = Buffer.byteLength(out, 'latin1');
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
	out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, 'latin1');
}

// --- Meine Dateien: Fotos Sommerlager ---------------------------------------------------

const fotos = await ensureFolder('personal', null, 'Fotos Sommerlager');
for (let i = 0; i < captions.length; i++) {
	await upload(
		'personal',
		fotos.id,
		`Sommerlager-${String(i + 1).padStart(2, '0')}.jpg`,
		await picture(i),
		'image/jpeg'
	);
}
await upload(
	'personal',
	fotos.id,
	'Packliste.txt',
	Buffer.from(
		'Packliste Sommerlager 2026\n\n- Schlafsack und Isomatte\n- Kluft und Halstuch\n- Taschenlampe\n- Trinkflasche\n- Regenjacke\n- Liederbuch\n'
	),
	'text/plain'
);

// --- Stamm: Elternbriefe (Freigabe an „Stamm“) -------------------------------------------

const eltern = await ensureFolder('shared', null, 'Elternbriefe');
await upload(
	'shared',
	eltern.id,
	'Elternbrief Sommerlager 2026.pdf',
	pdf([
		'Elternbrief Sommerlager 2026',
		'Liebe Eltern,',
		'vom 20. bis 30. Juli fahren wir ins Sommerlager an den See.',
		'Die Packliste liegt bei, der Teilnahmebeitrag betraegt 180 Euro.',
		'Gut Pfad!'
	]),
	'application/pdf'
);

const shares = await call('GET', `${F}/nodes/${eltern.id}/shares`);
const own = shares.json?.data?.shares ?? [];
if (own.some((s) => s.type === 'everyone' && s.id === '*')) {
	console.log('Freigabe „Elternbriefe“ an Stamm vorhanden');
} else {
	const r = await call('PUT', `${F}/nodes/${eltern.id}/shares`, {
		shares: [
			...own.map((s) => ({ type: s.type, id: s.id, level: s.level })),
			{ type: 'everyone', id: '*', level: 'read' }
		]
	});
	console.log('Freigabe „Elternbriefe“ an Stamm (Lesen):', r.status);
}

// --- Stamm: Satzung und Protokolle --------------------------------------------------------

const satzung = await ensureFolder('shared', null, 'Satzung und Protokolle');
await upload(
	'shared',
	satzung.id,
	'Satzung.pdf',
	pdf([
		'Satzung des Stammes',
		'Paragraf 1 - Name und Sitz',
		'Paragraf 2 - Zweck',
		'Paragraf 3 - Mitgliedschaft'
	]),
	'application/pdf'
);
await upload(
	'shared',
	satzung.id,
	'Protokoll Stammesrat 2026-09.txt',
	Buffer.from(
		'Protokoll Stammesrat vom 14.09.2026\n\nTOP 1: Rückblick Sommerlager\nTOP 2: Planung Herbstfahrt\nTOP 3: Material und Kasse\n'
	),
	'text/plain'
);

// --- Öffentlicher Link auf die Fotos -----------------------------------------------------

const links = await call('GET', `${F}/nodes/${fotos.id}/links`);
const active = (links.json?.data ?? []).filter((l) => l.active && !l.hasPassword);
if (active.length && !process.env.NEW_LINK) {
	console.log(
		'\nÖffentlicher Link auf „Fotos Sommerlager“ existiert bereits (die URL ist nur beim Anlegen sichtbar).\n' +
			'Neuen Link erzeugen: NEW_LINK=1 node scripts/seed-demo-files.mjs'
	);
} else {
	const r = await call('POST', `${F}/nodes/${fotos.id}/links`, { expiresOn: null, password: null });
	if (r.status >= 400) throw new Error(`Link konnte nicht angelegt werden (${r.status})`);
	console.log(`\nÖffentlicher Link auf „Fotos Sommerlager“:\n  ${r.json.data.url}`);
}
console.log('\nFertig. Ansehen: http://localhost:4300/modules/files');
