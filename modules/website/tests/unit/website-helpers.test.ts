/** Website: reine Helfer (aus `tests/unit/sdk-html.test.ts` herausgelöst) */
import { describe, expect, it } from 'vitest';
import { bannerState, firstNameOf } from '$modules/website/schemas';

describe('website: reine Helfer', () => {
	const now = Date.parse('2026-10-25T12:00:00Z');
	it('bannerState', () => {
		expect(bannerState({ active: false, startsAt: null, endsAt: null }, now)).toBe('inactive');
		expect(bannerState({ active: true, startsAt: null, endsAt: null }, now)).toBe('live');
		expect(bannerState({ active: true, startsAt: '2026-10-26T00:00:00Z', endsAt: null }, now)).toBe(
			'scheduled'
		);
		expect(bannerState({ active: true, startsAt: null, endsAt: '2026-10-25T12:00:00Z' }, now)).toBe(
			'expired'
		);
	});

	it('firstNameOf', () => {
		expect(firstNameOf('  Anna-Lena  Muster ')).toBe('Anna-Lena');
		expect(firstNameOf('')).toBe('');
	});
});
