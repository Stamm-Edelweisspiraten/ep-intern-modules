import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { setMailTransportForTests } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { runJobNow } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import { sendRun, waitForAnnualSends } from '$modules/treasury/annual-fee.service';
import type { RequestContext } from '$lib/sdk/types';
import type {
	AnnualMailPreview,
	AnnualPreview,
	AnnualRun,
	AnnualSendResult,
	InvoiceDetail,
	InvoiceList,
	Payer
} from '$modules/treasury/schemas';

let admin: RequestContext;
let close: () => Promise<void>;
const keys: Record<string, string> = {};
type Mail = {
	to: string;
	subject: string;
	text: string;
	attachments?: { filename: string; contentType?: string }[];
};
const mails: Mail[] = [];
let lastHtml = '';

function api(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
	const { token, json, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (token) headers.set('authorization', `Bearer ${token}`);
	if (json !== undefined) {
		rest.body = JSON.stringify(json);
		headers.set('content-type', 'application/json');
	}
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	return handleApiRequest({
		request: new Request(url, { ...rest, headers }),
		url,
		ip: '127.0.0.1'
	});
}
const T = (path: string, init: Parameters<typeof api>[1] = {}, who = 'kasse') =>
	api(`/modules/treasury${path}`, { token: keys[who], ...init });

async function data<D>(res: Response, status = 200): Promise<D> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as D;
}

/**
 * Versand läuft im Hintergrund (#24): POST → 202 mit Startstand, danach auf den Abschluss warten
 * und die Zähler aus `lastResult` lesen.
 */
async function sendAndWait(path: string): Promise<AnnualSendResult> {
	const started = await data<AnnualSendResult>(await T(path, { method: 'POST' }), 202);
	expect(started.sending).toBe(true);
	await waitForAnnualSends();
	const runId = path.split('/')[2]!;
	const r = (await data<AnnualRun>(await T(`/annual-fees/${runId}`))).lastResult!;
	expect(r.sending).toBe(false);
	return {
		invoicesCreated: r.invoicesCreated,
		mailsSent: r.mailsSent,
		mailErrors: r.mailErrors,
		withoutAddress: r.withoutAddress
	};
}

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

async function member(json: Record<string, unknown>): Promise<string> {
	return (
		await data<{ id: string }>(
			await api('/modules/members/members', {
				token: keys.kasse,
				method: 'POST',
				json: {
					birthDate: '2014-05-01',
					street: 'Lindenweg 4',
					postalCode: '28195',
					city: 'Bremen',
					stage: 'woelfling',
					...json
				}
			}),
			201
		)
	).id;
}

const ids: Record<string, string> = {};
let run: AnnualRun;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(treasuryModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
	admin = await ctxOf(u!.id);
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m as Mail) });
	setPdfRendererForTests(async (html) => {
		lastHtml = html;
		return new TextEncoder().encode('%PDF-fake');
	});
	setTodayForTests('2026-10-16');
	await core.settings.set(admin, 'treasury.bank.holder', 'Stamm Test');
	await core.settings.set(admin, 'treasury.bank.iban', 'DE89370400440532013000');

	const all = [...admin.permissions].filter((p) => /^(treasury|members|actions)\./.test(p));
	const roles = {
		kasse: await createRole(admin, { name: 'Kasse', permissions: ['core.api.manage', ...all] }),
		lesen: await createRole(admin, {
			name: 'Lesen',
			permissions: ['core.api.manage', 'treasury.cash.view', 'treasury.annual-fee.view']
		}),
		ohne: await createRole(admin, {
			name: 'Ohne',
			permissions: ['core.api.manage', 'treasury.cash.view']
		}),
		nurJahr: await createRole(admin, {
			name: 'NurJahr',
			permissions: ['core.api.manage', 'treasury.annual-fee.view']
		}),
		ohneSend: await createRole(admin, {
			name: 'Ohne Versand',
			permissions: ['core.api.manage', ...all.filter((p) => p !== 'treasury.invoice.send')]
		})
	};
	for (const [name, role] of Object.entries(roles)) {
		const id = await createUser(admin, {
			name,
			email: `${name.toLowerCase()}@example.test`,
			password: 'correct-horse-battery',
			roleIds: [role]
		});
		const ctx = await ctxOf(id);
		keys[name] = (await createApiKey(ctx, { name: 't', scopes: [...ctx.permissions] })).key;
	}

	ids.max = await member({
		firstName: 'Max',
		lastName: 'Muster',
		entryDate: '2020-01-01',
		emails: [{ name: 'Eltern', value: 'familie.muster@example.test' }]
	});
	ids.lena = await member({
		firstName: 'Lena',
		lastName: 'Muster',
		emails: [{ name: 'Eltern', value: 'familie.muster@example.test' }]
	});
	ids.tom = await member({
		firstName: 'Tom',
		lastName: 'Solo',
		birthDate: '1990-01-01',
		emails: [{ name: 'Tom', value: 'tom.solo@example.test' }]
	});
	ids.ex = await member({ firstName: 'Erik', lastName: 'Ex', exitDate: '2026-09-01' });
	// Am Stichtag (2026-10-16) noch Mitglied, aber vor dem Beitragsjahr 2027 ausgetreten
	ids.ende = await member({ firstName: 'Ute', lastName: 'Ende', exitDate: '2027-01-01' });
	ids.zweit = await member({
		firstName: 'Zoe',
		lastName: 'Zweit',
		secondaryMember: true,
		feeLevels: ['stamm'],
		emails: [{ name: 'Zoe', value: 'zoe@example.test' }]
	});
	await data<Payer>(
		await T('/payers', {
			method: 'POST',
			json: {
				name: 'Familie Muster',
				email: 'familie.muster@example.test',
				memberIds: [ids.max, ids.lena]
			}
		}),
		201
	);
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	setPdfRendererForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('Jahresbeitrag', () => {
	it('legt einen Lauf an (Stichtag heute, Frist 31.03., Sätze aus den Einstellungen); 409 bei gleichem Jahr', async () => {
		run = await data<AnnualRun>(
			await T('/annual-fees', { method: 'POST', json: { year: 2027 } }),
			201
		);
		expect(run).toMatchObject({
			year: 2027,
			createdOn: '2026-10-16',
			dueOn: '2027-03-31',
			status: 'draft',
			rates: { stamm: 1200, gau: 800, landesmark: 200, bund: 2500 },
			invoiceCount: 0
		});
		expect((await T('/annual-fees', { method: 'POST', json: { year: 2027 } })).status).toBe(409);
		const list = await data<AnnualRun[]>(await T('/annual-fees'));
		expect(list.map((r) => r.id)).toEqual([run.id]);
	});

	it('Vorschau: Sammelrechnung je Familie, Austritt ausgenommen, Zweitmitglied nur Stamm', async () => {
		const p = await data<AnnualPreview>(await T(`/annual-fees/${run.id}/preview`));
		expect(p.mode).toBe('run');
		expect(p.invoices.map((i) => [i.recipientName, i.totalCents])).toEqual([
			['Familie Muster', 9400],
			['Tom Solo', 4700],
			['Zoe Zweit', 1200]
		]);
		expect(p.totalCents).toBe(15300);
		expect(p.memberCount).toBe(4);
		expect(p.invoices[2]!.members[0]).toMatchObject({ levels: ['stamm'], note: 'secondary' });
		expect(p.invoices.flatMap((i) => i.members.map((m) => m.memberId))).not.toContain(ids.ex);
		// Austritt am 01.01. des Beitragsjahres → kein Beitrag, obwohl am Stichtag Mitglied
		expect(p.invoices.flatMap((i) => i.members.map((m) => m.memberId))).not.toContain(ids.ende);
		// Kasse mit invoice.send sieht Adressen
		expect(p.invoices[0]!.emails).toEqual(['familie.muster@example.test']);
	});

	it('Vorschau ohne invoice.send/edit: keine Adressen, nur Anzahl; ohne cash.view 403', async () => {
		const p = await data<AnnualPreview & { invoices: { emailCount: number }[] }>(
			await T(`/annual-fees/${run.id}/preview`, {}, 'lesen')
		);
		expect(p.invoices.every((i) => i.emails.length === 0)).toBe(true);
		expect(p.invoices[0]!.emailCount).toBe(1);
		const mail = await data<AnnualMailPreview>(
			await T(`/annual-fees/${run.id}/preview-mail`, {}, 'lesen')
		);
		expect(mail.to).toEqual([]);
		for (const path of ['', `/${run.id}`, `/${run.id}/preview`, `/${run.id}/preview-mail`]) {
			expect((await T(`/annual-fees${path}`, {}, 'nurJahr')).status).toBe(403);
		}
		expect((await T(`/annual-fees/${run.id}/preview.pdf`, {}, 'nurJahr')).status).toBe(403);
	});

	it('PDF- und Mail-Vorschau ohne Speichern', async () => {
		const p = await data<AnnualPreview>(await T(`/annual-fees/${run.id}/preview`));
		const key = p.invoices[0]!.key;
		const res = await T(`/annual-fees/${run.id}/preview.pdf?key=${encodeURIComponent(key)}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		expect(lastHtml).toContain('Landesmark');
		expect(lastHtml).toContain('Lena Muster');
		expect(lastHtml).toContain('2027');
		expect(lastHtml).toContain('Vorschau');
		const mail = await data<AnnualMailPreview>(
			await T(`/annual-fees/${run.id}/preview-mail?key=${encodeURIComponent(key)}`)
		);
		expect(mail.to).toEqual(['familie.muster@example.test']);
		expect(mail.subject).toContain('Jahresbeitrag 2027');
		expect(mail.text).toContain('Lena und Max');
		expect(mail.html).toContain('Zahlungsinformationen');
		expect((await T(`/annual-fees/${run.id}/preview-mail?key=payer:unbekannt`)).status).toBe(404);
		const inv = await data<InvoiceList>(await T('/invoices?source=annual'));
		expect(inv.total).toBe(0);
	});

	it('Rechte: ohne view 403, view ohne manage 403 auf POST, ohne invoice.send 403 beim Versand', async () => {
		expect((await T('/annual-fees', {}, 'ohne')).status).toBe(403);
		expect((await T(`/annual-fees/${run.id}/preview`, {}, 'lesen')).status).toBe(200);
		expect(
			(await T('/annual-fees', { method: 'POST', json: { year: 2030 } }, 'lesen')).status
		).toBe(403);
		expect((await T(`/annual-fees/${run.id}/send`, { method: 'POST' }, 'lesen')).status).toBe(403);
		expect((await T(`/annual-fees/${run.id}/send`, { method: 'POST' }, 'ohneSend')).status).toBe(
			403
		);
		for (const action of ['unschedule', 'catch-up', 'resend']) {
			expect(
				(await T(`/annual-fees/${run.id}/${action}`, { method: 'POST' }, 'ohneSend')).status
			).toBe(403);
		}
	});

	it('gleichzeitiges Anlegen desselben Jahres: genau einmal 201, sonst 409', async () => {
		const res = await Promise.all([
			T('/annual-fees', { method: 'POST', json: { year: 2031 } }),
			T('/annual-fees', { method: 'POST', json: { year: 2031 } })
		]);
		expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
		const created = (await res.find((r) => r.status === 201)!.json()).data as AnnualRun;
		expect((await T(`/annual-fees/${created.id}`, { method: 'DELETE' })).status).toBe(200);
	});

	it('ändert Texte und Sätze nur im Entwurf', async () => {
		const upd = await data<AnnualRun>(
			await T(`/annual-fees/${run.id}`, {
				method: 'PUT',
				json: { mailSubject: 'Jahresbeitrag {jahr}: {rechnungen}', dueOn: '2027-03-15' }
			})
		);
		expect(upd.dueOn).toBe('2027-03-15');
		expect(
			(await T(`/annual-fees/${run.id}`, { method: 'PUT', json: { dueOn: '2026-01-01' } })).status
		).toBe(422);
	});

	it('versendet: Rechnungen + Posten + Mails mit PDF; zweiter Versand 409', async () => {
		mails.length = 0;
		const res = await sendAndWait(`/annual-fees/${run.id}/send`);
		expect(res).toEqual({ invoicesCreated: 3, mailsSent: 3, mailErrors: 0, withoutAddress: 0 });
		expect(mails.map((m) => m.to).sort()).toEqual([
			'familie.muster@example.test',
			'tom.solo@example.test',
			'zoe@example.test'
		]);
		for (const m of mails) {
			expect(m.subject).toMatch(/^Jahresbeitrag 2027: R-2026-\d{4}$/);
			expect(m.attachments?.find((a) => a.filename.endsWith('.pdf'))?.filename).toMatch(
				/^Rechnung-R-2026-\d{4}\.pdf$/
			);
		}
		// Volljährige: kein „für <Name>“; Kinder: Hinweis bleibt
		const adultMail = mails.find((m) => m.to === 'tom.solo@example.test')!;
		expect(adultMail.text).toContain('der Jahresbeitrag 2027 ist fällig');
		expect(adultMail.text).not.toContain('für Tom');
		const kidMail = mails.find((m) => m.to === 'zoe@example.test')!;
		expect(kidMail.text).toContain('für Zoe');
		const list = await data<InvoiceList>(await T('/invoices?source=annual'));
		expect(list.total).toBe(3);
		expect(list.totals.totalCents).toBe(15300);
		const fam = list.items.find((i) => i.recipientName === 'Familie Muster')!;
		expect(fam.dueOn).toBe('2027-03-15');
		expect(fam.payer?.name).toBe('Familie Muster');
		const detail = await data<InvoiceDetail>(await T(`/invoices/${fam.id}`));
		// Ein offener Posten mit der Gesamtsumme (2 × 94 € = 94 € je Kind-Paar → 9400 ct)
		expect(detail.lines).toHaveLength(1);
		expect(detail.lines[0]!.description).toBe('Jahresbeitrag 2027 – Stammesbeitrag');
		expect(detail.lines[0]!.amountCents).toBe(9400);
		expect(detail.documents).toHaveLength(1);
		expect(detail.documents[0]!.reason).toBe('annual');
		// Rechnungs-PDF aus dem Snapshot enthält die Ebenen-Tabelle
		expect((await T(`/invoices/${fam.id}/pdf`)).status).toBe(200);
		expect(lastHtml).toContain('Landesmark');

		const after = await data<AnnualRun>(await T(`/annual-fees/${run.id}`));
		expect(after.status).toBe('sent');
		expect(after.invoiceCount).toBe(3);
		expect(after.lastResult?.invoicesCreated).toBe(3);
		expect((await T(`/annual-fees/${run.id}/send`, { method: 'POST' })).status).toBe(409);
		expect((await T(`/annual-fees/${run.id}`, { method: 'PUT', json: {} })).status).toBe(409);
		expect((await T(`/annual-fees/${run.id}`, { method: 'DELETE' })).status).toBe(409);
	});

	it('Abgleich mit Aktionen lässt Jahresbeitrags-Rechnungen in Ruhe', async () => {
		await data(await T('/sync', { method: 'POST' }), 201);
		const list = await data<InvoiceList>(await T('/invoices?source=annual'));
		expect(list.items.every((i) => i.status === 'open')).toBe(true);
		expect(list.total).toBe(3);
	});

	it('Nachberechnung: Eintritt am 01.05. → nur Stamm (12 €), danach nichts mehr offen', async () => {
		ids.paul = await member({
			firstName: 'Paul',
			lastName: 'Neu',
			entryDate: '2027-05-01',
			emails: [{ name: 'Paul', value: 'paul@example.test' }]
		});
		setTodayForTests('2027-05-02');
		const p = await data<AnnualPreview>(await T(`/annual-fees/${run.id}/preview`));
		expect(p.mode).toBe('catch-up');
		expect(p.invoices.map((i) => [i.recipientName, i.totalCents])).toEqual([['Paul Neu', 1200]]);
		expect(p.invoices[0]!.members[0]!.note).toBe('late-entry');
		mails.length = 0;
		// PDF-Erzeugung schlägt fehl: Rechnung bleibt gespeichert, Fehler wird gezählt
		setPdfRendererForTests(async () => {
			throw new Error('PDF kaputt');
		});
		const res = await sendAndWait(`/annual-fees/${run.id}/catch-up`);
		expect(res).toEqual({ invoicesCreated: 1, mailsSent: 0, mailErrors: 1, withoutAddress: 0 });
		expect(mails).toEqual([]);
		setPdfRendererForTests(async (html) => {
			lastHtml = html;
			return new TextEncoder().encode('%PDF-fake');
		});
		// SMTP fällt aus: Wiederholung zählt Mailfehler, legt keine Rechnung an
		setMailTransportForTests({
			sendMail: async () => {
				throw new Error('SMTP weg');
			}
		});
		const failed = await sendAndWait(`/annual-fees/${run.id}/resend`);
		expect(failed).toEqual({ invoicesCreated: 0, mailsSent: 0, mailErrors: 1, withoutAddress: 0 });
		setMailTransportForTests({ sendMail: async (m) => void mails.push(m as Mail) });
		const retried = await sendAndWait(`/annual-fees/${run.id}/resend`);
		expect(retried).toEqual({ invoicesCreated: 0, mailsSent: 1, mailErrors: 0, withoutAddress: 0 });
		expect(mails.map((m) => m.to)).toEqual(['paul@example.test']);
		// Alles zugestellt → Wiederholung sendet nichts mehr
		expect((await sendAndWait(`/annual-fees/${run.id}/resend`)).mailsSent).toBe(0);
		const again = await sendAndWait(`/annual-fees/${run.id}/catch-up`);
		expect(again.invoicesCreated).toBe(0);
		const list = await data<InvoiceList>(await T('/invoices?source=annual'));
		const paul = list.items.find((i) => i.recipientName === 'Paul Neu')!;
		// Frist des Laufs (15.03.) lag in der Vergangenheit → heute + Mindestfrist (14 Tage)
		expect(paul.dueOn).toBe('2027-05-16');
		expect(paul.totalCents).toBe(1200);
	});

	it('geplanter Versand: Job versendet erst am Datum', async () => {
		setTodayForTests('2027-05-02');
		const r = await data<AnnualRun>(
			await T('/annual-fees', { method: 'POST', json: { year: 2028 } }),
			201
		);
		expect(r.createdOn).toBe('2027-05-02');
		expect(r.dueOn).toBe('2028-03-31');
		expect(
			(await T(`/annual-fees/${r.id}/schedule`, { method: 'POST', json: { sendOn: '2027-05-01' } }))
				.status
		).toBe(422);
		const s = await data<AnnualRun>(
			await T(`/annual-fees/${r.id}/schedule`, { method: 'POST', json: { sendOn: '2027-05-10' } }),
			201
		);
		expect(s).toMatchObject({ status: 'scheduled', sendOn: '2027-05-10' });
		await runJobNow(admin, 'treasury.annual-fees');
		expect((await data<AnnualRun>(await T(`/annual-fees/${r.id}`))).status).toBe('scheduled');
		setTodayForTests('2027-05-10');
		mails.length = 0;
		await runJobNow(admin, 'treasury.annual-fees');
		const done = await data<AnnualRun>(await T(`/annual-fees/${r.id}`));
		expect(done.status).toBe('sent');
		// Max, Lena, Tom, Zoe, Paul (Eintritt vor Stichtag 2027-05-02 → voll für 2028); Ute ausgetreten
		expect(done.invoiceCount).toBe(4);
		expect(mails.length).toBe(4);
	});

	it('Entwurf löschen, unschedule zurück auf Entwurf', async () => {
		const r = await data<AnnualRun>(
			await T('/annual-fees', { method: 'POST', json: { year: 2029 } }),
			201
		);
		await data(
			await T(`/annual-fees/${r.id}/schedule`, { method: 'POST', json: { sendOn: '2027-06-01' } }),
			201
		);
		// Inhalt eines geplanten Laufs ändern → Planung zurückgenommen (Versand neu freigeben)
		const changed = await data<AnnualRun>(
			await T(`/annual-fees/${r.id}`, { method: 'PUT', json: { pdfText: 'Neuer Text {jahr}' } })
		);
		expect(changed).toMatchObject({ status: 'draft', sendOn: null });
		await data(
			await T(`/annual-fees/${r.id}/schedule`, { method: 'POST', json: { sendOn: '2027-06-01' } }),
			201
		);
		// Job darf nur geplante, fällige Läufe versenden (Prüfung unter Sperre)
		expect(await sendRun(admin, r.id, 'run', { scheduledOnly: true })).toBeNull();
		const u = await data<AnnualRun>(
			await T(`/annual-fees/${r.id}/unschedule`, { method: 'POST' }),
			201
		);
		expect(u).toMatchObject({ status: 'draft', sendOn: null });
		setTodayForTests('2027-06-01');
		expect(await sendRun(admin, r.id, 'run', { scheduledOnly: true })).toBeNull();
		expect((await data<AnnualRun>(await T(`/annual-fees/${r.id}`))).status).toBe('draft');
		expect((await T(`/annual-fees/${r.id}`, { method: 'DELETE' })).status).toBe(200);
		expect((await T(`/annual-fees/${r.id}`)).status).toBe(404);
	});

	it('Hintergrundversand (#24): 202 sofort, Fortschritt im Lauf, Doppelklick/Nachberechnung 409', async () => {
		const r = await data<AnnualRun>(
			await T('/annual-fees', { method: 'POST', json: { year: 2030 } }),
			201
		);
		// PDF-Erzeugung hängt, bis der Test sie freigibt
		let releasePdf!: () => void;
		const pdfGate = new Promise<void>((res) => (releasePdf = res));
		setPdfRendererForTests(async (html) => {
			await pdfGate;
			lastHtml = html;
			return new TextEncoder().encode('%PDF-fake');
		});
		mails.length = 0;
		try {
			const t0 = Date.now();
			const res = await T(`/annual-fees/${r.id}/send`, { method: 'POST' });
			expect(Date.now() - t0).toBeLessThan(2000);
			const started = await data<AnnualSendResult>(res, 202);
			expect(started).toMatchObject({ sending: true, kind: 'run', processed: 0, mailsSent: 0 });
			expect(started.total).toBe(started.invoicesCreated);
			expect(started.total).toBeGreaterThan(0);
			// Rechnungen sind schon angelegt, Mails noch nicht
			const during = await data<AnnualRun>(await T(`/annual-fees/${r.id}`));
			expect(during.status).toBe('sent');
			expect(during.invoiceCount).toBe(started.invoicesCreated);
			expect(during.lastResult?.sending).toBe(true);
			expect(mails).toEqual([]);
			// Doppelklick und parallele Nachberechnung/Wiederholung → 409
			for (const path of ['send', 'catch-up', 'resend']) {
				const again = await T(`/annual-fees/${r.id}/${path}`, { method: 'POST' });
				expect(again.status, path).toBe(409);
			}
		} finally {
			releasePdf();
			await waitForAnnualSends();
			setPdfRendererForTests(async (html) => {
				lastHtml = html;
				return new TextEncoder().encode('%PDF-fake');
			});
		}
		const done = (await data<AnnualRun>(await T(`/annual-fees/${r.id}`))).lastResult!;
		expect(done).toMatchObject({ sending: false, kind: 'run', mailErrors: 0 });
		expect(done.processed).toBe(done.total);
		expect(done.mailsSent).toBe(mails.length);
		expect(done.mailsSent).toBeGreaterThan(0);
		// Nach dem Abschluss ist die Wiederholung wieder möglich (nichts offen)
		expect((await sendAndWait(`/annual-fees/${r.id}/resend`)).mailsSent).toBe(0);
	});

	it('Audit ohne personenbezogene Daten', async () => {
		const rows = await getDb().select().from(schema.auditLog);
		const annual = rows.filter((r) => r.action.startsWith('treasury.annual-fee.'));
		expect(new Set(annual.map((r) => r.action))).toEqual(
			new Set([
				'treasury.annual-fee.created',
				'treasury.annual-fee.updated',
				'treasury.annual-fee.sent',
				'treasury.annual-fee.catch-up',
				'treasury.annual-fee.resent',
				'treasury.annual-fee.scheduled',
				'treasury.annual-fee.deleted'
			])
		);
		const text = JSON.stringify(
			rows.filter((r) => r.action.startsWith('treasury.')).map((r) => r.metadata)
		);
		expect(text).not.toContain('@');
		expect(text).not.toContain('Muster');
	});

	it('Modul deaktiviert → 404', async () => {
		await disableModule(admin, 'treasury');
		expect((await T('/annual-fees')).status).toBe(404);
		await enableModule(admin, 'treasury');
	});
});
