/**
 * Formatierte Infotexte im Anmeldeformular serverseitig bereinigen (nur Server). Die Anzeige ist durch
 * `parseRichText` (Allowlist) ohnehin sicher; gespeichert wird trotzdem nur bereinigtes HTML.
 */
import { sanitizeRichText } from '$lib/sdk/server';
import type { FormDefinition } from '$lib/forms/types';

export function sanitizeFormHtml(def: FormDefinition): FormDefinition {
	return {
		...def,
		fields: def.fields.map((f) =>
			f.type === 'info' && f.format === 'html' ? { ...f, text: sanitizeRichText(f.text) } : f
		)
	};
}
