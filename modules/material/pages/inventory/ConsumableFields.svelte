<script lang="ts">
	// Schalter „Verbrauchsmaterial“ und Einheit (Typ und Artikel ohne Typ).
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { FormField } from '$lib/components/layout';
	import { MAX_UNIT } from '../../schemas';

	let {
		idPrefix,
		consumable = $bindable(false),
		unit = $bindable(''),
		error,
		disabled = false
	}: {
		idPrefix: string;
		consumable?: boolean;
		unit?: string;
		error?: string;
		/** Artikel mit Typ: Angaben kommen vom Typ */
		disabled?: boolean;
	} = $props();
</script>

<div class="grid gap-4 sm:grid-cols-2">
	<div class="flex items-start gap-2 pt-1">
		<Checkbox id="{idPrefix}-consumable" bind:checked={consumable} {disabled} />
		<div class="grid gap-0.5">
			<Label for="{idPrefix}-consumable">Verbrauchsmaterial</Label>
			<span class="text-xs text-muted-foreground">
				z. B. Fackeln, Petroleum, Gas – bei der Rücknahme wird der Verbrauch vom Bestand abgezogen.
			</span>
		</div>
	</div>
	<FormField
		label="Einheit"
		id="{idPrefix}-unit"
		hint="Leer = Stück, sonst z. B. l, Rolle, Packung"
		{error}
	>
		<Input
			id="{idPrefix}-unit"
			bind:value={unit}
			maxlength={MAX_UNIT}
			placeholder="Stück"
			autocomplete="off"
			{disabled}
		/>
	</FormField>
</div>
