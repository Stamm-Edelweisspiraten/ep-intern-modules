<script lang="ts">
	// Dashboard-Kachel „Neue Galerien“: die zuletzt geänderten Galerien mit Titelbild.
	import { onMount } from 'svelte';
	import Images from '@lucide/svelte/icons/images';
	import ImageIcon from '@lucide/svelte/icons/image';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import { imageUrl, type GalleryItem, type GalleryList } from '../../schemas';

	let { onstatus }: DashboardWidgetProps = $props();

	const LIMIT = 4;

	let items = $state<GalleryItem[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			const r = await apiFetch<GalleryList>(`/modules/galleries/galleries?limit=${LIMIT}`);
			items = r.items.slice(0, LIMIT);
			onstatus?.(items.length ? 'ready' : 'empty');
		} catch (e) {
			error =
				e instanceof ApiClientError && e.message
					? e.message
					: 'Galerien konnten nicht geladen werden.';
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	function countLabel(n: number): string {
		return n === 1 ? '1 Bild' : `${n.toLocaleString('de-DE')} Bilder`;
	}
</script>

<DashboardCard
	title="Neue Galerien"
	icon={Images}
	href="/modules/galleries"
	{loading}
	{error}
	onretry={load}
	empty={!items.length}
	emptyText="Noch keine Galerien."
	skeletonRows={2}
>
	<ul class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		{#each items as g (g.id)}
			<li class="min-w-0">
				<a
					href="/modules/galleries/{encodeURIComponent(g.id)}"
					class="group block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				>
					<div class="aspect-[4/3] overflow-hidden rounded-md bg-muted">
						{#if g.cover}
							<img
								src={imageUrl(g.id, g.cover.imageId, 'thumb')}
								alt=""
								loading="lazy"
								decoding="async"
								width={g.cover.width}
								height={g.cover.height}
								class="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
							/>
						{:else}
							<div class="flex size-full items-center justify-center text-muted-foreground">
								<ImageIcon class="size-6" aria-hidden="true" />
							</div>
						{/if}
					</div>
					<p class="mt-1.5 truncate font-medium group-hover:underline" title={g.title}>
						{g.title}
					</p>
					<p class="text-xs text-muted-foreground tabular-nums">{countLabel(g.imageCount)}</p>
				</a>
			</li>
		{/each}
	</ul>
</DashboardCard>
