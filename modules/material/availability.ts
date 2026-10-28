/**
 * Verfügbarkeit (rein, ohne Server-Imports – in Tests und UI nutzbar).
 *
 * Belegungen sind Reservierungszeilen anderer (nicht stornierter) Reservierungen: „N beliebige des Typs T“
 * oder „N von Artikel I“. Je Tag gilt:
 * - Artikel I: frei = Anzahl(I, nutzbar) − Σ Artikel-Zeilen(I)
 * - Typ T: frei = Σ nutzbare Anzahl der Artikel von T − Σ Artikel-Zeilen(Artikel von T) − Σ Typ-Zeilen(T)
 * Das reicht aus, weil Typ-Zeilen jeden Artikel des Typs nehmen dürfen. Über einen Zeitraum zählt das
 * Minimum aller Tage; geprüft werden nur der Beginn und die Tage, an denen eine Belegung beginnt
 * (dort ist die Summe der Belegungen am größten).
 */

export interface StockItem {
	id: string;
	typeId: string | null;
	quantity: number;
	/** Nicht defekt/verloren und nicht archiviert */
	usable: boolean;
}

export interface Booking {
	startsOn: string;
	endsOn: string;
	typeId: string | null;
	itemId: string | null;
	quantity: number;
}

export interface Period {
	from: string;
	to: string;
}

export interface RequestLine {
	typeId: string | null;
	itemId: string | null;
	quantity: number;
}

export interface LineCheck {
	index: number;
	ok: boolean;
	/** So viele wären für diese Zeile höchstens frei (≥ 0) */
	available: number;
}

const overlaps = (b: Booking, day: string) => b.startsOn <= day && b.endsOn >= day;

/** Prüftage im Zeitraum: Beginn + jeder Beginn einer Belegung innerhalb */
function checkDays(bookings: Booking[], p: Period): string[] {
	const days = new Set<string>([p.from]);
	for (const b of bookings) {
		if (b.startsOn > p.from && b.startsOn <= p.to) days.add(b.startsOn);
	}
	return [...days];
}

export class AvailabilityIndex {
	private readonly items = new Map<string, StockItem>();
	private readonly typeItems = new Map<string, StockItem[]>();

	constructor(
		stock: StockItem[],
		private readonly bookings: Booking[]
	) {
		for (const s of stock) {
			this.items.set(s.id, s);
			if (s.typeId) {
				const list = this.typeItems.get(s.typeId) ?? [];
				list.push(s);
				this.typeItems.set(s.typeId, list);
			}
		}
	}

	item(id: string): StockItem | undefined {
		return this.items.get(id);
	}

	/** Nutzbare Gesamtanzahl eines Artikels bzw. Typs */
	totalItem(id: string): number {
		const s = this.items.get(id);
		return s && s.usable ? s.quantity : 0;
	}

	totalType(typeId: string): number {
		return (this.typeItems.get(typeId) ?? []).reduce((n, s) => n + (s.usable ? s.quantity : 0), 0);
	}

	private relevant(extra: Booking[]): Booking[] {
		return extra.length ? [...this.bookings, ...extra] : this.bookings;
	}

	/** Frei im Zeitraum (Minimum über die Tage), kann mit `extra` negativ werden */
	freeItem(id: string, p: Period, extra: Booking[] = []): number {
		const total = this.totalItem(id);
		const list = this.relevant(extra).filter((b) => b.itemId === id);
		let min = total;
		for (const day of checkDays(list, p)) {
			const used = list.reduce((n, b) => n + (overlaps(b, day) ? b.quantity : 0), 0);
			min = Math.min(min, total - used);
		}
		return min;
	}

	freeType(typeId: string, p: Period, extra: Booking[] = []): number {
		const members = this.typeItems.get(typeId) ?? [];
		const usableIds = new Set(members.filter((s) => s.usable).map((s) => s.id));
		const total = this.totalType(typeId);
		const list = this.relevant(extra).filter(
			(b) => b.typeId === typeId || (b.itemId !== null && usableIds.has(b.itemId))
		);
		let min = total;
		for (const day of checkDays(list, p)) {
			const used = list.reduce((n, b) => n + (overlaps(b, day) ? b.quantity : 0), 0);
			min = Math.min(min, total - used);
		}
		return min;
	}

	/**
	 * Neue Zeilen gemeinsam prüfen (alle gelten für den ganzen Zeitraum). Eine Zeile ist ok, wenn nach
	 * Hinzufügen ALLER neuen Zeilen weder ihr Artikel noch ihr Typ (bzw. der Typ ihres Artikels) überbucht ist.
	 */
	check(lines: RequestLine[], p: Period): LineCheck[] {
		const extra: Booking[] = lines.map((l) => ({
			startsOn: p.from,
			endsOn: p.to,
			typeId: l.typeId,
			itemId: l.itemId,
			quantity: l.quantity
		}));
		return lines.map((l, index) => {
			if (l.itemId) {
				const s = this.items.get(l.itemId);
				if (!s) return { index, ok: false, available: 0 };
				const afterItem = this.freeItem(l.itemId, p, extra);
				let after = afterItem;
				if (s.typeId && s.usable) after = Math.min(after, this.freeType(s.typeId, p, extra));
				return { index, ok: after >= 0, available: Math.max(0, after + l.quantity) };
			}
			if (l.typeId) {
				const after = this.freeType(l.typeId, p, extra);
				return { index, ok: after >= 0, available: Math.max(0, after + l.quantity) };
			}
			return { index, ok: false, available: 0 };
		});
	}
}
