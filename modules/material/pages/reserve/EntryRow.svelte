<script lang="ts">
	// Zeile im Reservieren-Katalog auf dem Handy: Bild, Name, „frei N von M“ und direkt −/+ für den
	// Warenkorb (Typ = beliebige Artikel, Artikel, Zelt). Antippen öffnet die Details (konkrete Artikel wählen).
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import type { CatalogEntry } from '../../schemas';
	import CategoryGlyph from '../shared/CategoryGlyph.svelte';

	let {
		entry,
		inCart = 0,
		quickQty = 0,
		canReserve,
		onselect,
		onchange
	}: {
		entry: CatalogEntry;
		/** Gesamtanzahl im Warenkorb (Typ + gezielt gewählte Artikel) */
		inCart?: number;
		/** Anzahl der direkt über −/+ gesteuerten Zeile (Typ, Artikel oder Zelt) */
		quickQty?: number;
		canReserve: boolean;
		onselect: (entry: CatalogEntry) => void;
		/** −1 / +1 auf die direkt gesteuerte Zeile */
		onchange: (entry: CatalogEntry, delta: 1 | -1) => void;
	} = $props();

	const left = $derived(entry.free - inCart);
	const picked = $derived(inCart - quickQty);
	const kindLabel = $derived(
		entry.kind === 'tent'
			? 'Zelt'
			: entry.kind === 'type'
				? `${entry.items.length} Artikel${entry.sets.length ? ` · ${entry.sets.length} ${entry.sets.length === 1 ? 'Set' : 'Sets'}` : ''}`
				: (entry.locationName ?? entry.category?.name ?? '')
	);
</script>

<div class="flex items-center gap-3 border-b px-3 py-2 last:border-b-0">
	<button
		type="button"
		class="flex min-w-0 flex-1 items-center gap-3 text-left"
		aria-label={`${entry.name} ansehen`}
		onclick={() => onselect(entry)}
	>
		{#if entry.thumbUrl}
			<img
				src={entry.thumbUrl}
				alt=""
				loading="lazy"
				class="size-12 shrink-0 rounded-lg object-cover"
			/>
		{:else}
			<CategoryGlyph category={entry.category} size="lg" />
		{/if}
		<span class="flex min-w-0 flex-1 flex-col">
			<span class="truncate font-semibold">{entry.name}</span>
			<span class="truncate text-xs text-muted-foreground">{kindLabel}</span>
			<span class="text-sm tabular-nums">
				{#if entry.free <= 0}
					<span class="font-medium text-warning">Nicht frei</span>
				{:else}
					frei <span class="font-semibold">{Math.max(0, left)}</span>
					<span class="text-muted-foreground"
						>von {entry.total}{entry.unit ? ` ${entry.unit}` : ''}</span
					>
				{/if}
				{#if picked > 0}
					<span class="text-link"> · {picked} gezielt gewählt</span>
				{/if}
			</span>
		</span>
	</button>
	{#if canReserve}
		<div class="flex shrink-0 items-center gap-1">
			{#if quickQty > 0}
				<button
					type="button"
					class="flex size-10 items-center justify-center rounded-full border bg-background active:bg-muted"
					aria-label={`${entry.name}: eins weniger`}
					onclick={() => onchange(entry, -1)}
				>
					<Minus class="size-4" />
				</button>
				<span class="w-6 text-center font-semibold tabular-nums" aria-live="polite">
					{quickQty}
				</span>
			{/if}
			<button
				type="button"
				class={[
					'flex size-10 items-center justify-center rounded-full disabled:opacity-40',
					quickQty > 0
						? 'border bg-background active:bg-muted'
						: 'bg-primary text-primary-foreground active:opacity-80'
				]}
				aria-label={`${entry.name}: eins mehr in den Warenkorb`}
				disabled={left <= 0}
				onclick={() => onchange(entry, 1)}
			>
				<Plus class="size-4" />
			</button>
		</div>
	{/if}
</div>
