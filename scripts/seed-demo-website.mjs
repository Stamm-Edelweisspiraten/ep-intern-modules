// Demo-Daten für die Stammeswebsite (`website/`) – über die echte API, idempotent soweit sinnvoll.
// Voraussetzung: demo-server läuft (http://127.0.0.1:4300), `seed-demo.mjs` und `seed-demo-modules.mjs`
// wurden ausgeführt (Admin, Mitglieder, Gruppen). Optional vorher `seed-demo-galleries.mjs` (Galerie).
//
// Das Skript
//  1. aktiviert `members`, `events`, `galleries` und `offices` (falls nötig),
//  2. stellt Gruppen auf die Website (Slugs `sportliche-panther`, `funkelfuechse`,
//     `die-goldenen-loewenzaehne`; passende Namen zuerst, sonst vorhandene Gruppen),
//  3. legt Website-Termine an bzw. aktualisiert sie (gleicher Titel → PUT): Gruppenstunden als
//     wöchentliche Serien, Termine mit Gruppe und für den ganzen Stamm, eine vergangene Fahrt,
//  4. stellt eine vorhandene Galerie öffentlich und verknüpft sie mit der vergangenen Fahrt,
//  5. widerruft einen vorhandenen Key „Stammeswebsite (Demo)“, legt ihn mit den vier
//     Website-Scopes neu an und schreibt `website/.env` (WEBSITE_API_URL, WEBSITE_API_KEY, ORIGIN).
//
//   node scripts/seed-demo-website.mjs
//   DEMO_EMAIL=… DEMO_PASSWORD=… node scripts/seed-demo-website.mjs

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';
const SITE_URL = 'http://localhost:3001';
const KEY_NAME = 'Stammeswebsite (Demo)';
const SCOPES = [
	'events.website.read',
	'galleries.website.read',
	'offices.website.read',
	'members.website.read'
];
const ENV_FILE = fileURLToPath(new URL('../website/.env', import.meta.url));

const EMAIL = process.env.DEMO_EMAIL ?? 'admin@demo.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Admin-2026!';

let cookie = '';
async function call(method, path, body, base = '/api/v1') {
	const res = await fetch(BASE + base + path, {
		method,
		headers: {
			...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			origin: ORIGIN,
			...(cookie ? { cookie } : {})
		},
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	const set = res.headers.getSetCookie?.() ?? [];
	if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
	const json = await res.json().catch(() => null);
	if (res.status >= 400) {
		console.warn(`${method} ${path} -> ${res.status}`, JSON.stringify(json?.error ?? json));
	}
	return { status: res.status, json, data: json?.data };
}

async function login() {
	// Better Auth begrenzt Anmeldungen: bei 429 kurz warten
	for (let attempt = 0; attempt < 12; attempt++) {
		cookie = '';
		const r = await call(
			'POST',
			'/sign-in/email',
			{ email: EMAIL, password: PASSWORD },
			'/api/auth'
		);
		if (cookie && r.status < 400) return true;
		if (r.status === 401) return false;
		console.log('Anmeldung begrenzt (429) – warte 15 s …');
		await new Promise((resolve) => setTimeout(resolve, 15_000));
	}
	return false;
}

// --- Datums-Helfer (Europe/Berlin, `YYYY-MM-DD`) -------------------------------------------

function todayBerlin() {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Europe/Berlin',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(new Date());
	const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')}`;
}
function addDays(iso, n) {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}
/** ISO-Wochentag 1 = Mo … 7 = So */
function isoWeekday(iso) {
	return new Date(`${iso}T00:00:00Z`).getUTCDay() || 7;
}
/** Nächstes Datum ≥ `from` mit diesem Wochentag */
function nextWeekday(from, weekday) {
	return addDays(from, (weekday - isoWeekday(from) + 7) % 7);
}

const today = todayBerlin();

// --- 1. Anmelden, Module aktivieren --------------------------------------------------------

if (!(await login())) {
	throw new Error(`Login als ${EMAIL} fehlgeschlagen – läuft der Demo-Server?`);
}

const modules = (await call('GET', '/modules')).data ?? [];
const isEnabled = (id) => modules.some((m) => m.id === id && m.enabled);
let changed = false;
for (const id of ['members', 'events', 'galleries', 'offices']) {
	if (isEnabled(id)) continue;
	const r = await call('POST', `/modules/${id}/enable`);
	console.log(`Modul ${id} aktivieren:`, r.status);
	if (r.status >= 400) throw new Error(`Modul ${id} konnte nicht aktiviert werden`);
	changed = true;
}
// Neue Modulrechte sind erst nach erneutem Login in der Sitzung wirksam
if (changed && !(await login())) {
	throw new Error(`Erneuter Login als ${EMAIL} fehlgeschlagen`);
}

// --- 2. Gruppen auf die Website ------------------------------------------------------------

const M = '/modules/members';
const groupsRaw = (await call('GET', `${M}/groups`)).data ?? [];
const groups = Array.isArray(groupsRaw) ? groupsRaw : (groupsRaw.items ?? []);

/** Steckbriefe aus der alten Website (Texte im Original) */
const GROUP_TEMPLATES = [
	{
		slug: 'sportliche-panther',
		name: 'Sportliche Panther',
		color: '#c05621',
		match: /panther/i,
		type: 'meute',
		meetingWeekday: 5,
		meetingTime: '16:30',
		endTime: '18:00',
		website: {
			description:
				'Wir sind die Meute der Edelweißpiraten – unsere Pfadfindergruppe für Kinder im Alter von 7 bis 10 Jahren. ' +
				'In unseren Gruppenstunden wird gespielt, gebastelt, gesungen und draußen getobt. ' +
				'Die Kinder erleben kleine Abenteuer, wachsen spielerisch als Gruppe zusammen und entdecken mit viel Freude, ' +
				'was es heißt, Teil einer Gemeinschaft zu sein.',
			ageRange: '6 bis 10 Jahre',
			contactEmail: 'meute@edelweisspiraten-bremen.de'
		}
	},
	{
		slug: 'funkelfuechse',
		name: 'Funkelfüchse',
		color: '#d53f8c',
		match: /funkelf/i,
		type: 'sippe',
		meetingWeekday: 5,
		meetingTime: '18:00',
		endTime: '19:30',
		website: {
			description:
				'Wir sind die ältere Sippe der Edelweißpiraten – eine Pfadfindergruppe für Jugendliche ab 15 und junge Erwachsene, ' +
				'auch für Quereinsteiger sehr gut geeignet. Wir bauen Zelte auf, machen Lagerfeuer, haben viel Spaß gemeinsam, ' +
				'sind oft in der Natur und lernen in besonderen Situationen eigenständig reagieren zu können.',
			ageRange: 'ab 15 Jahren',
			contactEmail: 'funkelfuechse@edelweisspiraten-bremen.de'
		}
	},
	{
		slug: 'die-goldenen-loewenzaehne',
		name: 'Die Goldenen Löwenzähne',
		color: '#d69e2e',
		match: /l(ö|oe)wenz/i,
		type: 'sippe',
		meetingWeekday: 1,
		meetingTime: '16:30',
		endTime: '18:00',
		website: {
			description:
				'Wir sind die Sippe der Edelweißpiraten – eine Pfadfindergruppe für Jugendliche ab 11 Jahren. ' +
				'In unseren wöchentlichen Gruppenstunden und auf Fahrten erleben wir echte Abenteuer, wachsen als Team zusammen ' +
				'und entdecken die Natur. Ob Lagerfeuer, Zeltlager oder Geländespiel – bei uns ist immer etwas los!',
			ageRange: '11 bis 14 Jahre',
			contactEmail: 'sippe@edelweisspiraten-bremen.de'
		}
	}
];

/** Slug → Gruppe (für die Termine) */
const websiteGroups = new Map();
// Gruppen mit den Namen der alten Website suchen, fehlende anlegen (Leitung aus einer vorhandenen Gruppe)
const assigned = new Map();
for (const t of GROUP_TEMPLATES) {
	const g = groups.find((x) => t.match.test(x.name));
	if (g) assigned.set(t.slug, g);
}
// Slugs, die an anderen Gruppen hängen (frühere Läufe), freigeben
for (const g of groups) {
	const t = GROUP_TEMPLATES.find((x) => x.slug === g.website?.slug);
	if (!t || assigned.get(t.slug)?.id === g.id) continue;
	const r = await call('PUT', `${M}/groups/${g.id}`, {
		name: g.name,
		type: g.type,
		leaderIds: g.leaders.map((l) => l.id),
		description: g.description ?? null,
		meetingPlace: g.meetingPlace ?? null,
		meetingWeekday: g.meetingWeekday ?? null,
		meetingTime: g.meetingTime ?? null,
		meetingEndTime: g.meetingEndTime ?? null,
		color: g.color ?? null,
		website: { onWebsite: false, slug: null, description: null, ageRange: null, contactEmail: null }
	});
	console.log(`Website-Adresse von „${g.name}“ freigegeben: ${r.status}`);
}
const leaderPool = groups.find((x) => x.leaders?.length)?.leaders ?? [];
for (const t of GROUP_TEMPLATES) {
	if (assigned.has(t.slug)) continue;
	if (!leaderPool.length) {
		console.log(`Hinweis: keine Leitung verfügbar – „${t.name}“ nicht angelegt.`);
		continue;
	}
	const r = await call('POST', `${M}/groups`, {
		name: t.name,
		type: t.type,
		leaderIds: [leaderPool[0].id],
		description: null,
		meetingPlace: 'Ev. Kirchengemeinde Bremen-Hastedt',
		meetingWeekday: t.meetingWeekday,
		meetingTime: t.meetingTime,
		meetingEndTime: t.endTime ?? null,
		color: t.color
	});
	if (r.status < 400) {
		console.log(`Gruppe angelegt: ${t.name}`);
		assigned.set(t.slug, r.data);
	}
}
for (const t of GROUP_TEMPLATES) {
	const group = assigned.get(t.slug);
	if (!group) {
		console.log(`Hinweis: keine Gruppe für „${t.slug}“ übrig – übersprungen.`);
		continue;
	}
	if (!group.leaders?.length) {
		console.log(`Hinweis: Gruppe „${group.name}“ hat keine Leitung – übersprungen.`);
		continue;
	}
	// PUT ersetzt alle Felder: bestehende Werte übernehmen, nur Website und Gruppenstunde setzen
	const r = await call('PUT', `${M}/groups/${group.id}`, {
		name: group.name,
		type: group.type,
		leaderIds: group.leaders.map((l) => l.id),
		description: group.description ?? null,
		meetingPlace: group.meetingPlace ?? null,
		meetingWeekday: t.meetingWeekday ?? group.meetingWeekday ?? null,
		meetingTime: t.meetingTime ?? group.meetingTime ?? null,
		// Ende nur zusammen mit dem Beginn aus der Vorlage (sonst 422 bei Ende ≤ Beginn)
		meetingEndTime: t.meetingTime ? (t.endTime ?? null) : (group.meetingEndTime ?? null),
		color: group.color ?? null,
		website: {
			onWebsite: true,
			slug: t.slug,
			description: t.website.description ?? group.website?.description ?? null,
			ageRange: t.website.ageRange ?? group.website?.ageRange ?? null,
			contactEmail: t.website.contactEmail ?? group.website?.contactEmail ?? null
		}
	});
	if (r.status < 400) {
		websiteGroups.set(t.slug, { ...r.data, template: t });
		console.log(`Gruppe „${group.name}“ auf der Website: /gruppen/${t.slug}`);
	}
}
// Leitende erscheinen nur mit Website-Einwilligung (#27): für die Demo-Leitungen erteilen
const leaderIds = [
	...new Set([...websiteGroups.values()].flatMap((g) => (g.leaders ?? []).map((l) => l.id)))
];
if (leaderIds.length) {
	const r = await call('POST', `${M}/members/bulk`, {
		action: 'set-consent',
		ids: leaderIds,
		consent: { consentWebsite: true }
	});
	console.log(`Website-Einwilligung für ${leaderIds.length} Leitende: ${r.status}`);
}

// --- 3. Website-Termine --------------------------------------------------------------------

const E = '/modules/events';
const everyone = [{ type: 'everyone', id: '*', level: 'read' }];

function eventBody(over) {
	return {
		title: 'Termin',
		description: null,
		location: null,
		color: null,
		startsOn: today,
		startsTime: null,
		endsOn: null,
		endsTime: null,
		tags: [],
		groupIds: [],
		shares: everyone,
		onWebsite: true,
		recurrence: null,
		...over
	};
}

/** Termin anlegen oder (gleicher Titel) per PUT aktualisieren → ID */
async function upsertEvent(body) {
	const found = await call('GET', `${E}/events?limit=500&search=${encodeURIComponent(body.title)}`);
	const existing = (found.data?.items ?? []).find((i) => i.title === body.title);
	const r = existing
		? await call('PUT', `${E}/events/${existing.id}`, body)
		: await call('POST', `${E}/events`, body);
	if (r.status >= 400) return null;
	console.log(`Termin ${existing ? 'aktualisiert' : 'angelegt'}: ${body.title}`);
	return r.data.id;
}

const eventIds = {};
for (const [slug, g] of websiteGroups) {
	const t = g.template;
	if (!t.meetingWeekday) continue;
	const start = nextWeekday(today, t.meetingWeekday);
	eventIds[slug] = await upsertEvent(
		eventBody({
			title: `Gruppenstunde ${g.name}`,
			description: `Wöchentliche Gruppenstunde (${t.website.ageRange}). Schnuppern ist jederzeit möglich!`,
			location: g.meetingPlace ?? 'Gemeindehaus',
			color: g.color ?? null,
			startsOn: start,
			startsTime: t.meetingTime,
			endsOn: start,
			endsTime: t.endTime,
			tags: ['Gruppenstunde'],
			groupIds: [g.id],
			recurrence: {
				freq: 'weekly',
				interval: 1,
				byWeekday: [t.meetingWeekday],
				end: { type: 'never' }
			}
		})
	);
}

const panther = websiteGroups.get('sportliche-panther');
if (panther) {
	const day = nextWeekday(addDays(today, 10), 6);
	await upsertEvent(
		eventBody({
			title: 'Meutenaktion: Schnitzeljagd im Bürgerpark',
			description:
				'Gemeinsame Schnitzeljagd für alle Wölflinge. Bitte wetterfeste Kleidung und ein Lunchpaket mitbringen.',
			location: 'Bürgerpark Bremen, Treffpunkt Meierei',
			startsOn: day,
			startsTime: '10:00',
			endsOn: day,
			endsTime: '14:00',
			tags: ['Aktion'],
			groupIds: [panther.id]
		})
	);
}

const assembly = nextWeekday(addDays(today, 21), 7);
await upsertEvent(
	eventBody({
		title: 'Stammesversammlung',
		description: 'Alle Mitglieder und Eltern sind herzlich eingeladen.',
		location: 'Gemeindehaus',
		startsOn: assembly,
		startsTime: '15:00',
		endsOn: assembly,
		endsTime: '17:00',
		tags: ['Stamm'],
		groupIds: ['stamm']
	})
);

const campStart = nextWeekday(addDays(today, 35), 5);
await upsertEvent(
	eventBody({
		title: 'Herbstlager',
		description: 'Ein Wochenende mit Zelten, Lagerfeuer und Geländespiel für den ganzen Stamm.',
		location: 'Zeltplatz Stühe',
		startsOn: campStart,
		startsTime: '17:00',
		endsOn: addDays(campStart, 2),
		endsTime: '14:00',
		tags: ['Lager'],
		groupIds: ['stamm']
	})
);

// vergangene Fahrt: Ziel für die Galerie
const tripStart = addDays(today, -60);
const pastTripId = await upsertEvent(
	eventBody({
		title: 'Sommerfahrt 2026',
		description: 'Eine Woche Fahrt mit Zelten und Wandern.',
		location: 'Dänemark',
		startsOn: tripStart,
		endsOn: addDays(tripStart, 6),
		tags: ['Fahrt'],
		groupIds: ['stamm']
	})
);

// --- 4. Galerie öffentlich + Termin --------------------------------------------------------

const G = '/modules/galleries';
const galleryList = (await call('GET', `${G}/galleries?limit=50`)).data?.items ?? [];
const gallery =
	galleryList.find((g) => g.imageCount > 0 && g.visibility === 'public') ??
	galleryList.find((g) => g.imageCount > 0) ??
	galleryList[0];
if (!gallery) {
	console.log(
		'Hinweis: keine Galerie vorhanden – erst `node scripts/seed-demo-galleries.mjs` (MinIO).'
	);
} else {
	const detail = (await call('GET', `${G}/galleries/${gallery.id}`)).data;
	if (detail) {
		const ids = new Set((detail.events ?? []).map((e) => e.id));
		if (pastTripId) ids.add(pastTripId);
		// PUT ersetzt alles (auch Freigaben und Termine): Bestehendes übernehmen
		const r = await call('PUT', `${G}/galleries/${gallery.id}`, {
			title: detail.title,
			description: detail.description ?? null,
			visibility: 'public',
			// Demo: Bestätigung der Website-Einwilligungen (Pflicht beim Veröffentlichen, #27)
			consentConfirmed: true,
			shares: (detail.shares ?? []).map((s) => ({ type: s.type, id: s.id, level: s.level })),
			eventIds: [...ids]
		});
		if (r.status < 400)
			console.log(`Galerie „${detail.title}“ öffentlich, mit „Sommerfahrt 2026“.`);
	}
}

// --- 5. API-Key + website/.env -------------------------------------------------------------

const keys = (await call('GET', '/api-keys')).data ?? [];
for (const k of keys) {
	if (k.name === KEY_NAME && !k.revokedAt) {
		const r = await call('DELETE', `/api-keys/${k.id}`);
		if (r.status < 400) console.log(`Alten Key „${KEY_NAME}“ (${k.prefix}…) widerrufen.`);
	}
}
const created = await call('POST', '/api-keys', { name: KEY_NAME, scopes: SCOPES });
const apiKey = created.data?.key;
if (!apiKey) {
	throw new Error(
		'API-Key konnte nicht angelegt werden (fehlt ein Website-Scope, z. B. members.website.read?)'
	);
}

const values = {
	WEBSITE_API_URL: BASE,
	WEBSITE_API_KEY: apiKey,
	ORIGIN: SITE_URL
};
// vorhandene Zeilen behalten, nur diese Schlüssel ersetzen bzw. ergänzen
const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
const seen = new Set();
const out = lines.map((line) => {
	const m = /^([A-Z0-9_]+)=/.exec(line);
	if (m && m[1] in values) {
		seen.add(m[1]);
		return `${m[1]}=${values[m[1]]}`;
	}
	return line;
});
while (out.length && out[out.length - 1] === '') out.pop();
for (const [k, v] of Object.entries(values)) if (!seen.has(k)) out.push(`${k}=${v}`);
writeFileSync(ENV_FILE, out.join('\n') + '\n', 'utf8');

console.log(`API-Key „${KEY_NAME}“ angelegt (Scopes: ${SCOPES.join(' ')}).`);
console.log(`Geschrieben: ${ENV_FILE}`);
console.log(
	`Prüfen: curl -H "Authorization: Bearer <key>" ${BASE}/api/v1/modules/events/website/events`
);
