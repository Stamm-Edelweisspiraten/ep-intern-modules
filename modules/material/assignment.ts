/**
 * Zuteilung konkreter Artikel zu allen Typ-Zeilen (rein, ohne Server-Imports).
 *
 * Fest stehen: Artikel-Zeilen, von Hand angeheftete Zuteilungen und die Zuteilungen eingefrorener
 * Reservierungen (ausgegeben oder schon begonnen). Umplanbare Typ-Zeilen werden nach Beginn sortiert der
 * Reihe nach verteilt (Greedy nach Startzeit). Eine bisherige Zuteilung bleibt, solange sie noch passt –
 * so wechseln die Bahnen nicht bei jeder Änderung. Bleibt dabei etwas offen, folgt ein zweiter Lauf ohne
 * diese Rücksicht; genommen wird der Lauf mit weniger Fehlmengen.
 */
import { allocate, type Candidate, type Pick } from './allocation';

export type { Pick } from './allocation';

export interface PlanItem {
	id: string;
	typeId: string | null;
	setId: string | null;
	setName: string | null;
	/** Nutzbare Anzahl (0 bei defekt/verloren/archiviert) */
	capacity: number;
	sortKey: string;
}

export interface Usage {
	itemId: string;
	startsOn: string;
	endsOn: string;
	quantity: number;
}

export interface PlanRequest {
	lineId: string;
	startsOn: string;
	endsOn: string;
	typeId: string;
	quantity: number;
	slotSize: number | null;
	/** Bisherige automatische Zuteilung */
	previous: Pick[];
	/** Angeheftet (zählen als fest, decken einen Teil der Anzahl) */
	pinned: Pick[];
	/** Eingefroren: bisherige Zuteilung bleibt; fehlt etwas und `fillMissing`, wird ergänzt */
	frozen: boolean;
	fillMissing: boolean;
}

/** Ergebnis je Zeile: automatische Zuteilung (ohne angeheftete) */
export type Plan = Map<string, Pick[]>;

const sum = (picks: readonly { quantity: number }[]) => picks.reduce((n, p) => n + p.quantity, 0);

class Usages {
	private readonly byItem = new Map<string, Usage[]>();

	add(u: Usage) {
		if (u.quantity <= 0) return;
		const list = this.byItem.get(u.itemId);
		if (list) list.push(u);
		else this.byItem.set(u.itemId, [u]);
	}

	/** Höchste Belegung an einem Tag im Zeitraum */
	maxUsed(itemId: string, from: string, to: string): number {
		const list = (this.byItem.get(itemId) ?? []).filter(
			(u) => u.startsOn <= to && u.endsOn >= from
		);
		if (!list.length) return 0;
		const days = new Set([from]);
		for (const u of list) if (u.startsOn > from) days.add(u.startsOn);
		let max = 0;
		for (const day of days) {
			const used = list.reduce(
				(n, u) => n + (u.startsOn <= day && u.endsOn >= day ? u.quantity : 0),
				0
			);
			max = Math.max(max, used);
		}
		return max;
	}
}

function pickUsages(r: { startsOn: string; endsOn: string }, picks: readonly Pick[]): Usage[] {
	return picks.map((p) => ({
		itemId: p.itemId,
		startsOn: r.startsOn,
		endsOn: r.endsOn,
		quantity: p.quantity
	}));
}

function run(
	items: Map<string, PlanItem>,
	byType: Map<string, PlanItem[]>,
	fixed: readonly Usage[],
	requests: readonly PlanRequest[],
	keepPrevious: boolean
): { plan: Plan; missing: number } {
	const usages = new Usages();
	for (const u of fixed) usages.add(u);
	for (const r of requests) {
		for (const u of pickUsages(r, r.pinned)) usages.add(u);
		if (r.frozen) for (const u of pickUsages(r, r.previous)) usages.add(u);
	}
	const free = (itemId: string, r: PlanRequest) => {
		const item = items.get(itemId);
		if (!item) return 0;
		return Math.max(0, item.capacity - usages.maxUsed(itemId, r.startsOn, r.endsOn));
	};

	const plan: Plan = new Map();
	let missing = 0;
	const order = [...requests].sort(
		(a, b) => a.startsOn.localeCompare(b.startsOn) || a.endsOn.localeCompare(b.endsOn)
	);
	for (const r of order) {
		const need = Math.max(0, r.quantity - sum(r.pinned));
		if (r.frozen) {
			const rest = need - sum(r.previous);
			let added: Pick[] = [];
			if (rest > 0 && r.fillMissing) {
				const result = allocate(candidates(byType, r, free), rest, {});
				added = result.picks;
				missing += result.missing;
				for (const u of pickUsages(r, added)) usages.add(u);
			} else if (rest > 0) {
				missing += rest;
			}
			plan.set(r.lineId, [...r.previous, ...added]);
			continue;
		}
		let picks: Pick[] | null = null;
		if (keepPrevious && sum(r.previous) === need && need > 0) {
			const perItem = new Map<string, number>();
			for (const p of r.previous) perItem.set(p.itemId, (perItem.get(p.itemId) ?? 0) + p.quantity);
			const valid = [...perItem.entries()].every(([itemId, qty]) => {
				const item = items.get(itemId);
				return !!item && item.typeId === r.typeId && free(itemId, r) >= qty;
			});
			if (valid) picks = r.previous.map((p) => ({ ...p }));
		}
		if (!picks) {
			const result = allocate(candidates(byType, r, free), need, { slotSize: r.slotSize });
			picks = result.picks;
			missing += result.missing;
		}
		for (const u of pickUsages(r, picks)) usages.add(u);
		plan.set(r.lineId, picks);
	}
	return { plan, missing };
}

function candidates(
	byType: Map<string, PlanItem[]>,
	r: PlanRequest,
	free: (itemId: string, r: PlanRequest) => number
): Candidate[] {
	return (byType.get(r.typeId) ?? []).map((i) => ({
		itemId: i.id,
		setId: i.setId,
		setName: i.setName,
		capacity: i.capacity,
		free: free(i.id, r),
		sortKey: i.sortKey
	}));
}

export function planAssignments(input: {
	items: readonly PlanItem[];
	fixed: readonly Usage[];
	requests: readonly PlanRequest[];
}): Plan {
	const items = new Map(input.items.map((i) => [i.id, i]));
	const byType = new Map<string, PlanItem[]>();
	for (const i of input.items) {
		if (!i.typeId || i.capacity <= 0) continue;
		const list = byType.get(i.typeId);
		if (list) list.push(i);
		else byType.set(i.typeId, [i]);
	}
	const first = run(items, byType, input.fixed, input.requests, true);
	if (first.missing === 0) return first.plan;
	const second = run(items, byType, input.fixed, input.requests, false);
	return second.missing < first.missing ? second.plan : first.plan;
}

/** Gleiche Zuteilung (Reihenfolge egal)? */
export function samePicks(a: readonly Pick[], b: readonly Pick[]): boolean {
	const key = (list: readonly Pick[]) =>
		list
			.map((p) => `${p.slot}:${p.itemId}:${p.quantity}`)
			.sort()
			.join('|');
	return key(a) === key(b);
}

export interface SlotInfo {
	/** Zelte (Slots), die nicht aus genau einem Set kommen */
	mixedSlots: number;
	slots: number;
}

/**
 * Hinweis „gemischt“ einer Teil-Zeile mit `slotSize`: ein Slot ist gemischt, wenn seine Artikel nicht alle
 * aus demselben Set stammen. Gibt es für den Typ gar keine Sets, ist nichts gemischt.
 */
export function slotInfo(
	picks: readonly { itemId: string; slot: number }[],
	setOf: (itemId: string) => string | null,
	slotSize: number | null,
	quantity: number,
	typeHasSets: boolean
): SlotInfo {
	if (!slotSize) return { mixedSlots: 0, slots: 0 };
	const slots = Math.ceil(quantity / slotSize);
	if (!typeHasSets) return { mixedSlots: 0, slots };
	let mixedSlots = 0;
	for (let s = 0; s < slots; s++) {
		const sources = new Set(picks.filter((p) => p.slot === s).map((p) => setOf(p.itemId) ?? '—'));
		if (sources.size > 1 || sources.has('—')) mixedSlots++;
	}
	return { mixedSlots, slots };
}
