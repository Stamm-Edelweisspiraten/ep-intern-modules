<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { MoneyInput, NumberStepper } from '$lib/components/layout';
	import { priceRange } from '../stock';
	import { MAX_LABEL, MAX_PRICE_CENTS, MAX_URL, MAX_VARIANTS } from '../schemas';
	import { SIZE_PRESETS, formatPriceRange, newVariantRow, type VariantRow } from './helpers';

	/**
	 * Größen & Preise eines Artikels. Ohne Größen gibt es genau eine Zeile (Preis + Mindestbestand).
	 * Fehler kommen als `{ 'variants.0.label': 'Meldung' }`.
	 */
	let {
		hasSizes = $bindable(false),
		rows = $bindable([]),
		errors = {},
		disabled = false
	}: {
		hasSizes?: boolean;
		rows?: VariantRow[];
		errors?: Record<string, string>;
		disabled?: boolean;
	} = $props();

	const range = $derived(priceRange(rows.map((r) => r.priceCents)));
	const listError = $derived(errors['variants'] ?? '');
	const err = (i: number, field: string) => errors[`variants.${i}.${field}`] ?? '';

	function toggleSizes(on: boolean) {
		hasSizes = on;
		if (!rows.length) rows = [newVariantRow()];
		if (!on) {
			// Nur die erste Zeile bleibt als Einzelpreis; die übrigen werden beim Speichern archiviert
			const first = rows[0]!;
			rows = [{ ...first, label: '' }];
		}
	}

	function addRow() {
		if (rows.length >= MAX_VARIANTS) return;
		const last = rows[rows.length - 1];
		rows = [...rows, newVariantRow({ priceCents: last?.priceCents ?? 0 })];
		queueMicrotask(() => {
			const el = document.getElementById(`variant-label-${rows.length - 1}`);
			el?.focus();
		});
	}

	function removeRow(i: number) {
		rows = rows.filter((_, j) => j !== i);
		if (!rows.length) rows = [newVariantRow()];
	}

	function applyPreset(sizes: string[]) {
		const price = rows[0]?.priceCents ?? 0;
		let next = [...rows];
		// Einzelne leere Zeile übernimmt die erste Größe
		if (next.length === 1 && !next[0]!.label.trim()) {
			next = [{ ...next[0]!, label: sizes[0]! }];
		}
		const present = new Set(next.map((r) => r.label.trim().toLowerCase()));
		for (const s of sizes) {
			if (next.length >= MAX_VARIANTS) break;
			if (!present.has(s.toLowerCase())) {
				next.push(newVariantRow({ label: s, priceCents: price }));
				present.add(s.toLowerCase());
			}
		}
		rows = next;
	}
</script>

<div class="space-y-4">
	<div class="flex items-center gap-3">
		<Switch
			id="variant-sizes"
			checked={hasSizes}
			onCheckedChange={(v) => toggleSizes(v === true)}
			{disabled}
		/>
		<Label for="variant-sizes" class="font-normal">Verschiedene Größen</Label>
	</div>

	{#if !hasSizes}
		{@const row = rows[0]}
		{#if row}
			<div class="grid gap-4 sm:grid-cols-2">
				<div class="space-y-2">
					<Label for="variant-price-0">Preis *</Label>
					<MoneyInput
						id="variant-price-0"
						label="Preis"
						bind:cents={row.priceCents}
						max={MAX_PRICE_CENTS}
						invalid={!!err(0, 'priceCents')}
						{disabled}
					/>
					{#if err(0, 'priceCents')}
						<p class="text-xs text-destructive" role="alert">{err(0, 'priceCents')}</p>
					{/if}
				</div>
				<div class="space-y-2">
					<Label for="variant-min-0">Mindestbestand</Label>
					<NumberStepper
						id="variant-min-0"
						label="Mindestbestand"
						bind:value={row.minStock}
						min={0}
						max={100000}
						{disabled}
					/>
					<p class="text-xs text-muted-foreground">
						Fällt der Bestand darunter, schlägt das Lager eine Nachbestellung vor.
					</p>
				</div>
			</div>
		{/if}
	{:else}
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-xs text-muted-foreground">Vorlagen:</span>
			{#each SIZE_PRESETS as p (p.id)}
				<Button
					variant="outline"
					size="sm"
					disabled={disabled || rows.length >= MAX_VARIANTS}
					onclick={() => applyPreset(p.sizes)}
				>
					<Plus />
					{p.label}
				</Button>
			{/each}
		</div>

		<fieldset class="space-y-3">
			<legend class="sr-only">Größen</legend>
			<div
				class="hidden gap-2 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[6rem_7rem_minmax(0,1fr)_8.5rem_2.25rem]"
				aria-hidden="true"
			>
				<span>Größe *</span>
				<span>Preis *</span>
				<span>Nachbestelllink</span>
				<span>Mindestbestand</span>
				<span></span>
			</div>
			{#each rows as row, i (row.key)}
				<div
					class="grid gap-2 rounded-md border p-3 sm:grid-cols-[6rem_7rem_minmax(0,1fr)_8.5rem_2.25rem] sm:items-start sm:border-0 sm:p-0"
				>
					<div class="space-y-1">
						<Label for={`variant-label-${i}`} class="text-xs sm:sr-only">Größe *</Label>
						<Input
							id={`variant-label-${i}`}
							bind:value={row.label}
							maxlength={MAX_LABEL}
							placeholder="z. B. M"
							aria-invalid={err(i, 'label') ? 'true' : undefined}
							{disabled}
						/>
						{#if err(i, 'label')}
							<p class="text-xs text-destructive" role="alert">{err(i, 'label')}</p>
						{/if}
					</div>
					<div class="space-y-1">
						<Label for={`variant-price-${i}`} class="text-xs sm:sr-only">Preis *</Label>
						<MoneyInput
							id={`variant-price-${i}`}
							label={`Preis Größe ${row.label || i + 1}`}
							bind:cents={row.priceCents}
							max={MAX_PRICE_CENTS}
							invalid={!!err(i, 'priceCents')}
							{disabled}
						/>
						{#if err(i, 'priceCents')}
							<p class="text-xs text-destructive" role="alert">{err(i, 'priceCents')}</p>
						{/if}
					</div>
					<div class="space-y-1">
						<Label for={`variant-url-${i}`} class="text-xs sm:sr-only">Nachbestelllink</Label>
						<Input
							id={`variant-url-${i}`}
							type="url"
							bind:value={row.reorderUrl}
							maxlength={MAX_URL}
							placeholder="https://…"
							aria-invalid={err(i, 'reorderUrl') ? 'true' : undefined}
							{disabled}
						/>
						{#if err(i, 'reorderUrl')}
							<p class="text-xs text-destructive" role="alert">{err(i, 'reorderUrl')}</p>
						{/if}
					</div>
					<div class="space-y-1">
						<Label for={`variant-min-${i}`} class="text-xs sm:sr-only">Mindestbestand</Label>
						<NumberStepper
							id={`variant-min-${i}`}
							label={`Mindestbestand Größe ${row.label || i + 1}`}
							bind:value={row.minStock}
							min={0}
							max={100000}
							{disabled}
						/>
					</div>
					<div class="flex justify-end">
						<Button
							variant="ghost"
							size="icon"
							aria-label={`Größe ${row.label || i + 1} entfernen`}
							disabled={disabled || rows.length <= 1}
							onclick={() => removeRow(i)}
						>
							<Trash2 />
						</Button>
					</div>
				</div>
			{/each}
		</fieldset>

		<Button
			variant="outline"
			size="sm"
			disabled={disabled || rows.length >= MAX_VARIANTS}
			onclick={addRow}
		>
			<Plus /> Größe hinzufügen
		</Button>
		<p class="text-xs text-muted-foreground">
			Ohne eigenen Nachbestelllink gilt der Link des Artikels. Entfernte Größen, die schon bestellt
			wurden, bleiben archiviert erhalten.
		</p>
	{/if}

	{#if listError}
		<p class="text-xs text-destructive" role="alert">{listError}</p>
	{/if}

	<p class="text-sm">
		Preis im Katalog:
		<span class="font-semibold tabular-nums">{formatPriceRange(range.min, range.max)}</span>
	</p>
</div>
