/** Mitglieder: Datumsprüfung mit „heute“ in Europe/Berlin (aus `tests/unit/sdk-dates.test.ts` herausgelöst) */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memberInput } from '$modules/members/schemas';

afterEach(() => {
	vi.useRealTimers();
});

describe('memberInput und todayBerlin', () => {
	it('Mitglied mit Eintritt „heute“ nachts um 00:30 wird akzeptiert', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-20T22:30:00Z'));
		const parsed = memberInput.safeParse({
			firstName: 'Mia',
			lastName: 'Muster',
			birthDate: '2026-10-21'
		});
		// Geburtsdatum „heute“ (Berlin) ist nicht in der Zukunft
		const issues = parsed.success
			? []
			: parsed.error.issues.filter((i) => i.path[0] === 'birthDate');
		expect(issues).toEqual([]);
	});
});
