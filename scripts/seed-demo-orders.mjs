// Demo-Daten für das Modul `orders` (Bestellungen / Kämmerer*in; idempotent, über die echte API).
// Voraussetzung: demo-server läuft, `seed-demo.mjs` und `seed-demo-modules.mjs` wurden ausgeführt (Mitglieder, Kasse).
// Bilder brauchen MinIO (`setup-demo-storage.mjs`); ohne Storage werden Artikel ohne Bilder angelegt.
// Legt Artikel (mit/ohne Größen), Lagerbestand, Bestellungen für Mitglieder (Rechnung über die Kasse),
// eine Teilausgabe und eine teilweise gelieferte Lieferantenbestellung mit Rechnung an die Kasse an.
import sharp from 'sharp';

const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';
const O = '/modules/orders';

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

// Zugangsdaten überschreibbar:  DEMO_EMAIL=… DEMO_PASSWORD=… node scripts/seed-demo-orders.mjs
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
		if (cookie && r.status < 400) return true;
		if (r.status === 401) return false;
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
	return false;
}

if (!(await login())) throw new Error(`Login als ${EMAIL} fehlgeschlagen - läuft der Demo-Server?`);
for (const id of ['members', 'treasury', 'offices', 'orders']) {
	const r = await call('POST', `/modules/${id}/enable`);
	console.log(`Modul ${id} aktivieren:`, r.status);
}
// Neue Modulrechte sind erst nach erneutem Login in der Sitzung wirksam
await login();

// --- Beispielbilder ----------------------------------------------------------------
function escapeXml(s) {
	return s.replace(
		/[<>&"]/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]
	);
}
async function sampleImage(label, [from, to]) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
	<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
		<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
	</linearGradient></defs>
	<rect width="100%" height="100%" fill="url(#g)"/>
	<circle cx="600" cy="420" r="220" fill="#ffffff" fill-opacity="0.18"/>
	<text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif"
		font-size="110" font-weight="bold" fill="#ffffff" fill-opacity="0.92">${escapeXml(label)}</text>
</svg>`;
	return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

// --- Artikel -----------------------------------------------------------------------
const SHIRT_SIZES = ['116', '128', '140', '152', '164', 'S', 'M', 'L', 'XL', 'XXL'];
const articles = [
	{
		title: 'Halstuch',
		description:
			'Das Stammeshalstuch in Dunkelblau mit gesticktem Stammeswappen.\nWird bei der Aufnahme verliehen – Ersatz kann hier bestellt werden.',
		notes: 'Bestellung bei der Stickerei Meyer, Mindestmenge 10 Stück, Lieferzeit ca. 4 Wochen.',
		reorderUrl: 'https://example.org/stickerei/halstuch',
		variants: [{ label: '', priceCents: 1200, minStock: 5 }],
		stock: { '': 3 },
		colors: [
			['#1e3a8a', '#3b82f6'],
			['#1e40af', '#60a5fa']
		]
	},
	{
		title: 'Kluft-Hemd',
		description:
			'Graues Fahrtenhemd (Kluft) aus Baumwolle. Kindergrößen 116–164, Erwachsene S–XXL.',
		notes: 'Lieferant: Ausrüster Nord. Kindergrößen günstiger.',
		reorderUrl: 'https://example.org/ausruester/kluft',
		variants: SHIRT_SIZES.map((label) => ({
			label,
			priceCents: /^\d+$/.test(label) ? 2900 : label === 'XXL' ? 3900 : 3500,
			minStock: ['140', '152', 'M', 'L'].includes(label) ? 2 : 0
		})),
		stock: { 128: 1, 140: 2, 152: 0, M: 3, L: 1 },
		colors: [['#4b5563', '#9ca3af']]
	},
	{
		title: 'Liederbuch „Codex“',
		description: 'Das Liederbuch für Fahrt und Lager, Spiralbindung.',
		notes: null,
		reorderUrl: 'https://example.org/verlag/codex',
		variants: [{ label: '', priceCents: 1500, minStock: 3 }],
		stock: { '': 6 },
		colors: [['#065f46', '#34d399']]
	},
	{
		title: 'Stammesaufnäher',
		description: 'Gewebter Aufnäher mit Stammeswappen, 7 cm.',
		notes: 'Rest aus der Sammelbestellung 2025.',
		reorderUrl: null,
		variants: [{ label: '', priceCents: 300, minStock: 10 }],
		stock: { '': 24 },
		colors: [['#b45309', '#fbbf24']]
	},
	{
		title: 'Stammespulli',
		description: 'Kapuzenpulli mit Stammeslogo auf dem Rücken.',
		notes: 'Nur einmal im Jahr Sammelbestellung (Herbst).',
		reorderUrl: 'https://example.org/textildruck/pulli',
		variants: [
			{ label: 'S', priceCents: 3500, minStock: 0 },
			{ label: 'M', priceCents: 3500, minStock: 0 },
			{ label: 'L', priceCents: 3500, minStock: 0 },
			{ label: 'XL', priceCents: 3500, minStock: 0 },
			{ label: 'XXL', priceCents: 3800, minStock: 0 }
		],
		stock: {},
		colors: [['#7f1d1d', '#ef4444']]
	}
];

const existing = (await call('GET', `${O}/articles?scope=all`)).json?.data ?? [];
const byTitle = new Map(existing.map((a) => [a.title, a]));
let storageMissing = false;

for (const def of articles) {
	let article = byTitle.get(def.title);
	if (article) {
		console.log(`${def.title}: vorhanden`);
	} else {
		const r = await call('POST', `${O}/articles`, {
			title: def.title,
			description: def.description,
			notes: def.notes,
			reorderUrl: def.reorderUrl,
			active: true,
			variants: def.variants
		});
		article = r.json?.data;
		if (!article) throw new Error(`Artikel "${def.title}" konnte nicht angelegt werden`);
		console.log(`${def.title}: angelegt`);
		// Anfangsbestand
		for (const v of article.variants) {
			const stock = def.stock[v.label] ?? 0;
			if (stock > 0) {
				await call('POST', `${O}/stock/corrections`, {
					variantId: v.id,
					stock,
					note: 'Anfangsbestand (Demo)'
				});
			}
		}
	}
	byTitle.set(def.title, article);
	if (!storageMissing && article.images.length === 0) {
		for (let i = 0; i < def.colors.length; i++) {
			const form = new FormData();
			const bytes = await sampleImage(def.title.replace(/[„“]/g, ''), def.colors[i]);
			form.set('file', new Blob([bytes], { type: 'image/jpeg' }), `artikel-${i + 1}.jpg`);
			const r = await call('POST', `${O}/articles/${article.id}/images`, form);
			if (r.status === 503) {
				storageMissing = true;
				console.warn('Storage nicht verfügbar (503) – Artikel bleiben ohne Bilder.');
				break;
			}
		}
	}
}

// --- Bestellungen ------------------------------------------------------------------
const variant = (title, label = '') =>
	byTitle.get(title)?.variants.find((v) => v.label === label && !v.archived)?.id;

const orders = (await call('GET', `${O}/orders?scope=all&limit=200`)).json?.data?.items ?? [];
if (orders.length > 0) {
	console.log(`Bestellungen: ${orders.length} vorhanden, keine neuen angelegt`);
} else {
	const members = [];
	for (const q of ['Müller', 'Schmidt', 'Becker', 'Neumann', 'Yılmaz']) {
		for (const m of (await call('GET', `${O}/members?search=${encodeURIComponent(q)}`)).json
			?.data ?? []) {
			if (!members.some((x) => x.id === m.id)) members.push(m);
		}
	}
	if (members.length < 3)
		console.warn('Weniger als 3 Mitglieder gefunden – seed-demo-modules.mjs?');
	const plans = [
		[
			{ variantId: variant('Halstuch'), quantity: 1 },
			{ variantId: variant('Kluft-Hemd', '140'), quantity: 1 }
		],
		[
			{ variantId: variant('Kluft-Hemd', '152'), quantity: 1 },
			{ variantId: variant('Liederbuch „Codex“'), quantity: 1 },
			{ variantId: variant('Stammesaufnäher'), quantity: 2 }
		],
		[
			{ variantId: variant('Stammespulli', 'M'), quantity: 1 },
			{ variantId: variant('Halstuch'), quantity: 2 }
		],
		[{ variantId: variant('Kluft-Hemd', 'L'), quantity: 1 }]
	];
	const created = [];
	for (let i = 0; i < plans.length && i < members.length; i++) {
		const items = plans[i].filter((it) => it.variantId);
		const r = await call('POST', `${O}/orders`, { memberId: members[i].id, items, note: null });
		const o = r.json?.data?.order;
		if (o) {
			created.push(o);
			console.log(
				`Bestellung ${o.number} für ${o.member.name}: Rechnung ${o.invoiceNumber ?? 'folgt'}`
			);
		}
	}
	// Teilausgabe: erste Bestellung – Halstuch ausgeben, Hemd 140 bleibt (falls Lager reicht)
	const first = created[0];
	if (first) {
		const items = first.items
			.filter((it) => it.articleTitle === 'Halstuch')
			.map((it) => ({ itemId: it.id, quantity: 1 }));
		if (items.length) await call('POST', `${O}/orders/${first.id}/handout`, { items });
	}
	// Vollständige Ausgabe der zweiten Bestellung, soweit auf Lager
	const second = created[1];
	if (second) {
		const items = second.items
			.filter((it) => (it.stock ?? 0) >= it.quantity)
			.map((it) => ({ itemId: it.id, quantity: it.quantity }));
		if (items.length) await call('POST', `${O}/orders/${second.id}/handout`, { items });
	}
}

// --- Einkauf -----------------------------------------------------------------------
const supplier = (await call('GET', `${O}/supplier-orders?status=all`)).json?.data ?? [];
if (supplier.length > 0) {
	console.log(`Lieferantenbestellungen: ${supplier.length} vorhanden`);
} else {
	const suggestion = (await call('GET', `${O}/supplier-orders/suggestion`)).json?.data?.items ?? [];
	const items = suggestion.map((s) => ({ variantId: s.variantId, quantity: s.quantity }));
	if (items.length) {
		const today = new Date().toISOString().slice(0, 10);
		const r = await call('POST', `${O}/supplier-orders`, {
			supplier: 'Ausrüster Nord',
			orderedOn: today,
			note: 'Nachbestellung aus dem Bestellvorschlag (Demo)',
			items
		});
		const so = r.json?.data;
		if (so) {
			console.log(`Lieferantenbestellung ${so.number} mit ${so.items.length} Positionen`);
			// Teillieferung: von jeder Position die Hälfte (mind. 1 bei der ersten)
			const rec = so.items.map((it, i) => ({
				itemId: it.id,
				quantity: i === 0 ? Math.max(1, Math.floor(it.quantity / 2)) : Math.floor(it.quantity / 2)
			}));
			await call('POST', `${O}/supplier-orders/${so.id}/receive`, {
				items: rec,
				note: 'Erste Teillieferung'
			});
			const form = new FormData();
			form.set('amountCents', '18450');
			form.set('recipientName', 'Ausrüster Nord GmbH');
			form.set('iban', 'DE89370400440532013000');
			form.set('note', 'Rechnung Nr. 2026-4711');
			const inv = await call('PUT', `${O}/supplier-orders/${so.id}/invoice`, form);
			console.log('Lieferantenrechnung an die Kasse:', inv.status);
		}
	} else {
		console.log('Kein Bestellvorschlag (keine Fehlmengen)');
	}
}

console.log('Fertig.');
