<script lang="ts">
	// Gewählte Lagerartikel an einen anderen Lagerort umlagern (oder „ohne Ort“).
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { SelectField } from '$lib/components/ui/select-field';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import type { Location } from '../../schemas';
	import { API, errorText } from '../helpers';
	import { locationOptions } from './options';

	let {
		open = $bindable(false),
		itemIds,
		locations,
		onmoved
	}: {
		open?: boolean;
		itemIds: string[];
		locations: Location[];
		onmoved: () => void;
	} = $props();

	let locationId = $state<string | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		untrack(() => (locationId = null));
	});

	async function save() {
		busy = true;
		try {
			const res = await apiFetch<{ moved: number }>(`${API}/items/move`, {
				method: 'POST',
				body: JSON.stringify({ itemIds, locationId })
			});
			const target = locations.find((l) => l.id === locationId)?.name;
			toast.success(
				`${res.moved === 1 ? '1 Artikel' : `${res.moved} Artikel`} ${target ? `nach „${target}“ umgelagert` : 'jetzt ohne Lagerort'}`
			);
			open = false;
			onmoved();
		} catch (e) {
			toast.error(errorText(e, 'Umlagern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Umlagern</Dialog.Title>
			<Dialog.Description>
				{itemIds.length === 1 ? '1 Artikel' : `${itemIds.length} Artikel`} an einen anderen Lagerort bringen.
			</Dialog.Description>
		</Dialog.Header>
		<FormField label="Neuer Lagerort" id="move-location">
			<SelectField
				id="move-location"
				label="Neuer Lagerort"
				options={locationOptions(locations)}
				emptyLabel="Ohne Lagerort"
				bind:value={locationId}
			/>
		</FormField>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button disabled={busy || !itemIds.length} onclick={save}>
				{busy ? BUSY_SAVE : 'Umlagern'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
