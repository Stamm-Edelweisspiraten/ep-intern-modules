/**
 * Übersicht (`/dashboard`): Gruppenstunden im Wochenstreifen („Diese Woche“) und Daten für die Kachel
 * „Meine Gruppe“ (Gruppenleitung).
 *
 * - Gruppenstunden aus Wochentag/Uhrzeit der Gruppen (a) der eigenen, verknüpften, nicht ausgetretenen
 *   Mitglieder (`members.own.view`, Zusatz = Vornamen) und (b) der selbst geleiteten Gruppen
 *   (`members.led-member.view`, Bereich `ledGroupIds`, Zusatz = Anzahl aktiver Mitglieder).
 * - Keine Gesundheitsdaten, keine Kontaktdaten. Core-Aufrufe nie in einer offenen Transaktion.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	inList,
	moduleDb,
	type ModuleDashboardSources,
	type RequestContext,
	rowsOf
} from '$lib/sdk/server';
import { addDays, daysBetween, todayBerlin } from '$lib/sdk/dates';
import type { DashboardAgendaItem } from '$lib/sdk/types/dashboard';
import { ledGroupIds } from './leader.service';
import { LED_VIEW, MODULE_ID, type LedGroupOverview } from './schemas';

const OWN_VIEW = 'members.own.view';
/** Geburtstage in so vielen Tagen oder weniger erscheinen in „Meine Gruppe“ */
export const BIRTHDAY_DAYS = 14;

/** Mitglied zählt: nicht ausgetreten (bis einschließlich `today`), nicht anonymisiert */
const active = (alias: string, today: string) => {
	const a = sql.raw(alias);
	return sql`${a}.anonymized_at IS NULL AND (${a}.exit_date IS NULL OR ${a}.exit_date > ${today}::date)`;
};

/** ISO-Wochentag (1 = Mo … 7 = So) eines `YYYY-MM-DD` */
export function isoWeekday(day: string): number {
	const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
	return wd === 0 ? 7 : wd;
}

/** Nächster Tag ab `from` (inklusive) mit dem Wochentag `weekday` */
export function nextWeekdayFrom(from: string, weekday: number): string {
	return addDays(from, (weekday - isoWeekday(from) + 7) % 7);
}

function weekdayOf(v: unknown): number | null {
	const n = Number(v);
	return v != null && v !== '' && Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
}

/** `HH:MM` aus `HH:MM[:SS]`, sonst `null` */
function timeOf(v: unknown): string | null {
	const m = /^(\d{1,2}):(\d{2})/.exec(typeof v === 'string' ? v.trim() : '');
	return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null;
}

/** Ende nur, wenn nach dem Beginn */
const endOf = (start: string | null, end: string | null) =>
	start && end && end > start ? end : null;

/**
 * Nächster Geburtstag ab `today` (0 = heute); 29.02. zählt in Nicht-Schaltjahren am 28.02.
 * Rückgabe Datum, Tage bis dahin und Alter an diesem Tag.
 */
export function nextBirthday(
	birthDate: string,
	today: string
): { date: string; days: number; age: number } | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
	if (!m) return null;
	const [by, bm, bd] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const at = (year: number) => {
		const last = new Date(Date.UTC(year, bm, 0)).getUTCDate();
		const day = Math.min(bd, last);
		return `${year}-${String(bm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	};
	let year = Number(today.slice(0, 4));
	if (at(year) < today) year += 1;
	const date = at(year);
	return { date, days: daysBetween(today, date), age: year - by };
}

interface GroupInfo {
	id: string;
	name: string;
	weekday: number | null;
	time: string | null;
	endTime: string | null;
	place: string | null;
}

async function loadGroups(ids: readonly string[]): Promise<Map<string, GroupInfo>> {
	if (!ids.length) return new Map();
	const rows = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT id, name, meeting_weekday, meeting_time, meeting_end_time, meeting_place
				FROM groups WHERE id IN (${inList([...ids])}) ORDER BY name, id`
		)
	);
	return new Map(
		rows.map((r) => {
			const time = timeOf(r.meeting_time);
			return [
				String(r.id),
				{
					id: String(r.id),
					name: String(r.name),
					weekday: weekdayOf(r.meeting_weekday),
					time,
					endTime: endOf(time, timeOf(r.meeting_end_time)),
					place: typeof r.meeting_place === 'string' ? r.meeting_place.trim() || null : null
				}
			];
		})
	);
}

/** Anzahl aktiver Mitglieder je Gruppe */
async function memberCounts(ids: readonly string[], today: string): Promise<Map<string, number>> {
	if (!ids.length) return new Map();
	const rows = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT mg.group_id, count(*) AS n FROM member_groups mg
				JOIN members m ON m.id = mg.member_id
				WHERE mg.group_id IN (${inList([...ids])}) AND ${active('m', today)}
				GROUP BY mg.group_id`
		)
	);
	return new Map(rows.map((r) => [String(r.group_id), Number(r.n)]));
}

/** Gruppen der eigenen, verknüpften, aktiven Mitglieder → Vornamen je Gruppe */
async function ownMemberGroups(userId: string, today: string): Promise<Map<string, string[]>> {
	const rows = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT mg.group_id, m.first_name FROM member_user_links l
				JOIN members m ON m.id = l.member_id
				JOIN member_groups mg ON mg.member_id = m.id
				WHERE l.user_id = ${userId} AND ${active('m', today)}
				ORDER BY m.first_name, m.id`
		)
	);
	const out = new Map<string, string[]>();
	for (const r of rows) {
		const list = out.get(String(r.group_id)) ?? [];
		const name = String(r.first_name);
		if (!list.includes(name)) list.push(name);
		out.set(String(r.group_id), list);
	}
	return out;
}

const joinNames = (names: string[]) =>
	names.length <= 1
		? (names[0] ?? '')
		: `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;

const countText = (n: number) => (n === 1 ? '1 Mitglied' : `${n} Mitglieder`);

export const membersDashboard: ModuleDashboardSources = {
	agenda: {
		anyPermission: [OWN_VIEW, LED_VIEW],
		async run(ctx, { today, from, to }) {
			if (!ctx.userId) return [];
			const own = core.permissions.has(ctx, OWN_VIEW)
				? await ownMemberGroups(ctx.userId, today)
				: new Map<string, string[]>();
			const led = core.permissions.has(ctx, LED_VIEW) ? await ledGroupIds(ctx) : [];
			const ids = [...new Set([...led, ...own.keys()])];
			const groups = await loadGroups(ids);
			const counts = await memberCounts(led, today);

			const items: DashboardAgendaItem[] = [];
			for (const g of groups.values()) {
				if (!g.weekday) continue;
				const leads = led.includes(g.id);
				const detail = leads ? countText(counts.get(g.id) ?? 0) : joinNames(own.get(g.id) ?? []);
				const href = leads
					? `/modules/members?${new URLSearchParams({ groupId: g.id })}`
					: '/profile';
				for (let day = nextWeekdayFrom(from, g.weekday); day <= to; day = addDays(day, 7)) {
					items.push({
						id: `${g.id}:${day}`,
						kind: 'meeting',
						title: `Gruppenstunde ${g.name}`,
						date: day,
						startTime: g.time,
						endTime: g.endTime,
						detail: detail || undefined,
						href,
						groupIds: [g.id]
					});
				}
			}
			return items;
		}
	}
};

/**
 * Daten der Kachel „Meine Gruppe“: je selbst geleiteter Gruppe Name, aktive Mitglieder, nächste
 * Gruppenstunde und Geburtstage der nächsten `BIRTHDAY_DAYS` Tage (nur Name, Alter, Datum).
 */
export async function ledGroupOverview(ctx: RequestContext): Promise<LedGroupOverview> {
	const today = todayBerlin();
	const led = await ledGroupIds(ctx);
	if (!led.length) return { today, groups: [] };
	const groups = await loadGroups(led);
	const counts = await memberCounts(led, today);
	const rows = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT DISTINCT mg.group_id, m.id, m.first_name, m.last_name, m.scout_name,
					to_char(m.birth_date, 'YYYY-MM-DD') AS birth_date
				FROM member_groups mg JOIN members m ON m.id = mg.member_id
				WHERE mg.group_id IN (${inList(led)}) AND ${active('m', today)}`
		)
	);
	const limit = addDays(today, BIRTHDAY_DAYS);
	return {
		today,
		groups: [...groups.values()].map((g) => {
			const birthdays = rows
				.filter((r) => String(r.group_id) === g.id)
				.flatMap((r) => {
					const b = nextBirthday(String(r.birth_date ?? ''), today);
					if (!b || b.date > limit) return [];
					return [
						{
							memberId: String(r.id),
							firstName: String(r.first_name),
							lastName: String(r.last_name),
							scoutName: r.scout_name == null ? null : String(r.scout_name) || null,
							date: b.date,
							days: b.days,
							age: b.age
						}
					];
				})
				.sort((a, b) => a.days - b.days || a.firstName.localeCompare(b.firstName, 'de'));
			return {
				id: g.id,
				name: g.name,
				memberCount: counts.get(g.id) ?? 0,
				meetingWeekday: g.weekday,
				meetingTime: g.time,
				meetingEndTime: g.endTime,
				meetingPlace: g.place,
				nextMeeting: g.weekday ? nextWeekdayFrom(today, g.weekday) : null,
				birthdays
			};
		})
	};
}
