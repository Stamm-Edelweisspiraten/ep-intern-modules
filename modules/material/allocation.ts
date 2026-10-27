/**
 * Zuteilung konkreter Stücke zu einer Anzahl-Anfrage („8 Kohtenbahnen“) und Vollständigkeit von Sets
 * (rein, ohne Server-Imports).
 */

export interface Candidate {
	unitId: string;
	/** Set, zu dem das Stück gehört (oder `null` = lose) */
	setId: string | null;
	setName: string | null;
	/** Anzahl nutzbarer Stücke dieses Artikels im Set (für „ganzes Set nehmen“) */
	setSize: number;
}

export interface Allocation {
	unitIds: string[];
	/** Sets, aus denen nur ein Teil genommen wird (sie werden aufgeteilt) */
	splitSets: string[];
	missing: number;
}

/**
 * Wählt `needed` Stücke aus freien Kandidaten. Reihenfolge, damit möglichst wenige Sets aufgeteilt werden:
 * 1. ganze Sets, die vollständig in den Rest passen (größte zuerst),
 * 2. lose Stücke,
 * 3. Teil eines Sets – zuerst aus Sets, die ohnehin schon unvollständig verfügbar sind (kleinste Restmenge).
 */
export function allocate(candidates: readonly Candidate[], needed: number): Allocation {
	let rest = Math.max(0, Math.floor(needed));
	const chosen: string[] = [];
	const loose = candidates.filter((c) => !c.setId);
	const bySet = new Map<string, Candidate[]>();
	for (const c of candidates) {
		if (!c.setId) continue;
		const list = bySet.get(c.setId);
		if (list) list.push(c);
		else bySet.set(c.setId, [c]);
	}
	const groups = [...bySet.values()].sort(
		(a, b) => b.length - a.length || (a[0]!.setName ?? '').localeCompare(b[0]!.setName ?? '')
	);
	const used = new Set<string>();

	// 1. ganze Sets (alle freien Stücke des Sets, und das Set ist dabei vollständig frei)
	for (const g of groups) {
		if (rest <= 0) break;
		const whole = g.length >= g[0]!.setSize;
		if (whole && g.length <= rest) {
			for (const c of g) chosen.push(c.unitId);
			used.add(g[0]!.setId!);
			rest -= g.length;
		}
	}
	// 2. lose Stücke
	for (const c of loose) {
		if (rest <= 0) break;
		chosen.push(c.unitId);
		rest--;
	}
	// 3. Rest aus Sets (aufteilen) – bereits unvollständige zuerst, dann kleinste
	const splitSets: string[] = [];
	const remaining = groups
		.filter((g) => !used.has(g[0]!.setId!))
		.sort((a, b) => {
			const aBroken = a.length < a[0]!.setSize ? 0 : 1;
			const bBroken = b.length < b[0]!.setSize ? 0 : 1;
			return aBroken - bBroken || a.length - b.length;
		});
	for (const g of remaining) {
		if (rest <= 0) break;
		const take = g.slice(0, rest);
		for (const c of take) chosen.push(c.unitId);
		rest -= take.length;
		if (take.length < g[0]!.setSize) splitSets.push(g[0]!.setName ?? 'Set');
	}
	return { unitIds: chosen, splitSets, missing: rest };
}

export interface CompletenessUnit {
	articleId: string;
	articleName: string;
	usable: boolean;
}

export interface TemplatePart {
	articleId: string;
	articleName: string;
	quantity: number;
}

/** Vollständigkeit eines Sets gegen seine Vorlage */
export function completeness(
	parts: readonly TemplatePart[],
	units: readonly CompletenessUnit[]
): {
	complete: boolean;
	missing: { articleId: string; articleName: string; count: number }[];
	extra: { articleId: string; articleName: string; count: number }[];
	unusable: number;
} {
	const usable = new Map<string, number>();
	const all = new Map<string, { name: string; count: number }>();
	let unusable = 0;
	for (const u of units) {
		const a = all.get(u.articleId);
		if (a) a.count++;
		else all.set(u.articleId, { name: u.articleName, count: 1 });
		if (u.usable) usable.set(u.articleId, (usable.get(u.articleId) ?? 0) + 1);
		else unusable++;
	}
	const missing = parts
		.map((p) => ({
			articleId: p.articleId,
			articleName: p.articleName,
			count: p.quantity - (usable.get(p.articleId) ?? 0)
		}))
		.filter((m) => m.count > 0);
	const wanted = new Map(parts.map((p) => [p.articleId, p.quantity]));
	const extra = [...all.entries()]
		.map(([articleId, a]) => ({
			articleId,
			articleName: a.name,
			count: a.count - (wanted.get(articleId) ?? 0)
		}))
		.filter((e) => e.count > 0);
	return { complete: missing.length === 0, missing, extra, unusable };
}
