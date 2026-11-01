/**
 * Modul `website` (Inhalte der Stammeswebsite): Banner, FAQ, Blog-Beiträge (Zugriff, Mitschreiben, Veröffentlichen,
 * Bilder, Bereinigung) und die Website-API (Scope `website.content.read`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { useTestDatabase } from '$testing';
import { fakeObjects, installFakeStorage, uninstallFakeStorage } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, deleteUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { core } from '$testing';
import membersModule from '$modules/members/module';
import websiteModule from '$modules/website/module';
import {
	websiteBannerSchema,
	websiteFaqSchema,
	websitePostPageSchema,
	websitePostSchema
} from '$modules/website/website.schemas';
import type {
	Banner,
	Faq,
	PostDetail,
	PostImage,
	PostListPage,
	WebsiteBanner,
	WebsiteFaq,
	WebsitePost,
	WebsitePostPage
} from '$modules/website/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules/website';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string; message: string; details?: unknown } };
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function raw(who: string, method: string, path: string, body?: BodyInit, json = false) {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json) headers.set('content-type', 'application/json');
	const url = new URL(`${ROOT}${path}`);
	return handleApiRequest({
		request: new Request(url, { method, headers, body }),
		url,
		ip: '127.0.0.1'
	});
}

async function call<T = unknown>(
	who: string,
	method: string,
	path: string,
	json?: unknown
): Promise<Res<T>> {
	const res = await raw(
		who,
		method,
		path,
		json === undefined ? undefined : JSON.stringify(json),
		json !== undefined
	);
	return { status: res.status, body: await res.json() };
}

function ok<T>(res: Res<T>, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

function fail(res: Res, status: number, code: string) {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	expect(res.body.error?.code).toBe(code);
}

async function jpeg(color: string, width = 800, height = 600): Promise<Uint8Array> {
	const buf = await sharp({ create: { width, height, channels: 3, background: color } })
		.jpeg()
		.withExif({ IFD0: { Make: 'TestCam' } })
		.toBuffer();
	return new Uint8Array(buf);
}

async function upload(who: string, postId: string, alt?: string): Promise<PostImage> {
	const fd = new FormData();
	fd.set(
		'file',
		new File([(await jpeg('#336699')) as BlobPart], 'foto.jpg', { type: 'image/jpeg' })
	);
	if (alt) fd.set('alt', alt);
	const res = await raw(who, 'POST', `/posts/${postId}/images`, fd);
	return ok<PostImage>({ status: res.status, body: await res.json() }, 201);
}

const ROLES: Record<string, string[]> = {
	editor: ['website.content.manage', 'core.api.manage'],
	writer: ['website.post.write', 'core.api.manage'],
	cowriter: ['website.post.write', 'core.api.manage'],
	stranger: ['website.post.write', 'core.api.manage'],
	publisher: ['website.post.write', 'website.post.publish', 'core.api.manage'],
	website: ['website.content.read', 'core.api.manage']
};
const NAMES: Record<string, string> = {
	editor: 'Erika Redakteurin',
	writer: 'Anna-Lena Schreiber',
	cowriter: 'Carl Mitschreiber',
	stranger: 'Sven Fremd',
	publisher: 'Paula Herausgeberin',
	website: 'Stammeswebsite'
};

beforeAll(async () => {
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	registerModule(websiteModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	await enableModule(admin, 'website');
	admin = await ctxOf(u!.id);
	for (const [name, perms] of Object.entries(ROLES)) {
		const roleId = await createRole(admin, { name: `role-${name}`, permissions: perms });
		userIds[name] = await createUser(admin, {
			name: NAMES[name]!,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleId]
		});
		const ctx = await ctxOf(userIds[name]!);
		const scopes = name === 'website' ? ['website.content.read'] : perms;
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes })).key;
	}
	await installFakeStorage(admin);
});

afterAll(() => uninstallFakeStorage());

describe('FAQ', () => {
	it('legt die bisherigen Fragen als Startdaten an', async () => {
		const faqs = ok<Faq[]>(await call('editor', 'GET', '/faqs'));
		expect(faqs.map((f) => f.question)).toEqual([
			'Wie alt muss ich sein?',
			'Was kostet das?',
			'Kann ich mir das mal anschauen?',
			'Was brauche ich?'
		]);
	});

	it('bereinigt Antworten, hängt neue ans Ende und sortiert um', async () => {
		const created = ok<Faq>(
			await call('editor', 'POST', '/faqs', {
				question: 'Gibt es Fahrten?',
				answerHtml:
					'<p onclick="x()">Ja, <a href="javascript:alert(1)">hier</a><script>bad()</script></p>',
				featured: false
			}),
			201
		);
		expect(created.answerHtml).not.toMatch(/script|onclick|javascript/);
		expect(created.position).toBe(5);
		const all = ok<Faq[]>(await call('editor', 'GET', '/faqs'));
		const ids = all.map((f) => f.id).reverse();
		const sorted = ok<Faq[]>(await call('editor', 'PUT', '/faqs/order', { ids }));
		expect(sorted[0]!.id).toBe(created.id);
		fail(
			await call('editor', 'PUT', '/faqs/order', { ids: ids.slice(1) }),
			422,
			'validation_failed'
		);
	});

	it('verlangt website.content.manage', async () => {
		fail(await call('writer', 'GET', '/faqs'), 403, 'forbidden');
	});
});

describe('Banner', () => {
	it('validiert Zeitfenster und Links', async () => {
		fail(
			await call('editor', 'POST', '/banners', {
				text: 'x',
				startsAt: '2026-08-02T10:00:00Z',
				endsAt: '2026-08-01T10:00:00Z'
			}),
			422,
			'validation_failed'
		);
		fail(
			await call('editor', 'POST', '/banners', { text: 'x', linkUrl: 'javascript:alert(1)' }),
			422,
			'validation_failed'
		);
	});

	it('liefert der Website nur laufende Banner', async () => {
		const live = ok<Banner>(
			await call('editor', 'POST', '/banners', {
				text: 'In den Ferien finden keine Gruppenstunden statt.',
				placement: 'home',
				linkUrl: '/termine',
				linkLabel: 'Termine'
			}),
			201
		);
		expect(live.state).toBe('live');
		const future = ok<Banner>(
			await call('editor', 'POST', '/banners', {
				text: 'Bald',
				startsAt: new Date(Date.now() + 86_400_000).toISOString()
			}),
			201
		);
		expect(future.state).toBe('scheduled');
		const off = ok<Banner>(
			await call('editor', 'POST', '/banners', { text: 'Aus', active: false }),
			201
		);
		expect(off.state).toBe('inactive');

		const site = ok<WebsiteBanner[]>(await call('website', 'GET', '/website/banners'));
		expect(site.map((b) => b.id)).toEqual([live.id]);
		websiteBannerSchema.array().parse(site);

		ok(await call('editor', 'DELETE', `/banners/${future.id}`));
		fail(await call('editor', 'DELETE', `/banners/${future.id}`), 404, 'not_found');
	});
});

describe('Beiträge', () => {
	let post: PostDetail;

	it('legt Entwürfe mit eindeutiger Adresse an', async () => {
		post = ok<PostDetail>(
			await call('writer', 'POST', '/posts', { title: 'Sommerlager an der Weser!' }),
			201
		);
		expect(post.slug).toBe('sommerlager-an-der-weser');
		expect(post.status).toBe('draft');
		expect(post.access).toMatchObject({ level: 'edit', isOwner: true, canPublish: false });
		const second = ok<PostDetail>(
			await call('writer', 'POST', '/posts', { title: 'Sommerlager an der Weser' }),
			201
		);
		expect(second.slug).toBe('sommerlager-an-der-weser-2');
		fail(
			await call('writer', 'PATCH', `/posts/${second.id}`, { slug: post.slug }),
			409,
			'conflict'
		);
		ok(await call('writer', 'DELETE', `/posts/${second.id}`));
	});

	it('zeigt fremde Beiträge nicht (404) – außer mit „veröffentlichen“', async () => {
		fail(await call('stranger', 'GET', `/posts/${post.id}`), 404, 'not_found');
		const list = ok<PostListPage>(await call('stranger', 'GET', '/posts'));
		expect(list.items.map((p) => p.id)).not.toContain(post.id);
		const pub = ok<PostDetail>(await call('publisher', 'GET', `/posts/${post.id}`));
		expect(pub.access.canPublish).toBe(true);
		expect(pub.authorName).toBe('Anna-Lena Schreiber');
	});

	it('erlaubt Mitschreiben über Freigaben (nur Autor*in/Veröffentlichende ändern sie)', async () => {
		ok(
			await call('writer', 'PUT', `/posts/${post.id}/shares`, {
				shares: [{ type: 'user', id: userIds.cowriter, level: 'edit' }]
			})
		);
		const co = ok<PostDetail>(
			await call('cowriter', 'PATCH', `/posts/${post.id}`, { teaser: 'Zehn Tage Zelte' })
		);
		expect(co.teaser).toBe('Zehn Tage Zelte');
		expect(co.access.isOwner).toBe(false);
		fail(
			await call('cowriter', 'PUT', `/posts/${post.id}/shares`, { shares: [] }),
			403,
			'forbidden'
		);
	});

	it('bereinigt den Text, nimmt nur eigene Bilder und löscht unbenutzte', async () => {
		const img = await upload('writer', post.id, 'Zelte am Ufer');
		const unused = await upload('writer', post.id);
		expect(img.width).toBeLessThanOrEqual(1600);
		const foreign = crypto.randomUUID();
		const saved = ok<PostDetail>(
			await call('writer', 'PATCH', `/posts/${post.id}`, {
				bodyHtml:
					`<p>Hallo <strong>Welt</strong><img src="x" onerror="alert(1)"></p>` +
					`<img data-image-id="${img.id}" alt="Zelte" src="https://evil.example/a.png">` +
					`<img data-image-id="${foreign}" alt="fremd">`,
				coverImageId: img.id,
				tags: ['Lager', 'lager', 'Sommer'],
				groupIds: [crypto.randomUUID()]
			})
		);
		expect(saved.bodyHtml).toContain(`<img data-image-id="${img.id}" alt="Zelte" />`);
		expect(saved.bodyHtml).not.toMatch(/onerror|evil|src=|alert/);
		expect(saved.bodyHtml).not.toContain(foreign);
		expect(saved.tags).toEqual(['Lager', 'Sommer']);
		expect(saved.images.map((i) => i.id)).toEqual([img.id]);
		expect(saved.coverImageId).toBe(img.id);
		expect([...fakeObjects.keys()].some((k) => k.includes(unused.id))).toBe(false);
		fail(
			await call('writer', 'PATCH', `/posts/${post.id}`, { coverImageId: foreign }),
			422,
			'validation_failed'
		);
	});

	it('veröffentlicht nur mit Recht; geplante Beiträge erscheinen erst später', async () => {
		fail(await call('writer', 'POST', `/posts/${post.id}/publish`, {}), 403, 'forbidden');
		const future = new Date(Date.now() + 3_600_000).toISOString();
		const planned = ok<PostDetail>(
			await call('publisher', 'POST', `/posts/${post.id}/publish`, { publishedAt: future }),
			201
		);
		expect(planned.status).toBe('published');
		expect(planned.live).toBe(false);
		let page = ok<WebsitePostPage>(await call('website', 'GET', '/website/posts'));
		expect(page.total).toBe(0);
		fail(await call('website', 'GET', `/website/posts/${post.slug}`), 404, 'not_found');

		ok(await call('publisher', 'POST', `/posts/${post.id}/publish`, {}), 201);
		page = ok<WebsitePostPage>(await call('website', 'GET', '/website/posts'));
		websitePostPageSchema.parse(page);
		expect(page.total).toBe(1);
		expect(page.items[0]).toMatchObject({ slug: post.slug, authorName: 'Anna-Lena' });
		expect(page.tags).toEqual([
			{ tag: 'Lager', count: 1 },
			{ tag: 'Sommer', count: 1 }
		]);
		expect(
			ok<WebsitePostPage>(await call('website', 'GET', '/website/posts?tag=lager')).total
		).toBe(1);
		expect(
			ok<WebsitePostPage>(await call('website', 'GET', '/website/posts?tag=winter')).total
		).toBe(0);

		const detail = ok<WebsitePost>(await call('website', 'GET', `/website/posts/${post.slug}`));
		websitePostSchema.parse(detail);
		expect(detail.cover?.alt).toBe('Zelte am Ufer');
		const imgRes = await raw(
			'website',
			'GET',
			`/website/posts/${post.slug}/images/${detail.cover!.id}/thumb`
		);
		expect(imgRes.status).toBe(200);
		expect(imgRes.headers.get('content-type')).toBe('image/webp');
	});

	it('Autor*innen löschen nur eigene Entwürfe', async () => {
		fail(await call('writer', 'DELETE', `/posts/${post.id}`), 403, 'forbidden');
		ok(await call('publisher', 'POST', `/posts/${post.id}/unpublish`), 201);
		fail(await call('website', 'GET', `/website/posts/${post.slug}`), 404, 'not_found');
	});

	it('der Website-Key erreicht nur die Website-Endpunkte', async () => {
		fail(await call('website', 'GET', '/posts'), 403, 'forbidden');
		fail(await call('website', 'GET', '/banners'), 403, 'forbidden');
		websiteFaqSchema.array().parse(ok<WebsiteFaq[]>(await call('website', 'GET', '/website/faqs')));
	});

	it('Audit ohne Texte', async () => {
		const rows = await getDb()
			.select()
			.from(schema.auditLog)
			.where(sql`${schema.auditLog.action} LIKE 'website.%'`);
		expect(rows.length).toBeGreaterThan(5);
		const dump = JSON.stringify(rows.map((r) => r.metadata));
		expect(dump).not.toMatch(/Sommerlager|Zelte|Ferien/);
	});

	it('Konto löschen: Beitrag bleibt ohne Autor*in, Freigabe entfällt', async () => {
		await deleteUser(admin, userIds.cowriter!);
		const shares = await core.database
			.forModule('website')
			.transaction((tx) => tx.execute(sql`SELECT count(*)::int AS n FROM post_shares`));
		expect(Number((shares as unknown as { rows: { n: number }[] }).rows[0]!.n)).toBe(0);
		await deleteUser(admin, userIds.writer!);
		const left = ok<PostDetail>(await call('publisher', 'GET', `/posts/${post.id}`));
		expect(left.authorId).toBeNull();
	});

	it('Modul deaktiviert → 404', async () => {
		await disableModule(admin, 'website');
		const res = await call('website', 'GET', '/website/faqs');
		expect(res.status).toBe(404);
		await enableModule(admin, 'website');
	});
});
