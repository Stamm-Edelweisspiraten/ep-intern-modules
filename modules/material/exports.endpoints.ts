/**
 * Exporte als PDF (A4 quer, Stammes-Vorlage) oder CSV: Materialliste nach Kategorie oder Lagerort,
 * Packliste je Reservierung und Übersicht aller Reservierungen in einem Zeitraum.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
	contentDisposition,
	core,
	defineEndpoint,
	errors,
	type AnyApiEndpoint,
	type PdfBlock,
	type RequestContext
} from '$lib/sdk/server';
import { csvDocument, type CsvValue } from '$lib/sdk/csv';
import { formatDateDe, todayBerlin } from '$lib/sdk/dates';
import { safeFileName } from '$lib/sdk/file-names';
import { listTemplateInput } from '$lib/pdf-lists/compose';
import { canManageReservations, mdb, rows, str } from './db';
import { loadItems, loadLocations } from './inventory';
import { fullReservation, listReservations } from './reservations.service';
import {
	CONDITION_LABELS,
	INVENTORY_COLUMNS,
	PERMISSIONS,
	PURPOSE_LABELS,
	RESERVATION_STATE_LABELS,
	formatQuery,
	idParams,
	inventoryExportInput,
	reservationsExportInput,
	type InventoryColumn,
	type Item,
	type Reservation,
	type ReservationLine,
	type ReservationListItem
} from './schemas';

const tags = ['Modul: material'];

interface Table {
	heading?: string;
	columns: string[];
	rows: string[][];
	align?: ('left' | 'right' | 'center')[];
	widths?: number[];
}

function fileResponse(body: BodyInit, type: string, name: string): Response {
	return new Response(body, {
		headers: {
			'content-type': type,
			'content-disposition': contentDisposition('attachment', name),
			'cache-control': 'private, no-store'
		}
	});
}

/** Tabellen als PDF (Stammes-Listenvorlage) oder CSV (eine Tabelle, Abschnitt als erste Spalte) */
async function render(
	ctx: RequestContext,
	format: 'pdf' | 'csv',
	opts: { title: string; intro: string; tables: Table[]; fileBase: string; sectionLabel?: string }
): Promise<Response> {
	const name = safeFileName(`${opts.fileBase}-${todayBerlin()}`);
	if (format === 'csv') {
		const first = opts.tables[0];
		const header = [...(opts.sectionLabel ? [opts.sectionLabel] : []), ...(first?.columns ?? [])];
		const out: CsvValue[][] = [];
		for (const t of opts.tables) {
			for (const r of t.rows) out.push([...(opts.sectionLabel ? [t.heading ?? ''] : []), ...r]);
		}
		return fileResponse(csvDocument(header, out), 'text/csv; charset=utf-8', `${name}.csv`);
	}
	const content: PdfBlock[] = [{ type: 'paragraph', text: opts.intro }];
	for (const t of opts.tables) {
		if (t.heading) content.push({ type: 'heading', text: t.heading, level: 2 });
		content.push({
			type: 'table',
			variant: 'grid',
			columns: t.columns,
			...(t.widths ? { widths: t.widths } : {}),
			...(t.align ? { align: t.align } : {}),
			rows: t.rows.length ? t.rows : [['Keine Einträge', ...t.columns.slice(1).map(() => '')]]
		});
	}
	const pdf = await core.pdf.generate(ctx, {
		...listTemplateInput(core.pdf.listTemplates().map((t) => t.id)),
		title: opts.title,
		content
	});
	return fileResponse(Buffer.from(pdf.buffer), 'application/pdf', `${name}.pdf`);
}

function itemCell(item: Item, column: InventoryColumn, pdf: boolean): string {
	switch (column) {
		case 'code':
			return item.code;
		case 'name':
			return item.name;
		case 'type':
			return item.typeName ?? '';
		case 'category':
			return item.category?.name ?? '';
		case 'location':
			return item.locationName ?? '';
		case 'set':
			return item.setName ?? '';
		case 'quantity':
			return String(item.quantity);
		case 'condition':
			return CONDITION_LABELS[item.condition] + (item.archived ? ' (archiviert)' : '');
		case 'notes':
			return item.notes;
		case 'check':
			return pdf ? '☐' : '';
	}
}

/** Typzeilen einer Reservierung: an welchen Orten liegen Artikel des Typs? */
async function typePlaces(typeIds: string[]): Promise<Map<string, string>> {
	if (!typeIds.length) return new Map();
	const list = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT i.type_id, string_agg(DISTINCT coalesce(l.name, 'ohne Ort'), ', ') AS places
				FROM items i LEFT JOIN locations l ON l.id = i.location_id
				WHERE i.archived_at IS NULL AND i.condition NOT IN ('defect', 'lost')
					AND i.type_id::text IN (${sql.join(
						typeIds.map((id) => sql`${id}`),
						sql`, `
					)})
				GROUP BY i.type_id`
		)
	);
	return new Map(list.map((r) => [String(r.type_id), str(r.places)]));
}

function purposeText(r: Pick<Reservation, 'purpose' | 'actionName' | 'groupName'>): string {
	if (r.purpose === 'action') return `Aktion: ${r.actionName ?? 'unbekannt'}`;
	if (r.purpose === 'group') return `Gruppe: ${r.groupName ?? 'unbekannt'}`;
	return PURPOSE_LABELS.other;
}

export const exportsEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'POST',
		path: '/exports/inventory',
		summary: 'Materialliste (PDF oder CSV), gruppiert nach Kategorie oder Lagerort',
		tags,
		permission: PERMISSIONS.view,
		body: inventoryExportInput,
		handler: async ({ ctx, body }) => {
			const columns: InventoryColumn[] =
				body.columns ?? INVENTORY_COLUMNS.filter((c) => c.default).map((c) => c.key);
			const where: SQL[] = [body.includeArchived ? sql`TRUE` : sql`i.archived_at IS NULL`];
			if (body.categoryId) where.push(sql`c.id = ${body.categoryId}`);
			if (body.locationId === 'none') where.push(sql`i.location_id IS NULL`);
			else if (body.locationId) where.push(sql`i.location_id = ${body.locationId}`);
			if (body.condition) where.push(sql`i.condition = ${body.condition}`);
			const { items, locations } = await mdb().transaction(async (tx) => ({
				items: await loadItems(tx, sql.join(where, sql` AND `)),
				locations: await loadLocations(tx)
			}));
			// Gruppen in fester Reihenfolge (Position der Kategorie/des Orts), „ohne …“ zuletzt
			const groups = new Map<string, Item[]>();
			const keyOf = (i: Item) =>
				body.groupBy === 'category'
					? (i.category?.name ?? 'Ohne Kategorie')
					: (i.locationName ?? 'Ohne Lagerort');
			for (const i of items) {
				const k = keyOf(i);
				groups.set(k, [...(groups.get(k) ?? []), i]);
			}
			const order = body.groupBy === 'location' ? locations.map((l) => l.name) : null;
			const keys = [...groups.keys()].sort((a, b) => {
				const rank = (k: string) =>
					k.startsWith('Ohne ') ? Infinity : order ? order.indexOf(k) : 0;
				return rank(a) - rank(b) || a.localeCompare(b, 'de', { numeric: true });
			});
			const visible = columns.filter((c) =>
				body.groupBy === 'category' ? c !== 'category' : c !== 'location'
			);
			const labels = new Map(INVENTORY_COLUMNS.map((c) => [c.key, c.label as string]));
			const tables: Table[] = keys.map((k) => {
				const list = groups.get(k)!;
				return {
					heading: `${k} (${list.length})`,
					columns: visible.map((c) => labels.get(c)!),
					align: visible.map((c) =>
						c === 'quantity' ? 'right' : c === 'check' ? 'center' : 'left'
					),
					rows: list.map((i) => visible.map((c) => itemCell(i, c, body.format === 'pdf')))
				};
			});
			const by = body.groupBy === 'category' ? 'Kategorie' : 'Lagerort';
			await core.audit.logFromContext(ctx, 'material.inventory.exported', {
				metadata: { format: body.format, groupBy: body.groupBy, items: items.length }
			});
			return render(ctx, body.format, {
				title: `Materialliste nach ${by}`,
				intro: `Stand ${formatDateDe(todayBerlin())} · ${items.length} Artikel`,
				tables,
				fileBase: `materialliste-${body.groupBy === 'category' ? 'kategorien' : 'lagerorte'}`,
				sectionLabel: by
			});
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/reservations/:id/packing-list',
		summary: 'Packliste einer Reservierung (PDF oder CSV, nach Lagerort sortiert)',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		query: formatQuery,
		handler: async ({ ctx, params, query }) => {
			const r = await fullReservation(ctx, params.id);
			const places = await typePlaces(
				r.lines
					.flatMap((l) => (l.kind === 'tent' ? l.parts : [l]))
					.flatMap((l) => (l.kind === 'type' && l.typeId ? [l.typeId] : []))
			);
			const lines = r.lines
				.flatMap((l): { line: ReservationLine; tent: ReservationLine | null }[] =>
					l.kind === 'tent' ? l.parts.map((p) => ({ line: p, tent: l })) : [{ line: l, tent: null }]
				)
				.flatMap(({ line: l, tent }) => {
					const group = (setName: string | null) =>
						[
							tent ? `${tent.name}${l.label ? ` – ${l.label}` : ''}` : '',
							setName ? `Set ${setName}` : ''
						]
							.filter(Boolean)
							.join(' · ');
					if (l.kind !== 'type') {
						return [
							{
								name: l.name,
								code: l.code ?? '',
								place: l.locationName ?? '',
								group: group(null),
								quantity: String(l.quantity)
							}
						];
					}
					const out = l.assignments.map((a) => ({
						name: a.name,
						code: a.code,
						place: a.locationName ?? '',
						group: group(a.setName),
						quantity: String(a.quantity)
					}));
					if (l.missing > 0) {
						out.push({
							name: `${l.name} (beliebige, noch nicht zugeteilt)`,
							code: '',
							place: places.get(l.typeId ?? '') ?? '',
							group: group(null),
							quantity: String(l.missing)
						});
					}
					return out;
				})
				.sort(
					(a, b) =>
						a.place.localeCompare(b.place, 'de') ||
						a.name.localeCompare(b.name, 'de', { numeric: true })
				);
			const pdf = query.format === 'pdf';
			await core.audit.logFromContext(ctx, 'material.reservation.packing-list', {
				target: r.id,
				metadata: { format: query.format, lines: lines.length }
			});
			return render(ctx, query.format, {
				title: `Packliste ${r.title}`,
				intro: [
					`Zeitraum: ${formatDateDe(r.startsOn)} – ${formatDateDe(r.endsOn)}`,
					purposeText(r),
					`Reserviert von: ${r.createdByName}`,
					r.notes ? `Hinweis: ${r.notes}` : ''
				]
					.filter(Boolean)
					.join(' · '),
				tables: [
					{
						columns: [
							'Material',
							'Code',
							'Lagerort',
							'Zelt / Set',
							'Anzahl',
							...(pdf ? ['Gepackt', 'Zurück'] : [])
						],
						widths: pdf ? [26, 11, 20, 21, 7, 8, 7] : undefined,
						align: ['left', 'left', 'left', 'left', 'right', 'center', 'center'],
						rows: lines.map((l) => [
							l.name,
							l.code,
							l.place,
							l.group,
							l.quantity,
							...(pdf ? ['☐', '☐'] : [])
						])
					}
				],
				fileBase: `packliste-${r.title}`
			});
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/exports/reservations',
		summary: 'Reservierungen in einem Zeitraum (PDF oder CSV)',
		description: 'Alle Reservierungen mit Verwaltungsrecht, sonst nur die eigenen.',
		tags,
		permission: PERMISSIONS.view,
		body: reservationsExportInput,
		handler: async ({ ctx, body }) => {
			const scope = canManageReservations(ctx) ? 'all' : 'mine';
			const all: ReservationListItem[] = [];
			for (let offset = 0; offset < 2200; offset += 200) {
				const page = await listReservations(ctx, {
					scope,
					state: 'all',
					from: body.from,
					to: body.to,
					purpose: body.purpose ?? undefined,
					limit: 200,
					offset
				});
				all.push(...page.items);
				if (all.length >= page.total || !page.items.length) break;
			}
			const list = all.filter((r) => body.includeCancelled || r.status !== 'cancelled');
			list.sort(
				(a, b) => a.startsOn.localeCompare(b.startsOn) || a.title.localeCompare(b.title, 'de')
			);
			if (list.length > 2000)
				throw errors.validation([{ path: ['to'], message: 'Zeitraum zu groß' }]);
			const details = body.withLines
				? await Promise.all(list.map((r) => fullReservation(ctx, r.id)))
				: [];
			const lineText = (id: string, fallback: string) => {
				const d = details.find((x) => x.id === id);
				if (!d) return fallback;
				return d.lines
					.map((l) => (l.quantity > 1 ? `${l.quantity} × ${l.name}` : l.name))
					.join(', ');
			};
			const rowsOut = list.map((r) => [
				`${formatDateDe(r.startsOn)} – ${formatDateDe(r.endsOn)}`,
				r.title,
				purposeText(r),
				r.createdByName,
				lineText(r.id, r.itemSummary),
				RESERVATION_STATE_LABELS[r.state]
			]);
			await core.audit.logFromContext(ctx, 'material.reservations.exported', {
				metadata: { format: body.format, count: list.length }
			});
			return render(ctx, body.format, {
				title: 'Materialreservierungen',
				intro: `Zeitraum ${formatDateDe(body.from)} – ${formatDateDe(body.to)} · ${list.length} Reservierungen`,
				tables: [
					{
						columns: ['Zeitraum', 'Titel', 'Zweck', 'Reserviert von', 'Material', 'Status'],
						widths: [15, 17, 16, 13, 30, 9],
						rows: rowsOut
					}
				],
				fileBase: `reservierungen-${body.from}-${body.to}`
			});
		}
	})
];
