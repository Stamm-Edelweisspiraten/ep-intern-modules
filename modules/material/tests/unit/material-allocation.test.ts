import { describe, expect, it } from 'vitest';
import { allocate, setCompleteness, type Candidate } from '$modules/material/allocation';
import {
	planAssignments,
	samePicks,
	slotInfo,
	type PlanItem,
	type PlanRequest
} from '$modules/material/assignment';
import { AvailabilityIndex } from '$modules/material/availability';
import { expandTent, tentFree, type TentPartSpec } from '$modules/material/tents';

// Zuteilung konkreter Artikel (Sets bevorzugt), Planer über mehrere Reservierungen, Zelte (Bauplan).

/** Set mit `n` Bahnen („KJ1.1“ …), alle frei */
function set(name: string, n: number, free = n): Candidate[] {
	return Array.from({ length: n }, (_, i) => ({
		itemId: `${name}.${i + 1}`,
		setId: name,
		setName: name,
		capacity: 1,
		free: i < free ? 1 : 0,
		sortKey: `${name}.${i + 1}`
	}));
}
function loose(prefix: string, n: number): Candidate[] {
	return Array.from({ length: n }, (_, i) => ({
		itemId: `${prefix}${i + 1}`,
		setId: null,
		setName: null,
		capacity: 1,
		free: 1,
		sortKey: `${prefix}${i + 1}`
	}));
}
const ids = (picks: { itemId: string }[]) => picks.map((p) => p.itemId).sort();
const sum = (picks: { quantity: number }[]) => picks.reduce((n, p) => n + p.quantity, 0);

describe('allocate', () => {
	it('nimmt ganze Sets, dann lose Bahnen (8 = KJ1 + 2 lose)', () => {
		const r = allocate([...set('KJ1', 6), ...set('KJ2', 6), ...loose('L', 3)], 8);
		expect(r.missing).toBe(0);
		expect(sum(r.picks)).toBe(8);
		expect(r.picks.filter((p) => p.itemId.startsWith('KJ')).map((p) => p.itemId)).toHaveLength(6);
		expect(r.picks.filter((p) => p.itemId.startsWith('L'))).toHaveLength(2);
	});

	it('bricht ein Set erst an, wenn lose Bahnen nicht reichen', () => {
		const r = allocate([...set('KJ1', 6), ...loose('L', 1)], 3);
		expect(ids(r.picks)).toEqual(['KJ1.1', 'KJ1.2', 'L1']);
	});

	it('mit slotSize: je Zelt ein ganzes Set genau passender Größe', () => {
		const r = allocate([...set('KJ1', 6), ...set('KJ2', 6), ...set('G', 8), ...loose('L', 6)], 12, {
			slotSize: 6
		});
		expect(r.missing).toBe(0);
		expect(r.mixedSlots).toBe(0);
		const bySlot = (s: number) => ids(r.picks.filter((p) => p.slot === s));
		expect(bySlot(0)).toEqual(['KJ1.1', 'KJ1.2', 'KJ1.3', 'KJ1.4', 'KJ1.5', 'KJ1.6']);
		expect(bySlot(1)).toEqual(['KJ2.1', 'KJ2.2', 'KJ2.3', 'KJ2.4', 'KJ2.5', 'KJ2.6']);
	});

	it('mit slotSize: sonst kleinstes Set mit genug freien Bahnen', () => {
		const r = allocate([...set('G', 8), ...set('KJ1', 6, 5)], 6, { slotSize: 6 });
		expect(r.mixedSlots).toBe(0);
		expect(new Set(r.picks.map((p) => p.itemId.split('.')[0]))).toEqual(new Set(['G']));
	});

	it('mit slotSize: kein Set reicht → gemischt, mit Hinweis', () => {
		const r = allocate([...set('KJ1', 6, 4), ...set('KJ2', 6, 3)], 6, { slotSize: 6 });
		expect(r.missing).toBe(0);
		expect(r.mixedSlots).toBe(1);
		expect(sum(r.picks)).toBe(6);
	});

	it('ohne Sets ist nichts „gemischt“', () => {
		const r = allocate(loose('L', 10), 6, { slotSize: 6 });
		expect(r.mixedSlots).toBe(0);
		expect(sum(r.picks)).toBe(6);
	});

	it('meldet Fehlmengen und nutzt Mengenartikel', () => {
		const heringe: Candidate = {
			itemId: 'H',
			setId: null,
			setName: null,
			capacity: 50,
			free: 20,
			sortKey: 'H'
		};
		const r = allocate([heringe], 24);
		expect(r.picks).toEqual([{ itemId: 'H', quantity: 20, slot: 0 }]);
		expect(r.missing).toBe(4);
	});

	it('Vollständigkeit eines Sets', () => {
		expect(
			setCompleteness([
				{ itemId: 'a', typeId: 't', quantity: 1, usable: true },
				{ itemId: 'b', typeId: 't', quantity: 1, usable: false }
			])
		).toEqual({ total: 2, usable: 1, complete: false });
	});
});

describe('planAssignments', () => {
	const items: PlanItem[] = [1, 2, 3, 4, 5, 6].map((n) => ({
		id: `KJ1.${n}`,
		typeId: 'bahn',
		setId: 'KJ1',
		setName: 'KJ1',
		capacity: 1,
		sortKey: `KJ1.${n}`
	}));
	items.push(
		...[1, 2].map((n) => ({
			id: `L${n}`,
			typeId: 'bahn',
			setId: null,
			setName: null,
			capacity: 1,
			sortKey: `L${n}`
		}))
	);
	const req = (over: Partial<PlanRequest>): PlanRequest => ({
		lineId: 'a',
		startsOn: '2026-07-01',
		endsOn: '2026-07-05',
		typeId: 'bahn',
		quantity: 6,
		slotSize: null,
		previous: [],
		pinned: [],
		frozen: false,
		fillMissing: true,
		...over
	});

	it('teilt das ganze Set zu und behält eine gültige Zuteilung bei', () => {
		const first = planAssignments({ items, fixed: [], requests: [req({})] });
		expect(ids(first.get('a')!)).toEqual(
			items
				.slice(0, 6)
				.map((i) => i.id)
				.sort()
		);
		// Bisher L1, L2 + 4 aus KJ1: bleibt so, obwohl das Set besser wäre (keine unnötigen Wechsel)
		const previous = ['L1', 'L2', 'KJ1.1', 'KJ1.2', 'KJ1.3', 'KJ1.4'].map((itemId) => ({
			itemId,
			quantity: 1,
			slot: 0
		}));
		const again = planAssignments({ items, fixed: [], requests: [req({ previous })] });
		expect(samePicks(again.get('a')!, previous)).toBe(true);
	});

	it('plant um, wenn ein zugeteilter Artikel gezielt reserviert wird', () => {
		const previous = items.slice(0, 6).map((i) => ({ itemId: i.id, quantity: 1, slot: 0 }));
		const plan = planAssignments({
			items,
			fixed: [{ itemId: 'KJ1.2', startsOn: '2026-07-03', endsOn: '2026-07-03', quantity: 1 }],
			requests: [req({ previous })]
		});
		const picks = ids(plan.get('a')!);
		expect(picks).not.toContain('KJ1.2');
		expect(picks).toHaveLength(6);
	});

	it('eingefrorene Reservierungen behalten ihre Zuteilung, andere weichen aus', () => {
		const frozen = items.slice(0, 6).map((i) => ({ itemId: i.id, quantity: 1, slot: 0 }));
		const plan = planAssignments({
			items,
			fixed: [],
			requests: [
				req({ lineId: 'alt', previous: frozen, frozen: true }),
				req({ lineId: 'neu', quantity: 2, startsOn: '2026-07-04', endsOn: '2026-07-06' })
			]
		});
		expect(plan.get('alt')).toEqual(frozen);
		expect(ids(plan.get('neu')!)).toEqual(['L1', 'L2']);
	});

	it('nacheinander liegende Reservierungen nutzen dieselben Bahnen', () => {
		const plan = planAssignments({
			items,
			fixed: [],
			requests: [
				req({ lineId: 'a', quantity: 8 }),
				req({ lineId: 'b', quantity: 8, startsOn: '2026-07-06', endsOn: '2026-07-07' })
			]
		});
		expect(sum(plan.get('a')!)).toBe(8);
		expect(sum(plan.get('b')!)).toBe(8);
	});

	it('Hinweis „gemischt“ je Zelt', () => {
		const setOf = (id: string) =>
			id.startsWith('KJ1') ? 'KJ1' : id.startsWith('KJ2') ? 'KJ2' : null;
		const picks = [
			...['KJ1.1', 'KJ1.2'].map((itemId) => ({ itemId, slot: 0 })),
			...['KJ2.1', 'L1'].map((itemId) => ({ itemId, slot: 1 }))
		];
		expect(slotInfo(picks, setOf, 2, 4, true)).toEqual({ mixedSlots: 1, slots: 2 });
		expect(slotInfo(picks, setOf, 2, 4, false)).toEqual({ mixedSlots: 0, slots: 2 });
	});
});

describe('Zelte', () => {
	const jurte: TentPartSpec[] = [
		{ label: 'Dach', typeId: 'bahn', itemId: null, quantity: 6, fromOneSet: true },
		{ label: 'Wand', typeId: 'bahn', itemId: null, quantity: 4, fromOneSet: false },
		{ label: '', typeId: null, itemId: 'seil', quantity: 1, fromOneSet: false }
	];

	it('löst Zelte in Teile auf', () => {
		expect(expandTent(jurte, 2)).toEqual([
			{ label: 'Dach', typeId: 'bahn', itemId: null, quantity: 12, slotSize: 6 },
			{ label: 'Wand', typeId: 'bahn', itemId: null, quantity: 8, slotSize: null },
			{ label: '', typeId: null, itemId: 'seil', quantity: 2, slotSize: null }
		]);
	});

	it('zählt baubare Zelte über alle Teile gemeinsam', () => {
		const stock = [
			...Array.from({ length: 22 }, (_, i) => ({
				id: `b${i}`,
				typeId: 'bahn',
				quantity: 1,
				usable: true
			})),
			{ id: 'seil', typeId: null, quantity: 3, usable: true }
		];
		const period = { from: '2026-07-01', to: '2026-07-02' };
		// 22 Bahnen / 10 je Jurte → 2
		expect(tentFree(new AvailabilityIndex(stock, []), jurte, period)).toBe(2);
		// 1 Seil belegt, 2 übrig → weiterhin 2; 2 belegt → 1
		const booked = (n: number) =>
			new AvailabilityIndex(stock, [
				{ startsOn: '2026-07-01', endsOn: '2026-07-01', typeId: null, itemId: 'seil', quantity: n }
			]);
		expect(tentFree(booked(1), jurte, period)).toBe(2);
		expect(tentFree(booked(2), jurte, period)).toBe(1);
	});
});
