<script lang="ts" module>
	export interface ProductPreset {
		barcode?: string;
		name?: string;
		brand?: string;
		packageSize?: string;
		/** Vorschlag stammt aus Open Food Facts */
		suggested?: boolean;
	}
</script>

<script lang="ts">
	// Lebensmittel-Produkt anlegen oder bearbeiten; nach einem Scan mit Strichcode und Vorschlag aus
	// Open Food Facts vorbelegt.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import {
		MAX_UNIT,
		productInput,
		productUpdateInput,
		type FoodProduct,
		type Location
	} from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import { locationOptions } from '../inventory/options';

	let {
		open = $bindable(false),
		product = null,
		preset = {},
		locations,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neu anlegen */
		product?: FoodProduct | null;
		preset?: ProductPreset;
		locations: Location[];
		onsaved: (product: FoodProduct) => void;
	} = $props();

	let name = $state('');
	let brand = $state('');
	let barcode = $state('');
	let unit = $state('');
	let packageSize = $state('');
	let locationId = $state<string | null>(null);
	let notes = $state('');
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			errors = {};
			name = product?.name ?? preset.name ?? '';
			brand = product?.brand ?? preset.brand ?? '';
			barcode = product?.barcode ?? preset.barcode ?? '';
			unit = product?.unit ?? '';
			packageSize = product?.packageSize ?? preset.packageSize ?? '';
			locationId = product?.locationId ?? null;
			notes = product?.notes ?? '';
		});
	});

	async function save(e?: SubmitEvent) {
		e?.preventDefault();
		errors = {};
		const input = {
			name,
			brand,
			barcode: barcode.trim() || null,
			unit,
			packageSize,
			locationId,
			notes
		};
		const parsed = (product ? productUpdateInput : productInput).safeParse(input);
		if (!parsed.success) {
			errors = fieldErrors(parsed.error);
			return;
		}
		busy = true;
		try {
			const saved = await apiFetch<FoodProduct>(
				product ? `${API}/pantry/products/${product.id}` : `${API}/pantry/products`,
				{ method: product ? 'PATCH' : 'POST', body: JSON.stringify(parsed.data) }
			);
			toast.success(product ? 'Produkt gespeichert' : `„${saved.name}“ angelegt`);
			open = false;
			onsaved(saved);
		} catch (err) {
			errors = apiFieldErrors(err);
			if (!Object.keys(errors).length) toast.error(errorText(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{product ? 'Produkt bearbeiten' : 'Lebensmittel anlegen'}</Dialog.Title>
			<Dialog.Description>
				{#if !product && preset.suggested}
					Vorschlag aus Open Food Facts – bitte prüfen und bei Bedarf anpassen.
				{:else if !product && preset.barcode}
					Diesen Strichcode kennen wir noch nicht. Lege das Produkt einmal an, danach reicht
					Scannen.
				{:else}
					Ein Produkt mit seinem Strichcode; Menge und Mindesthaltbarkeit kommen beim Einlagern
					dazu.
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<form id="product-form" class="grid gap-4" onsubmit={save}>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Name" id="product-name" required error={errors.name}>
					<Input
						id="product-name"
						bind:value={name}
						maxlength={150}
						placeholder="z. B. Spaghetti"
						autocomplete="off"
					/>
				</FormField>
				<FormField label="Marke" id="product-brand" error={errors.brand}>
					<Input id="product-brand" bind:value={brand} maxlength={150} autocomplete="off" />
				</FormField>
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField
					label="Strichcode"
					id="product-barcode"
					hint="EAN auf der Packung – scannen oder abtippen"
					error={errors.barcode}
				>
					<Input
						id="product-barcode"
						bind:value={barcode}
						inputmode="numeric"
						maxlength={20}
						autocomplete="off"
						class="font-mono"
						data-scan-field
					/>
				</FormField>
				<FormField label="Lagerort" id="product-location" error={errors.locationId}>
					<SelectField
						id="product-location"
						label="Lagerort"
						options={locationOptions(locations)}
						emptyLabel="Ohne Lagerort"
						bind:value={locationId}
					/>
				</FormField>
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField
					label="Gezählt in"
					id="product-unit"
					hint="Leer = Stück, sonst z. B. Packung, Dose, Glas"
					error={errors.unit}
				>
					<Input
						id="product-unit"
						bind:value={unit}
						maxlength={MAX_UNIT}
						placeholder="Stück"
						autocomplete="off"
					/>
				</FormField>
				<FormField
					label="Füllmenge"
					id="product-size"
					hint="Laut Packung, z. B. 500 g"
					error={errors.packageSize}
				>
					<Input id="product-size" bind:value={packageSize} maxlength={150} autocomplete="off" />
				</FormField>
			</div>
			<FormField label="Notizen" id="product-notes" error={errors.notes}>
				<Textarea id="product-notes" bind:value={notes} rows={2} />
			</FormField>
		</form>
		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button type="submit" form="product-form" disabled={busy}>
				{busy ? BUSY_SAVE : product ? 'Speichern' : 'Anlegen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
