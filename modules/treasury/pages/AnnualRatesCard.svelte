<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Label } from '$lib/components/ui/label';
	import { MoneyInput } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { FEE_LEVELS, FEE_LEVEL_LABELS, type FeeRates } from '../schemas';

	let {
		rates = $bindable(),
		disabled = false
	}: {
		/** Cent je Ebene */
		rates: FeeRates;
		disabled?: boolean;
	} = $props();

	const total = $derived(FEE_LEVELS.reduce((s, l) => s + (rates[l] || 0), 0));
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Beiträge</Card.Title>
		<Card.Description>Jahresbeitrag je Ebene für ein volles Mitglied.</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		<div class="grid gap-3 sm:grid-cols-2">
			{#each FEE_LEVELS as level (level)}
				<div class="grid gap-1.5">
					<Label for="annual-rate-{level}">{FEE_LEVEL_LABELS[level]}</Label>
					<MoneyInput
						id="annual-rate-{level}"
						label={`Beitrag ${FEE_LEVEL_LABELS[level]}`}
						bind:cents={rates[level]}
						max={100_000}
						{disabled}
					/>
				</div>
			{/each}
		</div>
		<div class="flex items-baseline justify-between gap-2 border-t pt-3">
			<span class="text-sm text-muted-foreground">Summe je volles Mitglied</span>
			<span class="text-lg font-semibold tabular-nums">{formatEuro(total)}</span>
		</div>
		<p class="text-xs text-muted-foreground">
			Eintritt im Beitragsjahr nach dem 28.02.: nur {FEE_LEVEL_LABELS.stamm}
			({formatEuro(rates.stamm || 0)}). Zweitmitglieder zahlen nur die Ebenen, die bei ihnen
			hinterlegt sind.
		</p>
	</Card.Content>
</Card.Root>
