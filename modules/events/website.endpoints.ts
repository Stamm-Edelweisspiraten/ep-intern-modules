import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type ApiEndpoint } from '$lib/sdk/server';
import { rowsOf } from './access';
import {
	EVENT_COLUMNS,
	EVENT_ORDER,
	compareOccurrences,
	expandRow,
	hydrateRows,
	loadExceptions,
	singleOccurrence,
	todayBerlin,
	type OccurrenceRow
} from './events.service';
import { loadGroupMap } from './groups';
import { addDays } from './recurrence';
import {
	MAX_OCCURRENCES,
	MODULE_ID,
	OPEN_WINDOW_DAYS,
	websiteQuery,
	type WebsiteEvent
} from './schemas';

/** Heutiges Datum in Europe/Berlin (liegt in `events.service.ts`, hier für bestehende Importe) */
export { todayBerlin };

/** Höchstzahl Kandidaten-Zeilen (einmalige Termine + Serien) vor dem Expandieren */
const WEBSITE_ROW_CAP = 5000;

export const websiteEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/website/events',
		summary: 'Termine für die Stammeswebsite (API-Key mit Scope events.website.read)',
		description:
			'Liefert nur Termine mit „auf der Website“, die den Zeitraum ab `from` (Standard: heute, ' +
			'Europe/Berlin) bis optional `to` berühren, sortiert nach Beginn. Serien erscheinen als ' +
			'einzelne Vorkommen (`recurring: true`, `occurrenceDate`; ohne `to` höchstens ein Jahr ' +
			'voraus), abgesagte Vorkommen fehlen. Nur öffentliche Felder: keine Freigaben, ' +
			'Eigentümer*innen oder Zeitstempel.',
		tags: ['Modul: events'],
		permission: 'events.website.read',
		query: websiteQuery,
		rateLimit: { limit: 120, windowSec: 60 },
		handler: async ({ ctx, query }) => {
			const from = query.from ?? todayBerlin();
			const to = query.to ?? null;
			if (to && to < from) throw errors.validation({ to: 'Das Enddatum liegt vor dem Startdatum' });
			const seriesTo = to ?? addDays(from, OPEN_WINDOW_DAYS);
			const tag = query.tag?.trim().toLowerCase() || null;

			const { rows, exceptions } = await core.database
				.forModule(MODULE_ID)
				.transaction(async (tx) => {
					const raw = await rowsOf(
						tx,
						sql`SELECT ${EVENT_COLUMNS} FROM events e
						WHERE e.on_website = true
							AND (
								(e.recurrence IS NULL
									AND COALESCE(e.ends_on, e.starts_on) >= ${from}::date
									${to ? sql`AND e.starts_on <= ${to}::date` : sql``})
								OR (e.recurrence IS NOT NULL
									AND e.starts_on <= ${seriesTo}::date
									AND (e.recurrence_until IS NULL OR
										e.recurrence_until + COALESCE(e.ends_on - e.starts_on, 0) >= ${from}::date))
							)
							${
								tag
									? sql`AND EXISTS (SELECT 1 FROM event_tags t
										WHERE t.event_id = e.id AND lower(t.tag) = ${tag})`
									: sql``
							}
						ORDER BY ${EVENT_ORDER}
						LIMIT ${WEBSITE_ROW_CAP}`
					);
					const rows = await hydrateRows(tx, raw);
					const exceptions = await loadExceptions(
						tx,
						rows.filter((r) => r.recurrence).map((r) => r.id)
					);
					return { rows, exceptions };
				});

			const all: OccurrenceRow[] = [];
			for (const row of rows) {
				if (row.recurrence) all.push(...expandRow(row, exceptions.get(row.id), from, seriesTo));
				else all.push(singleOccurrence(row));
			}
			all.sort(compareOccurrences);
			const page = all.slice(0, Math.min(query.limit, MAX_OCCURRENCES));

			const groupMap = await loadGroupMap(ctx);
			return page.map((r): WebsiteEvent => ({
				id: r.id,
				title: r.title,
				description: r.description,
				location: r.location,
				color: r.color,
				startsOn: r.startsOn,
				startsTime: r.startsTime,
				endsOn: r.endsOn,
				endsTime: r.endsTime,
				tags: r.tags,
				// nur Namen – keine Treffen-Daten (meeting*) der Gruppen
				groups: [...groupMap.values()].filter((g) => r.groupIds.includes(g.id)).map((g) => g.name),
				recurring: !!r.recurrence,
				occurrenceDate: r.occurrenceDate
			}));
		}
	})
] as unknown as ApiEndpoint[];
