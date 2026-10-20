<script lang="ts">
	import ImageOff from '@lucide/svelte/icons/image-off';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { Article } from '../schemas';
	import { formatPriceRange } from './helpers';

	let { article, onselect }: { article: Article; onselect: (article: Article) => void } = $props();

	const sizes = $derived(
		article.hasSizes
			? article.variants
					.filter((v) => !v.archived)
					.map((v) => v.label)
					.join(', ')
			: ''
	);
</script>

<Card.Root class="flex h-full flex-col gap-0 overflow-hidden py-0">
	<button
		type="button"
		class="block aspect-[4/3] w-full overflow-hidden bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
		aria-label={`${article.title} ansehen`}
		onclick={() => onselect(article)}
	>
		{#if article.cover}
			<img
				src={article.cover.thumbUrl}
				alt=""
				loading="lazy"
				class="size-full object-cover transition-transform duration-200 hover:scale-[1.02]"
			/>
		{:else}
			<span class="flex size-full items-center justify-center text-muted-foreground">
				<ImageOff class="size-8" aria-hidden="true" />
			</span>
		{/if}
	</button>
	<div class="flex flex-1 flex-col gap-2 p-4">
		<h3 class="leading-snug font-semibold">{article.title}</h3>
		{#if article.description}
			<p class="line-clamp-2 text-sm text-muted-foreground">{article.description}</p>
		{/if}
		{#if sizes}
			<p class="truncate text-xs text-muted-foreground" title={sizes}>Größen: {sizes}</p>
		{/if}
		<div class="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2">
			<span class="font-semibold tabular-nums">
				{formatPriceRange(article.priceMinCents, article.priceMaxCents)}
			</span>
			<Button size="sm" onclick={() => onselect(article)}>Auswählen</Button>
		</div>
	</div>
</Card.Root>
