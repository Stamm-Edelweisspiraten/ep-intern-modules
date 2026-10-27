/**
 * Sets (z. B. Zelte aus Zeltbahnen): Vorlagen mit Teileliste, konkrete Sets aus Einzelstücken,
 * Vollständigkeit gegen die Vorlage, Umbau (Stücke zwischen Sets verschieben).
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
import { completeness } from './allocation';
import { claimCode, logMovement, mdb, nextCodes, num, rows, str } from './db';
import { isUsable, loadPlaceIndex, unitSummaries, UNIT_SELECT } from './inventory';
import {
	PERMISSIONS,
	idParams,
	setInput,
	setTemplateInput,
	setTemplateUpdateInput,
	setUpdateInput,
	type ArticleKind,
	type MaterialSet,
	type SetTemplate
} from './schemas';

const tags = ['Modul: material'];

async function loadTemplates(tx: Tx, ids?: string[]): Promise<SetTemplate[]> {
	const list = await rows(
		tx,
		sql`SELECT t.id, t.name, t.description,
				(SELECT count(*) FROM sets s WHERE s.template_id = t.id) AS set_count
			FROM set_templates t ORDER BY t.position, lower(t.name)`
	);
	const parts = await rows(
		tx,
		sql`SELECT p.template_id, p.article_id, p.quantity, a.name, a.kind, a.unit_label
			FROM set_template_parts p JOIN articles a ON a.id = p.article_id
			ORDER BY p.position, lower(a.name)`
	);
	return list
		.filter((t) => !ids || ids.includes(String(t.id)))
		.map((t) => ({
			id: String(t.id),
			name: String(t.name),
			description: str(t.description),
			setCount: num(t.set_count),
			parts: parts
				.filter((p) => String(p.template_id) === String(t.id))
				.map((p) => ({
					articleId: String(p.article_id),
					articleName: String(p.name),
					kind: String(p.kind) as ArticleKind,
					unitLabel: str(p.unit_label) || 'Stück',
					quantity: num(p.quantity)
				}))
		}));
}

async function requireTemplate(tx: Tx, id: string): Promise<SetTemplate> {
	const [t] = await loadTemplates(tx, [id]);
	if (!t) throw errors.notFound('Set-Vorlage nicht gefunden');
	return t;
}

async function writeParts(
	tx: Tx,
	templateId: string,
	parts: { articleId: string; quantity: number }[]
) {
	await tx.execute(sql`DELETE FROM set_template_parts WHERE template_id = ${templateId}`);
	for (const [i, p] of parts.entries()) {
		const [a] = await rows(tx, sql`SELECT id FROM articles WHERE id = ${p.articleId}`);
		if (!a)
			throw errors.validation([{ path: ['parts', i, 'articleId'], message: 'Artikel fehlt' }]);
		await tx.execute(
			sql`INSERT INTO set_template_parts (template_id, article_id, quantity, position)
				VALUES (${templateId}, ${p.articleId}, ${p.quantity}, ${i})`
		);
	}
}

export async function loadSets(tx: Tx, ids?: string[]): Promise<MaterialSet[]> {
	const list = await rows(
		tx,
		sql`SELECT s.id, s.code, s.name, s.notes, s.template_id, t.name AS template_name
			FROM sets s JOIN set_templates t ON t.id = s.template_id
			ORDER BY lower(t.name), lower(s.name)`
	);
	const wanted = ids ? list.filter((s) => ids.includes(String(s.id))) : list;
	if (!wanted.length) return [];
	const index = await loadPlaceIndex(tx);
	const templates = new Map((await loadTemplates(tx)).map((t) => [t.id, t]));
	const members = await rows(tx, sql`SELECT set_id, unit_id FROM set_units`);
	const unitRows = await rows(tx, sql`${UNIT_SELECT} WHERE su.set_id IS NOT NULL`);
	const usable = new Map(unitRows.map((r) => [String(r.id), isUsable(r)]));
	const summaries = new Map(
		(
			await unitSummaries(
				tx,
				unitRows.map((r) => String(r.id)),
				index
			)
		).map((u) => [u.id, u])
	);
	return wanted.map((s) => {
		const id = String(s.id);
		const units = members
			.filter((m) => String(m.set_id) === id)
			.map((m) => summaries.get(String(m.unit_id)))
			.filter((u): u is NonNullable<typeof u> => !!u)
			.sort((a, b) => a.name.localeCompare(b.name, 'de'));
		const template = templates.get(String(s.template_id));
		return {
			id,
			code: String(s.code),
			name: String(s.name),
			templateId: String(s.template_id),
			templateName: String(s.template_name),
			notes: str(s.notes),
			units,
			completeness: completeness(
				(template?.parts ?? []).filter((p) => p.kind === 'unit'),
				units.map((u) => ({
					articleId: u.articleId,
					articleName: u.articleName,
					usable: usable.get(u.id) ?? false
				}))
			),
			bulkParts: (template?.parts ?? [])
				.filter((p) => p.kind === 'bulk')
				.map((p) => ({
					articleId: p.articleId,
					articleName: p.articleName,
					unitLabel: p.unitLabel,
					quantity: p.quantity
				})),
			issuedUnits: units.filter((u) => u.issued).length
		};
	});
}

async function requireSet(tx: Tx, id: string): Promise<MaterialSet> {
	const [s] = await loadSets(tx, [id]);
	if (!s) throw errors.notFound('Set nicht gefunden');
	return s;
}

/** Stücke eines Sets ersetzen; Stücke aus anderen Sets wandern herüber (Umbau) */
async function replaceSetUnits(
	tx: Tx,
	ctx: RequestContext,
	setId: string,
	setName: string,
	unitIds: string[]
) {
	const ids = [...new Set(unitIds)];
	for (const [i, id] of ids.entries()) {
		const [u] = await rows(tx, sql`SELECT id, retired_at FROM units WHERE id = ${id}`);
		if (!u) throw errors.validation([{ path: ['unitIds', i], message: 'Stück nicht gefunden' }]);
		if (u.retired_at != null) {
			throw errors.validation([{ path: ['unitIds', i], message: 'Stück ist ausgemustert' }]);
		}
	}
	const before = (await rows(tx, sql`SELECT unit_id FROM set_units WHERE set_id = ${setId}`)).map(
		(r) => String(r.unit_id)
	);
	for (const id of before.filter((x) => !ids.includes(x))) {
		await tx.execute(sql`DELETE FROM set_units WHERE set_id = ${setId} AND unit_id = ${id}`);
		await logMovement(tx, ctx, { kind: 'set-removed', unitId: id, detail: setName });
	}
	for (const id of ids.filter((x) => !before.includes(x))) {
		const [old] = await rows(
			tx,
			sql`SELECT s.name FROM set_units su JOIN sets s ON s.id = su.set_id WHERE su.unit_id = ${id}`
		);
		await tx.execute(sql`DELETE FROM set_units WHERE unit_id = ${id}`);
		if (old)
			await logMovement(tx, ctx, { kind: 'set-removed', unitId: id, detail: String(old.name) });
		await tx.execute(sql`INSERT INTO set_units (set_id, unit_id) VALUES (${setId}, ${id})`);
		await logMovement(tx, ctx, { kind: 'set-added', unitId: id, detail: setName });
	}
}

export const setsEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/set-templates',
		summary: 'Set-Vorlagen (z. B. Zelttypen) mit Teilen',
		tags,
		permission: PERMISSIONS.view,
		handler: () => mdb().transaction((tx) => loadTemplates(tx))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/set-templates',
		summary: 'Set-Vorlage anlegen',
		tags,
		permission: PERMISSIONS.manage,
		body: setTemplateInput,
		handler: async ({ ctx, body }): Promise<SetTemplate> => {
			const id = crypto.randomUUID();
			const t = await mdb().transaction(async (tx) => {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('material:set-templates'))`);
				await tx.execute(
					sql`INSERT INTO set_templates (id, name, description, position)
						VALUES (${id}, ${body.name}, ${body.description},
							(SELECT coalesce(max(position), -1) + 1 FROM set_templates))`
				);
				await writeParts(tx, id, body.parts);
				return requireTemplate(tx, id);
			});
			await core.audit.logFromContext(ctx, 'material.set-template.created', { target: id });
			return t;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/set-templates/:id',
		summary: 'Set-Vorlage bearbeiten',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: setTemplateUpdateInput,
		handler: async ({ ctx, params, body }): Promise<SetTemplate> => {
			const t = await mdb().transaction(async (tx) => {
				await requireTemplate(tx, params.id);
				const sets = [sql`updated_at = now()`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.description !== undefined) sets.push(sql`description = ${body.description}`);
				await tx.execute(
					sql`UPDATE set_templates SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`
				);
				if (body.parts) await writeParts(tx, params.id, body.parts);
				return requireTemplate(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.set-template.updated', { target: params.id });
			return t;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/set-templates/:id',
		summary: 'Set-Vorlage löschen (nur ohne Sets)',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				const t = await requireTemplate(tx, params.id);
				if (t.setCount > 0) throw errors.conflict('Es gibt noch Sets dieser Vorlage');
				await tx.execute(sql`DELETE FROM set_templates WHERE id = ${params.id}`);
			});
			await core.audit.logFromContext(ctx, 'material.set-template.deleted', { target: params.id });
			return { deleted: true };
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/sets',
		summary: 'Sets mit Stücken und Vollständigkeit',
		tags,
		permission: PERMISSIONS.view,
		handler: () => mdb().transaction((tx) => loadSets(tx))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/sets/:id',
		summary: 'Set abrufen',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: ({ params }) => mdb().transaction((tx) => requireSet(tx, params.id))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/sets',
		summary: 'Set anlegen (Stücke aus anderen Sets wandern herüber)',
		tags,
		permission: PERMISSIONS.manage,
		body: setInput,
		handler: async ({ ctx, body }): Promise<MaterialSet> => {
			const id = crypto.randomUUID();
			const s = await mdb().transaction(async (tx) => {
				await requireTemplate(tx, body.templateId);
				const code = body.code
					? await claimCode(tx, body.code)
					: (await nextCodes(tx, 'set', 1))[0]!;
				await tx.execute(
					sql`INSERT INTO sets (id, template_id, name, code, notes)
						VALUES (${id}, ${body.templateId}, ${body.name}, ${code}, ${body.notes})`
				);
				await replaceSetUnits(tx, ctx, id, body.name, body.unitIds);
				return requireSet(tx, id);
			});
			await core.audit.logFromContext(ctx, 'material.set.created', {
				target: id,
				metadata: { units: body.unitIds.length }
			});
			return s;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/sets/:id',
		summary: 'Set bearbeiten / umbauen (`unitIds` ersetzt die Stücke)',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: setUpdateInput,
		handler: async ({ ctx, params, body }): Promise<MaterialSet> => {
			const s = await mdb().transaction(async (tx) => {
				const current = await requireSet(tx, params.id);
				const sets = [sql`updated_at = now()`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.notes !== undefined) sets.push(sql`notes = ${body.notes}`);
				if (body.code !== undefined && body.code !== current.code) {
					await claimCode(tx, body.code, params.id);
					sets.push(sql`code = ${body.code}`);
				}
				await tx.execute(sql`UPDATE sets SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`);
				if (body.unitIds) {
					await replaceSetUnits(tx, ctx, params.id, body.name ?? current.name, body.unitIds);
				}
				return requireSet(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.set.updated', {
				target: params.id,
				metadata: { fields: Object.keys(body).sort() }
			});
			return s;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/sets/:id',
		summary: 'Set auflösen (Stücke bleiben als lose Stücke)',
		description: 'Mit offenen Reservierungen dieses Sets → 409.',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				const s = await requireSet(tx, params.id);
				const [r] = await rows(
					tx,
					sql`SELECT count(*) AS n FROM reservation_lines l JOIN reservations r ON r.id = l.reservation_id
						WHERE l.set_id = ${params.id} AND r.status IN ('reserved', 'issued')`
				);
				if (num(r?.n) > 0) throw errors.conflict('Das Set ist noch reserviert');
				for (const u of s.units) {
					await logMovement(tx, ctx, { kind: 'set-removed', unitId: u.id, detail: s.name });
				}
				await tx.execute(sql`DELETE FROM sets WHERE id = ${params.id}`);
			});
			await core.audit.logFromContext(ctx, 'material.set.deleted', { target: params.id });
			return { deleted: true };
		}
	})
];
