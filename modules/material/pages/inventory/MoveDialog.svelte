<script lang="ts">
	// Ein oder mehrere Stücke umlagern: Lagerort, Kiste oder ohne Ort.
	// Der Aufrufer rendert per `{#key}` neu.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import { MAX_NOTE, moveInput, moveManyInput, type Location } from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import HolderField from './HolderField.svelte';

	let {
		open = $bindable(false),
		unitIds,
		title,
		current = null,
		locations,
		onsaved
	}: {
		open?: boolean;
		unitIds: string[];
		/** z. B. „Kohtenbahn 07“ oder „3 Stücke“ */
		title: string;
		/** Aktueller Ort (nur bei einem Stück) zur Vorbelegung */
		current?: {
			locationId: string | null;
			containerId: string | null;
			containerName: string;
		} | null;
		locations: Location[];
		onsaved: () => void | Promise<void>;
	} = $props();

	const start = untrack(() => current);
	let locationId = $state<string | null>(start?.locationId ?? null);
	let containerId = $state<string | null>(start?.containerId ?? null);
	let containerName = $state(start?.containerName ?? '');
	let note = $state('');
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	const single = $derived(unitIds.length === 1);

	async function save() {
		const data = single ? { locationId, containerId, note } : { unitIds, locationId, containerId };
		const parsed = (single ? moveInput : moveManyInput).safeParse(data);
		if (!parsed.success) {
			errors = fieldErrors(parsed.error.issues);
			return;
		}
		errors = {};
		busy = true;
		try {
			if (single) {
				await apiFetch(`${API}/units/${unitIds[0]}/move`, {
					method: 'POST',
					body: JSON.stringify(data)
				});
				toast.success('Umgelagert');
			} else {
				const res = await apiFetch<{ moved: number }>(`${API}/units/move`, {
					method: 'POST',
					body: JSON.stringify(data)
				});
				toast.success(`${res.moved} Stücke umgelagert`);
			}
			open = false;
			await onsaved();
		} catch (e) {
			errors = apiFieldErrors(e);
			toast.error(errorText(e, 'Umlagern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Umlagern</Dialog.Title>
			<Dialog.Description>{title}</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-4">
			<FormField label="Neuer Ort" id="move-location">
				<HolderField
					id="move-location"
					bind:locationId
					bind:containerId
					bind:containerName
					{locations}
					allowNone
					exclude={unitIds}
					label="Neuer Ort"
					locationError={errors.locationId ?? null}
					containerError={errors.containerId ?? null}
				/>
			</FormField>
			{#if single}
				<FormField
					label="Notiz"
					id="move-note"
					error={errors.note ?? null}
					hint="Optional, erscheint im Verlauf."
				>
					<Input id="move-note" bind:value={note} maxlength={MAX_NOTE} />
				</FormField>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button onclick={save} disabled={busy}>{busy ? BUSY_SAVE : 'Umlagern'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
