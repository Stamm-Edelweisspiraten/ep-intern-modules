/**
 * Modul `material` v2 – Verfügbarkeit (`availability.ts`): Artikel- und Typ-Belegungen je Tag,
 * defekte Artikel, gemeinsame Prüfung neuer Zeilen. Dazu Codes und Mehrfach-Namen aus `schemas.ts`.
 */
import { describe, expect, it } from 'vitest';
import { AvailabilityIndex, type Booking, type StockItem } from '$modules/material/availability';
import {
	batchNames,
	codeFromScan,
	reservationInput,
	reservationState
} from '$modules/material/schemas';

// Typ T (Kohtenbahn): K1 (1), K2 (1), K3 (1, defekt); Typ U: Tampen-Bündel 21; lose Kiste ohne Typ
const stock: StockItem[] = [
	{ id: 'k1', typeId: 'T', quantity: 1, usable: true },
	{ id: 'k2', typeId: 'T', quantity: 1, usable: true },
	{ id: 'k3', typeId: 'T', quantity: 1, usable: false },
	{ id: 'tampen', typeId: 'U', quantity: 21, usable: true },
	{ id: 'kiste', typeId: null, quantity: 1, usable: true }
];
const p = { from: '2026-07-01', to: '2026-07-05' };
const b = (startsOn: string, endsOn: string, x: Partial<Booking>): Booking => ({
	startsOn,
	endsOn,
	typeId: null,
	itemId: null,
	quantity: 1,
	...x
});

describe('AvailabilityIndex', () => {
	it('zählt nur nutzbare Artikel', () => {
		const idx = new AvailabilityIndex(stock, []);
		expect(idx.totalType('T')).toBe(2);
		expect(idx.freeType('T', p)).toBe(2);
		expect(idx.totalItem('k3')).toBe(0);
		expect(idx.freeItem('tampen', p)).toBe(21);
	});

	it('Belegungen zählen nur an überlappenden Tagen (Minimum über den Zeitraum)', () => {
		const idx = new AvailabilityIndex(stock, [
			b('2026-06-28', '2026-07-01', { itemId: 'tampen', quantity: 5 }),
			b('2026-07-04', '2026-07-10', { itemId: 'tampen', quantity: 8 }),
			b('2026-07-06', '2026-07-08', { itemId: 'tampen', quantity: 20 })
		]);
		// 1.7.: 5 belegt, 4./5.7.: 8 belegt, Tage dazwischen frei → Minimum 21 − 8
		expect(idx.freeItem('tampen', p)).toBe(13);
		expect(idx.freeItem('tampen', { from: '2026-07-02', to: '2026-07-03' })).toBe(21);
	});

	it('Typ-Belegung und Artikel-Belegung teilen sich den Vorrat des Typs', () => {
		const idx = new AvailabilityIndex(stock, [b('2026-07-02', '2026-07-03', { typeId: 'T' })]);
		expect(idx.freeType('T', p)).toBe(1);
		// Der einzelne Artikel ist nicht konkret belegt …
		expect(idx.freeItem('k1', p)).toBe(1);
		const both = new AvailabilityIndex(stock, [
			b('2026-07-02', '2026-07-03', { typeId: 'T' }),
			b('2026-07-03', '2026-07-04', { itemId: 'k2' })
		]);
		// … aber Typ-Zeile + konkreter K2 lassen nur noch K1 übrig, und auch K1 ist dann „vergeben“
		expect(both.freeType('T', p)).toBe(0);
		const [k1] = both.check([{ typeId: null, itemId: 'k1', quantity: 1 }], p);
		expect(k1).toEqual({ index: 0, ok: false, available: 0 });
	});

	it('prüft neue Zeilen gemeinsam (Typ + Artikel desselben Typs)', () => {
		const idx = new AvailabilityIndex(stock, []);
		const res = idx.check(
			[
				{ typeId: 'T', itemId: null, quantity: 1 },
				{ typeId: null, itemId: 'k1', quantity: 1 }
			],
			p
		);
		expect(res.every((r) => r.ok)).toBe(true);
		const over = idx.check(
			[
				{ typeId: 'T', itemId: null, quantity: 2 },
				{ typeId: null, itemId: 'k1', quantity: 1 }
			],
			p
		);
		expect(over.map((r) => r.ok)).toEqual([false, false]);
		expect(over[0]!.available).toBe(1);
	});

	it('defekte Artikel und unbekannte IDs sind nie frei; Mengen begrenzt', () => {
		const idx = new AvailabilityIndex(stock, []);
		const [defect, unknown, many, loose] = idx.check(
			[
				{ typeId: null, itemId: 'k3', quantity: 1 },
				{ typeId: null, itemId: 'gibt-es-nicht', quantity: 1 },
				{ typeId: null, itemId: 'tampen', quantity: 22 },
				{ typeId: null, itemId: 'kiste', quantity: 1 }
			],
			p
		);
		expect(defect!.ok).toBe(false);
		expect(unknown).toEqual({ index: 1, ok: false, available: 0 });
		expect(many).toEqual({ index: 2, ok: false, available: 21 });
		expect(loose!.ok).toBe(true);
	});
});

describe('schemas', () => {
	it('batchNames nummeriert fortlaufend', () => {
		expect(batchNames('K1.', 3, 1)).toEqual(['K1.1', 'K1.2', 'K1.3']);
		expect(batchNames('Kiste', 1, 5)).toEqual(['Kiste']);
	});

	it('codeFromScan liest Codes und Scan-URLs', () => {
		expect(codeFromScan(' m-000123 ')).toBe('M-000123');
		expect(codeFromScan('https://intern.example.org/modules/material/scan/L-000002')).toBe(
			'L-000002'
		);
		expect(codeFromScan('https://example.org/anderes')).toBeNull();
	});

	it('reservationState leitet Vergangen/Läuft ab', () => {
		const r = { status: 'reserved' as const, startsOn: '2026-07-01', endsOn: '2026-07-05' };
		expect(reservationState(r, '2026-06-30')).toBe('upcoming');
		expect(reservationState(r, '2026-07-05')).toBe('running');
		expect(reservationState(r, '2026-07-06')).toBe('past');
		expect(reservationState({ ...r, status: 'cancelled' }, '2026-06-30')).toBe('cancelled');
	});

	it('reservationInput verlangt Aktion/Gruppe passend zum Zweck und leert die andere', () => {
		const base = {
			title: 'Sommerlager',
			startsOn: '2026-07-01',
			endsOn: '2026-07-05',
			lines: [{ kind: 'type', typeId: '00000000-0000-4000-8000-000000000001', quantity: 2 }]
		};
		expect(reservationInput.safeParse({ ...base, purpose: 'action' }).success).toBe(false);
		const ok = reservationInput.parse({
			...base,
			purpose: 'group',
			groupId: '00000000-0000-4000-8000-000000000002',
			actionId: '00000000-0000-4000-8000-000000000003'
		});
		expect(ok.actionId).toBeNull();
		expect(ok.groupId).toBe('00000000-0000-4000-8000-000000000002');
		expect(reservationInput.safeParse({ ...base, lines: [] }).success).toBe(false);
		expect(reservationInput.safeParse({ ...base, endsOn: '2026-06-30' }).success).toBe(false);
	});
});
