<script lang="ts">
	// Lagerartikel anlegen (auch mehrere nummeriert) oder bearbeiten; nach dem Anlegen eines einzelnen
	// Artikels können direkt Bilder hinzugefügt werden.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { BUSY_SAVE, FormField, NumberStepper } from '$lib/components/layout';
	import {
		MAX_BATCH_ITEMS,
		MAX_QUANTITY,
		batchNames,
		itemInput,
		itemUpdateInput,
		type Category,
		type Condition,
		type ImageRef,
		type Item,
		type Location,
		type MaterialType
	} from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import ImageManager from '../shared/ImageManager.svelte';
	import {
		categoryOptions,
		conditionOptions,
		locationOptions,
		previewNames,
		typeOptions,
		type ItemPreset
	} from './options';

	let {
		open = $bindable(false),
		item = null,
		preset = {},
		categories,
		locations,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neu anlegen */
		item?: Item | null;
		preset?: ItemPreset;
		categories: Category[];
		locations: Location[];
		/** Nach dem Speichern (angelegte bzw. geänderte Artikel) */
		onsaved: (items: Item[]) => void;
	} = $props();

	let types = $state<MaterialType[]>([]);
	let step = $state<'form' | 'images'>('form');
	let created = $state<Item | null>(null);
	let images = $state<ImageRef[]>([]);

	let typeId = $state<string | null>(null);
	let name = $state('');
	let categoryId = $state<string | null>(null);
	let quantity = $state(1);
	let locationId = $state<string | null>(null);
	let code = $state('');
	let condition = $state<string | null>('ok');
	let conditionNote = $state('');
	let notes = $state('');
	let multiple = $state(false);
	let count = $state(2);
	let numberFrom = $state(1);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);
	/** Zuletzt automatisch aus dem Typ übernommener Name */
	let autoName = '';

	const editing = $derived(!!item);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			step = 'form';
			created = null;
			errors = {};
			multiple = false;
			count = 2;
			numberFrom = 1;
			typeId = item?.typeId ?? preset.typeId ?? null;
			name = item?.name ?? '';
			categoryId = item?.typeId ? null : (item?.categoryId ?? null);
			quantity = item?.quantity ?? 1;
			locationId = item?.locationId ?? preset.locationId ?? null;
			code = item?.code ?? preset.code ?? '';
			condition = item?.condition ?? 'ok';
			conditionNote = item?.conditionNote ?? '';
			notes = item?.notes ?? '';
			images = item?.images ?? [];
			autoName = '';
			void loadTypes();
		});
	});

	async function loadTypes() {
		try {
			const list = await apiFetch<MaterialType[]>(`${API}/types`);
			types = list;
			// Vorbelegter Typ: Namen vorschlagen
			if (!item && typeId && !name) applyTypeName(typeId);
		} catch (e) {
			toast.error(errorText(e, 'Typen konnten nicht geladen werden'));
		}
	}

	function applyTypeName(id: string | null) {
		const t = types.find((x) => x.id === id);
		if (!t) return;
		if (!name.trim() || name === autoName) {
			name = `${t.name} `;
			autoName = name;
		}
	}

	const typeChoices = $derived.by(() => {
		const list = typeOptions(types);
		// Archivierter Typ des Artikels bleibt wählbar
		if (item?.typeId && !list.some((o) => o.value === item.typeId))
			list.unshift({ value: item.typeId, label: item.typeName ?? 'Typ' });
		return list;
	});
	const selectedType = $derived(types.find((t) => t.id === typeId) ?? null);
	const names = $derived(
		!editing && multiple ? batchNames(name.trim(), count, numberFrom) : [name.trim()]
	);

	function body() {
		return {
			typeId,
			name,
			categoryId: typeId ? null : categoryId,
			quantity,
			locationId,
			condition: (condition ?? 'ok') as Condition,
			conditionNote: condition === 'ok' ? '' : conditionNote,
			notes
		};
	}

	async function save(e?: SubmitEvent) {
		e?.preventDefault();
		errors = {};
		busy = true;
		try {
			if (item) {
				const patch: Record<string, unknown> = body();
				const trimmed = code.trim();
				if (trimmed && trimmed.toUpperCase() !== item.code) patch.code = trimmed;
				const parsed = itemUpdateInput.safeParse(patch);
				if (!parsed.success) {
					errors = fieldErrors(parsed.error);
					return;
				}
				const saved = await apiFetch<Item>(`${API}/items/${item.id}`, {
					method: 'PATCH',
					body: JSON.stringify(parsed.data)
				});
				toast.success('Artikel gespeichert');
				open = false;
				onsaved([saved]);
				return;
			}
			const parsed = itemInput.safeParse({
				...body(),
				code: !multiple && code.trim() ? code.trim() : null,
				count: multiple ? count : 1,
				numberFrom
			});
			if (!parsed.success) {
				errors = fieldErrors(parsed.error);
				return;
			}
			const list = await apiFetch<Item[]>(`${API}/items`, {
				method: 'POST',
				body: JSON.stringify(parsed.data)
			});
			onsaved(list);
			if (list.length === 1) {
				toast.success(`Artikel angelegt (Code ${list[0]!.code})`);
				created = list[0]!;
				images = [];
				step = 'images';
			} else {
				toast.success(`${list.length} Artikel angelegt`);
				open = false;
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
				<Dialog.Title>Bilder für „{created.name}“</Dialog.Title>
				<Dialog.Description>
					Der Artikel ist angelegt (Code {created.code}). Füge jetzt Bilder hinzu oder schließe den
					Dialog.
				</Dialog.Description>
			</Dialog.Header>
			<ImageManager
				owner="items"
				id={created.id}
				{images}
				onchange={(next) => {
					images = next;
					onsaved([
						{ ...created!, images: next, thumbUrl: next[0]?.thumbUrl ?? created!.thumbUrl }
					]);
				}}
			/>
			<Dialog.Footer>
				<Button onclick={() => (open = false)}>Fertig</Button>
			</Dialog.Footer>
		{:else}
			<Dialog.Header>
				<Dialog.Title>{editing ? 'Lagerartikel bearbeiten' : 'Lagerartikel anlegen'}</Dialog.Title>
				<Dialog.Description>
					{editing
						? `Code ${item?.code ?? ''}`
						: 'Ein Artikel ist ein einzelnes Stück (z. B. „Kohtenbahn K1.1“) oder eine Menge (z. B. „Tampen“ × 21).'}
				</Dialog.Description>
			</Dialog.Header>

			<form id="item-form" class="grid gap-4" onsubmit={save}>
				<div class="grid gap-4 sm:grid-cols-2">
					<FormField
						label="Typ"
						id="item-type"
						hint="Optional – fasst gleiche Artikel zusammen"
						error={errors.typeId}
					>
						<SelectField
							id="item-type"
							label="Typ"
							options={typeChoices}
							emptyLabel="Ohne Typ"
							bind:value={typeId}
							onchange={(v) => applyTypeName(v)}
						/>
					</FormField>
					{#if typeId}
						<FormField label="Kategorie" id="item-category-info" hint="Kommt vom Typ">
							<Input
								id="item-category-info"
								value={selectedType?.category?.name ?? item?.category?.name ?? 'Ohne Kategorie'}
								disabled
							/>
						</FormField>
					{:else}
						<FormField label="Kategorie" id="item-category" error={errors.categoryId}>
							<SelectField
								id="item-category"
								label="Kategorie"
								options={categoryOptions(categories)}
								emptyLabel="Ohne Kategorie"
								bind:value={categoryId}
							/>
						</FormField>
					{/if}
				</div>

				<FormField
					label="Name"
					id="item-name"
					required
					error={errors.name}
					hint={!editing && multiple
						? 'Die Nummer wird angehängt, z. B. „K1.“ → „K1.1“, „K1.2“ …'
						: undefined}
				>
					<Input
						id="item-name"
						bind:value={name}
						maxlength={150}
						placeholder="z. B. Kohtenbahn K1.1"
						autocomplete="off"
					/>
				</FormField>

				{#if !editing}
					<div class="grid gap-3 rounded-lg border p-3">
						<label class="flex items-center gap-2 text-sm">
							<Checkbox checked={multiple} onCheckedChange={(v) => (multiple = v === true)} />
							Mehrere nummerierte Artikel auf einmal anlegen
						</label>
						{#if multiple}
							<div class="grid gap-4 sm:grid-cols-2">
								<FormField label="Wie viele?" id="item-count" error={errors.count}>
									<NumberStepper
										id="item-count"
										label="Anzahl Artikel"
										min={2}
										max={MAX_BATCH_ITEMS}
										bind:value={count}
									/>
								</FormField>
								<FormField label="Erste Nummer" id="item-number-from" error={errors.numberFrom}>
									<NumberStepper
										id="item-number-from"
										label="Erste Nummer"
										min={0}
										max={99_999}
										bind:value={numberFrom}
									/>
								</FormField>
							</div>
							<p class="text-xs text-muted-foreground" aria-live="polite">
								{#if name.trim()}
									Vorschau: {previewNames(names)}
								{:else}
									Gib einen Namen ein, um die Vorschau zu sehen.
								{/if}
							</p>
						{/if}
					</div>
				{/if}

				<div class="grid gap-4 sm:grid-cols-2">
					<FormField
						label="Anzahl"
						id="item-quantity"
						hint="Bei Einzelstücken 1"
						error={errors.quantity}
					>
						<NumberStepper
							id="item-quantity"
							label="Anzahl"
							min={1}
							max={MAX_QUANTITY}
							bind:value={quantity}
						/>
					</FormField>
					<FormField label="Lagerort" id="item-location" error={errors.locationId}>
						<SelectField
							id="item-location"
							label="Lagerort"
							options={locationOptions(locations)}
							emptyLabel="Ohne Lagerort"
							bind:value={locationId}
						/>
					</FormField>
				</div>

				<div class="grid gap-4 sm:grid-cols-2">
					<FormField label="Zustand" id="item-condition" error={errors.condition}>
						<SelectField
							id="item-condition"
							label="Zustand"
							options={conditionOptions}
							bind:value={condition}
						/>
					</FormField>
					{#if !multiple || editing}
						<FormField
							label="Code"
							id="item-code"
							hint={editing
								? 'Ändern nur, wenn ein anderes Etikett aufgeklebt wird'
								: 'Optional, z. B. vorab gedrucktes Etikett – leer = automatisch (M-…)'}
							error={errors.code}
						>
							<Input
								id="item-code"
								bind:value={code}
								maxlength={40}
								autocomplete="off"
								autocapitalize="characters"
								spellcheck={false}
								class="font-mono"
								data-scan-field
							/>
						</FormField>
					{/if}
				</div>

				{#if condition && condition !== 'ok'}
					<FormField
						label="Notiz zum Zustand"
						id="item-condition-note"
						error={errors.conditionNote}
					>
						<Input
							id="item-condition-note"
							bind:value={conditionNote}
							maxlength={1000}
							placeholder="z. B. Riss an der Ecke"
						/>
					</FormField>
				{/if}

				<FormField label="Notizen" id="item-notes" error={errors.notes}>
					<Textarea id="item-notes" bind:value={notes} rows={3} />
				</FormField>

				{#if item}
					<section class="grid gap-2" aria-labelledby="item-images-heading">
						<h3 id="item-images-heading" class="text-sm font-medium">Bilder</h3>
						<ImageManager
							owner="items"
							id={item.id}
							{images}
							onchange={(next) => {
								images = next;
								onsaved([{ ...item, images: next, thumbUrl: next[0]?.thumbUrl ?? null }]);
							}}
						/>
					</section>
				{/if}
			</form>

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" form="item-form" disabled={busy}>
					{#if busy}
						{BUSY_SAVE}
					{:else if editing}
						Speichern
					{:else if multiple}
						{count} Artikel anlegen
					{:else}
						Anlegen
					{/if}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
