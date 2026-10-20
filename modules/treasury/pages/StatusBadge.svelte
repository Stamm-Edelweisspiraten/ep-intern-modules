<script lang="ts">
	// Einheitlicher Status für Rechnungen und Auszahlungen (überall gleiche Farben und Texte).
	import { Badge, type BadgeVariant } from '$lib/components/ui/badge';
	import type { InvoiceSummary, Payable } from '../schemas';
	import { statusText, statusVariant } from './helpers';

	let {
		invoice,
		payable,
		class: className = ''
	}: {
		invoice?: Pick<InvoiceSummary, 'status' | 'overdue' | 'daysOverdue'>;
		payable?: Pick<Payable, 'openCents' | 'paidCents' | 'cancelledAt' | 'overdue'>;
		class?: string;
	} = $props();

	function payableStatus(p: NonNullable<typeof payable>): { text: string; variant: BadgeVariant } {
		if (p.cancelledAt) return { text: 'Storniert', variant: 'outline' };
		if (p.openCents <= 0) return { text: 'Bezahlt', variant: 'secondary' };
		if (p.overdue) return { text: 'Überfällig', variant: 'destructive' };
		if (p.paidCents > 0) return { text: 'Teilweise bezahlt', variant: 'default' };
		return { text: 'Offen', variant: 'default' };
	}

	const view = $derived(
		invoice
			? { text: statusText(invoice), variant: statusVariant(invoice) }
			: payable
				? payableStatus(payable)
				: null
	);
</script>

{#if view}
	<Badge variant={view.variant} class={className}>{view.text}</Badge>
{/if}
