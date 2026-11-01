/** Reine Logik des Moduls `orders` (`stock.ts`): Mengen, Fehlmengen, Preise, Status, Nummern, Texte. */
import { describe, expect, it } from 'vitest';
import {
	billableCents,
	deficit,
	formatNumber,
	inTransitQty,
	lineDescription,
	openQty,
	orderStatus,
	priceRange,
	safeCount,
	supplierStatus
} from '$modules/orders/stock';

const item = (quantity: number, deliveredQty = 0, cancelledQty = 0) => ({
	quantity,
	deliveredQty,
	cancelledQty
});
const sItem = (quantity: number, receivedQty = 0, cancelledQty = 0) => ({
	quantity,
	receivedQty,
	cancelledQty
});

describe('safeCount', () => {
	it('ganze, nicht negative Zahlen', () => {
		expect(safeCount(0)).toBe(0);
		expect(safeCount(5)).toBe(5);
		expect(safeCount(2.9)).toBe(2);
		expect(safeCount('7')).toBe(7);
	});
	it('NaN, Infinity, negativ, Unsinn → 0', () => {
		expect(safeCount(NaN)).toBe(0);
		expect(safeCount(Infinity)).toBe(0);
		expect(safeCount(-Infinity)).toBe(0);
		expect(safeCount(-3)).toBe(0);
		expect(safeCount('abc')).toBe(0);
		expect(safeCount(undefined)).toBe(0);
		expect(safeCount(null)).toBe(0);
	});
});

describe('openQty / inTransitQty', () => {
	it('Menge minus ausgegeben minus storniert', () => {
		expect(openQty(item(5))).toBe(5);
		expect(openQty(item(5, 2, 1))).toBe(2);
		expect(openQty(item(5, 5))).toBe(0);
		expect(openQty(item(5, 3, 2))).toBe(0);
	});
	it('nie negativ, auch bei Überbuchung oder ungültigen Werten', () => {
		expect(openQty(item(2, 3, 1))).toBe(0);
		expect(openQty(item(NaN, 0, 0))).toBe(0);
		expect(openQty(item(4, -2, 0))).toBe(4);
	});
	it('Lieferanten: Menge minus eingegangen minus storniert', () => {
		expect(inTransitQty(sItem(10))).toBe(10);
		expect(inTransitQty(sItem(10, 4, 1))).toBe(5);
		expect(inTransitQty(sItem(10, 10))).toBe(0);
		expect(inTransitQty(sItem(3, 5))).toBe(0);
		expect(inTransitQty(sItem(Infinity, 0))).toBe(0);
	});
});

describe('deficit', () => {
	it('Nachfrage + Mindestbestand − Bestand − unterwegs', () => {
		// 3 + 2 − 1 − 0 = 4
		expect(deficit({ demand: 3, minStock: 2, stock: 1, inTransit: 0 })).toBe(4);
		// 3 + 2 − 1 − 4 = 0
		expect(deficit({ demand: 3, minStock: 2, stock: 1, inTransit: 4 })).toBe(0);
	});
	it('Grenzwerte: genau gedeckt → 0, Überdeckung → 0', () => {
		expect(deficit({ demand: 0, minStock: 0, stock: 0, inTransit: 0 })).toBe(0);
		expect(deficit({ demand: 2, minStock: 3, stock: 5, inTransit: 0 })).toBe(0);
		expect(deficit({ demand: 2, minStock: 3, stock: 4, inTransit: 0 })).toBe(1);
		expect(deficit({ demand: 0, minStock: 0, stock: 10, inTransit: 5 })).toBe(0);
	});
	it('ungültige Werte zählen als 0', () => {
		expect(deficit({ demand: NaN, minStock: -1, stock: 0, inTransit: 0 })).toBe(0);
		expect(deficit({ demand: 2, minStock: 0, stock: NaN, inTransit: -5 })).toBe(2);
	});
});

describe('priceRange', () => {
	it('leere Liste → 0/0', () => {
		expect(priceRange([])).toEqual({ min: 0, max: 0 });
	});
	it('ein Preis → Einzelpreis', () => {
		expect(priceRange([1250])).toEqual({ min: 1250, max: 1250 });
	});
	it('Spanne über mehrere Preise, 0 ist gültig', () => {
		expect(priceRange([1500, 0, 900])).toEqual({ min: 0, max: 1500 });
	});
	it('NaN, Infinity und negative werden ignoriert', () => {
		expect(priceRange([NaN, -100, Infinity, 800, 1200])).toEqual({ min: 800, max: 1200 });
		expect(priceRange([NaN, -1])).toEqual({ min: 0, max: 0 });
	});
});

describe('orderStatus', () => {
	it('nichts ausgegeben → open', () => {
		expect(orderStatus([item(2), item(1)])).toBe('open');
	});
	it('teilweise ausgegeben → partial', () => {
		expect(orderStatus([item(2, 1), item(1)])).toBe('partial');
	});
	it('alles ausgegeben (Rest storniert) → delivered', () => {
		expect(orderStatus([item(2, 2), item(1, 0, 1)])).toBe('delivered');
		expect(orderStatus([item(3, 2, 1)])).toBe('delivered');
	});
	it('alles storniert, leer oder Bestellung storniert → cancelled', () => {
		expect(orderStatus([item(2, 0, 2), item(1, 0, 1)])).toBe('cancelled');
		expect(orderStatus([])).toBe('cancelled');
		expect(orderStatus([item(2)], '2026-10-19T10:00:00.000Z')).toBe('cancelled');
	});
	it('teilweise storniert, Rest offen → open', () => {
		expect(orderStatus([item(3, 0, 1)])).toBe('open');
	});
	it('cancelledAt null/undefined ändert nichts', () => {
		expect(orderStatus([item(1)], null)).toBe('open');
		expect(orderStatus([item(1)], undefined)).toBe('open');
	});
});

describe('billableCents', () => {
	it('(Menge − storniert) × Einzelpreis, Ausgabe zählt mit', () => {
		// (3 − 1) × 1250 = 2500
		expect(billableCents({ ...item(3, 1, 1), unitPriceCents: 1250 })).toBe(2500);
		expect(billableCents({ ...item(3, 0, 3), unitPriceCents: 1250 })).toBe(0);
		expect(billableCents({ ...item(2), unitPriceCents: 0 })).toBe(0);
	});
	it('ungültige Werte → 0, Überstorno nie negativ', () => {
		expect(billableCents({ ...item(2, 0, 5), unitPriceCents: 100 })).toBe(0);
		expect(billableCents({ ...item(2), unitPriceCents: NaN })).toBe(0);
		expect(billableCents({ ...item(2), unitPriceCents: -100 })).toBe(0);
	});
});

describe('supplierStatus', () => {
	it('abgeschlossen gewinnt immer', () => {
		expect(supplierStatus([sItem(5)], '2026-10-01T00:00:00.000Z')).toBe('closed');
	});
	it('nichts eingegangen → ordered', () => {
		expect(supplierStatus([sItem(5), sItem(2)])).toBe('ordered');
	});
	it('teilweise eingegangen → partial', () => {
		expect(supplierStatus([sItem(5, 2), sItem(2)])).toBe('partial');
	});
	it('alles eingegangen oder storniert → received', () => {
		expect(supplierStatus([sItem(5, 5), sItem(2, 0, 2)])).toBe('received');
		expect(supplierStatus([])).toBe('received');
	});
});

describe('formatNumber', () => {
	it('vierstellig mit führenden Nullen', () => {
		expect(formatNumber('B', 2026, 1)).toBe('B-2026-0001');
		expect(formatNumber('E', 2026, 42)).toBe('E-2026-0042');
		expect(formatNumber('B', 2026, 9999)).toBe('B-2026-9999');
	});
	it('ab 10000 fünfstellig (kein Abschneiden)', () => {
		expect(formatNumber('B', 2027, 10000)).toBe('B-2027-10000');
	});
});

describe('lineDescription', () => {
	it('mit Größe', () => {
		expect(lineDescription('Halstuch', 'M', 2)).toBe('Halstuch (Gr. M) × 2');
	});
	it('ohne Größe', () => {
		expect(lineDescription('Liederbuch', '', 1)).toBe('Liederbuch × 1');
	});
});
