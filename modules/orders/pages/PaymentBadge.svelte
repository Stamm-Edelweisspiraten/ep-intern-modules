<script lang="ts">
	// Zahlstand aus der Kasse – für Mitgliedsbestellungen (Rechnung) und Lieferantenrechnungen (Auszahlung).
	import { Badge, type BadgeVariant } from '$lib/components/ui/badge';
	import { PAYMENT_STATUS_LABELS, type OrderPayment, type SupplierPayment } from '../schemas';

	let {
		payment,
		pending = false,
		showNumber = true,
		class: className = ''
	}: {
		payment: OrderPayment | SupplierPayment | null;
		/** Noch keine Rechnung/Auszahlung vorhanden → „Rechnung folgt“ */
		pending?: boolean;
		/** Rechnungsnummer unter dem Status anzeigen (nur Mitgliedsbestellungen) */
		showNumber?: boolean;
		class?: string;
	} = $props();

	const isOrderPayment = (p: OrderPayment | SupplierPayment): p is OrderPayment =>
		'invoiceNumber' in p;

	const view = $derived.by((): { text: string; variant: BadgeVariant; title?: string } | null => {
		if (!payment) return pending ? { text: 'Rechnung folgt', variant: 'outline' } : null;
		const overdue = isOrderPayment(payment) && payment.overdue && payment.status !== 'paid';
		if (payment.status === 'cancelled')
			return { text: PAYMENT_STATUS_LABELS.cancelled, variant: 'outline' };
		if (payment.status === 'paid')
			return { text: PAYMENT_STATUS_LABELS.paid, variant: 'secondary' };
		if (overdue) return { text: 'Überfällig', variant: 'destructive' };
		return { text: PAYMENT_STATUS_LABELS[payment.status] ?? payment.status, variant: 'default' };
	});
	const number = $derived(payment && isOrderPayment(payment) ? payment.invoiceNumber : null);
</script>

{#if view}
	<span class={['inline-flex flex-col items-start gap-0.5', className].filter(Boolean).join(' ')}>
		<Badge variant={view.variant}>{view.text}</Badge>
		{#if showNumber && number}
			<span class="text-xs text-muted-foreground tabular-nums">{number}</span>
		{/if}
	</span>
{/if}
