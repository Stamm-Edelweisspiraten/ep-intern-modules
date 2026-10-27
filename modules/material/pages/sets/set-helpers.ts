/**
 * Anzeige-Hilfen für Sets (Vollständigkeits-Ampel, Teile-Text), ohne Server-Imports.
 */
import type { BadgeVariant } from '$lib/components/ui/badge';
import type { SetCompleteness, SetTemplate } from '../../schemas';

export interface CompletenessView {
	variant: BadgeVariant;
	label: string;
	/** Einzelheiten („fehlt: 1 × Kohtenbahn“ …) */
	details: string[];
}

const list = (items: { articleName: string; count: number }[]) =>
	items.map((i) => `${i.count} × ${i.articleName}`).join(', ');

/** Ampel: vollständig (grün) · defekt (rot) · fehlt (gelb) · zu viel (blau) */
export function completenessView(c: SetCompleteness): CompletenessView {
	const details: string[] = [];
	if (c.missing.length) details.push(`Fehlt: ${list(c.missing)}`);
	if (c.unusable)
		details.push(`${c.unusable} ${c.unusable === 1 ? 'Stück' : 'Stücke'} defekt oder verloren`);
	if (c.extra.length) details.push(`Zu viel: ${list(c.extra)}`);
	if (c.complete && !details.length) return { variant: 'success', label: 'Vollständig', details };
	if (c.unusable) return { variant: 'destructive', label: 'Defekt', details };
	if (c.missing.length) {
		const n = c.missing.reduce((s, m) => s + m.count, 0);
		return { variant: 'warning', label: `Fehlt ${n}`, details };
	}
	if (c.extra.length) return { variant: 'info', label: 'Zu viel', details };
	return {
		variant: c.complete ? 'success' : 'warning',
		label: c.complete ? 'Vollständig' : 'Unvollständig',
		details
	};
}

/** Teileliste einer Vorlage als Text „4 × Kohtenbahn, 1 × Kohtenkreuz“ */
export function partsText(t: Pick<SetTemplate, 'parts'>): string {
	return t.parts
		.map((p) =>
			p.kind === 'bulk'
				? `${p.quantity} ${p.unitLabel} ${p.articleName}`
				: `${p.quantity} × ${p.articleName}`
		)
		.join(', ');
}
