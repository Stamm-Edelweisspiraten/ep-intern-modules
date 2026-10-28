<script lang="ts">
	// Eintrag ansehen und in den Warenkorb legen (wie `orders/ArticleDetailDialog`). Typen: beliebige
	// Anzahl UND/ODER konkrete Artikel ankreuzen. Artikel ohne Typ: Anzahl. Der Aufrufer rendert den
	// Dialog per `{#key}` neu, damit die Auswahl bei jedem Öffnen frisch beginnt.
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { NumberStepper } from '$lib/components/layout';
	import { cn } from '$lib/utils';
	import { isUsableCondition, type CatalogEntry, type CatalogItem } from '../../schemas';
	import CategoryGlyph from '../shared/CategoryGlyph.svelte';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import { itemQuantityInCart, typeQuantityInCart, type CartLine } from './cart';

	let {
		open = $bindable(false),
		entry,
		lines,
		canReserve,
		period,
		onadd
	}: {
		open?: boolean;
		entry: CatalogEntry;
		/** Aktueller Warenkorb (für bereits gewählte Artikel) */
		lines: CartLine[];
		canReserve: boolean;
		/** Zeitraum als Text, z. B. „01.07.2026 – 10.07.2026“ */
		period: string;
		onadd: (lines: CartLine[]) => void;
	} = $props();

	let imageIndex = $state(0);
	const image = $derived(entry.images[imageIndex] ?? entry.images[0] ?? null);

	function step(dir: 1 | -1) {
		const n = entry.images.length;
		if (n > 1) imageIndex = (imageIndex + dir + n) % n;
	}

	// --- Typ ---------------------------------------------------------------------
	let anyQty = $state(0);
	let picked = $state<string[]>([]);

	const isType = $derived(entry.kind === 'type');
	const inCartType = $derived(isType ? typeQuantityInCart(lines, entry.id) : 0);
	const inCartItems = $derived(
		isType
			? entry.items.reduce((s, i) => s + Math.min(i.free, itemQuantityInCart(lines, i.id)), 0)
			: itemQuantityInCart(lines, entry.id)
	);
	const pickedQty = $derived(
		entry.items.filter((i) => picked.includes(i.id)).reduce((s, i) => s + i.free, 0)
	);
	const restFree = $derived(Math.max(0, entry.free - inCartType - inCartItems));
	const maxAny = $derived(Math.max(0, restFree - pickedQty));

	const selectable = (i: CatalogItem) =>
		i.free > 0 && isUsableCondition(i.condition) && itemQuantityInCart(lines, i.id) === 0;

	function itemState(i: CatalogItem): string {
		if (itemQuantityInCart(lines, i.id) > 0) return 'Im Warenkorb';
		if (!isUsableCondition(i.condition)) return 'Nicht nutzbar';
		if (i.free <= 0) return 'Belegt';
		if (i.quantity > 1) return `${i.free} von ${i.quantity} frei`;
		return 'Frei';
	}

	function toggle(id: string, on: boolean) {
		picked = on ? [...picked, id] : picked.filter((x) => x !== id);
		if (anyQty > maxAny) anyQty = maxAny;
	}

	// --- Artikel ohne Typ ----------------------------------------------------------
	let qty = $state(1);
	const maxItem = $derived(Math.max(0, entry.free - (isType ? 0 : inCartItems)));

	const canAdd = $derived(isType ? anyQty > 0 || picked.length > 0 : maxItem > 0 && qty >= 1);

	function add() {
		const out: CartLine[] = [];
		if (isType) {
			if (anyQty > 0) {
				out.push({
					kind: 'type',
					typeId: entry.id,
					name: entry.name,
					thumbUrl: entry.thumbUrl,
					quantity: anyQty
				});
			}
			for (const i of entry.items.filter((x) => picked.includes(x.id))) {
				out.push({
					kind: 'item',
					itemId: i.id,
					name: i.name,
					code: i.code,
					thumbUrl: i.thumbUrl ?? entry.thumbUrl,
					quantity: Math.max(1, i.free),
					max: i.quantity
				});
			}
		} else {
			out.push({
				kind: 'item',
				itemId: entry.id,
				name: entry.name,
				code: entry.code,
				thumbUrl: entry.thumbUrl,
				quantity: Math.min(qty, maxItem),
				max: Math.max(1, entry.total)
			});
		}
		if (!out.length) return;
		onadd(out);
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>{entry.name}</Dialog.Title>
			<Dialog.Description class="tabular-nums">
				{entry.category?.name ?? 'Ohne Kategorie'} · frei {entry.free} von {entry.total} · {period}
			</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-6 md:grid-cols-2">
			<div class="space-y-2">
				<div class="relative aspect-[4/3] overflow-hidden rounded-lg bg-muted">
					{#if image}
						<img
							src={image.webUrl}
							alt={`${entry.name}, Bild ${imageIndex + 1} von ${entry.images.length}`}
							class="size-full object-contain"
						/>
						{#if entry.images.length > 1}
							<Button
								variant="secondary"
								size="icon"
								class="absolute top-1/2 left-2 -translate-y-1/2 opacity-90"
								aria-label="Vorheriges Bild"
								onclick={() => step(-1)}
							>
								<ChevronLeft />
							</Button>
							<Button
								variant="secondary"
								size="icon"
								class="absolute top-1/2 right-2 -translate-y-1/2 opacity-90"
								aria-label="Nächstes Bild"
								onclick={() => step(1)}
							>
								<ChevronRight />
							</Button>
						{/if}
					{:else}
						<span class="flex size-full items-center justify-center">
							<CategoryGlyph category={entry.category} size="lg" />
							<span class="sr-only">Kein Bild vorhanden</span>
						</span>
					{/if}
				</div>
				{#if entry.images.length > 1}
					<div class="flex flex-wrap gap-2" role="group" aria-label="Bilder">
						{#each entry.images as img, i (img.id)}
							<button
								type="button"
								class={cn(
									'size-14 overflow-hidden rounded-md border-2 bg-muted focus-visible:outline-2 focus-visible:outline-ring',
									i === imageIndex ? 'border-primary' : 'border-transparent opacity-80'
								)}
								aria-label={`Bild ${i + 1} anzeigen`}
								aria-current={i === imageIndex ? 'true' : undefined}
								onclick={() => (imageIndex = i)}
							>
								<img src={img.thumbUrl} alt="" loading="lazy" class="size-full object-cover" />
							</button>
						{/each}
					</div>
				{/if}
				{#if entry.description}
					<p class="text-sm whitespace-pre-line">{entry.description}</p>
				{/if}
				{#if entry.kind === 'item' && (entry.code || entry.locationName)}
					<p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						{#if entry.locationName}
							<span class="inline-flex items-center gap-1">
								<MapPin class="size-3.5" aria-hidden="true" />
								{entry.locationName}
							</span>
						{/if}
						{#if entry.code}<span class="font-mono">{entry.code}</span>{/if}
					</p>
				{/if}
			</div>

			<div class="min-w-0 space-y-5">
				{#if !canReserve}
					<p class="text-xs text-muted-foreground">
						Du darfst das Material ansehen, aber nicht reservieren.
					</p>
				{:else if entry.kind === 'type'}
					<div class="space-y-2">
						<span class="text-sm font-medium">Beliebige {entry.name}</span>
						<p class="text-xs text-muted-foreground">
							Die Materialwart*in sucht passende Artikel aus.
							{#if inCartType}Schon im Warenkorb: {inCartType}.{/if}
						</p>
						<NumberStepper
							label={`Anzahl beliebige ${entry.name}`}
							bind:value={anyQty}
							min={0}
							max={maxAny}
							disabled={maxAny === 0 && anyQty === 0}
						/>
					</div>

					{#if entry.items.length}
						<fieldset class="space-y-2">
							<legend class="mb-1 text-sm font-medium">Oder bestimmte Artikel</legend>
							<ul class="max-h-72 divide-y overflow-y-auto rounded-md border">
								{#each entry.items as i (i.id)}
									{@const ok = selectable(i)}
									<li>
										<label
											class={cn(
												'flex items-start gap-3 px-3 py-2',
												ok ? 'cursor-pointer hover:bg-muted/50' : 'opacity-60'
											)}
										>
											<Checkbox
												class="mt-0.5"
												checked={picked.includes(i.id)}
												disabled={!ok}
												onCheckedChange={(v) => toggle(i.id, v === true)}
											/>
											<span class="min-w-0 flex-1">
												<span class="flex flex-wrap items-center gap-2">
													<span class="text-sm font-medium">{i.name}</span>
													<ConditionBadge condition={i.condition} hideOk />
												</span>
												<span class="block text-xs text-muted-foreground">
													<span class="font-mono">{i.code}</span>{#if i.locationName}
														· {i.locationName}{/if}
												</span>
											</span>
											<span
												class={cn(
													'shrink-0 text-xs tabular-nums',
													ok ? 'text-success' : 'text-muted-foreground'
												)}
											>
												{itemState(i)}
											</span>
										</label>
									</li>
								{/each}
							</ul>
						</fieldset>
					{/if}
				{:else}
					<div class="space-y-2">
						<span class="text-sm font-medium">Anzahl</span>
						{#if maxItem > 0}
							<NumberStepper label="Anzahl" bind:value={qty} min={1} max={maxItem} />
						{:else}
							<p class="text-sm text-muted-foreground">
								{inCartItems ? 'Alles Freie liegt schon im Warenkorb.' : 'Im Zeitraum nicht frei.'}
							</p>
						{/if}
					</div>
				{/if}

				{#if canReserve}
					<div class="flex items-center justify-between gap-3 border-t pt-4">
						<span class="text-sm text-muted-foreground tabular-nums">
							{#if entry.free <= 0}
								Im Zeitraum nicht frei
							{:else}
								frei {restFree} von {entry.total}
							{/if}
						</span>
						<Button disabled={!canAdd} onclick={add}><ShoppingCart /> In den Warenkorb</Button>
					</div>
				{/if}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
