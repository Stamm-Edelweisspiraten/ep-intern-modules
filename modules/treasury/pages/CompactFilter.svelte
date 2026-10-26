<script lang="ts">
	// Handy/Tablet: Suche + „Filter“-Knopf über einer Liste. Die Filter (Chips) öffnen auf dem
	// Handy als Blatt von unten, auf dem Tablet als Popover am Knopf. Zahl am Knopf = aktive Filter.
	import type { Snippet } from 'svelte';
	import Search from '@lucide/svelte/icons/search';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import { Button } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';
	import { BottomSheet, CountBadge, type DeviceLayout } from '$lib/components/layout';

	let {
		search = $bindable(''),
		searchLabel,
		placeholder,
		layout,
		activeCount = 0,
		resultLabel,
		onreset,
		oninput,
		chips,
		filterLabel = 'Filter'
	}: {
		search?: string;
		searchLabel: string;
		placeholder: string;
		layout: DeviceLayout;
		/** Anzahl abweichender Filter (Zahl am Knopf) */
		activeCount?: number;
		/** Knopf im Filterblatt, z. B. „12 Treffer anzeigen“ */
		resultLabel: string;
		onreset: () => void;
		oninput?: () => void;
		/** Filtergruppen (`ChoiceChips`); fehlt = kein Filterknopf */
		chips?: Snippet;
		filterLabel?: string;
	} = $props();

	let open = $state(false);
</script>

{#snippet trigger(props: Record<string, unknown> = {})}
	<Button
		{...props}
		variant="outline"
		class="h-11 shrink-0 gap-1.5 px-3.5 font-semibold"
		aria-label={activeCount ? `${filterLabel} (${activeCount} aktiv)` : filterLabel}
		onclick={layout === 'phone' ? () => (open = true) : (props.onclick as () => void)}
	>
		<SlidersHorizontal class="size-4.5" />
		{filterLabel}
		{#if activeCount}<CountBadge count={activeCount} label={`${activeCount} aktiv`} />{/if}
	</Button>
{/snippet}

<div class="flex gap-2">
	<label
		class="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-background px-3 text-muted-foreground focus-within:ring-2 focus-within:ring-ring"
	>
		<Search class="size-4.5 shrink-0" aria-hidden="true" />
		<input
			type="search"
			class="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none"
			{placeholder}
			aria-label={searchLabel}
			bind:value={search}
			{oninput}
		/>
	</label>
	{#if chips}
		{#if layout === 'phone'}
			{@render trigger()}
		{:else}
			<Popover.Root bind:open>
				<Popover.Trigger>
					{#snippet child({ props })}
						{@render trigger(props)}
					{/snippet}
				</Popover.Trigger>
				<Popover.Content align="end" class="w-96 p-0 py-2">
					{@render chips()}
					<div class="flex gap-2 px-4 pt-2">
						<Button variant="outline" size="sm" onclick={onreset}>Zurücksetzen</Button>
						<Button size="sm" class="ml-auto" onclick={() => (open = false)}>Fertig</Button>
					</div>
				</Popover.Content>
			</Popover.Root>
		{/if}
	{/if}
</div>

{#if chips && layout === 'phone'}
	<BottomSheet bind:open title={filterLabel}>
		{#snippet headerActions()}
			<Button variant="ghost" class="text-link" onclick={onreset}>Zurücksetzen</Button>
		{/snippet}
		{@render chips()}
		{#snippet footer()}
			<Button class="mb-1 h-12 w-full text-base" onclick={() => (open = false)}
				>{resultLabel}</Button
			>
		{/snippet}
	</BottomSheet>
{/if}
