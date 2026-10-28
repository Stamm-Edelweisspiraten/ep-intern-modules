<script lang="ts">
	// Typ anlegen oder bearbeiten (Name, Kategorie, Beschreibung, Notizen, Bilder).
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import { typeInput, type Category, type ImageRef, type MaterialType } from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import ImageManager from '../shared/ImageManager.svelte';
	import { categoryOptions } from './options';

	let {
		open = $bindable(false),
		type = null,
		categories,
		onsaved,
		onadditems
	}: {
		open?: boolean;
		/** `null` = neu anlegen */
		type?: MaterialType | null;
		categories: Category[];
		onsaved: (type: MaterialType) => void;
		/** Nach dem Anlegen direkt Artikel des Typs anlegen */
		onadditems?: (type: MaterialType) => void;
	} = $props();

	let step = $state<'form' | 'images'>('form');
	let created = $state<MaterialType | null>(null);
	let images = $state<ImageRef[]>([]);
	let name = $state('');
	let categoryId = $state<string | null>(null);
	let description = $state('');
	let notes = $state('');
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			step = 'form';
			created = null;
			errors = {};
			name = type?.name ?? '';
			categoryId = type?.categoryId ?? null;
			description = type?.description ?? '';
			notes = type?.notes ?? '';
			images = type?.images ?? [];
		});
	});

	async function save(e?: SubmitEvent) {
		e?.preventDefault();
		errors = {};
		const parsed = typeInput.safeParse({ name, categoryId, description, notes });
		if (!parsed.success) {
			errors = fieldErrors(parsed.error);
			return;
		}
		busy = true;
		try {
			const saved = await apiFetch<MaterialType>(
				type ? `${API}/types/${type.id}` : `${API}/types`,
				{ method: type ? 'PATCH' : 'POST', body: JSON.stringify(parsed.data) }
			);
			onsaved(saved);
			if (type) {
				toast.success('Typ gespeichert');
				open = false;
			} else {
				toast.success(`Typ „${saved.name}“ angelegt`);
				created = saved;
				images = [];
				step = 'images';
			}
		} catch (err) {
			errors = apiFieldErrors(err);
			if (!Object.keys(errors).length) toast.error(errorText(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		{#if step === 'images' && created}
			<Dialog.Header>
				<Dialog.Title>Typ „{created.name}“ angelegt</Dialog.Title>
				<Dialog.Description>
					Füge Bilder hinzu und lege danach die Artikel dieses Typs an (z. B. „{created.name} 1“, „{created.name}
					2“ …).
				</Dialog.Description>
			</Dialog.Header>
			<ImageManager
				owner="types"
				id={created.id}
				{images}
				onchange={(next) => {
					images = next;
					onsaved({ ...created!, images: next });
				}}
			/>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)}>Fertig</Button>
				{#if onadditems}
					<Button
						onclick={() => {
							const t = { ...created!, images };
							open = false;
							onadditems(t);
						}}
					>
						Artikel anlegen
					</Button>
				{/if}
			</Dialog.Footer>
		{:else}
			<Dialog.Header>
				<Dialog.Title>{type ? 'Typ bearbeiten' : 'Typ anlegen'}</Dialog.Title>
				<Dialog.Description>
					Ein Typ (z. B. „Kohtenbahn“) fasst gleichartige Lagerartikel zusammen – reserviert wird
					dann einfach „8 × Kohtenbahn“.
				</Dialog.Description>
			</Dialog.Header>
			<form id="type-form" class="grid gap-4" onsubmit={save}>
				<div class="grid gap-4 sm:grid-cols-2">
					<FormField label="Name" id="type-name" required error={errors.name}>
						<Input
							id="type-name"
							bind:value={name}
							maxlength={150}
							placeholder="z. B. Kohtenbahn"
							autocomplete="off"
						/>
					</FormField>
					<FormField label="Kategorie" id="type-category" error={errors.categoryId}>
						<SelectField
							id="type-category"
							label="Kategorie"
							options={categoryOptions(categories)}
							emptyLabel="Ohne Kategorie"
							bind:value={categoryId}
						/>
					</FormField>
				</div>
				<FormField
					label="Beschreibung"
					id="type-description"
					hint="Sehen alle beim Reservieren"
					error={errors.description}
				>
					<Textarea id="type-description" bind:value={description} rows={3} />
				</FormField>
				<FormField
					label="Notizen"
					id="type-notes"
					hint="Intern, z. B. Aufbauhinweise oder Pflege"
					error={errors.notes}
				>
					<Textarea id="type-notes" bind:value={notes} rows={3} />
				</FormField>
				{#if type}
					<section class="grid gap-2" aria-labelledby="type-images-heading">
						<h3 id="type-images-heading" class="text-sm font-medium">Bilder</h3>
						<ImageManager
							owner="types"
							id={type.id}
							{images}
							onchange={(next) => {
								images = next;
								onsaved({ ...type, images: next });
							}}
						/>
					</section>
				{/if}
			</form>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" form="type-form" disabled={busy}>
					{busy ? BUSY_SAVE : type ? 'Speichern' : 'Anlegen'}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
