/**
 * Ausleihen und Wiederfinden: Katalog mit freier Anzahl im Zeitraum, „Wo ist …?“-Suche, Ausgabeliste je
 * Reservierung und Bestandsliste als PDF.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	type AnyApiEndpoint,
	type PdfBlock,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import { formatDateDe, todayBerlin } from '$lib/sdk/dates';
import { formatEuro } from '$lib/components/layout/money';
import { listTemplateInput } from '$lib/pdf-lists/compose';
import { freeQuantity, freeUnitCount } from './availability';
import { mdb, num, rows, str, userNames } from './db';
import {
	containedUnits,
	holderText,
	isUsable,
	loadPlaceIndex,
	placeText,
	toUnitSummary,
	UNIT_SELECT,
	type PlaceIndex
} from './inventory';
import { descendants, effectivePlace } from './places';
import { loadBookings, loadReservation, setUnitMap } from './reservations.service';
import {
	CONDITION_LABELS,
	INVENTORY_COLUMNS,
	PERMISSIONS,
	catalogQuery,
	findQuery,
	idParams,
	imageUrl,
	inventoryPdfInput,
	type ArticleKind,
	type Catalog,
	type CatalogArticle,
	type CatalogTemplate,
	type Condition,
	type FindHit,
	type InventoryColumn
} from './schemas';

const tags = ['Modul: material'];
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const pdfResponse = (r: { buffer: Uint8Array; fileName: string }) =>
	new Response(Buffer.from(r.buffer), {
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': `attachment; filename="${r.fileName}"`,
			'cache-control': 'private, no-store'
		}
	});

/** Orte, an denen ein Mengenartikel liegt (größter Bestand zuerst) */
async function bulkPlaces(tx: Tx, index: PlaceIndex): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	for (const h of await rows(
		tx,
		sql`SELECT article_id, location_id, container_id FROM stock WHERE quantity > 0 ORDER BY quantity DESC`
	)) {
		const key = String(h.article_id);
		const list = out.get(key) ?? [];
		list.push(
			holderText(index, {
				locationId: h.location_id ? String(h.location_id) : null,
				containerId: h.container_id ? String(h.container_id) : null
			})
		);
		out.set(key, list);
	}
	return out;
}

async function loadCatalog(
	tx: Tx,
	q: { from: string; to: string; search?: string; categoryId?: string }
): Promise<Catalog> {
	const to = q.to < q.from ? q.from : q.to;
	const index = await loadPlaceIndex(tx);
	const { bookings } = await loadBookings(tx, { from: q.from, to }, { index });
	const where = [sql`a.archived_at IS NULL`];
	if (q.categoryId) where.push(sql`a.category_id = ${q.categoryId}`);
	if (q.search) {
		const p = like(q.search);
		where.push(
			sql`(a.name ILIKE ${p} OR a.description ILIKE ${p} OR a.code = ${q.search.toUpperCase()})`
		);
	}
	const articles = await rows(
		tx,
		sql`SELECT a.id, a.code, a.name, a.kind, a.unit_label, a.description, a.category_id,
				c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
				(SELECT coalesce(sum(quantity), 0) FROM stock s WHERE s.article_id = a.id) AS stock_total,
				(SELECT i.id FROM article_images i WHERE i.article_id = a.id ORDER BY i.position, i.created_at LIMIT 1) AS image_id
			FROM articles a LEFT JOIN categories c ON c.id = a.category_id
			WHERE ${sql.join(where, sql` AND `)}
			ORDER BY lower(c.name) NULLS LAST, lower(a.name)`
	);
	const unitRows = await rows(tx, sql`SELECT id, article_id, condition, retired_at FROM units`);
	const usable = new Map<string, string[]>();
	for (const u of unitRows) {
		if (!isUsable(u)) continue;
		const list = usable.get(String(u.article_id)) ?? [];
		list.push(String(u.id));
		usable.set(String(u.article_id), list);
	}
	const bulk = await bulkPlaces(tx, index);
	const freeBy = new Map<string, number>();
	const out: CatalogArticle[] = articles.map((a) => {
		const id = String(a.id);
		const kind = String(a.kind) as ArticleKind;
		let total: number;
		let free: number;
		let places: string[];
		if (kind === 'bulk') {
			total = num(a.stock_total);
			free = freeQuantity(total, id, bookings, q.from, to);
			places = bulk.get(id) ?? [];
		} else {
			const list = usable.get(id) ?? [];
			total = list.length;
			free = freeUnitCount(list, id, bookings, q.from, to);
			places = [...new Set(list.map((u) => placeText(index, u)))];
		}
		freeBy.set(id, free);
		return {
			id,
			code: String(a.code),
			name: String(a.name),
			kind,
			unitLabel: str(a.unit_label) || 'Stück',
			description: str(a.description),
			categoryId: a.category_id ? String(a.category_id) : null,
			categoryName: a.category_name ? String(a.category_name) : null,
			categoryColor: a.category_color ? String(a.category_color) : null,
			categoryIcon: a.category_icon ? String(a.category_icon) : null,
			thumbUrl: a.image_id ? imageUrl(id, String(a.image_id), 'thumb') : null,
			total,
			free,
			places: places.slice(0, 3)
		};
	});
	// Set-Typen: wie viele vollständige Exemplare lassen sich aus freien Teilen bilden?
	const tpls = await rows(
		tx,
		sql`SELECT t.id, t.name, t.description, (SELECT count(*) FROM sets s WHERE s.template_id = t.id) AS sets
			FROM set_templates t ORDER BY t.position, lower(t.name)`
	);
	const parts = await rows(
		tx,
		sql`SELECT p.template_id, p.article_id, p.quantity, a.name, a.kind, a.unit_label FROM set_template_parts p
			JOIN articles a ON a.id = p.article_id ORDER BY p.position`
	);
	const templates: CatalogTemplate[] = [];
	for (const t of tpls) {
		const myParts = parts
			.filter((p) => String(p.template_id) === String(t.id))
			.map((p) => ({
				articleId: String(p.article_id),
				articleName: String(p.name),
				kind: String(p.kind) as ArticleKind,
				unitLabel: str(p.unit_label) || 'Stück',
				quantity: num(p.quantity)
			}));
		if (!myParts.length) continue;
		if (q.search) {
			const s = q.search.toLowerCase();
			const hit =
				String(t.name).toLowerCase().includes(s) ||
				myParts.some((p) => p.articleName.toLowerCase().includes(s));
			if (!hit) continue;
		}
		let free = Number.POSITIVE_INFINITY;
		for (const p of myParts) {
			const f =
				freeBy.get(p.articleId) ??
				freeUnitCount(usable.get(p.articleId) ?? [], p.articleId, bookings, q.from, to);
			free = Math.min(free, Math.floor(f / p.quantity));
		}
		templates.push({
			id: String(t.id),
			name: String(t.name),
			description: str(t.description),
			parts: myParts,
			free: Number.isFinite(free) ? free : 0,
			sets: num(t.sets)
		});
	}
	return { from: q.from, to, articles: out, templates };
}

async function find(tx: Tx, q: string): Promise<FindHit[]> {
	const p = like(q);
	const code = q.trim().toUpperCase();
	const index = await loadPlaceIndex(tx);
	const hits: FindHit[] = [];
	const units = await rows(
		tx,
		sql`${UNIT_SELECT}
			WHERE u.retired_at IS NULL AND (u.code = ${code} OR u.label ILIKE ${p} OR a.name ILIKE ${p})
			ORDER BY (u.code = ${code}) DESC, lower(a.name), lower(u.label) LIMIT 40`
	);
	for (const r of units) {
		const u = toUnitSummary(index, r);
		hits.push({
			type: u.isContainer ? 'container' : 'unit',
			id: u.id,
			code: u.code,
			name: u.name,
			detail: [u.articleName, u.setName ? `Set ${u.setName}` : ''].filter(Boolean).join(' · '),
			place: u.locationPath,
			away: u.issued?.title ?? null,
			condition: u.condition,
			quantity: null
		});
	}
	const bulk = await bulkPlaces(tx, index);
	const articles = await rows(
		tx,
		sql`SELECT a.id, a.code, a.name, a.kind, a.unit_label, c.name AS category,
				(SELECT coalesce(sum(quantity), 0) FROM stock s WHERE s.article_id = a.id) AS total
			FROM articles a LEFT JOIN categories c ON c.id = a.category_id
			WHERE a.archived_at IS NULL AND a.kind = 'bulk' AND (a.code = ${code} OR a.name ILIKE ${p})
			ORDER BY lower(a.name) LIMIT 20`
	);
	for (const a of articles) {
		hits.push({
			type: 'article',
			id: String(a.id),
			code: String(a.code),
			name: String(a.name),
			detail: [str(a.category), 'Menge'].filter(Boolean).join(' · '),
			place: (bulk.get(String(a.id)) ?? []).join(', ') || 'Kein Bestand',
			away: null,
			condition: null,
			quantity: num(a.total)
		});
	}
	const sets = await rows(
		tx,
		sql`SELECT s.id, s.code, s.name, t.name AS template FROM sets s JOIN set_templates t ON t.id = s.template_id
			WHERE s.code = ${code} OR s.name ILIKE ${p} OR t.name ILIKE ${p} ORDER BY lower(s.name) LIMIT 20`
	);
	const setUnits = await setUnitMap(tx);
	for (const s of sets) {
		const members = setUnits.get(String(s.id)) ?? [];
		const placesOf = [...new Set(members.map((u) => placeText(index, u)))];
		hits.push({
			type: 'set',
			id: String(s.id),
			code: String(s.code),
			name: String(s.name),
			detail: String(s.template),
			place: placesOf.slice(0, 2).join(', ') || 'Leer',
			away: null,
			condition: null,
			quantity: members.length
		});
	}
	const locs = await rows(
		tx,
		sql`SELECT id, code, name FROM locations WHERE code = ${code} OR name ILIKE ${p} ORDER BY lower(name) LIMIT 20`
	);
	for (const l of locs) {
		hits.push({
			type: 'location',
			id: String(l.id),
			code: String(l.code),
			name: String(l.name),
			detail: 'Lagerort',
			place: index.locationPaths.get(String(l.id)) ?? String(l.name),
			away: null,
			condition: null,
			quantity: null
		});
	}
	return hits;
}

/** Zeilen der Ausgabeliste: nach Lagerort sortiert, Kisteninhalt eingerückt */
async function handoutRows(
	tx: Tx,
	ctx: RequestContext,
	id: string
): Promise<{
	title: string;
	startsOn: string;
	endsOn: string;
	notes: string;
	createdBy: string | null;
	actionId: string | null;
	rows: string[][];
}> {
	const r = await loadReservation(tx, ctx, id);
	const index = await loadPlaceIndex(tx);
	const sets = await setUnitMap(tx);
	const unitName = (uid: string) => index.units.get(uid)?.name ?? 'Unbekannt';
	const codes = new Map(
		(await rows(tx, sql`SELECT id, code FROM units`)).map((u) => [String(u.id), String(u.code)])
	);
	const bulk = await bulkPlaces(tx, index);
	const assignedBy = new Map<string, string[]>();
	for (const a of r.assigned) {
		if (!a.lineId) continue;
		const list = assignedBy.get(a.lineId) ?? [];
		list.push(a.unit.id);
		assignedBy.set(a.lineId, list);
	}
	type Item = { sort: string; cells: string[] };
	const items: Item[] = [];
	const addUnit = (uid: string, indent = '') => {
		const place = placeText(index, uid);
		items.push({
			sort: `${place}\u0000${unitName(uid)}`,
			cells: [`${indent}${unitName(uid)}`, codes.get(uid) ?? '', place, '1', '☐', '☐']
		});
		if (index.units.get(uid)?.isContainer) {
			for (const c of containedUnits(index, uid)) {
				items.push({
					sort: `${place}\u0000${unitName(uid)}\u0001${unitName(c)}`,
					cells: [`   └ ${unitName(c)}`, codes.get(c) ?? '', 'in der Kiste', '1', '☐', '☐']
				});
			}
		}
	};
	for (const l of r.lines) {
		if (l.kind === 'unit' && l.unitId) addUnit(l.unitId);
		else if (l.kind === 'set' && l.setId) {
			items.push({
				sort: `\u0000${l.name}`,
				cells: [l.name, l.code ?? '', '', String(l.quantity), '', '']
			});
			for (const uid of sets.get(l.setId) ?? []) addUnit(uid, '   ');
		} else if (l.articleKind === 'bulk' && l.articleId) {
			const places = bulk.get(l.articleId) ?? [];
			items.push({
				sort: `${places[0] ?? ''}\u0000${l.name}`,
				cells: [l.name, '', places.slice(0, 2).join(', '), `${l.quantity} ${l.unitLabel}`, '☐', '☐']
			});
		} else if (l.articleId) {
			const done = assignedBy.get(l.id) ?? [];
			if (done.length) for (const uid of done) addUnit(uid);
			const rest = l.quantity - done.length;
			if (rest > 0) {
				const free = [...index.units.values()].filter((u) => u.articleId === l.articleId);
				const where = [...new Set(free.map((u) => placeText(index, u.id)))].slice(0, 2).join(', ');
				items.push({
					sort: `${where}\u0000${l.name}`,
					cells: [`${rest} × ${l.name} (beliebige)`, '', where, String(rest), '☐', '☐']
				});
			}
		}
	}
	items.sort((a, b) => a.sort.localeCompare(b.sort, 'de'));
	return {
		title: r.title,
		startsOn: r.startsOn,
		endsOn: r.endsOn,
		notes: r.notes,
		createdBy: r.createdBy,
		actionId: r.actionId,
		rows: items.map((i) => i.cells)
	};
}

function inventoryCell(
	col: InventoryColumn,
	u: ReturnType<typeof toUnitSummary>,
	value: number | null
): string {
	switch (col) {
		case 'code':
			return u.code;
		case 'name':
			return u.name;
		case 'article':
			return u.articleName;
		case 'category':
			return u.categoryName ?? '–';
		case 'place':
			return u.locationPath;
		case 'condition':
			return CONDITION_LABELS[u.condition as Condition];
		case 'set':
			return u.setName ?? '–';
		case 'away':
			return u.issued?.title ?? '–';
		case 'value':
			return value == null ? '–' : formatEuro(value);
		case 'check':
			return '☐';
	}
}

export const borrowEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/catalog',
		summary: 'Katalog zum Ausleihen: Artikel und Zelttypen mit freier Anzahl im Zeitraum',
		tags,
		permission: PERMISSIONS.view,
		query: catalogQuery,
		handler: ({ query }) => mdb().transaction((tx) => loadCatalog(tx, query))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/find',
		summary: '„Wo ist …?“ – Stücke, Kisten, Mengenartikel, Sets und Lagerorte mit Ort',
		tags,
		permission: PERMISSIONS.view,
		query: findQuery,
		handler: ({ query }) => mdb().transaction((tx) => find(tx, query.q))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/reservations/:id/handout.pdf',
		summary: 'Ausgabeliste einer Reservierung (PDF, nach Lagerort sortiert, zum Abhaken)',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const data = await mdb().transaction((tx) => handoutRows(tx, ctx, params.id));
			const names = await userNames(ctx, [data.createdBy]);
			const hasLetterhead = core.pdf.listTemplates().some((t) => t.id === 'stamm-briefkopf');
			// Titel setzt die Vorlage selbst (`title`)
			const content: PdfBlock[] = [
				{
					type: 'paragraph',
					text: [
						`Zeitraum: ${formatDateDe(data.startsOn)} – ${formatDateDe(data.endsOn)}`,
						data.createdBy ? `Reserviert von: ${names.get(data.createdBy) ?? 'Unbekannt'}` : ''
					]
						.filter(Boolean)
						.join(' · ')
				}
			];
			if (data.notes) content.push({ type: 'paragraph', text: `Hinweis: ${data.notes}` });
			content.push({
				type: 'table',
				variant: 'grid',
				columns: ['Material', 'Code', 'Lagerort', 'Menge', 'Ausg.', 'Zurück'],
				widths: [27, 15, 28, 10, 10, 10],
				align: ['left', 'left', 'left', 'right', 'center', 'center'],
				rows: data.rows.length ? data.rows : [['Keine Positionen', '', '', '', '', '']]
			});
			content.push(
				{
					type: 'paragraph',
					text: 'Ausgegeben am ____________  durch ____________________  Empfang ____________________'
				},
				{
					type: 'paragraph',
					text: 'Zurück am ________________  durch ____________________  Geprüft ____________________'
				}
			);
			const pdf = await core.pdf.generate(ctx, {
				template: hasLetterhead ? 'stamm-briefkopf' : 'default',
				title: `Ausgabeliste ${data.title}`,
				content
			});
			await core.audit.logFromContext(ctx, 'material.reservation.handout-list', {
				target: params.id,
				metadata: { rows: data.rows.length }
			});
			return pdfResponse(pdf);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/inventory.pdf',
		summary: 'Bestandsliste (PDF, A4 quer), gefiltert und gruppiert',
		tags,
		permission: PERMISSIONS.view,
		body: inventoryPdfInput,
		handler: async ({ ctx, body }) => {
			const columns = (body.columns ??
				INVENTORY_COLUMNS.filter((c) => c.default).map((c) => c.key)) as InventoryColumn[];
			const labels = new Map<string, string>(INVENTORY_COLUMNS.map((c) => [c.key, c.label]));
			const { sections, bulkRows, filterText } = await mdb().transaction(async (tx) => {
				const index = await loadPlaceIndex(tx);
				const where = [sql`TRUE`];
				if (!body.includeRetired) where.push(sql`u.retired_at IS NULL`);
				if (body.categoryId) where.push(sql`a.category_id = ${body.categoryId}`);
				if (body.articleId) where.push(sql`u.article_id = ${body.articleId}`);
				if (body.condition) where.push(sql`u.condition = ${body.condition}`);
				let units = (
					await rows(
						tx,
						sql`${UNIT_SELECT} WHERE ${sql.join(where, sql` AND `)} ORDER BY lower(a.name), lower(u.label), u.code`
					)
				).map((r) => ({
					u: toUnitSummary(index, r),
					value: r.value_cents == null ? null : num(r.value_cents)
				}));
				let allowed: Set<string> | null = null;
				if (body.locationId) {
					allowed = descendants(index.locationParents, body.locationId);
					allowed.add(body.locationId);
					const ok = allowed;
					units = units.filter((x) => {
						const loc = effectivePlace(index.units, x.u.id).locationId;
						return !!loc && ok.has(loc);
					});
				}
				const groups = new Map<string, string[][]>();
				for (const x of units) {
					const key =
						body.groupBy === 'category'
							? (x.u.categoryName ?? 'Ohne Kategorie')
							: (() => {
									const loc = effectivePlace(index.units, x.u.id).locationId;
									return loc ? (index.locationPaths.get(loc) ?? 'Ohne Ort') : 'Ohne Ort';
								})();
					const list = groups.get(key) ?? [];
					const cells = columns.map((c) => inventoryCell(c, x.u, x.value));
					// Nach Ort gruppiert: in der Ort-Spalte nur noch die Kiste („in Kochkiste 1“) statt des ganzen Pfads
					const placeIdx = columns.indexOf('place');
					if (body.groupBy === 'place' && placeIdx >= 0) {
						const rest = x.u.locationPath.startsWith(key)
							? x.u.locationPath.slice(key.length).replace(/^\s*›\s*/, '')
							: x.u.locationPath;
						cells[placeIdx] = rest || '–';
					}
					list.push(cells);
					groups.set(key, list);
				}
				const bulkRows: string[][] = [];
				if (body.includeBulk) {
					const stock = await rows(
						tx,
						sql`SELECT s.article_id, s.location_id, s.container_id, s.quantity, a.code, a.name, a.unit_label,
								a.category_id, c.name AS category
							FROM stock s JOIN articles a ON a.id = s.article_id LEFT JOIN categories c ON c.id = a.category_id
							WHERE s.quantity > 0 ORDER BY lower(a.name)`
					);
					for (const s of stock) {
						if (body.categoryId && String(s.category_id ?? '') !== body.categoryId) continue;
						if (body.articleId && String(s.article_id) !== body.articleId) continue;
						const holder = {
							locationId: s.location_id ? String(s.location_id) : null,
							containerId: s.container_id ? String(s.container_id) : null
						};
						if (allowed) {
							const loc =
								holder.locationId ??
								(holder.containerId
									? effectivePlace(index.units, holder.containerId).locationId
									: null);
							if (!loc || !allowed.has(loc)) continue;
						}
						bulkRows.push([
							String(s.name),
							String(s.code),
							holderText(index, holder),
							`${num(s.quantity)} ${str(s.unit_label) || 'Stück'}`
						]);
					}
				}
				const parts: string[] = [];
				if (body.locationId) parts.push(`Ort: ${index.locationPaths.get(body.locationId) ?? '?'}`);
				if (body.condition) parts.push(`Zustand: ${CONDITION_LABELS[body.condition]}`);
				return {
					sections: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de')),
					bulkRows,
					filterText: parts.join(' · ')
				};
			});
			const total = sections.reduce((s, [, r]) => s + r.length, 0);
			const content: PdfBlock[] = [
				{
					type: 'paragraph',
					text: [`Stand ${formatDateDe(todayBerlin())}`, `${total} Stücke`, filterText]
						.filter(Boolean)
						.join(' · ')
				}
			];
			for (const [name, list] of sections) {
				content.push({ type: 'heading', text: `${name} (${list.length})`, level: 2 });
				content.push({
					type: 'table',
					variant: 'grid',
					columns: columns.map((c) =>
						c === 'place' && body.groupBy === 'place' ? 'In Kiste' : (labels.get(c) ?? c)
					),
					align: columns.map((c) => (c === 'value' ? 'right' : c === 'check' ? 'center' : 'left')),
					rows: list
				});
			}
			if (bulkRows.length) {
				content.push({ type: 'heading', text: `Mengen (${bulkRows.length})`, level: 2 });
				content.push({
					type: 'table',
					variant: 'grid',
					columns: ['Artikel', 'Code', 'Lagerort', 'Menge'],
					widths: [30, 12, 43, 15],
					align: ['left', 'left', 'left', 'right'],
					rows: bulkRows
				});
			}
			if (!total && !bulkRows.length)
				content.push({ type: 'paragraph', text: 'Keine Treffer für diese Auswahl.' });
			const pdf = await core.pdf.generate(ctx, {
				...listTemplateInput(core.pdf.listTemplates().map((t) => t.id)),
				title: 'Bestandsliste Material',
				content
			});
			await core.audit.logFromContext(ctx, 'material.inventory.list-exported', {
				metadata: { units: total, bulk: bulkRows.length, groupBy: body.groupBy }
			});
			return pdfResponse(pdf);
		}
	})
];
