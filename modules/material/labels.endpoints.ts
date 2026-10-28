/**
 * Etiketten: Formate (Vorgaben + eigene), Layouts (Designer), Druck als PDF über `core.pdf.labels`.
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
import { idList, iso, mdb, num, rows, str } from './db';
import { loadItems } from './inventory';
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
	type LabelTemplate
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
	if (target === 'item') {
		const items = await loadItems(tx, sql`i.id IN (${idList(ids)})`);
		if (items.length !== new Set(ids).size) throw errors.notFound('Artikel nicht gefunden');
		const byId = new Map(items.map((i) => [i.id, i]));
		return ids.map((id) => {
			const i = byId.get(id)!;
			return {
				...common(i.code),
				name: i.name,
				type: i.typeName ?? '',
				category: i.category?.name ?? '',
				location: i.locationName ?? '',
				quantity: String(i.quantity)
			};
		});
	}
	const locs = await rows(
		tx,
		sql`SELECT l.id, l.name, l.description, l.code,
				(SELECT count(*) FROM items i WHERE i.location_id = l.id AND i.archived_at IS NULL) AS n
			FROM locations l WHERE l.id IN (${idList(ids)})`
	);
	const byId = new Map(locs.map((l) => [String(l.id), l]));
	return ids.map((id) => {
		const l = byId.get(id);
		if (!l) throw errors.notFound('Lagerort nicht gefunden');
		return {
			...common(String(l.code)),
			name: String(l.name),
			description: str(l.description),
			count: String(num(l.n))
		};
	});
}

const canPrint = (ctx: RequestContext) =>
	ctx.permissions.has(PERMISSIONS.manage) || ctx.permissions.has(PERMISSIONS.labels);

export const labelsEndpoints: AnyApiEndpoint[] = [
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
