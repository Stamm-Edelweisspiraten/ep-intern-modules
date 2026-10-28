/**
 * Zuteilung konkreter Artikel zu einer Anzahl-Anfrage („8 Kohtenbahnen“, „Dach: 6 Kohtenbahnen je Jurte“)
 * – rein, ohne Server-Imports.
 *
 * Kandidaten sind die Artikel EINES Typs mit ihrer im Zeitraum freien Menge (Einzelstücke 0/1, Mengenartikel
 * mehr). Gehört ein Artikel zu einem Set, zählt die Gruppe „Set ∩ Typ“: Sie ist **ganz frei**, wenn jeder
 * nutzbare Artikel des Typs im Set vollständig frei ist.
 */

export interface Candidate {
	itemId: string;
	setId: string | null;
	setName: string | null;
	/** Im Zeitraum frei (≥ 0) */
	free: number;
	/** Nutzbare Anzahl des Artikels (für „ganz frei“) */
	capacity: number;
	/** Sortierung innerhalb einer Gruppe (Name/Code) */
	sortKey: string;
}

export interface Pick {
	itemId: string;
	quantity: number;
	/** Nummer des Zelts (0 … count−1) bei `slotSize`, sonst 0 */
	slot: number;
}

export interface Allocation {
	picks: Pick[];
	/** Nicht zuteilbar */
	missing: number;
	/** Nur mit `slotSize`: Zelte, deren Teil nicht aus genau einem Set kommt */
	mixedSlots: number;
}

interface Group {
	setId: string | null;
	setName: string;
	members: Candidate[];
	free: number;
	whole: boolean;
}

function groupsOf(candidates: readonly Candidate[]): { sets: Group[]; loose: Candidate[] } {
	const bySet = new Map<string, Candidate[]>();
	const loose: Candidate[] = [];
	for (const c of candidates) {
		if (c.capacity <= 0) continue;
		if (!c.setId) {
			loose.push(c);
			continue;
		}
		const list = bySet.get(c.setId);
		if (list) list.push(c);
		else bySet.set(c.setId, [c]);
	}
	const sets = [...bySet.entries()].map(([setId, members]) => {
		members.sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'de', { numeric: true }));
		return {
			setId,
			setName: members[0]!.setName ?? '',
			members,
			free: members.reduce((n, m) => n + m.free, 0),
			whole: members.every((m) => m.free >= m.capacity)
		};
	});
	loose.sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'de', { numeric: true }));
	return { sets, loose };
}

/** Bis zu `want` Einheiten aus den Kandidaten nehmen (verbraucht `left`) */
function take(
	members: readonly Candidate[],
	want: number,
	left: Map<string, number>,
	slot: number,
	out: Pick[]
): number {
	let got = 0;
	for (const m of members) {
		if (got >= want) break;
		const free = left.get(m.itemId) ?? 0;
		if (free <= 0) continue;
		const n = Math.min(free, want - got);
		left.set(m.itemId, free - n);
		out.push({ itemId: m.itemId, quantity: n, slot });
		got += n;
	}
	return got;
}

const freeOf = (members: readonly Candidate[], left: Map<string, number>) =>
	members.reduce((n, m) => n + (left.get(m.itemId) ?? 0), 0);

const byName = (a: Group, b: Group) => a.setName.localeCompare(b.setName, 'de', { numeric: true });

/**
 * Ohne `slotSize` (freie Anzahl): 1. ganze Sets, die vollständig in den Rest passen (größte zuerst),
 * 2. lose Artikel, 3. Rest aus Sets – angebrochene zuerst, dann kleinste.
 *
 * Mit `slotSize` (je Zelt ein Teil aus einem Set): je Zelt 1. ein ganz freies Set genau dieser Größe,
 * 2. das kleinste Set mit genug freien Einheiten (es wird angebrochen), sonst 3. zusammenstellen wie oben
 * (zählt als gemischt).
 */
export function allocate(
	candidates: readonly Candidate[],
	needed: number,
	opts: { slotSize?: number | null } = {}
): Allocation {
	const total = Math.max(0, Math.floor(needed));
	const left = new Map(candidates.map((c) => [c.itemId, Math.max(0, c.free)]));
	const { sets, loose } = groupsOf(candidates);
	const picks: Pick[] = [];
	const slotSize = opts.slotSize && opts.slotSize > 0 ? Math.floor(opts.slotSize) : null;

	if (slotSize) {
		const slots = Math.ceil(total / slotSize);
		let missing = 0;
		let mixedSlots = 0;
		for (let slot = 0; slot < slots; slot++) {
			const want = Math.min(slotSize, total - slot * slotSize);
			const exact = sets.filter((g) => g.whole && freeOf(g.members, left) === want).sort(byName)[0];
			const fitting =
				exact ??
				sets
					.filter((g) => freeOf(g.members, left) >= want)
					.sort((a, b) => freeOf(a.members, left) - freeOf(b.members, left) || byName(a, b))[0];
			if (fitting) {
				take(fitting.members, want, left, slot, picks);
				continue;
			}
			const got = fill(sets, loose, want, left, slot, picks);
			missing += want - got;
			// Kein Set reicht: gemischt – nur ein Hinweis wert, wenn es für den Typ überhaupt Sets gibt
			if (got > 0 && sets.length > 0) mixedSlots++;
		}
		return { picks: merge(picks), missing, mixedSlots };
	}

	const got = fill(sets, loose, total, left, 0, picks);
	return { picks: merge(picks), missing: total - got, mixedSlots: 0 };
}

/** Freie Anzahl verteilen: ganze Sets → lose → angebrochene Sets */
function fill(
	sets: Group[],
	loose: Candidate[],
	want: number,
	left: Map<string, number>,
	slot: number,
	picks: Pick[]
): number {
	let rest = want;
	const whole = sets
		.filter((g) => g.whole && freeOf(g.members, left) === g.free && g.free > 0)
		.sort((a, b) => b.free - a.free || byName(a, b));
	for (const g of whole) {
		if (rest <= 0) break;
		if (g.free > rest) continue;
		rest -= take(g.members, g.free, left, slot, picks);
	}
	if (rest > 0) rest -= take(loose, rest, left, slot, picks);
	if (rest > 0) {
		const remaining = sets
			.filter((g) => freeOf(g.members, left) > 0)
			.sort((a, b) => {
				const aBroken = freeOf(a.members, left) < a.free || !a.whole ? 0 : 1;
				const bBroken = freeOf(b.members, left) < b.free || !b.whole ? 0 : 1;
				return aBroken - bBroken || freeOf(a.members, left) - freeOf(b.members, left);
			});
		for (const g of remaining) {
			if (rest <= 0) break;
			rest -= take(g.members, rest, left, slot, picks);
		}
	}
	return want - rest;
}

/** Gleiche Artikel im gleichen Slot zusammenfassen */
function merge(picks: Pick[]): Pick[] {
	const out = new Map<string, Pick>();
	for (const p of picks) {
		const key = `${p.slot}:${p.itemId}`;
		const prev = out.get(key);
		if (prev) prev.quantity += p.quantity;
		else out.set(key, { ...p });
	}
	return [...out.values()];
}

export interface CompletenessUnit {
	itemId: string;
	typeId: string | null;
	quantity: number;
	usable: boolean;
}

/** Vollständigkeit eines Sets: nutzbare / alle Einheiten */
export function setCompleteness(units: readonly CompletenessUnit[]): {
	total: number;
	usable: number;
	complete: boolean;
} {
	const total = units.reduce((n, u) => n + u.quantity, 0);
	const usable = units.reduce((n, u) => n + (u.usable ? u.quantity : 0), 0);
	return { total, usable, complete: total > 0 && usable === total };
}
