/**
 * Etiketten: Formate (Vorgaben + eigene), Layouts (Designer), Druck als PDF über `core.pdf.labels`,
 * dazu die Übersicht des Moduls.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	errors,
	type AnyApiEndpoint,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import {
	LABEL_FORMAT_PRESETS,
	labelFormatSchema,
	labelLayoutSchema,
	type LabelFormat,
	type LabelLayout
} from '$lib/sdk/labels';
import { iso, mdb, num, rows, str, today } from './db';
import { holderText, loadPlaceIndex, placeText, unitSummaries } from './inventory';
import { loadSets } from './sets.endpoints';
import {
	MAX_LABELS,
	PERMISSIONS,
	codeFromScan,
	idParams,
	labelFormatInput,
	labelFormatUpdateInput,
	labelPrintInput,
	labelTemplateInput,
	labelTemplateUpdateInput,
	scanPath,
	type LabelFormatEntry,
	type LabelTarget,
	type LabelTemplate,
	type Overview
} from './schemas';

const tags = ['Modul: material'];

async function loadFormats(tx: Tx): Promise<LabelFormatEntry[]> {
	const custom = (
		await rows(tx, sql`SELECT id, name, format FROM label_formats ORDER BY lower(name)`)
	)
		.map((r) => {
			const raw = typeof r.format === 'string' ? JSON.parse(r.format) : r.format;
			const parsed = labelFormatSchema.safeParse(raw);
			if (!parsed.success) return null;
			const entry: LabelFormatEntry = {
				key: `custom:${String(r.id)}`,
				id: String(r.id),
				name: String(r.name),
				format: parsed.data as LabelFormat,
				preset: false
			};
			return entry;
		})
		.filter((f): f is LabelFormatEntry => !!f);
	return [
		...custom,
		...LABEL_FORMAT_PRESETS.map((p) => ({
			key: p.key,
			id: null,
			name: p.name,
			format: p.format,
			preset: true
		}))
	];
}

function toTemplate(r: Record<string, unknown>): LabelTemplate {
	const raw = typeof r.layout === 'string' ? JSON.parse(r.layout) : r.layout;
	const parsed = labelLayoutSchema.safeParse(raw);
	return {
		id: String(r.id),
		name: String(r.name),
		target: String(r.target) as LabelTarget,
		layout: (parsed.success
			? parsed.data
			: { widthMm: 70, heightMm: 37, elements: [] }) as LabelLayout,
		formatKey: String(r.format_key),
		updatedAt: iso(r.updated_at)
	};
}

async function loadTemplates(tx: Tx): Promise<LabelTemplate[]> {
	return (
		await rows(
			tx,
			sql`SELECT id, name, target, layout, format_key, updated_at FROM label_templates ORDER BY lower(name)`
		)
	).map(toTemplate);
}

async function requireTemplate(tx: Tx, id: string): Promise<LabelTemplate> {
	const [r] = await rows(
		tx,
		sql`SELECT id, name, target, layout, format_key, updated_at FROM label_templates WHERE id = ${id}`
	);
	if (!r) throw errors.notFound('Etikett-Layout nicht gefunden');
	return toTemplate(r);
}

async function assertFormatKey(tx: Tx, key: string): Promise<LabelFormat> {
	const f = (await loadFormats(tx)).find((x) => x.key === key);
	if (!f)
		throw errors.validation([{ path: ['formatKey'], message: 'Unbekanntes Etikettenformat' }]);
	return f.format;
}

/** Platzhalter-Werte je Objekt (Reihenfolge = `ids`) */
async function labelValues(
	tx: Tx,
	target: LabelTarget,
	ids: string[],
	codes: string[],
	base: { origin: string; org: string }
): Promise<Record<string, string>[]> {
	const common = (code: string) => ({
		code,
		url: `${base.origin}${scanPath(code)}`,
		org: base.org
	});
	if (target === 'blank') {
		return codes.map((c) => {
			const code = codeFromScan(c);
			if (!code) throw errors.validation([{ path: ['codes'], message: 'Ungültiger Code' }]);
			return common(code);
		});
	}
	if (target === 'unit') {
		const index = await loadPlaceIndex(tx);
		const units = await unitSummaries(tx, ids, index);
		if (units.length !== new Set(ids).size) throw errors.notFound('Stück nicht gefunden');
		const byId = new Map(units.map((u) => [u.id, u]));
		const contents = new Map<string, string>();
		for (const u of units.filter((x) => x.isContainer)) {
			const parts = await rows(
				tx,
				sql`SELECT a.name, count(*) AS n FROM units x JOIN articles a ON a.id = x.article_id
					WHERE x.container_id = ${u.id} AND x.retired_at IS NULL GROUP BY a.name
					UNION ALL
					SELECT a.name, sum(s.quantity) FROM stock s JOIN articles a ON a.id = s.article_id
					WHERE s.container_id = ${u.id} AND s.quantity > 0 GROUP BY a.name
					ORDER BY 1`
			);
			contents.set(
				u.id,
				parts
					.map((p) => (num(p.n) > 1 ? `${num(p.n)} × ${String(p.name)}` : String(p.name)))
					.join(', ')
			);
		}
		return ids.map((id) => {
			const u = byId.get(id)!;
			return {
				...common(u.code),
				name: u.name,
				article: u.articleName,
				category: u.categoryName ?? '',
				location: placeText(index, u.id),
				set: u.setName ?? '',
				contents: contents.get(u.id) ?? ''
			};
		});
	}
	if (target === 'article') {
		const index = await loadPlaceIndex(tx);
		const list = await rows(
			tx,
			sql`SELECT a.id, a.code, a.name, a.kind, a.unit_label, c.name AS category,
					(SELECT coalesce(sum(quantity), 0) FROM stock s WHERE s.article_id = a.id) AS stock_total,
					(SELECT count(*) FROM units u WHERE u.article_id = a.id AND u.retired_at IS NULL) AS unit_total
				FROM articles a LEFT JOIN categories c ON c.id = a.category_id
				WHERE a.id::text IN (${sql.join(
					(ids.length ? ids : ['00000000-0000-0000-0000-000000000000']).map((id) => sql`${id}`),
					sql`, `
				)})`
		);
		if (list.length !== new Set(ids).size) throw errors.notFound('Artikel nicht gefunden');
		const byId = new Map(list.map((r) => [String(r.id), r]));
		const out: Record<string, string>[] = [];
		for (const id of ids) {
			const r = byId.get(id)!;
			const places = new Set<string>();
			if (String(r.kind) === 'bulk') {
				for (const h of await rows(
					tx,
					sql`SELECT location_id, container_id FROM stock WHERE article_id = ${id} AND quantity > 0
						ORDER BY quantity DESC`
				)) {
					places.add(
						holderText(index, {
							locationId: h.location_id ? String(h.location_id) : null,
							containerId: h.container_id ? String(h.container_id) : null
						})
					);
				}
			} else {
				for (const u of index.units.values()) {
					if (u.articleId === id) places.add(placeText(index, u.id));
				}
			}
			const where = [...places];
			out.push({
				...common(String(r.code)),
				name: String(r.name),
				category: str(r.category),
				unit: str(r.unit_label) || 'Stück',
				total: String(String(r.kind) === 'bulk' ? num(r.stock_total) : num(r.unit_total)),
				locations: where.slice(0, 3).join(', ') + (where.length > 3 ? ' …' : '')
			});
		}
		return out;
	}
	if (target === 'set') {
		const sets = await loadSets(tx, ids);
		if (sets.length !== new Set(ids).size) throw errors.notFound('Set nicht gefunden');
		const byId = new Map(sets.map((s) => [s.id, s]));
		return ids.map((id) => {
			const s = byId.get(id)!;
			const counts = new Map<string, number>();
			for (const u of s.units) counts.set(u.articleName, (counts.get(u.articleName) ?? 0) + 1);
			return {
				...common(s.code),
				name: s.name,
				template: s.templateName,
				parts: [...counts].map(([n, c]) => `${c} × ${n}`).join(', ')
			};
		});
	}
	const index = await loadPlaceIndex(tx);
	const locs = await rows(tx, sql`SELECT id, name, code FROM locations`);
	const byId = new Map(locs.map((l) => [String(l.id), l]));
	return ids.map((id) => {
		const l = byId.get(id);
		if (!l) throw errors.notFound('Lagerort nicht gefunden');
		return {
			...common(String(l.code)),
			name: String(l.name),
			path: index.locationPaths.get(id) ?? String(l.name)
		};
	});
}

async function overview(tx: Tx): Promise<Overview> {
	const t = today();
	const [c] = await rows(
		tx,
		sql`SELECT
			(SELECT count(*) FROM articles WHERE archived_at IS NULL) AS articles,
			(SELECT count(*) FROM units WHERE retired_at IS NULL AND NOT is_container) AS units,
			(SELECT count(*) FROM units WHERE retired_at IS NULL AND is_container) AS containers,
			(SELECT count(*) FROM sets) AS sets,
			(SELECT count(*) FROM locations) AS locations,
			(SELECT count(*) FROM units WHERE issued_reservation_id IS NOT NULL) AS issued,
			(SELECT count(*) FROM reservations WHERE status = 'issued' AND ends_on < ${t}::date) AS overdue,
			(SELECT count(*) FROM units WHERE retired_at IS NULL AND condition IN ('damaged', 'defect')) AS damaged,
			(SELECT count(*) FROM reservations WHERE status = 'reserved' AND starts_on >= ${t}::date) AS upcoming,
			(SELECT count(*) FROM units WHERE retired_at IS NULL AND location_id IS NULL AND container_id IS NULL) AS unplaced`
	);
	const low = await rows(
		tx,
		sql`SELECT a.id, a.name, a.min_quantity,
				(SELECT coalesce(sum(quantity), 0) FROM stock s WHERE s.article_id = a.id) AS total
			FROM articles a
			WHERE a.kind = 'bulk' AND a.archived_at IS NULL AND a.min_quantity > 0
				AND (SELECT coalesce(sum(quantity), 0) FROM stock s WHERE s.article_id = a.id) < a.min_quantity
			ORDER BY lower(a.name) LIMIT 20`
	);
	return {
		articles: num(c?.articles),
		units: num(c?.units),
		containers: num(c?.containers),
		sets: num(c?.sets),
		locations: num(c?.locations),
		issuedUnits: num(c?.issued),
		overdueReservations: num(c?.overdue),
		damagedUnits: num(c?.damaged),
		upcomingReservations: num(c?.upcoming),
		unplacedUnits: num(c?.unplaced),
		lowStock: low.map((l) => ({
			articleId: String(l.id),
			name: String(l.name),
			total: num(l.total),
			min: num(l.min_quantity)
		}))
	};
}

const canPrint = (ctx: RequestContext) =>
	ctx.permissions.has(PERMISSIONS.manage) || ctx.permissions.has(PERMISSIONS.labels);

export const labelsEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/overview',
		summary: 'Kennzahlen (Bestand, Ausgaben, Überfälliges, Mindestbestand)',
		tags,
		permission: PERMISSIONS.view,
		handler: () => mdb().transaction(overview)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/label-formats',
		summary: 'Etikettenformate (eigene + Vorgaben)',
		tags,
		permission: PERMISSIONS.view,
		handler: () => mdb().transaction(loadFormats)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/label-formats',
		summary: 'Eigenes Etikettenformat anlegen',
		tags,
		permission: PERMISSIONS.labels,
		body: labelFormatInput,
		handler: async ({ ctx, body }) => {
			const id = crypto.randomUUID();
			const list = await mdb().transaction(async (tx) => {
				await tx.execute(
					sql`INSERT INTO label_formats (id, name, format)
						VALUES (${id}, ${body.name}, ${JSON.stringify(body.format)}::jsonb)`
				);
				return loadFormats(tx);
			});
			await core.audit.logFromContext(ctx, 'material.label-format.created', { target: id });
			return list.find((f) => f.id === id)!;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/label-formats/:id',
		summary: 'Eigenes Etikettenformat bearbeiten',
		tags,
		permission: PERMISSIONS.labels,
		params: idParams,
		body: labelFormatUpdateInput,
		handler: async ({ ctx, params, body }) => {
			const list = await mdb().transaction(async (tx) => {
				const sets = [sql`id = id`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.format !== undefined)
					sets.push(sql`format = ${JSON.stringify(body.format)}::jsonb`);
				const res = await rows(
					tx,
					sql`UPDATE label_formats SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id} RETURNING id`
				);
				if (!res.length) throw errors.notFound('Format nicht gefunden');
				return loadFormats(tx);
			});
			await core.audit.logFromContext(ctx, 'material.label-format.updated', { target: params.id });
			return list.find((f) => f.id === params.id)!;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/label-formats/:id',
		summary: 'Eigenes Etikettenformat löschen (nicht, solange ein Layout es nutzt)',
		tags,
		permission: PERMISSIONS.labels,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				const [used] = await rows(
					tx,
					sql`SELECT count(*) AS n FROM label_templates WHERE format_key = ${`custom:${params.id}`}`
				);
				if (num(used?.n) > 0) throw errors.conflict('Ein Etikett-Layout nutzt dieses Format');
				const res = await rows(
					tx,
					sql`DELETE FROM label_formats WHERE id = ${params.id} RETURNING id`
				);
				if (!res.length) throw errors.notFound('Format nicht gefunden');
			});
			await core.audit.logFromContext(ctx, 'material.label-format.deleted', { target: params.id });
			return { deleted: true };
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/label-templates',
		summary: 'Etikett-Layouts',
		tags,
		permission: PERMISSIONS.view,
		handler: () => mdb().transaction(loadTemplates)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/label-templates',
		summary: 'Etikett-Layout anlegen',
		tags,
		permission: PERMISSIONS.labels,
		body: labelTemplateInput,
		handler: async ({ ctx, body }): Promise<LabelTemplate> => {
			const id = crypto.randomUUID();
			const t = await mdb().transaction(async (tx) => {
				await assertFormatKey(tx, body.formatKey);
				await tx.execute(
					sql`INSERT INTO label_templates (id, name, target, layout, format_key, created_by)
						VALUES (${id}, ${body.name}, ${body.target}, ${JSON.stringify(body.layout)}::jsonb,
							${body.formatKey}, ${ctx.userId ?? null})`
				);
				return requireTemplate(tx, id);
			});
			await core.audit.logFromContext(ctx, 'material.label-template.created', { target: id });
			return t;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/label-templates/:id',
		summary: 'Etikett-Layout speichern',
		tags,
		permission: PERMISSIONS.labels,
		params: idParams,
		body: labelTemplateUpdateInput,
		handler: async ({ ctx, params, body }): Promise<LabelTemplate> => {
			const t = await mdb().transaction(async (tx) => {
				await requireTemplate(tx, params.id);
				if (body.formatKey !== undefined) await assertFormatKey(tx, body.formatKey);
				const sets = [sql`updated_at = now()`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.target !== undefined) sets.push(sql`target = ${body.target}`);
				if (body.layout !== undefined)
					sets.push(sql`layout = ${JSON.stringify(body.layout)}::jsonb`);
				if (body.formatKey !== undefined) sets.push(sql`format_key = ${body.formatKey}`);
				await tx.execute(
					sql`UPDATE label_templates SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`
				);
				return requireTemplate(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.label-template.updated', {
				target: params.id
			});
			return t;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/label-templates/:id',
		summary: 'Etikett-Layout löschen',
		tags,
		permission: PERMISSIONS.labels,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				const res = await rows(
					tx,
					sql`DELETE FROM label_templates WHERE id = ${params.id} RETURNING id`
				);
				if (!res.length) throw errors.notFound('Etikett-Layout nicht gefunden');
			});
			await core.audit.logFromContext(ctx, 'material.label-template.deleted', {
				target: params.id
			});
			return { deleted: true };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/labels.pdf',
		summary: 'Etiketten drucken (PDF)',
		description:
			'Layout + Format (Standard: das des Layouts) + Objekte (`ids`) bzw. vorab vergebene Codes (`target=blank`). ' +
			'`startIndex` = erstes freies Feld auf dem Bogen, `copies` = Etiketten je Objekt.',
		tags,
		permission: PERMISSIONS.view,
		body: labelPrintInput,
		handler: async ({ ctx, body }) => {
			if (!canPrint(ctx))
				throw errors.forbidden('Drucken nur mit Materialverwaltungs- oder Etikettenrecht');
			const [org] = await Promise.all([core.settings.getMany(['core.organization.name'])]);
			const base = {
				origin: core.app.origin(),
				org: str(org['core.organization.name']) || 'Stamm'
			};
			const { template, format, values } = await mdb().transaction(async (tx) => {
				const template = await requireTemplate(tx, body.templateId);
				const format = await assertFormatKey(tx, body.formatKey ?? template.formatKey);
				const values = await labelValues(tx, body.target, body.ids, body.codes, base);
				return { template, format, values };
			});
			if (!values.length)
				throw errors.validation([{ path: ['ids'], message: 'Nichts ausgewählt' }]);
			const labels = values.flatMap((v) => Array.from({ length: body.copies }, () => v));
			if (labels.length > MAX_LABELS) {
				throw errors.validation([
					{ path: ['copies'], message: `Höchstens ${MAX_LABELS} Etiketten` }
				]);
			}
			const pdf = await core.pdf.labels(ctx, {
				title: `Etiketten ${template.name}`,
				format,
				layout: template.layout,
				labels,
				startIndex: body.startIndex,
				outlines: body.outlines
			});
			await core.audit.logFromContext(ctx, 'material.labels.printed', {
				target: template.id,
				metadata: { target: body.target, count: labels.length }
			});
			return new Response(Buffer.from(pdf.buffer), {
				headers: {
					'content-type': 'application/pdf',
					'content-disposition': `attachment; filename="${pdf.fileName}"`,
					'cache-control': 'private, no-store'
				}
			});
		}
	})
];
