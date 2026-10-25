// Posteingang der Demo (Modul Nachrichten): richtet GreenMail (docker-compose.demo.yml, IMAP 127.0.0.1:1143)
// als Catch-all-Postfach ein, legt Beispiel-Mails an die vorhandenen Postfächer per IMAP-APPEND ab und
// ruft sie einmal ab. Voraussetzung: Demo-Server läuft (http://localhost:4300), Modul Nachrichten aktiv.
// Idempotent bis auf die Beispiel-Mails (jeder Lauf legt neue an).
import { ImapFlow } from 'imapflow';

const BASE = 'http://127.0.0.1:4300';
const headers = { origin: 'http://localhost:4300', 'content-type': 'application/json' };

const login = await fetch(`${BASE}/api/auth/sign-in/email`, {
	method: 'POST',
	headers,
	body: JSON.stringify({ email: 'admin@demo.test', password: 'Demo-Admin-2026!' })
});
if (!login.ok) throw new Error(`Login fehlgeschlagen (${login.status})`);
const cookie = login.headers
	.getSetCookie()
	.map((c) => c.split(';')[0])
	.join('; ');
const api = async (path, init = {}) => {
	const res = await fetch(`${BASE}/api/v1${path}`, {
		...init,
		headers: { ...headers, cookie, ...(init.headers ?? {}) }
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
	return body.data;
};

// Domain der persönlichen Adressen nur setzen, wenn noch keine eingetragen ist
const current = await api('/settings?group=messages');
const list = Array.isArray(current) ? current : (current?.settings ?? []);
let domain = list.find((s) => s.key === 'messages.domain')?.value;
if (!domain) {
	domain = 'demo.test';
	await api('/settings', {
		method: 'PUT',
		body: JSON.stringify({ values: { 'messages.domain': domain } })
	});
}
await api('/settings', {
	method: 'PUT',
	body: JSON.stringify({
		values: {
			'messages.imap.enabled': true,
			'messages.imap.host': '127.0.0.1',
			'messages.imap.port': 1143,
			'messages.imap.secure': false,
			'messages.imap.user': 'catchall@demo.test',
			'messages.imap.password': 'demo',
			'messages.imap.folder': 'INBOX',
			'messages.imap.processedFolder': 'Importiert'
		}
	})
});
console.log(`IMAP-Einstellungen gespeichert (Domain ${domain}).`);

const targets = await api('/modules/messages/mailboxes/all');
console.log(`${targets.length} Postfächer gefunden.`);

const client = new ImapFlow({
	host: '127.0.0.1',
	port: 1143,
	secure: false,
	auth: { user: 'catchall@demo.test', pass: 'demo' },
	logger: false
});
await client.connect();

let n = 0;
const date = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toUTCString();
function plain({ from, to, subject, text, minutesAgo = 5, extra = [] }) {
	return [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`Date: ${date(minutesAgo)}`,
		`Message-ID: <demo-${Date.now()}-${++n}@extern.example>`,
		...extra,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: 8bit',
		'',
		text,
		''
	].join('\r\n');
}
function html({ from, to, subject, body, minutesAgo = 5, attachment }) {
	const b = `b-${Date.now()}-${n}`;
	const parts = [
		`--${b}`,
		'Content-Type: text/html; charset=utf-8',
		'Content-Transfer-Encoding: 8bit',
		'',
		body
	];
	if (attachment) {
		parts.push(
			`--${b}`,
			`Content-Type: ${attachment.type}; name="${attachment.name}"`,
			'Content-Transfer-Encoding: base64',
			`Content-Disposition: attachment; filename="${attachment.name}"`,
			'',
			Buffer.from(attachment.content).toString('base64')
		);
	}
	parts.push(`--${b}--`, '');
	return [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`Date: ${date(minutesAgo)}`,
		`Message-ID: <demo-${Date.now()}-${++n}@extern.example>`,
		'MIME-Version: 1.0',
		`Content-Type: multipart/mixed; boundary="${b}"`,
		'',
		...parts
	].join('\r\n');
}

const mails = [];
for (const [i, t] of targets.slice(0, 6).entries()) {
	mails.push(
		plain({
			from: 'Petra Schneider <petra.schneider@extern.example>',
			to: t.address,
			subject: i === 0 ? 'Frage zur Herbstfahrt' : `Anfrage an ${t.name}`,
			text: `Hallo,\n\nich habe eine Frage zur Anmeldung: Bis wann muss der Beitrag überwiesen sein?\n\nViele Grüße\nPetra Schneider`,
			minutesAgo: 30 + i * 7
		})
	);
}
const first = targets[0];
if (first) {
	mails.push(
		html({
			from: 'Zeltverleih Nord <info@zeltverleih.example>',
			to: first.address,
			subject: 'Angebot Zeltmiete Pfingsten',
			body: '<h2>Ihr Angebot</h2><p>Vielen Dank für Ihre Anfrage. Im Anhang finden Sie unser <strong>Angebot</strong>.</p><table border="1" cellpadding="4"><tr><th>Posten</th><th>Preis</th></tr><tr><td>Jurte 6 m</td><td>120,00 €</td></tr><tr><td>Kohte</td><td>45,00 €</td></tr></table><p><img src="https://tracker.example/pixel.gif" alt=""></p><p><a href="https://zeltverleih.example">zeltverleih.example</a></p>',
			minutesAgo: 3,
			attachment: {
				name: 'Angebot-Pfingsten.pdf',
				type: 'application/pdf',
				content: '%PDF-1.4\n% Demo\n'
			}
		})
	);
}
mails.push(
	plain({
		from: 'Unbekannt <irgendwer@extern.example>',
		to: `unbekannt@${domain}`,
		subject: 'Irrläufer an eine unbekannte Adresse',
		text: 'Diese Mail ging an eine Adresse, die es nicht gibt.',
		minutesAgo: 60
	})
);

for (const raw of mails) await client.append('INBOX', raw);
await client.logout();
console.log(`${mails.length} Beispiel-Mails ins Catch-all-Postfach gelegt.`);

const result = await api('/modules/messages/inbox/poll', { method: 'POST' });
console.log('Abruf:', result.message);
