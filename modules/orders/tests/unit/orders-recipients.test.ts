import { describe, expect, it } from 'bun:test';
import { recipientChoices, recipientLabel, recipientPayload } from '$modules/orders/pages/helpers';
import { orderCreateInput } from '$modules/orders/schemas';

// Empfänger im Warenkorb (Mitglied, Gruppe, Stamm) und Body von `POST /orders`.

describe('recipientChoices / recipientPayload', () => {
	it('baut die Auswahl in fester Reihenfolge', () => {
		expect(
			recipientChoices({
				members: [{ id: 'm1', name: 'Kira Muster' }],
				groups: [{ id: 'g1', name: 'Wölfe' }],
				stamm: true
			})
		).toEqual([
			{ value: 'member:m1', label: 'Kira Muster' },
			{ value: 'group:g1', label: 'Gruppe Wölfe' },
			{ value: 'stamm', label: 'Stamm (Stammesmaterial)' }
		]);
		expect(recipientChoices({ members: [], groups: [], stamm: false })).toEqual([]);
	});

	it('übersetzt den Auswahlwert in den Body', () => {
		expect(recipientPayload('member:m1')).toEqual({ recipientKind: 'member', memberId: 'm1' });
		expect(recipientPayload('group:g:1')).toEqual({ recipientKind: 'group', groupId: 'g:1' });
		expect(recipientPayload('stamm')).toEqual({ recipientKind: 'stamm' });
		for (const v of [null, '', 'member:', 'x:1', 'group']) expect(recipientPayload(v)).toBeNull();
	});

	it('Anzeigetext', () => {
		expect(recipientLabel({ kind: 'group', id: 'g', name: 'Wölfe' })).toBe('Gruppe Wölfe');
		expect(recipientLabel({ kind: 'stamm', id: null, name: 'Stamm' })).toBe('Stamm');
		expect(recipientLabel({ kind: 'member', id: 'm', name: 'Kira' })).toBe('Kira');
	});
});

describe('orderCreateInput', () => {
	const items = [{ variantId: crypto.randomUUID(), quantity: 1 }];

	it('ohne `recipientKind` = Mitglied (rückwärtskompatibel)', () => {
		const r = orderCreateInput.parse({ memberId: 'm1', items });
		expect(r.recipientKind).toBe('member');
		expect(orderCreateInput.safeParse({ items }).success).toBe(false);
	});

	it('Gruppe braucht `groupId`, Stamm nichts', () => {
		expect(orderCreateInput.safeParse({ recipientKind: 'group', items }).success).toBe(false);
		expect(
			orderCreateInput.safeParse({ recipientKind: 'group', groupId: 'g1', items }).success
		).toBe(true);
		expect(orderCreateInput.safeParse({ recipientKind: 'stamm', items }).success).toBe(true);
	});
});
