// Demo-Daten für das Modul `galleries` (idempotent, über die echte API).
// Voraussetzung: demo-server läuft, `node scripts/seed-demo.mjs` und `node scripts/seed-demo-modules.mjs`
// wurden ausgeführt, Storage ist konfiguriert (MinIO + `node scripts/setup-demo-storage.mjs`).
// Legt Galerien mit erzeugten Beispielbildern an (sharp) und ordnet eine Galerie einem Termin zu,
// falls das Modul `events` aktiv ist. Vorhandene Galerien gleichen Titels mit Bildern werden übersprungen.
import sharp from 'sharp';

const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';
const G = '/modules/galleries';

let cookie = '';
async function call(method, path, body, base = '/api/v1') {
	const isForm = body instanceof FormData;
	const res = await fetch(BASE + base + path, {
		method,
		headers: {
			...(isForm ? {} : { 'content-type': 'application/json' }),
			origin: ORIGIN,
			...(cookie ? { cookie } : {})
		},
		body: body ? (isForm ? body : JSON.stringify(body)) : undefined
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
//   DEMO_EMAIL=… DEMO_PASSWORD=… node scripts/seed-demo-galleries.mjs
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
	throw new Error(`Login als ${EMAIL} fehlgeschlagen - läuft der Demo-Server?`);
}

await login();
const enabled = await call('POST', `/modules/galleries/enable`);
console.log('Modul galleries aktivieren:', enabled.status);
if (enabled.status >= 400 && enabled.status !== 409) {
	throw new Error('Modul galleries konnte nicht aktiviert werden');
}
// Neue Modulrechte sind erst nach erneutem Login in der Sitzung wirksam
await login();

// --- Beispielbilder -------------------------------------------------------------
function escapeXml(s) {
	return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** JPEG mit Farbverlauf, ein paar Formen und Beschriftung */
async function sampleImage(label, [from, to], width, height, seed) {
	const shapes = [];
	for (let i = 0; i < 6; i++) {
		const x = ((seed * 97 + i * 211) % 100) / 100;
		const y = ((seed * 53 + i * 137) % 100) / 100;
		const r = 0.05 + (((seed + i) * 31) % 20) / 100;
		shapes.push(
			`<circle cx="${Math.round(x * width)}" cy="${Math.round(y * height)}" r="${Math.round(
				r * Math.min(width, height)
			)}" fill="#ffffff" fill-opacity="0.12"/>`
		);
	}
	const fontSize = Math.round(Math.min(width, height) / 9);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
	<defs>
		<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="${from}"/>
			<stop offset="1" stop-color="${to}"/>
		</linearGradient>
	</defs>
	<rect width="100%" height="100%" fill="url(#g)"/>
	${shapes.join('\n\t')}
	<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif"
		font-size="${fontSize}" font-weight="bold" fill="#ffffff" fill-opacity="0.92">${escapeXml(label)}</text>
	<text x="50%" y="${Math.round(height / 2 + fontSize * 1.1)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
		font-size="${Math.round(fontSize / 2.6)}" fill="#ffffff" fill-opacity="0.75">${width} × ${height}</text>
</svg>`;
	return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

const SIZES = [
	[1600, 1067], // 3:2 quer
	[1200, 1600], // 3:4 hoch
	[1600, 900], // 16:9
	[1200, 1200], // quadratisch
	[1067, 1600], // 2:3 hoch
	[1800, 1000] // breit
];

const galleries = [
	{
		title: 'Sommerlager 2026',
		description: 'Zwei Wochen Zeltlager am See – Lagerbau, Hajk und Singerunden.',
		visibility: 'public',
		shares: [],
		colors: [
			['#f59e0b', '#b45309'],
			['#10b981', '#065f46'],
			['#3b82f6', '#1e3a8a']
		],
		images: [
			['Lagerbau', 'Aufbau der Jurte am ersten Tag'],
			['Am See', 'Baden nach dem Geländespiel'],
			['Lagerfeuer', 'Singerunde am Abend'],
			['Hajk', 'Unterwegs zur Übernachtung im Wald'],
			['Küchenzelt', null],
			['Abschluss', 'Gruppenbild am letzten Tag']
		],
		withEvent: true
	},
	{
		title: 'Gruppenstunde Wölflinge',
		description: 'Bilder aus den Gruppenstunden der Wölflinge.',
		visibility: 'private',
		shares: [{ type: 'everyone', id: '*', level: 'read' }],
		colors: [
			['#ec4899', '#831843'],
			['#8b5cf6', '#4c1d95']
		],
		images: [
			['Basteln', 'Laternen für den Herbst'],
			['Knoten', 'Kreuzknoten und Palstek üben'],
			['Spiele', null],
			['Waldtag', 'Spurensuche im Stadtwald']
		],
		withEvent: false
	},
	{
		title: 'Stammesversammlung',
		description: 'Interne Bilder von der Stammesversammlung.',
		visibility: 'private',
		shares: [],
		colors: [
			['#64748b', '#1e293b'],
			['#14b8a6', '#134e4a']
		],
		images: [
			['Begrüßung', null],
			['Wahlen', 'Neue Stammesführung'],
			['Ausklang', 'Gemeinsames Essen']
		],
		withEvent: false
	}
];

// --- Termin für die Zuordnung (optional) ----------------------------------------
let eventId = null;
{
	const r = await call('GET', '/modules/events/events?limit=5');
	if (r.status === 200) {
		const items = r.json?.data?.items ?? [];
		const pick = items.find((e) => !e.recurrence) ?? items[0];
		eventId = pick?.id ?? null;
		console.log(eventId ? `Termin für Zuordnung: ${pick.title}` : 'Keine Termine vorhanden');
	} else {
		console.log('Modul events nicht aktiv – keine Termin-Zuordnung');
	}
}

// --- Galerien und Bilder -----------------------------------------------------------
let seed = 1;
for (const g of galleries) {
	const found = await call('GET', `${G}/galleries?search=${encodeURIComponent(g.title)}&limit=50`);
	if (found.status !== 200)
		throw new Error(`Galerien konnten nicht gelesen werden (${found.status})`);
	let gallery = (found.json?.data?.items ?? []).find((x) => x.title === g.title);
	if (gallery && gallery.imageCount > 0) {
		console.log(`${g.title}: vorhanden (${gallery.imageCount} Bilder), übersprungen`);
		seed += g.images.length;
		continue;
	}
	if (!gallery) {
		const created = await call('POST', `${G}/galleries`, {
			title: g.title,
			description: g.description,
			visibility: g.visibility,
			shares: g.shares,
			// Termine hängen an der ganzen Galerie
			eventIds: g.withEvent && eventId ? [eventId] : []
		});
		if (created.status !== 200 && created.status !== 201) {
			throw new Error(`Galerie "${g.title}" konnte nicht angelegt werden (${created.status})`);
		}
		gallery = created.json.data;
		console.log(`${g.title}: angelegt (${g.visibility})`);
	} else {
		console.log(`${g.title}: vorhanden ohne Bilder, lade Bilder hoch`);
	}

	for (let i = 0; i < g.images.length; i++) {
		const [label, description] = g.images[i];
		const [w, h] = SIZES[(seed + i) % SIZES.length];
		const bytes = await sampleImage(label, g.colors[i % g.colors.length], w, h, seed + i);
		const form = new FormData();
		form.set('file', new Blob([bytes], { type: 'image/jpeg' }), `${label.toLowerCase()}.jpg`);
		if (description) form.set('description', description);
		const r = await call('POST', `${G}/galleries/${gallery.id}/images`, form);
		if (r.status === 503) {
			console.error(
				'Storage nicht verfügbar (503). Bitte MinIO starten (docker compose -f docker-compose.demo.yml up -d)\n' +
					'und `node scripts/setup-demo-storage.mjs` ausführen, dann dieses Skript erneut starten.'
			);
			process.exit(1);
		}
		if (r.status !== 200 && r.status !== 201) {
			throw new Error(`Upload "${label}" fehlgeschlagen (${r.status})`);
		}
		console.log(`  ${label.padEnd(14)} ${w}x${h}`, r.status);
	}
	seed += g.images.length;
	if (g.withEvent && eventId) console.log('  Termin zugeordnet');
}

console.log('Fertig.');
