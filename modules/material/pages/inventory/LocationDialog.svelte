<script lang="ts">
	// Lagerort anlegen, umbenennen oder verschieben (übergeordneter Ort).
	// Der Aufrufer rendert per `{#key}` neu.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import { MAX_NAME, MAX_TEXT, locationInput, type Location } from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import { locationOptions, subtreeIds } from './inventory';

	let {
		open = $bindable(false),
		location = null,
		parentId: initialParent = null,
		locations,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neuer Ort */
		location?: Location | null;
		/** Vorbelegung für neue Orte */
		parentId?: string | null;
		locations: Location[];
		onsaved: (location: Location) => void | Promise<void>;
	} = $props();

	const initial = untrack(() => location);
	let name = $state(initial?.name ?? '');
	let parentId = $state<string | null>(initial ? initial.parentId : untrack(() => initialParent));
	let description = $state(initial?.description ?? '');
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	// Ein Ort darf nicht in sich selbst oder einem seiner Unterorte liegen
	const options = $derived(
		locationOptions(locations, initial ? subtreeIds(locations, initial.id) : new Set())
	);

	async function save() {
		const data = { name, parentId, description };
		const parsed = locationInput.safeParse(data);
		if (!parsed.success) {
			errors = fieldErrors(parsed.error.issues);
			document.getElementById(`location-${Object.keys(errors)[0]}`)?.focus();
			return;
		}
		errors = {};
		busy = true;
		try {
			const saved = initial
				? await apiFetch<Location>(`${API}/locations/${initial.id}`, {
						method: 'PATCH',
						body: JSON.stringify(data)
					})
				: await apiFetch<Location>(`${API}/locations`, {
						method: 'POST',
						body: JSON.stringify(data)
					});
			toast.success(initial ? 'Lagerort gespeichert' : 'Lagerort angelegt');
			open = false;
			await onsaved(saved);
		} catch (e) {
			errors = apiFieldErrors(e);
			toast.error(errorText(e, 'Lagerort konnte nicht gespeichert werden'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{initial ? 'Lagerort bearbeiten' : 'Lagerort anlegen'}</Dialog.Title>
			<Dialog.Description>
				Orte lassen sich verschachteln, z. B. Materialraum › Regal A › Fach 2.
			</Dialog.Description>
		</Dialog.Header>
		<form
			id="location-form"
			class="space-y-4"
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<FormField label="Name" id="location-name" error={errors.name ?? null} required>
				<Input
					id="location-name"
					bind:value={name}
					maxlength={MAX_NAME}
					placeholder="z. B. Regal A"
				/>
			</FormField>
			<FormField
				label="Liegt in"
				id="location-parentId"
				error={errors.parentId ?? null}
				hint="Leer = oberste Ebene"
			>
				<SelectField
					id="location-parentId"
					{options}
					bind:value={parentId}
					label="Übergeordneter Lagerort"
					emptyLabel="Oberste Ebene"
					placeholder="Oberste Ebene"
				/>
			</FormField>
			<FormField label="Beschreibung" id="location-description" error={errors.description ?? null}>
				<Textarea
					id="location-description"
					bind:value={description}
					rows={2}
					maxlength={MAX_TEXT}
				/>
			</FormField>
			{#if initial}
				<p class="text-xs text-muted-foreground">Code: {initial.code}</p>
			{/if}
		</form>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button type="submit" form="location-form" disabled={busy}>
				{busy ? BUSY_SAVE : initial ? 'Speichern' : 'Anlegen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
