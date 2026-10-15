<script lang="ts">
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '$lib/components/ui/button';
	import { formatEuro } from '$lib/components/layout/money';
	import type { AccountingSummary } from '../schemas';

	let { summary, onshowmissing }: { summary: AccountingSummary; onshowmissing: () => void } =
		$props();
</script>

{#snippet kpi(label: string, cents: number, tone?: string, hint?: string)}
	<div class="bg-card ring-foreground/10 flex flex-col gap-1 rounded-xl px-4 py-3 ring-1">
		<span class="text-xs text-muted-foreground">{label}</span>
		<span class={['text-xl font-semibold tabular-nums', tone]}>{formatEuro(cents)}</span>
		{#if hint}<span class="text-xs text-muted-foreground tabular-nums">{hint}</span>{/if}
	</div>
{/snippet}

<section aria-label="Kennzahlen" class="space-y-3">
	<div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
		{@render kpi(
			'Einnahmen',
			summary.incomeCents,
			'text-green-700 dark:text-green-400',
			summary.plannedIncomeCents !== null
				? `geplant ${formatEuro(summary.plannedIncomeCents)}`
				: undefined
		)}
		{@render kpi(
			'Ausgaben',
			summary.expenseCents,
			undefined,
			summary.plannedExpenseCents !== null
				? `geplant ${formatEuro(summary.plannedExpenseCents)}`
				: undefined
		)}
		{@render kpi(
			'Saldo',
			summary.balanceCents,
			summary.balanceCents < 0
				? 'text-red-700 dark:text-red-400'
				: 'text-green-700 dark:text-green-400'
		)}
		{@render kpi(
			'Offene Auslagen',
			summary.openReimbursementCents,
			summary.openReimbursementCents > 0 ? 'text-amber-700 dark:text-amber-400' : undefined,
			'noch nicht ausgezahlt'
		)}
	</div>

	{#if summary.missingReceipts > 0}
		<div
			class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
			role="status"
		>
			<span class="flex items-center gap-2">
				<AlertTriangle class="size-4 shrink-0" aria-hidden="true" />
				{summary.missingReceipts === 1
					? '1 Ausgabe ohne Beleg'
					: `${summary.missingReceipts} Ausgaben ohne Beleg`}
			</span>
			<Button variant="ghost" size="sm" onclick={onshowmissing}>Nur diese anzeigen</Button>
		</div>
	{/if}
</section>
