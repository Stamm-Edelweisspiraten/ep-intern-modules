<script lang="ts">
	// Materialliste exportieren (PDF/CSV), gruppiert nach Kategorie oder Lagerort, mit Filtern und Spalten.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Download from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField } from '$lib/components/layout';
	import { downloadPdf } from '$lib/components/layout/download';
	import {
		INVENTORY_COLUMNS,
		type Category,
		type Condition,
		type ExportFormat,
		type InventoryColumn,
		type Location
	} from '../../schemas';
	import { API } from '../helpers';
	import { categoryOptions, conditionOptions, locationOptions } from './options';

	let {
		open = $bindable(false),
		categories,
		locations,
		initial
	}: {
		open?: boolean;
		categories: Category[];
		locations: Location[];
		/** Vorbelegung aus den Filtern der Lagertabelle */
		initial: {
			categoryId: string | null;
			locationId: string | null;
			condition: Condition | null;
			archived: boolean;
		};
	} = $props();

	let format = $state<ExportFormat>('pdf');
	let groupBy = $state<'category' | 'location'>('category');
	let categoryId = $state<string | null>(null);
	let locationId = $state<string | null>(null);
	let condition = $state<string | null>(null);
	let columns = $state<InventoryColumn[]>(
		INVENTORY_COLUMNS.filter((c) => c.default).map((c) => c.key)
	);
	let includeArchived = $state(false);
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			categoryId = initial.categoryId;
			locationId = initial.locationId;
			condition = initial.condition;
			includeArchived = initial.archived;
		});
	});

	const locOptions = $derived([
		{ value: 'none', label: 'Ohne Lagerort' },
		...locationOptions(locations)
	]);

	function toggleColumn(key: InventoryColumn, on: boolean) {
		const set = new Set(columns);
		if (on) set.add(key);
		else set.delete(key);
		// Reihenfolge wie in der Vorgabe
		columns = INVENTORY_COLUMNS.map((c) => c.key).filter((k) => set.has(k));
	}

	async function run() {
		if (!columns.length) {
			toast.error('Wähle mindestens eine Spalte.');
			return;
		}
		busy = true;
		try {
			await downloadPdf(
				`/api/v1${API}/exports/inventory`,
				{
					method: 'POST',
					body: JSON.stringify({
						format,
						groupBy,
						categoryId,
						locationId,
						condition,
						columns,
						includeArchived
					})
				},
				`materialliste.${format}`
			);
			toast.success('Materialliste erstellt');
			open = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Export fehlgeschlagen');
		} finally {
			busy = false;
		}
	}
</script>

{#snippet choice(
	value: string,
	options: { value: string; label: string }[],
	set: (v: string) => void,
	label: string
)}
	<div class="flex flex-wrap gap-1" role="group" aria-label={label}>
		{#each options as o (o.value)}
			<Button
				type="button"
				size="sm"
				variant={value === o.value ? 'default' : 'outline'}
				aria-pressed={value === o.value}
				onclick={() => set(o.value)}
			>
				{o.label}
			</Button>
		{/each}
	</div>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Materialliste exportieren</Dialog.Title>
			<Dialog.Description>
				Alle passenden Lagerartikel als Liste – zum Ausdrucken, Abhaken oder Weiterverarbeiten.
			</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-4">
			<div class="grid gap-4 sm:grid-cols-2">
				<div class="grid content-start gap-2">
					<span class="text-sm font-medium">Format</span>
					{@render choice(
						format,
						[
							{ value: 'pdf', label: 'PDF' },
							{ value: 'csv', label: 'CSV (Tabelle)' }
						],
						(v) => (format = v as ExportFormat),
						'Format'
					)}
				</div>
				<div class="grid content-start gap-2">
					<span class="text-sm font-medium">Sortiert nach</span>
					{@render choice(
						groupBy,
						[
							{ value: 'category', label: 'Kategorie' },
							{ value: 'location', label: 'Lagerort' }
						],
						(v) => (groupBy = v as 'category' | 'location'),
						'Gruppierung'
					)}
				</div>
			</div>

			<div class="grid gap-4 sm:grid-cols-3">
				<FormField label="Kategorie" id="export-category">
					<SelectField
						id="export-category"
						label="Kategorie"
						options={categoryOptions(categories)}
						emptyLabel="Alle Kategorien"
						bind:value={categoryId}
					/>
				</FormField>
				<FormField label="Lagerort" id="export-location">
					<SelectField
						id="export-location"
						label="Lagerort"
						options={locOptions}
						emptyLabel="Alle Orte"
						bind:value={locationId}
					/>
				</FormField>
				<FormField label="Zustand" id="export-condition">
					<SelectField
						id="export-condition"
						label="Zustand"
						options={conditionOptions}
						emptyLabel="Alle Zustände"
						bind:value={condition}
					/>
				</FormField>
			</div>

			<fieldset class="grid gap-2">
				<legend class="mb-1 text-sm font-medium">Spalten</legend>
				<div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
					{#each INVENTORY_COLUMNS as c (c.key)}
						<label class="flex items-center gap-2 text-sm">
							<Checkbox
								checked={columns.includes(c.key)}
								onCheckedChange={(v) => toggleColumn(c.key, v === true)}
							/>
							{c.label}
						</label>
					{/each}
				</div>
				{#if !columns.length}
					<p class="text-xs text-destructive" role="alert">Wähle mindestens eine Spalte.</p>
				{/if}
			</fieldset>

			<label class="flex items-center gap-2 text-sm">
				<Checkbox
					checked={includeArchived}
					onCheckedChange={(v) => (includeArchived = v === true)}
				/>
				Archivierte Artikel einschließen
			</label>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button disabled={busy || !columns.length} onclick={run}>
				<Download />
				{busy ? 'Erstellt …' : format === 'pdf' ? 'PDF herunterladen' : 'CSV herunterladen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
