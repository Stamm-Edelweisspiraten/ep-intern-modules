// Demo-Daten für das Modul `offices` (Ämter; idempotent, über die echte API).
// Voraussetzung: demo-server läuft, `node scripts/seed-demo.mjs` wurde ausgeführt (Demo-Benutzer und Rollen).
// Aktiviert das Modul, legt Ämter mit E-Mail-Adressen, verknüpften Rollen und Inhaber*innen an und
// hinterlegt persönliche Beschreibungen (Anmeldung als die jeweilige Person). Vorhandene Ämter gleichen
// Namens werden aktualisiert statt doppelt angelegt.

const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';
const O = '/modules/offices';

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

// Zugangsdaten überschreibbar, falls die Admin-Adresse in der Demo-DB geändert wurde:
//   DEMO_EMAIL=… DEMO_PASSWORD=… node scripts/seed-demo-offices.mjs
const EMAIL = process.env.DEMO_EMAIL ?? 'admin@demo.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Admin-2026!';
/** Passwort der Demo-Benutzer aus `seed-demo.mjs` */
const USER_PASSWORD = 'Demo-Passwort-2026!';

async function login(email, password) {
	// Better Auth begrenzt Anmeldungen (gemeinsamer Bucket ohne Client-IP): bei 401/429 kurz warten
	for (let attempt = 0; attempt < 6; attempt++) {
		cookie = '';
		const r = await call('POST', '/sign-in/email', { email, password }, '/api/auth');
		if (cookie && r.status < 400) return true;
		if (r.status === 401) return false;
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
	return false;
}

if (!(await login(EMAIL, PASSWORD))) {
	throw new Error(`Login als ${EMAIL} fehlgeschlagen - läuft der Demo-Server?`);
}
const enabled = await call('POST', '/modules/offices/enable');
console.log('Modul offices aktivieren:', enabled.status);
if (enabled.status >= 400 && enabled.status !== 409) {
	throw new Error('Modul offices konnte nicht aktiviert werden');
}
// Neue Modulrechte sind erst nach erneutem Login in der Sitzung wirksam
await login(EMAIL, PASSWORD);

// --- Rollen und Benutzer auflösen -------------------------------------------------
const roles = (await call('GET', `${O}/roles`)).json?.data ?? [];
const roleId = (name) => roles.find((r) => r.name === name)?.id;

async function userId(email) {
	const r = await call('GET', `${O}/users?search=${encodeURIComponent(email)}`);
	return (r.json?.data ?? []).find((u) => u.email === email)?.id;
}

// --- Ämter ------------------------------------------------------------------------
const offices = [
	{
		name: 'Stammesführung',
		description:
			'Leitet den Stamm, vertritt ihn nach außen und im Gau, lädt zur Stammesversammlung ein und hält die Fäden zwischen Gruppen, Eltern und Gemeinde zusammen.',
		emails: [
			{ label: 'Stammesführung', email: 'stammesfuehrung@stamm.example' },
			{ label: 'Vertretung', email: 'vertretung@stamm.example' }
		],
		roles: ['Benutzerverwaltung'],
		holders: [
			{ email: 'anna@demo.test', since: '2023-09-01' },
			{ email: 'dieter@demo.test', since: '2024-03-15' }
		]
	},
	{
		name: 'Kasse',
		description:
			'Führt die Stammeskasse, verschickt Rechnungen und Erinnerungen, erstattet Auslagen und erstellt den Kassenbericht für die Stammesversammlung.',
		emails: [{ label: null, email: 'kasse@stamm.example' }],
		roles: ['Auditor'],
		holders: [{ email: 'bernd@demo.test', since: '2022-01-01' }]
	},
	{
		name: 'Materialwart',
		description:
			'Verwaltet Zelte, Kochausrüstung und Werkzeug, organisiert Ausleihe und Reparaturen und hält das Materiallager in Ordnung.',
		emails: [{ label: null, email: 'material@stamm.example' }],
		roles: [],
		holders: [{ email: 'dieter@demo.test', since: '2025-05-01' }]
	},
	{
		name: 'Öffentlichkeitsarbeit',
		description:
			'Pflegt Website und Social Media, schreibt Berichte für den Gemeindebrief und kümmert sich um Fotos von Fahrten und Lagern.',
		emails: [
			{ label: 'Presse', email: 'presse@stamm.example' },
			{ label: 'Website', email: 'web@stamm.example' }
		],
		roles: ['Redaktion'],
		holders: [{ email: 'clara@demo.test', since: '2024-09-01' }]
	},
	{
		name: 'Elternvertretung',
		description: 'Ansprechpartner*in für Eltern, unterstützt bei Fahrten und Festen.',
		emails: [{ label: null, email: 'eltern@stamm.example' }],
		roles: [],
		holders: []
	}
];

const existing = (await call('GET', `${O}/offices`)).json?.data ?? [];
for (const def of offices) {
	const body = {
		name: def.name,
		description: def.description,
		emails: def.emails,
		roleIds: def.roles.map(roleId).filter(Boolean)
	};
	const found = existing.find((o) => o.name === def.name);
	const r = found
		? await call('PATCH', `${O}/offices/${found.id}`, body)
		: await call('POST', `${O}/offices`, body);
	const id = r.json?.data?.id;
	if (!id) continue;
	const holders = [];
	for (const h of def.holders) {
		const uid = await userId(h.email);
		if (uid) holders.push({ userId: uid, since: h.since });
		else console.warn(`Benutzer ${h.email} nicht gefunden – erst seed-demo.mjs ausführen`);
	}
	const hr = await call('PUT', `${O}/offices/${id}/holders`, { holders });
	console.log(
		`Amt „${def.name}“: ${found ? 'aktualisiert' : 'angelegt'}, ${holders.length} Person(en)`,
		hr.status
	);
}

// --- Persönliche Beschreibungen (je Person eine, gilt für alle ihre Ämter) ----------------
const bios = [
	[
		'anna@demo.test',
		'Seit 2012 bei den Pfadfinder*innen, früher Sippenführung bei den Füchsen. Ich bin erreichbar für alles rund um den Stamm – am liebsten per Mail.'
	],
	[
		'bernd@demo.test',
		'Im Hauptberuf Buchhalter, im Stamm für Zahlen zuständig. Fragen zu Rechnungen und Erstattungen gerne an die Kassen-Adresse.'
	],
	[
		'clara@demo.test',
		'Ich fotografiere auf fast jeder Fahrt und schreibe die Berichte für Website und Gemeindebrief. Fotos und Ideen sind jederzeit willkommen!'
	],
	[
		'dieter@demo.test',
		'Technik, Zelte und alles, was repariert werden muss. Material bitte immer über die Material-Adresse ausleihen.'
	]
];
for (const [email, bio] of bios) {
	if (!(await login(email, USER_PASSWORD))) {
		console.warn(`Login als ${email} fehlgeschlagen – Beschreibung übersprungen`);
		continue;
	}
	const r = await call('PUT', `${O}/me/bio`, { bio });
	console.log(`Beschreibung ${email}:`, r.status);
}

console.log('Fertig: Ämter unter http://localhost:4300/modules/offices');
