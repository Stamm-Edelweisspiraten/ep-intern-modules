<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import { Badge } from '$lib/components/ui/badge';
	import { formatEuro } from '$lib/components/layout/money';
	import type { Participant } from '../schemas';

	let {
		payment,
		/** Link zur Rechnung in der Kasse (nur mit Kassen-Leserecht) */
		linkToInvoice = false
	}: { payment: Participant['payment']; linkToInvoice?: boolean } = $props();

	const fmtDate = (d: string) => {
		const [y, m, day] = d.split('-');
		return `${day}.${m}.${y}`;
	};

	const title = $derived(
		payment
			? [
					`Rechnung ${payment.invoiceNumber}`,
					`Beitrag ${formatEuro(payment.dueCents)}`,
					`bezahlt ${formatEuro(payment.paidCents)}`,
					payment.dueOn ? `fällig ${fmtDate(payment.dueOn)}` : ''
				]
					.filter(Boolean)
					.join(' · ')
			: 'Keine Rechnung in der Kasse'
	);
	const amber = 'border-warning-border text-warning';
</script>

{#snippet badge()}
	{#if !payment}
		<span class="text-muted-foreground">–</span>
	{:else if payment.status === 'paid'}
		<Badge variant="secondary" class="text-success"
			><Check class="size-3" aria-hidden="true" /> Bezahlt</Badge
		>
	{:else if payment.status === 'waived'}
		<Badge variant="secondary">Erlassen</Badge>
	{:else if payment.overdue}
		<Badge variant="outline" class="border-destructive/50 text-destructive"
			>Überfällig · {formatEuro(payment.openCents)}</Badge
		>
	{:else if payment.status === 'partial'}
		<Badge variant="outline" class={amber}>Teilweise · {formatEuro(payment.openCents)} offen</Badge>
	{:else}
		<Badge variant="outline" class={amber}>Offen · {formatEuro(payment.openCents)}</Badge>
	{/if}
{/snippet}

<span class="whitespace-nowrap" {title}>
	{#if payment && linkToInvoice}
		<a
			href={`/modules/treasury/invoices/${payment.invoiceId}`}
			class="rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			aria-label={`${title} – Rechnung in der Kasse öffnen`}>{@render badge()}</a
		>
	{:else}
		{@render badge()}
	{/if}
</span>
