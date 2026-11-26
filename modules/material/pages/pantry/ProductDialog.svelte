<script lang="ts" module>
	export interface ProductPreset {
		barcode?: string;
		name?: string;
		brand?: string;
		packageSize?: string;
		/** Vorschlag stammt aus Open Food Facts */
		suggested?: boolean;
		/** Open Food Facts hat ein Produktbild */
		hasImage?: boolean;
	}
</script>

<script lang="ts">
	import ImageDown from '@lucide/svelte/icons/image-down';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	// Lebensmittel-Produkt anlegen oder bearbeiten; nach einem Scan mit Strichcode und Vorschlag aus
	// Open Food Facts vorbelegt. Nach dem Anlegen folgt ein Schritt „Bilder“ (eigene Fotos, Bild aus Open Food Facts).
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { apiFetch } from '$lib/sdk/client';
	import {
		type FoodProduct,
		type ImageRef,
		type Location,
		MAX_UNIT,
		productInput,
		productUpdateInput
	} from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import { locationOptions } from '../inventory/options';
	import ImageManager from '../shared/ImageManager.svelte';

	let {
		open = $bindable(false),
		product = null,
		preset = {},
		locations,
		continueLabel = 'Fertig',
		onsaved
	}: {
		open?: boolean;
		/** `null` = neu anlegen */
		product?: FoodProduct | null;
		preset?: ProductPreset;
		locations: Location[];
		/** Knopf im Bilder-Schritt nach dem Anlegen (z. B. „Weiter zum Einlagern“) */
		continueLabel?: string;
		/** Beim Bearbeiten nach dem Speichern bzw. bei Bildänderungen; beim Anlegen einmal, wenn der Dialog schließt */
		onsaved: (product: FoodProduct) => void;
	} = $props();

	let step = $state<'form' | 'images'>('form');
	let created = $state<FoodProduct | null>(null);
	let images = $state<ImageRef[]>([]);
	let name = $state('');
	let brand = $state('');
	let barcode = $state('');
	let unit = $state('');
	let packageSize = $state('');
	let locationId = $state<string | null>(null);
	let notes = $state('');
	let takeOffImage = $state(true);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);
	let offBusy = $state(false);

	/** Angelegtes Produkt, das beim Schließen noch gemeldet werden muss */
	let pending: FoodProduct | null = null;

	$effect(() => {
		if (!open) {
			untrack(() => {
				if (pending) {
					const p = pending;
					pending = null;
					onsaved(p);
				}
			});
			return;
		}
		untrack(() => {
			step = 'form';
			created = null;
			pending = null;
			errors = {};
			name = product?.name ?? preset.name ?? '';
			brand = product?.brand ?? preset.brand ?? '';
			barcode = product?.barcode ?? preset.barcode ?? '';
			unit = product?.unit ?? '';
			packageSize = product?.packageSize ?? preset.packageSize ?? '';
			locationId = product?.locationId ?? null;
			notes = product?.notes ?? '';
			images = product?.images ?? [];
			takeOffImage = true;
		});
	});

	/** Gespeichertes Produkt, dessen Bilder gerade bearbeitet werden */
	const current = $derived(created ?? product);
	const canLoadOff = $derived(!!current?.barcode && !images.some((i) => i.source === 'off'));

	function setImages(next: ImageRef[]) {
		images = next;
		if (created) {
			created = { ...created, images: next };
			pending = created;
		} else if (product) {
			onsaved({ ...product, images: next });
		}
	}

	async function loadOffImage(quiet = false): Promise<void> {
		if (!current) return;
		offBusy = true;
		try {
			const img = await apiFetch<ImageRef>(`${API}/pantry/products/${current.id}/images/off`, {
				method: 'POST'
			});
			setImages([...images, img]);
			if (!quiet) toast.success('Bild aus Open Food Facts übernommen');
		} catch (err) {
			toast.error(errorText(err, 'Das Bild aus Open Food Facts konnte nicht geladen werden'));
		} finally {
			offBusy = false;
		}
	}

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
			if (product) {
				toast.success('Produkt gespeichert');
				open = false;
				onsaved(saved);
				return;
			}
			toast.success(`„${saved.name}“ angelegt`);
			created = saved;
			pending = saved;
			images = saved.images;
			step = 'images';
			if (offOffered && takeOffImage && saved.barcode) await loadOffImage(true);
		} catch (err) {
			errors = apiFieldErrors(err);
			if (!Object.keys(errors).length) toast.error(errorText(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	/** Checkbox nur, wenn der Vorschlag ein Bild hat und der Strichcode noch der gescannte ist */
	const offOffered = $derived(
		!product && !!preset.hasImage && !!preset.barcode && barcode.trim() === preset.barcode
	);
</script>

{#snippet offButton()}
	{#if canLoadOff}
		<div class="flex flex-wrap items-center gap-2">
			<Button variant="outline" size="sm" disabled={offBusy} onclick={() => loadOffImage()}>
				{#if offBusy}
					<LoaderCircle class="animate-spin" />
				{:else}
					<ImageDown />
				{/if}
				Bild aus Open Food Facts laden
			</Button>
			<span class="text-xs text-muted-foreground">
				Wird hier gespeichert; dafür geht nur der Strichcode an Open Food Facts.
			</span>
		</div>
	{/if}
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		{#if step === 'images' && created}
			<Dialog.Header>
				<Dialog.Title>„{created.name}“ angelegt</Dialog.Title>
				<Dialog.Description>
					Füge ein Foto der Packung hinzu, damit man das Lebensmittel im Vorrat schnell erkennt.
				</Dialog.Description>
			</Dialog.Header>
			{#if offBusy && !images.length}
				<p class="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
					<LoaderCircle class="size-4 animate-spin" aria-hidden="true" /> Lade Bild aus Open Food
					Facts …
				</p>
			{/if}
			<ImageManager
				owner="products"
				id={created.id}
				{images}
				onchange={setImages}
				extra={offButton}
			/>
			<Dialog.Footer>
				<Button onclick={() => (open = false)}>{continueLabel}</Button>
			</Dialog.Footer>
		{:else}
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
				{#if offOffered}
					<div class="flex items-start gap-2">
						<Checkbox id="product-off-image" bind:checked={takeOffImage} />
						<div class="grid gap-0.5">
							<Label for="product-off-image">Produktbild von Open Food Facts übernehmen</Label>
							<span class="text-xs text-muted-foreground">
								Das Bild wird hier gespeichert (Lizenz CC BY-SA). Eigene Fotos kannst du im nächsten
								Schritt hinzufügen.
							</span>
						</div>
					</div>
				{/if}
			</form>
			{#if product}
				<section class="grid gap-2" aria-labelledby="product-images-heading">
					<h3 id="product-images-heading" class="text-sm font-medium">Bilder</h3>
					<ImageManager
						owner="products"
						id={product.id}
						{images}
						onchange={setImages}
						extra={offButton}
					/>
				</section>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" form="product-form" disabled={busy}>
					{busy ? BUSY_SAVE : product ? 'Speichern' : 'Anlegen'}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
