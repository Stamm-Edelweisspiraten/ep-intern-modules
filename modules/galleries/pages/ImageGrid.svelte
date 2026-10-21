<script lang="ts">
	import StarIcon from '@lucide/svelte/icons/star';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { imageUrl, type GalleryImage } from '../schemas';

	let {
		galleryId,
		images,
		coverImageId,
		selectable,
		selected = $bindable<string[]>([]),
		onopen
	}: {
		galleryId: string;
		images: GalleryImage[];
		coverImageId: string | null;
		selectable: boolean;
		selected?: string[];
		onopen: (index: number) => void;
	} = $props();

	const selectedSet = $derived(new Set(selected));

	function toggle(id: string) {
		selected = selectedSet.has(id) ? selected.filter((s) => s !== id) : [...selected, id];
	}

	function activate(index: number) {
		const img = images[index];
		if (!img) return;
		if (selectable) toggle(img.id);
		else onopen(index);
	}

	function label(img: GalleryImage, index: number): string {
		const base = img.description ?? `Bild ${index + 1}`;
		const parts = [base];
		if (img.id === coverImageId) parts.push('Titelbild');
		return parts.join(', ');
	}
</script>

{#if images.length > 0}
	<ul
		class="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
		aria-label="Bilder"
	>
		{#each images as img, i (img.id)}
			{@const isSelected = selectedSet.has(img.id)}
			{@const isCover = img.id === coverImageId}
			<li class="relative">
				<button
					type="button"
					aria-pressed={selectable ? isSelected : undefined}
					aria-label={selectable ? `${label(img, i)} auswählen` : `${label(img, i)} öffnen`}
					title={img.description ?? undefined}
					class={[
						'group bg-muted relative block aspect-square w-full cursor-pointer overflow-hidden rounded-md outline-none',
						'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-3 focus-visible:ring-offset-2',
						isSelected ? 'ring-primary ring-offset-background ring-3 ring-offset-2' : ''
					]}
					onclick={() => activate(i)}
				>
					<img
						src={imageUrl(galleryId, img.id, 'thumb')}
						loading="lazy"
						decoding="async"
						alt={img.description ?? 'Bild'}
						width={img.width}
						height={img.height}
						class={[
							'size-full object-cover transition-transform duration-200',
							selectable ? '' : 'group-hover:scale-[1.03]',
							isSelected ? 'opacity-80' : ''
						]}
						draggable="false"
					/>

					{#if isCover}
						<span
							class="bg-background/90 text-foreground absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium shadow-sm"
						>
							<StarIcon class="size-3 fill-warning text-warning" aria-hidden="true" />
							Titelbild
						</span>
					{/if}
				</button>

				{#if selectable}
					<!-- Nur Anzeige: Klicks gehen durch auf die Kachel -->
					<span
						class="bg-background/90 pointer-events-none absolute top-1.5 left-1.5 flex size-7 items-center justify-center rounded-md shadow-sm"
						aria-hidden="true"
					>
						<Checkbox checked={isSelected} tabindex={-1} class="pointer-events-none" />
					</span>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
