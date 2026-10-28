<script lang="ts">
	// Set anlegen oder bearbeiten: Name, Notiz und die zusammengehörigen Artikel (z. B. „KJ1“ = Kohtenbahnen
	// KJ1.1–KJ1.6). Ein Artikel gehört höchstens zu einem Set – wird er hier gewählt, verlässt er sein altes.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import { MAX_BATCH_ITEMS, setInput, type MaterialSet } from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import ItemPicker from '../shared/ItemPicker.svelte';

	let {
		open = $bindable(false),
		set = null,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neu anlegen */
		set?: MaterialSet | null;
		onsaved: (set: MaterialSet) => void;
	} = $props();

	let name = $state('');
	let notes = $state('');
	let itemIds = $state<string[]>([]);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			name = set?.name ?? '';
			notes = set?.notes ?? '';
			itemIds = set?.items.map((i) => i.id) ?? [];
			errors = {};
		});
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		errors = {};
		const parsed = setInput.safeParse({ name, notes });
		if (!parsed.success) {
			errors = fieldErrors(parsed.error);
			document.getElementById('set-name')?.focus();
			return;
		}
		busy = true;
		try {
			let saved: MaterialSet;
			if (set) {
				await apiFetch(`${API}/sets/${set.id}`, {
					method: 'PATCH',
					body: JSON.stringify(parsed.data)
				});
				saved = await apiFetch<MaterialSet>(`${API}/sets/${set.id}/items`, {
					method: 'PUT',
					body: JSON.stringify({ itemIds })
				});
			} else {
				saved = await apiFetch<MaterialSet>(`${API}/sets`, {
					method: 'POST',
					body: JSON.stringify({ ...parsed.data, itemIds })
				});
			}
			toast.success(set ? 'Set gespeichert' : 'Set angelegt');
			onsaved(saved);
			open = false;
		} catch (err) {
			errors = apiFieldErrors(err);
			toast.error(errorText(err, 'Set konnte nicht gespeichert werden'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{set ? 'Set bearbeiten' : 'Set anlegen'}</Dialog.Title>
			<Dialog.Description>
				Artikel, die zusammengehören – z. B. die sechs Bahnen eines Jurtendachs. Sie bleiben normale
				Lagerartikel und lassen sich auch einzeln reservieren.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={save} novalidate>
			<FormField label="Name" id="set-name" required error={errors.name}>
				<Input id="set-name" bind:value={name} maxlength={150} placeholder="z. B. KJ1" />
			</FormField>
			<FormField label="Notiz" id="set-notes" error={errors.notes}>
				<Textarea id="set-notes" bind:value={notes} rows={2} />
			</FormField>
			<div class="space-y-2">
				<span class="text-sm font-medium">Artikel</span>
				<ItemPicker
					target="item"
					id="set-items"
					label="Artikel für das Set suchen"
					max={MAX_BATCH_ITEMS}
					bind:selected={itemIds}
					seed={set?.items.map((i) => ({
						id: i.id,
						title: i.name,
						detail: i.typeName ?? '',
						code: i.code
					})) ?? []}
				/>
				{#if errors.itemIds}
					<p class="text-xs text-destructive" role="alert">{errors.itemIds}</p>
				{/if}
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
