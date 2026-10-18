// Hängt Beispiel-Belege (abwechselnd PDF und PNG) an alle Ausgaben der Demo-Aktion "Kopenhagen 2026"
// und speichert den Bericht als .data/demo-report.pdf. Voraussetzung: Demo-Storage eingerichtet
// (docker compose -f docker-compose.demo.yml up -d; node scripts/setup-demo-storage.mjs).
import { writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const BASE = 'http://127.0.0.1:4300';
const headers = { origin: 'http://localhost:4300' };

const login = await fetch(`${BASE}/api/auth/sign-in/email`, {
	method: 'POST',
	headers: { ...headers, 'content-type': 'application/json' },
	body: JSON.stringify({ email: 'admin@demo.test', password: 'Demo-Admin-2026!' })
});
const cookie = login.headers
	.getSetCookie()
	.map((c) => c.split(';')[0])
	.join('; ');
const list = await (
	await fetch(`${BASE}/api/v1/modules/actions/actions?search=Kopenhagen`, {
		headers: { ...headers, cookie }
	})
).json();
const ACTION = list.data.items.find((a) => a.name === 'Kopenhagen 2026')?.id;
if (!ACTION)
	throw new Error('Demo-Aktion "Kopenhagen 2026" fehlt (node scripts/seed-demo-modules.mjs)');
const api = (path, init = {}) =>
	fetch(`${BASE}/api/v1/modules/actions/actions/${ACTION}/accounting${path}`, {
		...init,
		headers: { ...headers, ...(init.headers ?? {}), cookie }
	});

async function samplePdf(title) {
	const doc = await PDFDocument.create();
	const page = doc.addPage([420, 595]);
	const font = await doc.embedFont(StandardFonts.Helvetica);
	page.drawText('Quittung', { x: 40, y: 540, size: 24, font, color: rgb(0, 0, 0) });
	page.drawText(title, { x: 40, y: 500, size: 14, font });
	page.drawText('Beispielbeleg (Demo)', { x: 40, y: 470, size: 10, font });
	return Buffer.from(await doc.save());
}

// 8x8 graues PNG, groß skaliert dargestellt
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
	'base64'
);

const state = await (await api('')).json();
const expenses = state.data.entries.filter((e) => e.type === 'expense');
let i = 0;
for (const e of expenses) {
	const asPdf = i++ % 2 === 0;
	const form = new FormData();
	const bytes = asPdf ? await samplePdf(e.description) : PNG;
	form.set(
		'file',
		new Blob([bytes], { type: asPdf ? 'application/pdf' : 'image/png' }),
		asPdf ? 'beleg.pdf' : 'beleg.png'
	);
	const r = await api(`/entries/${e.id}/receipt`, { method: 'POST', body: form });
	console.log(e.description.slice(0, 30).padEnd(32), asPdf ? 'PDF' : 'PNG', r.status);
}

const report = await api('/report.pdf');
const buf = Buffer.from(await report.arrayBuffer());
writeFileSync('.data/demo-report.pdf', buf);
const pdf = await PDFDocument.load(buf);
console.log('Bericht', report.status, buf.length, 'Bytes,', pdf.getPageCount(), 'Seiten');
