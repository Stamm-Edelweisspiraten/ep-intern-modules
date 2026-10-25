/**
 * Banner/Hinweise und FAQ der Stammeswebsite (Recht `website.content.manage`). Neue Einträge am Ende,
 * Reihenfolge über `PUT …/order` (alle IDs genau einmal). Audit nur mit IDs/Zählern, ohne Texte.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	errors,
	rowsOf,
	sanitizeRichText,
	str,
	toIso,
	toIsoOrNull,
	type AnyApiEndpoint,
	type Row,
	type Tx
} from '$lib/sdk/server';
import { db } from './files';
import {
	MAX_BANNERS,
	MAX_FAQ_ANSWER,
	MAX_FAQS,
	PERM,
	bannerInput,
	bannerState,
	faqInput,
	idParams,
	orderInput,
	type Banner,
	type BannerLevel,
	type BannerPlacement,
	type Faq
} from './schemas';

const tags = ['Modul: website'];
const bool = (v: unknown) => v === true || v === 't';

export function toBanner(r: Row, now = Date.now()): Banner {
	const b = {
		id: String(r.id),
		title: str(r.title),
		text: String(r.text),
		level: String(r.level) as BannerLevel,
		placement: String(r.placement) as BannerPlacement,
		linkUrl: str(r.link_url),
		linkLabel: str(r.link_label),
		startsAt: toIsoOrNull(r.starts_at),
		endsAt: toIsoOrNull(r.ends_at),
		dismissible: bool(r.dismissible),
		active: bool(r.active),
		position: Number(r.position),
		createdAt: toIso(r.created_at),
		updatedAt: toIso(r.updated_at)
	};
	return { ...b, state: bannerState(b, now) };
}

export function toFaq(r: Row): Faq {
	return {
		id: String(r.id),
		question: String(r.question),
		answerHtml: String(r.answer_html ?? ''),
		featured: bool(r.featured),
		active: bool(r.active),
		position: Number(r.position),
		updatedAt: toIso(r.updated_at)
	};
}

/** Bereinigte FAQ-Antwort (ohne Bilder); zu lang nach der Bereinigung → 422 */
function cleanAnswer(html: string): string {
	const clean = sanitizeRichText(html);
	const textLength = clean.replace(/<[^>]*>/g, '').length;
	if (textLength > MAX_FAQ_ANSWER) {
		throw errors.validation([
			{ path: ['answerHtml'], message: `Höchstens ${MAX_FAQ_ANSWER} Zeichen` }
		]);
	}
	return clean;
}

async function lock(tx: Tx, name: string) {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`website:${name}`}))`);
}

async function nextPosition(tx: Tx, table: 'banners' | 'faqs', max: number): Promise<number> {
	await lock(tx, table);
	const [r] = await rowsOf(
		tx,
		sql`SELECT count(*)::int AS n, COALESCE(MAX(position), 0)::int AS p FROM ${sql.identifier(table)}`
	);
	if (Number(r?.n ?? 0) >= max) throw errors.conflict(`Höchstens ${max} Einträge`);
	return Number(r?.p ?? 0) + 1;
}

async function reorder(tx: Tx, table: 'banners' | 'faqs', ids: string[]) {
	await lock(tx, table);
	const rows = await rowsOf(tx, sql`SELECT id FROM ${sql.identifier(table)}`);
	const known = new Set(rows.map((r) => String(r.id)));
	const unique = new Set(ids);
	if (unique.size !== ids.length || ids.length !== known.size || ids.some((id) => !known.has(id))) {
		throw errors.validation([{ path: ['ids'], message: 'Alle Einträge genau einmal angeben' }]);
	}
	for (const [i, id] of ids.entries()) {
		await tx.execute(
			sql`UPDATE ${sql.identifier(table)} SET position = ${i + 1} WHERE id = ${id}`
		);
	}
}

const listBanners = (tx: Tx) =>
	rowsOf(tx, sql`SELECT * FROM banners ORDER BY position, created_at, id`);
const listFaqs = (tx: Tx) => rowsOf(tx, sql`SELECT * FROM faqs ORDER BY position, created_at, id`);

export const contentEndpoints: AnyApiEndpoint[] = [
	// --- Banner ---------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/banners',
		summary: 'Banner und Hinweise der Website (alle, mit Zustand)',
		tags,
		permission: PERM.contentManage,
		handler: async (): Promise<Banner[]> => {
			const rows = await db().transaction(listBanners);
			const now = Date.now();
			return rows.map((r) => toBanner(r, now));
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/banners/order',
		summary: 'Reihenfolge der Banner festlegen (alle IDs genau einmal)',
		tags,
		permission: PERM.contentManage,
		body: orderInput,
		handler: async ({ ctx, body }): Promise<Banner[]> => {
			const rows = await db().transaction(async (tx) => {
				await reorder(tx, 'banners', body.ids);
				return listBanners(tx);
			});
			await core.audit.logFromContext(ctx, 'website.banner.reordered', {
				metadata: { count: body.ids.length }
			});
			return rows.map((r) => toBanner(r));
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/banners',
		summary: 'Banner anlegen (am Ende der Liste)',
		tags,
		permission: PERM.contentManage,
		body: bannerInput,
		handler: async ({ ctx, body }): Promise<Banner> => {
			const id = crypto.randomUUID();
			const row = await db().transaction(async (tx) => {
				const position = await nextPosition(tx, 'banners', MAX_BANNERS);
				const [r] = await rowsOf(
					tx,
					sql`INSERT INTO banners (id, title, text, level, placement, link_url, link_label, starts_at,
							ends_at, dismissible, active, position, created_by)
						VALUES (${id}, ${body.title}, ${body.text}, ${body.level}, ${body.placement}, ${body.linkUrl},
							${body.linkLabel}, ${body.startsAt}, ${body.endsAt}, ${body.dismissible}, ${body.active},
							${position}, ${ctx.userId})
						RETURNING *`
				);
				return r!;
			});
			await core.audit.logFromContext(ctx, 'website.banner.created', {
				target: id,
				metadata: { placement: body.placement, level: body.level }
			});
			return toBanner(row);
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/banners/:id',
		summary: 'Banner ändern (alle Felder)',
		tags,
		permission: PERM.contentManage,
		params: idParams,
		body: bannerInput,
		handler: async ({ ctx, params, body }): Promise<Banner> => {
			const row = await db().transaction(async (tx) => {
				const [r] = await rowsOf(
					tx,
					sql`UPDATE banners SET title = ${body.title}, text = ${body.text}, level = ${body.level},
							placement = ${body.placement}, link_url = ${body.linkUrl}, link_label = ${body.linkLabel},
							starts_at = ${body.startsAt}, ends_at = ${body.endsAt}, dismissible = ${body.dismissible},
							active = ${body.active}, updated_at = now()
						WHERE id = ${params.id} RETURNING *`
				);
				if (!r) throw errors.notFound('Banner nicht gefunden');
				return r;
			});
			await core.audit.logFromContext(ctx, 'website.banner.updated', {
				target: params.id,
				metadata: { placement: body.placement, active: body.active }
			});
			return toBanner(row);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/banners/:id',
		summary: 'Banner löschen',
		tags,
		permission: PERM.contentManage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const deleted = await db().transaction(async (tx) => {
				const r = await rowsOf(tx, sql`DELETE FROM banners WHERE id = ${params.id} RETURNING id`);
				return r.length > 0;
			});
			if (!deleted) throw errors.notFound('Banner nicht gefunden');
			await core.audit.logFromContext(ctx, 'website.banner.deleted', { target: params.id });
			return { deleted: true };
		}
	}),

	// --- FAQ ------------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/faqs',
		summary: 'Häufige Fragen der Website (alle)',
		tags,
		permission: PERM.contentManage,
		handler: async (): Promise<Faq[]> => (await db().transaction(listFaqs)).map(toFaq)
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/faqs/order',
		summary: 'Reihenfolge der Fragen festlegen (alle IDs genau einmal)',
		tags,
		permission: PERM.contentManage,
		body: orderInput,
		handler: async ({ ctx, body }): Promise<Faq[]> => {
			const rows = await db().transaction(async (tx) => {
				await reorder(tx, 'faqs', body.ids);
				return listFaqs(tx);
			});
			await core.audit.logFromContext(ctx, 'website.faq.reordered', {
				metadata: { count: body.ids.length }
			});
			return rows.map(toFaq);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/faqs',
		summary: 'Frage anlegen (am Ende der Liste)',
		tags,
		permission: PERM.contentManage,
		body: faqInput,
		handler: async ({ ctx, body }): Promise<Faq> => {
			const id = crypto.randomUUID();
			const answer = cleanAnswer(body.answerHtml);
			const row = await db().transaction(async (tx) => {
				const position = await nextPosition(tx, 'faqs', MAX_FAQS);
				const [r] = await rowsOf(
					tx,
					sql`INSERT INTO faqs (id, question, answer_html, featured, active, position, created_by)
						VALUES (${id}, ${body.question}, ${answer}, ${body.featured}, ${body.active}, ${position},
							${ctx.userId})
						RETURNING *`
				);
				return r!;
			});
			await core.audit.logFromContext(ctx, 'website.faq.created', { target: id });
			return toFaq(row);
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/faqs/:id',
		summary: 'Frage ändern (alle Felder)',
		tags,
		permission: PERM.contentManage,
		params: idParams,
		body: faqInput,
		handler: async ({ ctx, params, body }): Promise<Faq> => {
			const answer = cleanAnswer(body.answerHtml);
			const row = await db().transaction(async (tx) => {
				const [r] = await rowsOf(
					tx,
					sql`UPDATE faqs SET question = ${body.question}, answer_html = ${answer},
							featured = ${body.featured}, active = ${body.active}, updated_at = now()
						WHERE id = ${params.id} RETURNING *`
				);
				if (!r) throw errors.notFound('Frage nicht gefunden');
				return r;
			});
			await core.audit.logFromContext(ctx, 'website.faq.updated', { target: params.id });
			return toFaq(row);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/faqs/:id',
		summary: 'Frage löschen',
		tags,
		permission: PERM.contentManage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const deleted = await db().transaction(async (tx) => {
				const r = await rowsOf(tx, sql`DELETE FROM faqs WHERE id = ${params.id} RETURNING id`);
				return r.length > 0;
			});
			if (!deleted) throw errors.notFound('Frage nicht gefunden');
			await core.audit.logFromContext(ctx, 'website.faq.deleted', { target: params.id });
			return { deleted: true };
		}
	})
];
