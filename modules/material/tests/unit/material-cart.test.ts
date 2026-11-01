import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CART_KEY,
	addLine,
	cartCount,
	clearDraft,
	editCartKey,
	emptyDraft,
	fromReservation,
	itemQuantityInCart,
	lineKey,
	loadDraft,
	parseDraft,
	reconcileCart,
	removeLine,
	saveDraft,
	setQuantity,
	shiftDate,
	toLines,
	typeQuantityInCart,
	type CartLine
} from '$modules/material/pages/reserve/cart';
import type { Catalog, CatalogEntry, Reservation } from '$modules/material/schemas';

const TODAY = '2026-10-28';

const bahnen: CartLine = {
	kind: 'type',
	typeId: 'type-bahn',
	name: 'Kohtenbahn',
	thumbUrl: null,
	quantity: 3
};
const k11: CartLine = {
	kind: 'item',
	itemId: 'item-k11',
	name: 'Kohtenbahn K1.1',
	code: 'M-000001',
	thumbUrl: null,
	quantity: 1,
	max: 1
};
const tampen: CartLine = {
	kind: 'item',
	itemId: 'item-tampen',
	name: 'Tampen',
	code: 'M-000002',
	thumbUrl: null,
	quantity: 5,
	max: 21
};

function entry(partial: Partial<CatalogEntry> & Pick<CatalogEntry, 'kind' | 'id' | 'name'>) {
	return {
		description: '',
		category: null,
		images: [],
		thumbUrl: null,
		total: 1,
		free: 1,
		items: [],
		code: null,
		locationName: null,
		sets: [],
		parts: [],
		...partial
	} satisfies CatalogEntry;
}

const catalog: Pick<Catalog, 'entries'> = {
	entries: [
		entry({
			kind: 'type',
			id: 'type-bahn',
			name: 'Kohtenbahn (neu)',
			thumbUrl: '/thumb/bahn',
			total: 8,
			free: 6,
			items: [
				{
					id: 'item-k11',
					name: 'Kohtenbahn K1.1',
					code: 'M-000001',
					quantity: 1,
					free: 1,
					locationName: 'Regal A',
					condition: 'ok',
					thumbUrl: null,
					setId: null,
					setName: null
				}
			]
		}),
		entry({ kind: 'item', id: 'item-tampen', name: 'Tampen', code: 'M-000002', total: 4, free: 4 }),
		entry({ kind: 'tent', id: 'tent-jurte', name: 'Jurte (neu)', total: 2, free: 2 })
	]
};

/** Felder einer Reservierungszeile, die für den Warenkorb keine Rolle spielen */
const LINE_EXTRA = {
	tentId: null,
	label: '',
	assignments: [],
	missing: 0,
	slotSize: null,
	mixedSlots: 0,
	parts: []
};

describe('Zelte im Warenkorb', () => {
	it('fasst gleiche Zelte zusammen, gleicht Namen ab und entfernt archivierte', () => {
		const tent = { kind: 'tent' as const, tentId: 'tent-jurte', name: 'Jurte', thumbUrl: null };
		const lines = addLine(addLine([], { ...tent, quantity: 1 }), { ...tent, quantity: 2 });
		expect(lines).toHaveLength(1);
		expect(lines[0]!.quantity).toBe(3);
		const r = reconcileCart(
			[...lines, { kind: 'tent', tentId: 'tent-weg', name: 'Kohte', thumbUrl: null, quantity: 1 }],
			catalog
		);
		expect(r.lines.map((l) => l.name)).toEqual(['Jurte (neu)']);
		expect(r.removed).toEqual(['Kohte']);
		expect(
			parseDraft({ lines: [{ kind: 'tent', tentId: 'x', quantity: 2 }] }, TODAY).lines
		).toEqual([{ kind: 'tent', tentId: 'x', name: '', thumbUrl: null, quantity: 2 }]);
	});
});

describe('Entwurf', () => {
	it('beginnt heute und endet zwei Tage später', () => {
		const d = emptyDraft(TODAY);
		expect(d.from).toBe(TODAY);
		expect(d.to).toBe('2026-10-30');
		expect(d.lines).toEqual([]);
		expect(d.purpose).toBe('other');
	});

	it('rechnet Datumsgrenzen über Monats- und Jahreswechsel', () => {
		expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
		expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
	});

	it('liest kaputte oder fremde Daten tolerant', () => {
		expect(parseDraft(null, TODAY)).toEqual(emptyDraft(TODAY));
		expect(parseDraft('x', TODAY)).toEqual(emptyDraft(TODAY));
		const d = parseDraft(
			{
				lines: [
					bahnen,
					{ kind: 'type', typeId: 'type-bahn', quantity: 1 }, // doppelt → verworfen
					{ kind: 'set', id: 'x' }, // unbekannte Art
					{ ...tampen, quantity: 999 }, // über der Anzahl → geklemmt
					{ ...k11, quantity: Number.NaN }
				],
				from: '2026-11-01',
				to: '2026-11-03',
				purpose: 'quatsch',
				title: 'Lager',
				actionId: 42
			},
			TODAY
		);
		expect(d.lines.map(lineKey)).toEqual(['t:type-bahn', 'i:item-tampen', 'i:item-k11']);
		expect(d.lines[1]!.quantity).toBe(21);
		expect(d.lines[2]!.quantity).toBe(1);
		expect(d.purpose).toBe('other');
		expect(d.actionId).toBeNull();
		expect(d.from).toBe('2026-11-01');
	});

	it('setzt einen vergangenen Zeitraum auf heute zurück', () => {
		const old = parseDraft({ from: '2026-01-01', to: '2026-01-03' }, TODAY);
		expect([old.from, old.to]).toEqual([TODAY, '2026-10-30']);
		const running = parseDraft({ from: '2026-10-20', to: '2026-11-02' }, TODAY);
		expect([running.from, running.to]).toEqual([TODAY, '2026-11-02']);
		const swapped = parseDraft({ from: '2026-11-05', to: '2026-11-04' }, TODAY);
		expect(swapped.to).toBe('2026-11-05');
		// Bearbeiten: laufende Reservierung behält ihren Beginn
		const kept = parseDraft({ from: '2026-10-20', to: '2026-11-02' }, TODAY, { keepDates: true });
		expect([kept.from, kept.to]).toEqual(['2026-10-20', '2026-11-02']);
	});
});

describe('Zeilen', () => {
	it('fasst gleiche Typen und Artikel zusammen', () => {
		let lines = addLine([], bahnen);
		lines = addLine(lines, { ...bahnen, quantity: 2 });
		lines = addLine(lines, tampen);
		expect(lines).toHaveLength(2);
		expect(typeQuantityInCart(lines, 'type-bahn')).toBe(5);
		expect(cartCount(lines)).toBe(10);
	});

	it('begrenzt Artikel auf ihre Anzahl', () => {
		let lines = addLine([], tampen);
		lines = addLine(lines, { ...tampen, quantity: 30 });
		expect(itemQuantityInCart(lines, 'item-tampen')).toBe(21);
		lines = addLine([], k11);
		lines = addLine(lines, k11);
		expect(itemQuantityInCart(lines, 'item-k11')).toBe(1);
	});

	it('setzt und entfernt Anzahlen (mindestens 1)', () => {
		let lines: CartLine[] = [bahnen, tampen];
		lines = setQuantity(lines, 't:type-bahn', 0);
		expect(lines[0]!.quantity).toBe(1);
		lines = setQuantity(lines, 'i:item-tampen', 50);
		expect(lines[1]!.quantity).toBe(21);
		lines = setQuantity(lines, 'i:item-tampen', 7.8);
		expect(lines[1]!.quantity).toBe(7);
		lines = removeLine(lines, 't:type-bahn');
		expect(lines.map(lineKey)).toEqual(['i:item-tampen']);
	});

	it('baut die API-Zeilen', () => {
		expect(toLines([bahnen, tampen])).toEqual([
			{ kind: 'type', typeId: 'type-bahn', quantity: 3 },
			{ kind: 'item', itemId: 'item-tampen', quantity: 5 }
		]);
	});
});

describe('reconcileCart', () => {
	it('aktualisiert Namen und Obergrenzen und entfernt Unbekanntes', () => {
		const gone: CartLine = { ...bahnen, typeId: 'type-weg', name: 'Jurtenbahn' };
		const r = reconcileCart([bahnen, gone, { ...tampen, quantity: 10 }, k11], catalog);
		expect(r.changed).toBe(true);
		expect(r.removed).toEqual(['Jurtenbahn']);
		expect(r.lines.map(lineKey)).toEqual(['t:type-bahn', 'i:item-tampen', 'i:item-k11']);
		expect(r.lines[0]!.name).toBe('Kohtenbahn (neu)');
		expect(r.lines[0]!.thumbUrl).toBe('/thumb/bahn');
		const t = r.lines[1]!;
		expect(t.kind === 'item' && t.max).toBe(4);
		expect(t.quantity).toBe(4);
		// Artikel eines Typs bekommt das Bild des Typs
		expect(r.lines[2]!.thumbUrl).toBe('/thumb/bahn');
	});

	it('meldet keine Änderung, wenn alles passt', () => {
		const first = reconcileCart([bahnen, k11], catalog).lines;
		const again = reconcileCart(first, catalog);
		expect(again.changed).toBe(false);
		expect(again.removed).toEqual([]);
	});
});

describe('fromReservation', () => {
	it('übernimmt Angaben und Zeilen', () => {
		const r = {
			id: 'r1',
			title: 'Sommerlager',
			startsOn: '2026-07-01',
			endsOn: '2026-07-10',
			status: 'reserved',
			state: 'upcoming',
			purpose: 'action',
			actionId: 'a1',
			actionName: 'Sommerlager 2026',
			groupId: null,
			groupName: null,
			notes: 'Bitte trocken lagern',
			createdBy: 'u1',
			createdByName: 'Tessa',
			createdAt: '2026-06-01T10:00:00Z',
			canEdit: true,
			handedOutAt: null,
			handedOutByName: null,
			canHandOut: false,
			notices: [],
			lines: [
				{
					id: 'l1',
					kind: 'type',
					typeId: 'type-bahn',
					itemId: null,
					name: 'Kohtenbahn',
					code: null,
					locationName: null,
					quantity: 4,
					thumbUrl: null,
					...LINE_EXTRA
				},
				{
					id: 'l2',
					kind: 'item',
					typeId: null,
					itemId: 'item-tampen',
					name: 'Tampen',
					code: 'M-000002',
					locationName: 'Kiste 1',
					quantity: 3,
					thumbUrl: null,
					...LINE_EXTRA
				},
				{
					id: 'l3',
					kind: 'tent',
					typeId: null,
					itemId: null,
					name: 'Jurte',
					code: null,
					locationName: null,
					quantity: 2,
					thumbUrl: null,
					...LINE_EXTRA,
					tentId: 'tent-jurte'
				}
			]
		} satisfies Reservation;
		const d = fromReservation(r);
		expect(d).toMatchObject({
			from: '2026-07-01',
			to: '2026-07-10',
			title: 'Sommerlager',
			purpose: 'action',
			actionId: 'a1',
			notes: 'Bitte trocken lagern'
		});
		expect(toLines(d.lines)).toEqual([
			{ kind: 'type', typeId: 'type-bahn', quantity: 4 },
			{ kind: 'item', itemId: 'item-tampen', quantity: 3 },
			{ kind: 'tent', tentId: 'tent-jurte', quantity: 2 }
		]);
		expect(d.lines[1]!.kind === 'item' && d.lines[1]!.max).toBeNull();
	});
});

describe('sessionStorage', () => {
	let store: Map<string, string>;
	beforeEach(() => {
		store = new Map();
		vi.stubGlobal('sessionStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k)
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it('speichert getrennt für Entwurf und Bearbeiten', () => {
		const d = { ...emptyDraft(TODAY), title: 'Neu', lines: [bahnen] };
		saveDraft(CART_KEY, d);
		saveDraft(editCartKey('r1'), { ...d, title: 'Bearbeitet' });
		expect(loadDraft(CART_KEY, TODAY)?.title).toBe('Neu');
		expect(loadDraft(editCartKey('r1'), TODAY)?.title).toBe('Bearbeitet');
		clearDraft(editCartKey('r1'));
		expect(loadDraft(editCartKey('r1'), TODAY)).toBeNull();
		expect(loadDraft(CART_KEY, TODAY)?.lines).toHaveLength(1);
	});

	it('übersteht kaputtes JSON und fehlenden Speicher', () => {
		store.set(CART_KEY, '{kaputt');
		expect(loadDraft(CART_KEY, TODAY)).toBeNull();
		vi.stubGlobal('sessionStorage', undefined);
		expect(loadDraft(CART_KEY, TODAY)).toBeNull();
		expect(() => saveDraft(CART_KEY, emptyDraft(TODAY))).not.toThrow();
		expect(() => clearDraft(CART_KEY)).not.toThrow();
	});
});
