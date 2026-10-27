<script lang="ts">
	// Bestandsliste als PDF: Filter (Ort inkl. Unterorte, Kategorie, Zustand), Gruppierung,
	// Spaltenauswahl, Mengenartikel. Der Aufrufer rendert per `{#key}` neu (Vorbelegung des Orts).
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import { FormField } from '$lib/components/layout';
	import { downloadPdf } from '$lib/components/layout/download';
	import {
		CONDITIONS,
		CONDITION_LABELS,
		INVENTORY_COLUMNS,
		inventoryPdfInput,
		type Category,
		type InventoryColumn,
		type Location
	} from '../../schemas';
	import { API } from '../helpers';
	import ModeSwitch from '../inventory/ModeSwitch.svelte';
	import { locationOptions } from '../inventory/inventory';

	let {
		open = $bindable(false),
		locationId = null,
		locations,
		categories
	}: {
		open?: boolean;
		/** Vorbelegter Ort (aktuell gewählter Ort im Lager) */
		locationId?: string | null;
		locations: Location[];
		categories: Category[];
	} = $props();

	type GroupBy = 'place' | 'category';

	let place = $state<string | null>(untrack(() => locationId));
	let categoryId = $state<string | null>(null);
	let condition = $state<string | null>(null);
	let groupBy = $state<GroupBy>('place');
	let includeBulk = $state(true);
	let includeRetired = $state(false);
	let columns = $state<InventoryColumn[]>(
		INVENTORY_COLUMNS.filter((c) => c.default).map((c) => c.key)
	);
	let busy = $state(false);
	let error = $state('');

	const locOptions = $derived(locationOptions(locations));
	const categoryOptions = $derived(categories.map((c) => ({ value: c.id, label: c.name })));
	const conditionOptions = CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }));

	function toggleColumn(key: InventoryColumn, on: boolean) {
		if (on) {
			if (!columns.includes(key))
				columns = INVENTORY_COLUMNS.map((c) => c.key).filter(
					(k) => k === key || columns.includes(k)
				);
		} else columns = columns.filter((k) => k !== key);
	}

	async function download() {
		const body = {
			locationId: place,
			categoryId,
			articleId: null,
			condition,
			groupBy,
			columns,
			includeBulk,
			includeRetired
		};
		const parsed = inventoryPdfInput.safeParse(body);
		if (!parsed.success) {
			error = columns.length ? 'Die Angaben sind unvollständig.' : 'Wähle mindestens eine Spalte.';
			return;
		}
		error = '';
		busy = true;
		try {
			await downloadPdf(
				`/api/v1${API}/inventory.pdf`,
				{ method: 'POST', body: JSON.stringify(body) },
				'bestandsliste.pdf'
			);
			open = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'PDF konnte nicht erzeugt werden');
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Bestandsliste (PDF)</Dialog.Title>
			<Dialog.Description>
				Zum Ausdrucken und Abhaken – Stücke und Kisten, auf Wunsch mit Mengenartikeln.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			<div class="grid gap-4 sm:grid-cols-2">
				<div class="sm:col-span-2">
					<FormField label="Lagerort" id="inv-pdf-place" hint="Mit allen Unterorten">
						<SelectField
							id="inv-pdf-place"
							options={locOptions}
							bind:value={place}
							label="Lagerort"
							emptyLabel="Alle Lagerorte"
							placeholder="Alle Lagerorte"
						/>
					</FormField>
				</div>
				<FormField label="Kategorie" id="inv-pdf-category">
					<SelectField
						id="inv-pdf-category"
						options={categoryOptions}
						bind:value={categoryId}
						label="Kategorie"
						emptyLabel="Alle Kategorien"
						placeholder="Alle Kategorien"
					/>
				</FormField>
				<FormField label="Zustand" id="inv-pdf-condition">
					<SelectField
						id="inv-pdf-condition"
						options={conditionOptions}
						bind:value={condition}
						label="Zustand"
						emptyLabel="Jeder Zustand"
						placeholder="Jeder Zustand"
					/>
				</FormField>
			</div>

			<div class="space-y-1.5">
				<p class="text-sm font-medium" aria-hidden="true">Gruppieren nach</p>
				<ModeSwitch
					value={groupBy}
					options={[
						{ value: 'place', label: 'Lagerort' },
						{ value: 'category', label: 'Kategorie' }
					]}
					label="Gruppieren nach"
					onchange={(v) => (groupBy = v)}
				/>
			</div>

			<fieldset class="space-y-2">
				<legend class="text-sm font-medium">Spalten</legend>
				<div class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
					{#each INVENTORY_COLUMNS as c (c.key)}
						<div class="flex min-h-9 items-center gap-2">
							<Checkbox
								id={`inv-pdf-col-${c.key}`}
								checked={columns.includes(c.key)}
								onCheckedChange={(v) => toggleColumn(c.key, v === true)}
							/>
							<Label for={`inv-pdf-col-${c.key}`} class="font-normal">{c.label}</Label>
						</div>
					{/each}
				</div>
			</fieldset>

			<div class="space-y-2">
				<div class="flex min-h-9 items-center gap-2">
					<Switch id="inv-pdf-bulk" bind:checked={includeBulk} />
					<Label for="inv-pdf-bulk" class="font-normal">Mengen mit aufnehmen</Label>
				</div>
				<div class="flex min-h-9 items-center gap-2">
					<Switch id="inv-pdf-retired" bind:checked={includeRetired} />
					<Label for="inv-pdf-retired" class="font-normal">Ausgemusterte Stücke aufnehmen</Label>
				</div>
			</div>

			{#if error}
				<p class="text-sm text-destructive" role="alert">{error}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button onclick={download} disabled={busy || !columns.length}>
				{busy ? 'Erstellt …' : 'PDF herunterladen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
