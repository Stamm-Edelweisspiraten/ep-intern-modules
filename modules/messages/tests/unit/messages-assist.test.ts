/** Nachrichten: Schreibhilfe für Antwortentwürfe (aus `tests/unit/ai-assist.test.ts` herausgelöst) */
import { describe, expect, it } from 'vitest';

describe('Schreibhilfe: Antwortentwurf', () => {
	it('schneidet den zitierten Verlauf ab', async () => {
		const { withoutQuotedHistory } = await import('$modules/messages/assist');
		const text = [
			'Hallo, kommt Mila auch mit?',
			'Danke!',
			'',
			'Am 12.10.2026 um 10:00 schrieb Stamm <stamm@example.org>:',
			'> Liebe Eltern …'
		].join('\r\n');
		expect(withoutQuotedHistory(text)).toBe('Hallo, kommt Mila auch mit?\nDanke!');
		expect(withoutQuotedHistory('Text\n> zitiert\nweiter')).toBe('Text\nweiter');
		expect(withoutQuotedHistory('Oben\n-----Original Message-----\nalt')).toBe('Oben');
	});
});
