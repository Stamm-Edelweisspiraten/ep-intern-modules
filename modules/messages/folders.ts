/**
 * Reine Logik für Ordner im Posteingang (ohne Server-/Svelte-Imports, in Tests und UI nutzbar):
 * Baum aufbauen, Tiefe, Pfad, Nachfahren, Zyklusprüfung beim Verschieben.
 */

export interface FolderRef {
	id: string;
	parentId: string | null;
	name: string;
}

export interface FolderNode<T extends FolderRef = FolderRef> {
	folder: T;
	depth: number;
	children: FolderNode<T>[];
}

const byName = (a: FolderRef, b: FolderRef) =>
	a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/**
 * Baum aus einer flachen Liste (alphabetisch je Ebene, Tiefe ab 1). Ordner mit unbekanntem
 * Elternordner landen oben (robust gegen Teil-Listen), Zyklen werden abgeschnitten.
 */
export function buildFolderTree<T extends FolderRef>(folders: T[]): FolderNode<T>[] {
	const ids = new Set(folders.map((f) => f.id));
	const byParent = new Map<string | null, T[]>();
	for (const f of folders) {
		const parent = f.parentId && ids.has(f.parentId) && f.parentId !== f.id ? f.parentId : null;
		const list = byParent.get(parent) ?? [];
		list.push(f);
		byParent.set(parent, list);
	}
	const seen = new Set<string>();
	const build = (parent: string | null, depth: number): FolderNode<T>[] =>
		(byParent.get(parent) ?? [])
			.slice()
			.sort(byName)
			.filter((f) => !seen.has(f.id) && (seen.add(f.id), true))
			.map((f) => ({ folder: f, depth, children: build(f.id, depth + 1) }));
	return build(null, 1);
}

/** Baum in Anzeige-Reihenfolge (Tiefensuche) als flache Liste mit Tiefe */
export function flattenFolderTree<T extends FolderRef>(
	nodes: FolderNode<T>[]
): { folder: T; depth: number }[] {
	const out: { folder: T; depth: number }[] = [];
	const walk = (list: FolderNode<T>[]) => {
		for (const n of list) {
			out.push({ folder: n.folder, depth: n.depth });
			walk(n.children);
		}
	};
	walk(nodes);
	return out;
}

/** Pfad von oben bis zum Ordner (inklusive); unbekannt → leer */
export function folderPath<T extends FolderRef>(folders: T[], id: string | null): T[] {
	if (!id) return [];
	const map = new Map(folders.map((f) => [f.id, f]));
	const path: T[] = [];
	const seen = new Set<string>();
	let cur = map.get(id);
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		path.unshift(cur);
		cur = cur.parentId ? map.get(cur.parentId) : undefined;
	}
	return path;
}

/** Ebene des Ordners (oberste Ebene = 1); unbekannt → 0 */
export function folderDepth(folders: FolderRef[], id: string | null): number {
	return folderPath(folders, id).length;
}

/** IDs aller Unterordner (beliebig tief, ohne den Ordner selbst) */
export function descendantIds(folders: FolderRef[], id: string): string[] {
	const out: string[] = [];
	const seen = new Set([id]);
	const queue = [id];
	while (queue.length) {
		const cur = queue.shift()!;
		for (const f of folders) {
			if (f.parentId === cur && !seen.has(f.id)) {
				seen.add(f.id);
				out.push(f.id);
				queue.push(f.id);
			}
		}
	}
	return out;
}

/** Höhe des Unterbaums (nur der Ordner selbst = 1) */
export function subtreeHeight(folders: FolderRef[], id: string): number {
	const children = folders.filter((f) => f.parentId === id && f.id !== id);
	return 1 + Math.max(0, ...children.map((c) => subtreeHeight(folders, c.id)));
}

/** Würde `id` unter `newParentId` einen Zyklus bilden (Ziel = Ordner selbst oder ein Unterordner)? */
export function wouldCycle(folders: FolderRef[], id: string, newParentId: string | null): boolean {
	if (!newParentId) return false;
	return newParentId === id || descendantIds(folders, id).includes(newParentId);
}

/** Gleicher Name auf derselben Ebene (Groß-/Kleinschreibung egal)? */
export function nameTaken(
	folders: FolderRef[],
	parentId: string | null,
	name: string,
	exceptId?: string
): boolean {
	const n = name.trim().toLowerCase();
	return folders.some(
		(f) => f.id !== exceptId && (f.parentId ?? null) === parentId && f.name.toLowerCase() === n
	);
}
