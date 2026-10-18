<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import Loader from '@lucide/svelte/icons/loader-circle';
	import { Label } from '$lib/components/ui/label';
	import { Slider } from '$lib/components/ui/slider';
	import { CostBar, NumberStepper, SummaryList } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { CALC_CATEGORY_LABELS, type CalculationResult, type SubsidyResult } from '../schemas';

	let {
		result,
		subsidy,
		includeSubsidy,
		bufferPercent = $bindable(),
		teamPercent = 0,
		team = 0,
		canApply = false,
		applying = false,
		onapply,
		disabled = false
	}: {
		result: CalculationResult;
		subsidy: SubsidyResult | null;
		includeSubsidy: boolean;
		bufferPercent: number;
		teamPercent?: number;
		team?: number;
		canApply?: boolean;
		applying?: boolean;
		onapply?: () => void;
		disabled?: boolean;
	} = $props();

	const showSubsidy = $derived(includeSubsidy && !!subsidy);
	const noPayers = $derived(result.payingParticipants <= 0);

	const teamPays = $derived(team > 0 && teamPercent > 0);

	const rows = $derived([
		{
			label: `Gesamtkosten inkl. ${bufferPercent} % Puffer`,
			value: formatEuro(result.totalCents),
			hint: `Zwischensumme ${formatEuro(result.subtotalCents)} + Puffer ${formatEuro(result.bufferCents)}`
		},
		...(showSubsidy
			? [
					{
						label: 'Zuschuss',
						value: formatEuro(result.subsidyCents),
						negative: true,
						details: (subsidy?.lines ?? [])
							.filter((l) => l.totalCents > 0)
							.map((l) => ({ label: l.label, value: formatEuro(l.totalCents) }))
					}
				]
			: []),
		{
			label: 'Nettokosten',
			value: formatEuro(result.netCents),
			emphasis: 'strong' as const
		},
		{
			label: 'Exakter Preis pro Person',
			value: noPayers ? '–' : formatEuro(Math.round(result.perPersonCents)),
			hint: noPayers ? 'Keine zahlenden Teilnehmenden' : `${result.payingParticipants} zahlende`,
			emphasis: 'muted' as const
		}
	]);

	const segments = $derived(
		result.byCategory
			.filter((c) => c.totalCents > 0)
			.map((c) => ({ label: CALC_CATEGORY_LABELS[c.category], value: c.totalCents }))
	);
</script>

<!-- Ziel der Live-Leiste unten (`CalculationTab`): `id` + `tabindex` für Scrollen/Fokus -->
<section
	id="calc-summary"
	tabindex="-1"
	aria-label="Zusammenfassung der Kalkulation"
	class="bg-card scroll-mt-4 rounded-xl border focus-visible:outline-none lg:sticky lg:top-4"
>
	<div class="flex w-full items-center justify-between gap-3 px-4 pt-4 pb-2.5">
		<span class="flex flex-col">
			<span class="text-muted-foreground text-xs">Beitrag Teilnehmende (empfohlen)</span>
			<span class="text-2xl font-semibold tabular-nums">
				{noPayers ? '–' : formatEuro(result.recommendedPerPersonCents)}
			</span>
			{#if teamPays && !noPayers}
				<span class="text-muted-foreground text-xs tabular-nums">
					Beitrag Team ({teamPercent.toLocaleString('de-DE')} %): {formatEuro(
						result.recommendedTeamPerPersonCents
					)}
				</span>
			{/if}
		</span>
	</div>
	<div class="flex flex-col gap-3 px-4 pb-4">
		{#if noPayers}
			<p class="text-muted-foreground text-sm">
				Trage mindestens eine zahlende Person ein, um den Beitrag zu berechnen.
			</p>
		{/if}
		{#if teamPays && !noPayers}
			<p class="text-muted-foreground text-xs">
				Das Team zahlt {teamPercent.toLocaleString('de-DE')} % des Beitrags, der Rest wird auf die Teilnehmenden
				umgelegt.
			</p>
		{/if}
		{#if canApply && onapply}
			<Button onclick={onapply} disabled={applying || noPayers} class="w-full">
				{#if applying}<Loader class="animate-spin" />{/if}
				Beitrag in die Aktion übernehmen
			</Button>
		{/if}
		<SummaryList {rows} />
		<div class="flex flex-col gap-2">
			<div class="flex items-center justify-between gap-2">
				<Label for="calc-buffer">Puffer</Label>
				<NumberStepper
					id="calc-buffer"
					bind:value={bufferPercent}
					min={0}
					max={25}
					step={1}
					unit="%"
					label="Puffer in Prozent"
					{disabled}
				/>
			</div>
			<Slider
				class="py-1"
				bind:value={bufferPercent}
				min={0}
				max={25}
				step={1}
				label="Puffer in Prozent"
				{disabled}
			/>
		</div>
		{#if segments.length}
			<CostBar {segments} format={formatEuro} />
		{/if}
	</div>
</section>
