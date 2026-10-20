<script lang="ts" generics="T extends string">
	// Einheitliche Filter-Knöpfe für alle Tabellen der Kasse (Einfachauswahl).
	import { Button } from '$lib/components/ui/button';

	let {
		options,
		value = $bindable(),
		label,
		onchange
	}: {
		options: { value: T; label: string; count?: number | null }[];
		value: T;
		/** Bezeichnung der Gruppe für Screenreader, z. B. „Buchungen filtern“ */
		label: string;
		onchange?: (value: T) => void;
	} = $props();
</script>

<div class="flex flex-wrap gap-1" role="group" aria-label={label}>
	{#each options as o (o.value)}
		<Button
			size="sm"
			variant={value === o.value ? 'default' : 'outline'}
			aria-pressed={value === o.value}
			onclick={() => {
				if (value === o.value) return;
				value = o.value;
				onchange?.(o.value);
			}}
		>
			{o.label}
			{#if o.count != null && o.count > 0}
				<span class="tabular-nums opacity-70">{o.count}</span>
			{/if}
		</Button>
	{/each}
</div>
