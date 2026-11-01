import { describe, expect, it } from 'vitest';
import { OVERVIEW_TASK_KINDS, type OverviewTask } from '$modules/treasury/schemas';
import { taskView } from '$modules/treasury/pages/task-view';

const task = (kind: OverviewTask['kind']): OverviewTask =>
	({
		kind,
		severity: 'warning',
		count: 2,
		cents: 1250,
		year: 2026,
		date: '2026-03-01',
		tab: kind === 'bank-missing' ? null : 'transactions'
	}) as OverviewTask;

describe('taskView (#70, 04-10): eine Quelle für die Kassen-Aufgabentexte', () => {
	it.each(OVERVIEW_TASK_KINDS)('%s liefert Titel, Hinweis, Knopf und Ziel', (kind) => {
		const v = taskView(task(kind));
		expect(v.title.trim()).not.toBe('');
		expect(v.hint.trim()).not.toBe('');
		expect(v.action.trim()).not.toBe('');
		expect(v.href.startsWith('/modules/treasury')).toBe(true);
	});

	it('Mehrzahl und Betrag', () => {
		expect(taskView(task('overdue')).title).toBe('2 Rechnungen sind überfällig (12,50 €)');
		expect(taskView({ ...task('overdue'), count: 1, cents: null }).title).toBe(
			'1 Rechnung ist überfällig'
		);
	});
});
