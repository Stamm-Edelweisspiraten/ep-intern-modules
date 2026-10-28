/**
 * Zelte (Bauplan aus Typen und Artikeln): in Teil-Zeilen auflösen und baubare Anzahl bestimmen
 * (rein, ohne Server-Imports).
 */
import type { AvailabilityIndex, Period, RequestLine } from './availability';

export interface TentPartSpec {
	label: string;
	typeId: string | null;
	itemId: string | null;
	/** Je Zelt */
	quantity: number;
	fromOneSet: boolean;
}

export interface ExpandedPart {
	label: string;
	typeId: string | null;
	itemId: string | null;
	/** Für alle Zelte zusammen */
	quantity: number;
	/** Je Zelt so viele Einheiten möglichst aus einem Set (nur Typen) */
	slotSize: number | null;
}

/** `count` Zelte → Teil-Zeilen (Reihenfolge der Teile bleibt) */
export function expandTent(parts: readonly TentPartSpec[], count: number): ExpandedPart[] {
	const n = Math.max(0, Math.floor(count));
	return parts.map((p) => ({
		label: p.label,
		typeId: p.typeId,
		itemId: p.itemId,
		quantity: p.quantity * n,
		slotSize: p.fromOneSet && p.typeId ? p.quantity : null
	}));
}

export const toRequestLines = (parts: readonly ExpandedPart[]): RequestLine[] =>
	parts.map((p) => ({ typeId: p.typeId, itemId: p.itemId, quantity: p.quantity }));

/** Höchstens so viele Zelte sind im Zeitraum baubar (alle Teile gemeinsam geprüft, Obergrenze `max`) */
export function tentFree(
	index: AvailabilityIndex,
	parts: readonly TentPartSpec[],
	period: Period,
	max = 99
): number {
	if (!parts.length) return 0;
	let ok = 0;
	for (let n = 1; n <= max; n++) {
		const checks = index.check(toRequestLines(expandTent(parts, n)), period);
		if (!checks.every((c) => c.ok)) break;
		ok = n;
	}
	return ok;
}
