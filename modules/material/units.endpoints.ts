/**
 * Einzelstücke und Kisten: Liste mit Filtern, Detail mit Inhalt/Verlauf, Anlegen (auch mehrere),
 * Bearbeiten, Umlagern, Zustand, Ausmustern, Löschen, Packliste.
 * Feste Pfade (`/units/move`) stehen vor `/units/:id`.
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
import { blockedUnits } from './availability';
import {
	bool,
	claimCode,
	dateStr,
	iso,
	logMovement,
	mdb,
	nextCodes,
	num,
	rows,
	str,
	userNames
} from './db';
import {
	UNIT_SELECT,
	containedUnits,
	holderText,
	loadPlaceIndex,
	requireUnitRow,
	toUnitSummary,
	unitSummaries,
	type PlaceIndex
} from './inventory';
import { descendants, effectivePlace } from './places';
import { loadBookings } from './reservations.service';
import {
	CONDITION_LABELS,
	PERMISSIONS,
	conditionInput,
	idParams,
	moveInput,
	moveManyInput,
	targetsInput,
	unitInput,
	unitListQuery,
	unitUpdateInput,
	type ArticleKind,
	type Condition,
	type ContainerTarget,
	type Movement,
	type ReservationRef,
	type ReservationStatus,
	type StockEntry,
	type UnitDetail,
	type UnitSummary
} from './schemas';
import { z } from 'zod';

const tags = ['Modul: material'];

const MOVEMENT_LABELS: Record<string, string> = {
	created: 'Erfasst',
	moved: 'Umgelagert',
	issued: 'Ausgegeben',
	returned: 'Zurückgegeben',
	condition: 'Zustand geändert',
	retired: 'Ausgemustert',
	reactivated: 'Wieder aufgenommen',
	'set-added': 'Zum Set hinzugefügt',
	'set-removed': 'Aus Set entfernt',
	'stock-set': 'Bestand gezählt',
	'stock-moved': 'Bestand umgelagert',
	'stock-lost': 'Als verloren ausgebucht'
};

/** Ziel eines Stücks prüfen: Ort/Kiste existiert, Kiste ist eine Kiste und liegt nicht im Stück selbst */
export async function assertPlacement(
	tx: Tx,
	index: PlaceIndex,
	unitId: string | null,
	target: { locationId: string | null; containerId: string | null }
): Promise<void> {
	if (target.locationId && !index.locationPaths.has(target.locationId)) {
		throw errors.validation([{ path: ['locationId'], message: 'Lagerort nicht gefunden' }]);
	}
	if (target.containerId) {
		const c = index.units.get(target.containerId);
		if (!c || !c.isContainer) {
			throw errors.validation([{ path: ['containerId'], message: 'Kiste nicht gefunden' }]);
		}
		if (
			unitId &&
			(target.containerId === unitId || containedUnits(index, unitId).includes(target.containerId))
		) {
			throw errors.validation([
				{ path: ['containerId'], message: 'Eine Kiste kann nicht in sich selbst liegen' }
			]);
		}
	}
}

function placeLabel(
	index: PlaceIndex,
	t: { locationId: string | null; containerId: string | null }
) {
	return holderText(index, t);
}

async function loadStockFor(
	tx: Tx,
	index: PlaceIndex,
	where: { containerId?: string; locationId?: string }
): Promise<StockEntry[]> {
	const cond = where.containerId
		? sql`s.container_id = ${where.containerId}`
		: sql`s.location_id = ${where.locationId!}`;
	return (
		await rows(
			tx,
			sql`SELECT s.id, s.article_id, a.name, a.unit_label, s.location_id, s.container_id, s.quantity
				FROM stock s JOIN articles a ON a.id = s.article_id
				WHERE ${cond} AND s.quantity > 0 ORDER BY lower(a.name)`
		)
	).map((r) => {
		const holder = {
			locationId: r.location_id ? String(r.location_id) : null,
			containerId: r.container_id ? String(r.container_id) : null
		};
		return {
			id: String(r.id),
			articleId: String(r.article_id),
			articleName: String(r.name),
			unitLabel: str(r.unit_label) || 'Stück',
			...holder,
			holderName: holderText(index, holder),
			quantity: num(r.quantity)
		};
	});
}

async function loadDetail(
	tx: Tx,
	ctx: RequestContext,
	id: string
): Promise<Omit<UnitDetail, 'history'> & { history: (Movement & { actorId: string | null })[] }> {
	const row = await requireUnitRow(tx, id);
	const index = await loadPlaceIndex(tx);
	const summary = toUnitSummary(index, row);
	let contents: UnitDetail['contents'] = null;
	if (summary.isContainer) {
		const direct = [...index.units.values()].filter((u) => u.containerId === id).map((u) => u.id);
		const unitsIn = (await unitSummaries(tx, direct, index)).sort((a, b) =>
			a.name.localeCompare(b.name, 'de')
		);
		const stockIn = await loadStockFor(tx, index, { containerId: id });
		const targetRows = await rows(
			tx,
			sql`SELECT t.article_id, a.name, a.kind, a.unit_label, t.quantity
				FROM container_targets t JOIN articles a ON a.id = t.article_id
				WHERE t.container_id = ${id} ORDER BY lower(a.name)`
		);
		const targets: ContainerTarget[] = targetRows.map((t) => {
			const articleId = String(t.article_id);
			const kind = String(t.kind) as ArticleKind;
			const actual =
				kind === 'bulk'
					? stockIn.filter((s) => s.articleId === articleId).reduce((s, x) => s + x.quantity, 0)
					: unitsIn.filter((u) => u.articleId === articleId && !u.retired && u.condition !== 'lost')
							.length;
			return {
				articleId,
				articleName: String(t.name),
				kind,
				unitLabel: str(t.unit_label) || 'Stück',
				target: num(t.quantity),
				actual
			};
		});
		contents = { units: unitsIn, stock: stockIn, targets };
	}
	const history = (
		await rows(
			tx,
			sql`SELECT id, kind, quantity, detail, note, actor_id, reservation_id, created_at
				FROM movements WHERE unit_id = ${id} ORDER BY created_at DESC, id LIMIT 100`
		)
	).map((m) => ({
		id: String(m.id),
		kind: String(m.kind),
		label: [MOVEMENT_LABELS[String(m.kind)] ?? String(m.kind), str(m.detail)]
			.filter(Boolean)
			.join(': '),
		quantity: m.quantity == null ? null : num(m.quantity),
		note: str(m.note),
		actorName: '',
		actorId: m.actor_id ? String(m.actor_id) : null,
		createdAt: iso(m.created_at),
		reservationId: m.reservation_id ? String(m.reservation_id) : null
	}));
	const reservations = await reservationsOfUnit(tx, id, summary.setId);
	void ctx;
	return {
		...summary,
		conditionNote: str(row.condition_note),
		purchasedOn: row.purchased_on ? dateStr(row.purchased_on) : null,
		valueCents: row.value_cents == null ? null : num(row.value_cents),
		notes: str(row.notes),
		createdAt: iso(row.created_at),
		contents,
		history,
		reservations
	};
}

async function reservationsOfUnit(
	tx: Tx,
	unitId: string,
	setId: string | null
): Promise<ReservationRef[]> {
	const list = await rows(
		tx,
		sql`SELECT DISTINCT r.id, r.title, r.status, to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on,
				to_char(r.ends_on, 'YYYY-MM-DD') AS ends_on
			FROM reservations r
			LEFT JOIN reservation_lines l ON l.reservation_id = r.id
			LEFT JOIN reservation_units ru ON ru.reservation_id = r.id
			WHERE r.status IN ('reserved', 'issued')
				AND (l.unit_id = ${unitId} OR (${setId}::uuid IS NOT NULL AND l.set_id = ${setId}::uuid)
					OR (ru.unit_id = ${unitId} AND ru.returned_at IS NULL))
			ORDER BY starts_on`
	);
	return list.map((r) => ({
		id: String(r.id),
		title: String(r.title),
		startsOn: dateStr(r.starts_on),
		endsOn: dateStr(r.ends_on),
		status: String(r.status) as ReservationStatus
	}));
}

async function withActorNames(
	ctx: RequestContext,
	d: Awaited<ReturnType<typeof loadDetail>>
): Promise<UnitDetail> {
	const names = await userNames(
		ctx,
		d.history.map((h) => h.actorId)
	);
	return {
		...d,
		history: d.history.map(({ actorId, ...h }) => ({
			...h,
			actorName: actorId ? (names.get(actorId) ?? 'Unbekannt') : 'System'
		}))
	};
}

/** Stück an einen neuen Ort legen (ohne Prüfung) + Verlauf */
async function moveUnit(
	tx: Tx,
	ctx: RequestContext,
	index: PlaceIndex,
	unitId: string,
	target: { locationId: string | null; containerId: string | null },
	note = ''
): Promise<void> {
	await tx.execute(
		sql`UPDATE units SET location_id = ${target.locationId}, container_id = ${target.containerId},
				updated_at = now()
			WHERE id = ${unitId}`
	);
	await logMovement(tx, ctx, {
		kind: 'moved',
		unitId,
		detail: `nach ${placeLabel(index, target)}`,
		note
	});
}

export const unitsEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/units',
		summary: 'Stücke und Kisten (gefiltert)',
		description:
			'`deep=1` mit `locationId` zeigt auch Unterorte und den Inhalt der Kisten dort. ' +
			'`from`/`to` zeigt nur Stücke, die im Zeitraum frei sind.',
		tags,
		permission: PERMISSIONS.view,
		query: unitListQuery,
		handler: ({ query }) =>
			mdb().transaction(async (tx) => {
				const where = [sql`TRUE`];
				if (query.retired !== '1') where.push(sql`u.retired_at IS NULL`);
				if (query.articleId) where.push(sql`u.article_id = ${query.articleId}`);
				if (query.categoryId) where.push(sql`a.category_id = ${query.categoryId}`);
				if (query.containerId) where.push(sql`u.container_id = ${query.containerId}`);
				if (query.containers === '1') where.push(sql`u.is_container`);
				if (query.condition) where.push(sql`u.condition = ${query.condition}`);
				if (query.issued === '1') where.push(sql`u.issued_reservation_id IS NOT NULL`);
				if (query.unplaced === '1')
					where.push(sql`u.location_id IS NULL AND u.container_id IS NULL`);
				if (query.locationId && query.deep !== '1')
					where.push(sql`u.location_id = ${query.locationId}`);
				if (query.search) {
					const like = `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
					where.push(sql`(u.code ILIKE ${like} OR u.label ILIKE ${like} OR a.name ILIKE ${like})`);
				}
				const index = await loadPlaceIndex(tx);
				let list = (
					await rows(
						tx,
						sql`${UNIT_SELECT} WHERE ${sql.join(where, sql` AND `)}
							ORDER BY lower(a.name), lower(u.label), u.code`
					)
				).map((r) => toUnitSummary(index, r));
				if (query.locationId && query.deep === '1') {
					const allowed = descendants(index.locationParents, query.locationId);
					allowed.add(query.locationId);
					list = list.filter((u) => {
						const loc = effectivePlace(index.units, u.id).locationId;
						return !!loc && allowed.has(loc);
					});
				}
				if (query.from && query.to) {
					const to = query.to < query.from ? query.from : query.to;
					const { bookings } = await loadBookings(tx, { from: query.from, to }, { index });
					const blocked = blockedUnits(bookings, query.from, to);
					list = list.filter(
						(u) => !blocked.has(u.id) && u.condition !== 'defect' && u.condition !== 'lost'
					);
				}
				return {
					total: list.length,
					items: list.slice(query.offset, query.offset + query.limit)
				};
			})
	}),

	defineEndpoint({
		method: 'POST',
		path: '/units/move',
		summary: 'Mehrere Stücke umlagern (z. B. Kiste packen, Inventur)',
		tags,
		permission: PERMISSIONS.manage,
		body: moveManyInput,
		handler: async ({ ctx, body }) => {
			const moved = await mdb().transaction(async (tx) => {
				const index = await loadPlaceIndex(tx);
				const ids = [...new Set(body.unitIds)];
				for (const id of ids) {
					if (!index.units.has(id)) throw errors.notFound('Stück nicht gefunden');
					await assertPlacement(tx, index, id, body);
				}
				for (const id of ids) await moveUnit(tx, ctx, index, id, body);
				return ids.length;
			});
			await core.audit.logFromContext(ctx, 'material.unit.moved', {
				metadata: { count: moved }
			});
			return { moved };
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/units/:id',
		summary: 'Stück/Kiste mit Inhalt, Verlauf und Reservierungen',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }) =>
			withActorNames(ctx, await mdb().transaction((tx) => loadDetail(tx, ctx, params.id)))
	}),

	defineEndpoint({
		method: 'POST',
		path: '/units',
		summary: 'Stück(e) erfassen',
		description:
			'`count` > 1 legt mehrere gleichartige Stücke an; mit `numbered` (oder `count` > 1) bekommen sie ' +
			'die Bezeichnung „<label> <Nummer>“ ab `numberFrom`. Codes werden automatisch vergeben, außer ' +
			'ein eigener `code` (nur einzeln) ist angegeben.',
		tags,
		permission: PERMISSIONS.manage,
		body: unitInput,
		handler: async ({ ctx, body }): Promise<UnitSummary[]> => {
			const created = await mdb().transaction(async (tx) => {
				const [article] = await rows(
					tx,
					sql`SELECT id, name, kind, archived_at FROM articles WHERE id = ${body.articleId}`
				);
				if (!article) throw errors.validation([{ path: ['articleId'], message: 'Artikel fehlt' }]);
				if (String(article.kind) !== 'unit') {
					throw errors.validation([
						{ path: ['articleId'], message: 'Für Mengenartikel den Bestand erfassen, keine Stücke' }
					]);
				}
				const index = await loadPlaceIndex(tx);
				await assertPlacement(tx, index, null, body);
				const codes = body.code
					? [await claimCode(tx, body.code)]
					: await nextCodes(tx, 'unit', body.count);
				const numbered = body.numbered || body.count > 1;
				const base = body.label || String(article.name);
				const ids: string[] = [];
				for (let i = 0; i < body.count; i++) {
					const id = crypto.randomUUID();
					const label = numbered
						? `${base} ${String(body.numberFrom + i).padStart(2, '0')}`
						: body.label;
					await tx.execute(
						sql`INSERT INTO units (id, article_id, code, label, is_container, container_id, location_id,
								condition, condition_note, purchased_on, value_cents, notes, created_by)
							VALUES (${id}, ${body.articleId}, ${codes[i]!}, ${label}, ${body.isContainer},
								${body.containerId}, ${body.locationId}, ${body.condition}, ${body.conditionNote},
								${body.purchasedOn}, ${body.valueCents}, ${body.notes}, ${ctx.userId ?? null})`
					);
					await logMovement(tx, ctx, {
						kind: 'created',
						unitId: id,
						detail: placeLabel(index, body)
					});
					ids.push(id);
				}
				return unitSummaries(tx, ids);
			});
			await core.audit.logFromContext(ctx, 'material.unit.created', {
				target: created[0]?.id,
				metadata: { count: created.length, articleId: body.articleId }
			});
			return created;
		}
	}),

	defineEndpoint({
		method: 'PATCH',
		path: '/units/:id',
		summary: 'Stück bearbeiten',
		description: 'Ort über `/units/:id/move`, Zustand über `/units/:id/condition`.',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: unitUpdateInput,
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				const row = await requireUnitRow(tx, params.id);
				const sets = [sql`updated_at = now()`];
				if (body.label !== undefined) sets.push(sql`label = ${body.label}`);
				if (body.code !== undefined && body.code !== String(row.code)) {
					await claimCode(tx, body.code, params.id);
					sets.push(sql`code = ${body.code}`);
				}
				if (body.isContainer !== undefined) {
					if (!body.isContainer) {
						const [c] = await rows(
							tx,
							sql`SELECT
								(SELECT count(*) FROM units WHERE container_id = ${params.id}) +
								(SELECT count(*) FROM stock WHERE container_id = ${params.id} AND quantity > 0) AS n`
						);
						if (num(c?.n) > 0) throw errors.conflict('Die Kiste ist nicht leer');
						await tx.execute(sql`DELETE FROM stock WHERE container_id = ${params.id}`);
						await tx.execute(sql`DELETE FROM container_targets WHERE container_id = ${params.id}`);
					}
					sets.push(sql`is_container = ${body.isContainer}`);
				}
				if (body.conditionNote !== undefined)
					sets.push(sql`condition_note = ${body.conditionNote}`);
				if (body.purchasedOn !== undefined) sets.push(sql`purchased_on = ${body.purchasedOn}`);
				if (body.valueCents !== undefined) sets.push(sql`value_cents = ${body.valueCents}`);
				if (body.notes !== undefined) sets.push(sql`notes = ${body.notes}`);
				if (body.articleId !== undefined && body.articleId !== String(row.article_id)) {
					const [a] = await rows(tx, sql`SELECT kind FROM articles WHERE id = ${body.articleId}`);
					if (!a || String(a.kind) !== 'unit') {
						throw errors.validation([
							{ path: ['articleId'], message: 'Artikel mit Einzelstücken wählen' }
						]);
					}
					sets.push(sql`article_id = ${body.articleId}`);
				}
				await tx.execute(sql`UPDATE units SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`);
			});
			await core.audit.logFromContext(ctx, 'material.unit.updated', {
				target: params.id,
				metadata: { fields: Object.keys(body).sort() }
			});
			return withActorNames(ctx, await mdb().transaction((tx) => loadDetail(tx, ctx, params.id)));
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/units/:id/move',
		summary: 'Stück umlagern (Lagerort oder Kiste; beides leer = ohne Ort)',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: moveInput,
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				await requireUnitRow(tx, params.id);
				const index = await loadPlaceIndex(tx);
				await assertPlacement(tx, index, params.id, body);
				await moveUnit(tx, ctx, index, params.id, body, body.note);
			});
			await core.audit.logFromContext(ctx, 'material.unit.moved', { target: params.id });
			return withActorNames(ctx, await mdb().transaction((tx) => loadDetail(tx, ctx, params.id)));
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/units/:id/condition',
		summary: 'Zustand setzen (z. B. Schaden melden)',
		description: 'Auch mit Reservierungsrecht erlaubt (Schaden melden).',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		body: conditionInput,
		handler: async ({ ctx, params, body }) => {
			if (!ctx.permissions.has(PERMISSIONS.manage) && !ctx.permissions.has(PERMISSIONS.reserve)) {
				throw errors.forbidden('Keine Berechtigung');
			}
			await mdb().transaction(async (tx) => {
				const row = await requireUnitRow(tx, params.id);
				await tx.execute(
					sql`UPDATE units SET condition = ${body.condition}, condition_note = ${body.note},
							updated_at = now()
						WHERE id = ${params.id}`
				);
				await logMovement(tx, ctx, {
					kind: 'condition',
					unitId: params.id,
					detail: `${CONDITION_LABELS[String(row.condition) as Condition]} → ${CONDITION_LABELS[body.condition]}`,
					note: body.note
				});
			});
			await core.audit.logFromContext(ctx, 'material.unit.condition-changed', {
				target: params.id,
				metadata: { condition: body.condition }
			});
			return withActorNames(ctx, await mdb().transaction((tx) => loadDetail(tx, ctx, params.id)));
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/units/:id/retire',
		summary: 'Stück ausmustern bzw. wieder aufnehmen',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: z.object({ retired: z.boolean(), note: z.string().trim().max(1000).default('') }),
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				const row = await requireUnitRow(tx, params.id);
				if (body.retired && row.issued_reservation_id) {
					throw errors.conflict('Das Stück ist gerade ausgegeben');
				}
				await tx.execute(
					sql`UPDATE units SET retired_at = ${body.retired ? sql`coalesce(retired_at, now())` : sql`NULL`},
							updated_at = now()
						WHERE id = ${params.id}`
				);
				if (body.retired) await tx.execute(sql`DELETE FROM set_units WHERE unit_id = ${params.id}`);
				await logMovement(tx, ctx, {
					kind: body.retired ? 'retired' : 'reactivated',
					unitId: params.id,
					note: body.note
				});
			});
			await core.audit.logFromContext(
				ctx,
				body.retired ? 'material.unit.retired' : 'material.unit.reactivated',
				{ target: params.id }
			);
			return withActorNames(ctx, await mdb().transaction((tx) => loadDetail(tx, ctx, params.id)));
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/units/:id/targets',
		summary: 'Packliste (Soll-Inhalt) einer Kiste ersetzen',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: targetsInput,
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				const row = await requireUnitRow(tx, params.id);
				if (!bool(row.is_container)) throw errors.conflict('Nur Kisten haben eine Packliste');
				await tx.execute(sql`DELETE FROM container_targets WHERE container_id = ${params.id}`);
				for (const t of body.targets) {
					const [a] = await rows(tx, sql`SELECT id FROM articles WHERE id = ${t.articleId}`);
					if (!a) throw errors.validation([{ path: ['targets'], message: 'Artikel fehlt' }]);
					await tx.execute(
						sql`INSERT INTO container_targets (container_id, article_id, quantity)
							VALUES (${params.id}, ${t.articleId}, ${t.quantity})`
					);
				}
			});
			await core.audit.logFromContext(ctx, 'material.unit.targets-updated', {
				target: params.id,
				metadata: { count: body.targets.length }
			});
			return withActorNames(ctx, await mdb().transaction((tx) => loadDetail(tx, ctx, params.id)));
		}
	}),

	defineEndpoint({
		method: 'DELETE',
		path: '/units/:id',
		summary: 'Stück löschen (nur ohne Reservierungen; sonst ausmustern)',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				await requireUnitRow(tx, params.id);
				const [r] = await rows(
					tx,
					sql`SELECT
						(SELECT count(*) FROM reservation_lines WHERE unit_id = ${params.id}) +
						(SELECT count(*) FROM reservation_units WHERE unit_id = ${params.id}) AS used,
						(SELECT count(*) FROM units WHERE container_id = ${params.id}) +
						(SELECT count(*) FROM stock WHERE container_id = ${params.id} AND quantity > 0) AS content`
				);
				if (num(r?.used) > 0) {
					throw errors.conflict('Das Stück war schon reserviert – bitte ausmustern statt löschen');
				}
				if (num(r?.content) > 0) throw errors.conflict('Die Kiste ist nicht leer');
				await tx.execute(sql`DELETE FROM stock WHERE container_id = ${params.id}`);
				await tx.execute(sql`DELETE FROM units WHERE id = ${params.id}`);
			});
			await core.audit.logFromContext(ctx, 'material.unit.deleted', { target: params.id });
			return { deleted: true };
		}
	})
];
