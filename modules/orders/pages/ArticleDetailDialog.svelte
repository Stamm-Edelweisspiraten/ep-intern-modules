<script lang="ts">
	import { untrack } from 'svelte';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ImageOff from '@lucide/svelte/icons/image-off';
	import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { NumberStepper } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { cn } from '$lib/utils';
	import { MAX_QUANTITY, type Article } from '../schemas';
	import { formatPriceRange, type CartItem } from './helpers';

	/**
	 * Artikel ansehen und in den Warenkorb legen. Der Aufrufer rendert den Dialog per `{#key}` neu,
	 * damit Auswahl und Menge bei jedem Öffnen frisch beginnen.
	 */
	let {
		open = $bindable(false),
		article,
		canOrder,
		onadd
	}: {
		open?: boolean;
		article: Article;
		/** Darf bestellen (sonst nur ansehen) */
		canOrder: boolean;
		onadd: (item: CartItem) => void;
	} = $props();

	const variants = $derived(article.variants.filter((v) => !v.archived));
	const samePrice = $derived(article.priceMinCents === article.priceMaxCents);

	let imageIndex = $state(0);
	let variantId = $state<string | null>(
		untrack(() => {
			const list = article.variants.filter((v) => !v.archived);
			return list.length === 1 ? list[0]!.id : null;
		})
	);
	let quantity = $state(1);
	let sizeError = $state('');

	const image = $derived(article.images[imageIndex] ?? article.images[0] ?? null);
	const variant = $derived(variants.find((v) => v.id === variantId) ?? null);

	function step(dir: 1 | -1) {
		const n = article.images.length;
		if (n > 1) imageIndex = (imageIndex + dir + n) % n;
	}

	function pick(id: string) {
		variantId = id;
		sizeError = '';
	}

	function add() {
		if (!variant) {
			sizeError = 'Bitte wähle eine Größe.';
			return;
		}
		onadd({
			variantId: variant.id,
			articleId: article.id,
			articleTitle: article.title,
			variantLabel: variant.label,
			unitPriceCents: variant.priceCents,
			quantity,
			thumbUrl: article.cover?.thumbUrl ?? null
		});
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>{article.title}</Dialog.Title>
			<Dialog.Description class="tabular-nums">
				{formatPriceRange(article.priceMinCents, article.priceMaxCents)}
			</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-6 md:grid-cols-2">
			<div class="space-y-2">
				<div class="relative aspect-[4/3] overflow-hidden rounded-lg bg-muted">
					{#if image}
						<img
							src={image.webUrl}
							alt={`${article.title}, Bild ${imageIndex + 1} von ${article.images.length}`}
							class="size-full object-contain"
						/>
						{#if article.images.length > 1}
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
						<span class="flex size-full items-center justify-center text-muted-foreground">
							<ImageOff class="size-10" aria-hidden="true" />
							<span class="sr-only">Kein Bild vorhanden</span>
						</span>
					{/if}
				</div>
				{#if article.images.length > 1}
					<div class="flex flex-wrap gap-2" role="group" aria-label="Bilder">
						{#each article.images as img, i (img.id)}
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
			</div>

			<div class="space-y-5">
				{#if article.description}
					<p class="text-sm whitespace-pre-line">{article.description}</p>
				{:else}
					<p class="text-sm text-muted-foreground">Keine Beschreibung.</p>
				{/if}

				{#if article.hasSizes}
					<fieldset class="space-y-2">
						<legend class="mb-2 text-sm font-medium">Größe *</legend>
						<div
							class="flex flex-wrap gap-2"
							role="radiogroup"
							aria-label="Größe"
							aria-invalid={sizeError ? 'true' : undefined}
							aria-describedby={sizeError ? 'article-size-error' : undefined}
						>
							{#each variants as v (v.id)}
								<button
									type="button"
									role="radio"
									aria-checked={v.id === variantId}
									class={cn(
										'flex min-h-11 min-w-14 flex-col items-center justify-center rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring sm:min-h-9',
										v.id === variantId
											? 'border-primary bg-primary text-primary-foreground'
											: 'bg-background hover:bg-muted'
									)}
									onclick={() => pick(v.id)}
								>
									<span class="font-medium">{v.label}</span>
									{#if !samePrice}
										<span class="text-xs tabular-nums opacity-80">{formatEuro(v.priceCents)}</span>
									{/if}
								</button>
							{/each}
						</div>
						{#if sizeError}
							<p id="article-size-error" class="text-xs text-destructive" role="alert">
								{sizeError}
							</p>
						{/if}
					</fieldset>
				{/if}

				{#if canOrder}
					<div class="space-y-2">
						<span class="text-sm font-medium">Menge</span>
						<NumberStepper label="Menge" bind:value={quantity} min={1} max={MAX_QUANTITY} />
					</div>
					<div class="flex items-center justify-between gap-3 border-t pt-4">
						<span class="text-sm text-muted-foreground">
							{#if variant}
								Zusammen
								<span class="font-semibold text-foreground tabular-nums">
									{formatEuro(variant.priceCents * quantity)}
								</span>
							{:else}
								Größe wählen
							{/if}
						</span>
						<Button onclick={add}><ShoppingCart /> In den Warenkorb</Button>
					</div>
				{:else}
					<p class="text-xs text-muted-foreground">
						Du darfst nur ansehen, nicht bestellen. Wende dich bei Fragen an die*den Kämmerer*in.
					</p>
				{/if}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
