/**
 * Orte und Kisten als Bäume (rein): Pfade der Lagerorte, effektiver Ort eines Stücks über die
 * Kisten-Kette, Schutz vor Zyklen.
 */

export const PATH_SEPARATOR = ' › ';

export interface TreeNode {
	id: string;
	parentId: string | null;
	name: string;
}

/** Voller Pfad je Lagerort („Materialraum › Regal A“); kaputte Zyklen brechen ab */
export function locationPaths(nodes: readonly TreeNode[]): Map<string, string> {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const out = new Map<string, string>();
	for (const n of nodes) {
		const parts: string[] = [];
		const seen = new Set<string>();
		let cur: TreeNode | undefined = n;
		while (cur && !seen.has(cur.id)) {
			seen.add(cur.id);
			parts.unshift(cur.name);
			cur = cur.parentId ? byId.get(cur.parentId) : undefined;
		}
		out.set(n.id, parts.join(PATH_SEPARATOR));
	}
	return out;
}

/** Würde `id` unter `newParentId` einen Zyklus erzeugen (Elternteil ist der Knoten selbst oder ein Nachfahre)? */
export function wouldCycle(
	parents: ReadonlyMap<string, string | null>,
	id: string,
	newParentId: string | null
): boolean {
	const seen = new Set<string>();
	let cur = newParentId;
	while (cur) {
		if (cur === id) return true;
		if (seen.has(cur)) return true;
		seen.add(cur);
		cur = parents.get(cur) ?? null;
	}
	return false;
}

/** Alle Nachfahren eines Knotens (ohne ihn selbst) */
export function descendants(parents: ReadonlyMap<string, string | null>, id: string): Set<string> {
	const children = new Map<string, string[]>();
	for (const [child, parent] of parents) {
		if (!parent) continue;
		const list = children.get(parent);
		if (list) list.push(child);
		else children.set(parent, [child]);
	}
	const out = new Set<string>();
	const stack = [...(children.get(id) ?? [])];
	while (stack.length) {
		const next = stack.pop()!;
		if (out.has(next) || next === id) continue;
		out.add(next);
		stack.push(...(children.get(next) ?? []));
	}
	return out;
}

export interface Placed {
	id: string;
	containerId: string | null;
	locationId: string | null;
}

/**
 * Effektiver Lagerort eines Stücks: eigener Ort oder der Ort der äußersten Kiste.
 * Liefert außerdem die Kisten-Kette von innen nach außen.
 */
export function effectivePlace(
	byId: ReadonlyMap<string, Placed>,
	id: string
): { locationId: string | null; chain: string[] } {
	const chain: string[] = [];
	const seen = new Set<string>([id]);
	let cur = byId.get(id);
	while (cur?.containerId && !seen.has(cur.containerId)) {
		chain.push(cur.containerId);
		seen.add(cur.containerId);
		cur = byId.get(cur.containerId);
	}
	return { locationId: cur?.locationId ?? null, chain };
}
