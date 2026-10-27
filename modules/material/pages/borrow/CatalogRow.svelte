<script lang="ts">
	// Eine Zeile im Ausleih-Katalog: Bild/Icon, Name, Unterzeile, „frei N von M“ und Stepper.
	// Klick auf Bild/Name öffnet die Details; der Stepper ist davon getrennt.
	import Package from '@lucide/svelte/icons/package';
	import Tent from '@lucide/svelte/icons/tent';
	import { DynamicIcon } from '$lib/components/ui/icon-picker';
	import { NumberStepper } from '$lib/components/layout';

	let {
		title,
		subtitle,
		thumbUrl = null,
		icon = null,
		tent = false,
		free,
		total = null,
		freeLabel = 'frei',
		quantity,
		max,
		canReserve,
		problem = null,
		onchange,
		onopen
	}: {
		title: string;
		subtitle: string;
		thumbUrl?: string | null;
		/** Kategorie-Icon (Name aus der Icon-Bibliothek) */
		icon?: string | null;
		tent?: boolean;
		free: number;
		total?: number | null;
		/** z. B. „frei“ oder „Stück frei“ */
		freeLabel?: string;
		quantity: number;
		max: number;
		canReserve: boolean;
		problem?: string | null;
		onchange: (value: number) => void;
		onopen?: () => void;
	} = $props();

	const blocked = $derived(free <= 0 && quantity === 0);
</script>

<!-- Handy: Name volle Breite, darunter frei + Stepper; ab sm eine Zeile -->
<li class="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 py-2 sm:flex-nowrap">
	<button
		type="button"
		class="flex min-w-0 basis-full items-center gap-3 rounded-md text-left sm:flex-1 sm:basis-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
		onclick={() => onopen?.()}
		disabled={!onopen}
		aria-label="{title}: Details anzeigen"
	>
		{#if thumbUrl}
			<img
				src={thumbUrl}
				alt=""
				width="48"
				height="48"
				class="size-12 shrink-0 rounded-lg border object-cover"
				loading="lazy"
			/>
		{:else}
			<span
				class="flex size-12 shrink-0 items-center justify-center rounded-lg border text-muted-foreground"
				aria-hidden="true"
			>
				{#if tent}
					<Tent class="size-5" />
				{:else}
					<DynamicIcon name={icon} class="size-5">
						{#snippet fallback()}<Package class="size-5" />{/snippet}
					</DynamicIcon>
				{/if}
			</span>
		{/if}
		<span class="min-w-0 flex-1">
			<span class="block truncate font-medium">{title}</span>
			<span class="block truncate text-sm text-muted-foreground">{subtitle}</span>
			{#if problem}
				<span class="block text-xs text-destructive">{problem}</span>
			{:else if blocked}
				<span class="block text-xs text-muted-foreground">Im Zeitraum vergeben</span>
			{/if}
		</span>
	</button>
	<div class="flex w-full items-center justify-end gap-3 pl-15 sm:w-auto sm:pl-0">
		<span class="shrink-0 text-right text-sm leading-tight tabular-nums">
			<span class={['block font-medium', free > 0 ? 'text-link' : 'text-muted-foreground']}>
				{free}
				{freeLabel}
			</span>
			{#if total !== null}
				<span class="block text-xs text-muted-foreground">von {total}</span>
			{/if}
		</span>
		{#if canReserve}
			<NumberStepper
				value={quantity}
				min={0}
				max={Math.max(max, quantity)}
				label="Menge {title}"
				disabled={blocked}
				class="shrink-0"
				{onchange}
			/>
		{/if}
	</div>
</li>
