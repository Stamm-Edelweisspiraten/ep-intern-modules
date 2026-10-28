<script lang="ts">
	// Kachel im Reservieren-Katalog (wie `orders/ArticleCard`): Bild, Name, Kategorie, „frei N von M“.
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { CatalogEntry } from '../../schemas';
	import CategoryGlyph from '../shared/CategoryGlyph.svelte';

	let {
		entry,
		inCart = 0,
		onselect
	}: {
		entry: CatalogEntry;
		/** Anzahl dieses Eintrags (Typ + seine Artikel bzw. Artikel) im Warenkorb */
		inCart?: number;
		onselect: (entry: CatalogEntry) => void;
	} = $props();

	const none = $derived(entry.free <= 0);
	const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
	const subtitle = $derived(
		entry.kind === 'tent'
			? `Zelt · ${count(entry.parts.length, 'Teil', 'Teile')}`
			: [
					entry.category?.name ?? 'Ohne Kategorie',
					entry.kind === 'type' ? count(entry.items.length, 'Artikel', 'Artikel') : '',
					entry.kind === 'type' && entry.sets.length ? count(entry.sets.length, 'Set', 'Sets') : ''
				]
					.filter(Boolean)
					.join(' · ')
	);
</script>

<Card.Root class="flex h-full flex-col gap-0 overflow-hidden py-0">
	<button
		type="button"
		class="relative block aspect-[4/3] w-full overflow-hidden bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
		aria-label={`${entry.name} ansehen`}
		onclick={() => onselect(entry)}
	>
		{#if entry.thumbUrl}
			<img
				src={entry.thumbUrl}
				alt=""
				loading="lazy"
				class="size-full object-cover transition-transform duration-200 hover:scale-[1.02]"
			/>
		{:else}
			<span class="flex size-full items-center justify-center">
				<CategoryGlyph category={entry.category} size="lg" />
			</span>
		{/if}
		{#if inCart}
			<Badge class="absolute top-2 right-2 tabular-nums">{inCart} im Warenkorb</Badge>
		{/if}
	</button>
	<div class="flex flex-1 flex-col gap-1.5 p-4">
		<h3 class="leading-snug font-semibold">{entry.name}</h3>
		<p class="truncate text-xs text-muted-foreground">
			{subtitle}
		</p>
		<div class="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2">
			<span class={['text-sm tabular-nums', none ? 'text-muted-foreground' : 'font-medium']}>
				{#if none}
					<span class="font-medium text-warning">Nicht frei</span> · {entry.total} gesamt
				{:else}
					frei <span class="font-semibold">{entry.free}</span> von {entry.total}
				{/if}
			</span>
			<Button size="sm" variant={none ? 'outline' : 'default'} onclick={() => onselect(entry)}>
				Auswählen
			</Button>
		</div>
	</div>
</Card.Root>
