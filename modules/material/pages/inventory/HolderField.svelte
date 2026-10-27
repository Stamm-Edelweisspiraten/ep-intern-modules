<script lang="ts">
	// Ort wählen: Lagerort ODER Kiste (optional „ohne Ort“). Lagerorte als Auswahl mit Suche,
	// Kisten über die Stück-Suche (nur Kisten).
	import { untrack } from 'svelte';
	import Box from '@lucide/svelte/icons/box';
	import { Button } from '$lib/components/ui/button';
	import { SelectField } from '$lib/components/ui/select-field';
	import type { Location, UnitSummary } from '../../schemas';
	import UnitPicker from '../shared/UnitPicker.svelte';
	import ModeSwitch from './ModeSwitch.svelte';
	import { locationOptions } from './inventory';

	type Mode = 'location' | 'container' | 'none';

	let {
		locationId = $bindable(null),
		containerId = $bindable(null),
		containerName = $bindable(''),
		locations,
		allowNone = false,
		exclude = [],
		id,
		label = 'Ort',
		locationError = null,
		containerError = null
	}: {
		locationId?: string | null;
		containerId?: string | null;
		/** Anzeigename der gewählten Kiste */
		containerName?: string;
		locations: Location[];
		/** „Ohne Ort“ anbieten (nur Stücke; Mengen brauchen immer einen Ort) */
		allowNone?: boolean;
		/** Diese Stücke nie als Kiste anbieten (z. B. die Kiste selbst) */
		exclude?: string[];
		/** ID für das Lagerort-Feld (FormField) */
		id: string;
		label?: string;
		locationError?: string | null;
		containerError?: string | null;
	} = $props();

	// Startmodus aus den Werten (nur einmal; der Aufrufer rendert per `{#key}` neu)
	let mode = $state<Mode>(
		untrack(() => (containerId ? 'container' : locationId || !allowNone ? 'location' : 'none'))
	);

	let picking = $state(false);

	const options = $derived(locationOptions(locations));
	const modes = $derived([
		{ value: 'location' as Mode, label: 'Lagerort' },
		{ value: 'container' as Mode, label: 'Kiste' },
		...(allowNone ? [{ value: 'none' as Mode, label: 'Ohne Ort' }] : [])
	] satisfies { value: Mode; label: string }[]);

	function setMode(m: Mode) {
		mode = m;
		if (m === 'location') {
			containerId = null;
			containerName = '';
		} else if (m === 'container') {
			locationId = null;
			picking = !containerId;
		} else {
			locationId = null;
			containerId = null;
			containerName = '';
		}
	}

	function pick(u: UnitSummary) {
		containerId = u.id;
		containerName = `${u.name} (${u.code})`;
		locationId = null;
		picking = false;
	}
</script>

<div class="space-y-2">
	<ModeSwitch value={mode} options={modes} label={`${label}: Art`} onchange={setMode} size="sm" />
	{#if mode === 'location'}
		<SelectField
			{id}
			{options}
			bind:value={locationId}
			label={`${label}: Lagerort`}
			placeholder="Lagerort wählen …"
			invalid={!!locationError}
		/>
		{#if !options.length}
			<p class="text-xs text-muted-foreground">
				Noch keine Lagerorte – leg sie unter „Lagerorte“ an.
			</p>
		{/if}
		{#if locationError}
			<p class="text-xs text-destructive" role="alert">{locationError}</p>
		{/if}
	{:else if mode === 'container'}
		{#if containerId && !picking}
			<div class="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
				<Box class="size-4 text-muted-foreground" aria-hidden="true" />
				<span class="min-w-0 flex-1 truncate">{containerName || 'Kiste gewählt'}</span>
				<Button size="sm" variant="ghost" onclick={() => (picking = true)}>Ändern</Button>
			</div>
		{:else}
			<UnitPicker single containersOnly {exclude} label={`${label}: Kiste suchen`} onpick={pick} />
		{/if}
		{#if containerError}
			<p class="text-xs text-destructive" role="alert">{containerError}</p>
		{/if}
	{:else}
		<p class="text-sm text-muted-foreground">Das Stück hat keinen festen Ort.</p>
	{/if}
</div>
