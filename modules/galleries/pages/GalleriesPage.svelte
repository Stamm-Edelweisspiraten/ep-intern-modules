<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Globe from '@lucide/svelte/icons/globe';
	import ImageIcon from '@lucide/svelte/icons/image';
	import Lock from '@lucide/svelte/icons/lock';
	import Plus from '@lucide/svelte/icons/plus';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		EmptyState,
		PageHeader,
		Pagination,
		SearchInput,
		PageTitle
	} from '$lib/components/layout';
	import {
		VISIBILITIES,
		VISIBILITY_LABELS,
		imageUrl,
		type GalleryDetail,
		type GalleryItem,
		type GalleryList,
		type Visibility
	} from '../schemas';
	import EventBadges from './EventBadges.svelte';
	import GalleryDialog from './GalleryDialog.svelte';

	/** Teilbar durch 1–4 Spalten, damit die letzte Reihe voll ist */
	const PAGE_SIZE = 48;
	const SKELETONS = Array.from({ length: 8 }, (_, i) => i);

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canCreate = $derived(can(permissions, 'galleries.gallery.create'));

	// --- Zustand aus der URL ---------------------------------------------------------------
	const urlParams = $derived(page.url.searchParams);
	const search = $derived(urlParams.get('search') ?? '');
	const visibility = $derived.by<Visibility | null>(() => {
		const v = urlParams.get('visibility');
		return (VISIBILITIES as readonly string[]).includes(v ?? '') ? (v as Visibility) : null;
	});
	const offset = $derived(Math.max(0, Number(urlParams.get('offset')) || 0));
	const filtered = $derived(!!(search || visibility));

	const visibilityOptions = VISIBILITIES.map((v) => ({ value: v, label: VISIBILITY_LABELS[v] }));

	function setVisibility(v: string | null) {
		const url = new URL(page.url);
		if (v) url.searchParams.set('visibility', v);
		else url.searchParams.delete('visibility');
		url.searchParams.delete('offset');
		void goto(url, { keepFocus: true, noScroll: true, replaceState: true });
	}

	// --- Galerien laden --------------------------------------------------------------------
	let items = $state<GalleryItem[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let loadError = $state('');
	/** Wird zum Neuladen erhöht */
	let reloadKey = $state(0);

	const query = $derived.by(() => {
		const q = new URLSearchParams();
		if (search) q.set('search', search);
		if (visibility) q.set('visibility', visibility);
		q.set('limit', String(PAGE_SIZE));
		q.set('offset', String(offset));
		return q.toString();
	});

	$effect(() => {
		const q = query;
		void reloadKey;
		let stale = false;
		loading = true;
		apiFetch<GalleryList>(`/modules/galleries/galleries?${q}`)
			.then((r) => {
				if (stale) return;
				items = r.items;
				total = r.total;
				loadError = '';
			})
			.catch((e) => {
				if (!stale) {
					loadError =
						e instanceof ApiClientError ? e.message : 'Galerien konnten nicht geladen werden.';
				}
			})
			.finally(() => {
				if (!stale) loading = false;
			});
		return () => {
			stale = true;
		};
	});

	function reload() {
		reloadKey++;
	}

	function imageCountLabel(n: number): string {
		return n === 1 ? '1 Bild' : `${n.toLocaleString('de-DE')} Bilder`;
	}

	// --- Anlegen ---------------------------------------------------------------------------
	let dialogOpen = $state(false);

	function onsaved(detail: GalleryDetail) {
		void goto(`/modules/galleries/${encodeURIComponent(detail.id)}`);
	}
</script>

<PageTitle title="Galerien" />

<PageHeader
	title="Galerien"
	description="Fotos sammeln und ausgewählte Galerien auf der Website zeigen"
>
	{#snippet actions()}
		{#if canCreate}
			<Button onclick={() => (dialogOpen = true)}><Plus /> Neue Galerie</Button>
		{/if}
	{/snippet}
</PageHeader>

<div class="space-y-4">
	<div class="flex flex-wrap items-center gap-2">
		<SearchInput placeholder="Galerie suchen …" label="Galerien suchen" />
		<SelectField
			label="Sichtbarkeit"
			size="sm"
			class="w-full sm:w-48"
			options={visibilityOptions}
			value={visibility}
			emptyLabel="Alle"
			onchange={setVisibility}
		/>
	</div>

	{#if loadError}
		<div
			class="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
			role="alert"
		>
			<span class="text-destructive">{loadError}</span>
			<Button size="sm" variant="outline" onclick={reload}>Erneut versuchen</Button>
		</div>
	{:else if loading && items.length === 0}
		<div
			class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4"
			aria-busy="true"
			aria-label="Galerien werden geladen"
		>
			{#each SKELETONS as i (i)}
				<div class="overflow-hidden rounded-lg border">
					<Skeleton class="aspect-[4/3] w-full rounded-none" />
					<div class="space-y-2 p-3">
						<Skeleton class="h-4 w-2/3" />
						<Skeleton class="h-3 w-1/3" />
					</div>
				</div>
			{/each}
		</div>
	{:else if items.length === 0}
		{#if filtered}
			<EmptyState
				title="Keine Galerien gefunden"
				description="Zu deiner Suche oder dem Filter passt keine Galerie."
			/>
		{:else}
			<EmptyState
				title="Noch keine Galerien"
				description={canCreate
					? 'Lege eine Galerie an und lade Fotos hoch. Öffentliche Galerien erscheinen auf der Stammeswebsite.'
					: 'Es wurden noch keine Galerien für dich freigegeben.'}
			>
				{#if canCreate}
					<Button onclick={() => (dialogOpen = true)}><Plus /> Neue Galerie</Button>
				{/if}
			</EmptyState>
		{/if}
	{:else}
		<ul
			class={[
				'grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4',
				loading && 'opacity-60 transition-opacity'
			]}
			aria-busy={loading}
		>
			{#each items as g (g.id)}
				<li>
					<a
						href="/modules/galleries/{encodeURIComponent(g.id)}"
						class="group block overflow-hidden rounded-lg border bg-card text-card-foreground transition-shadow outline-none hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					>
						<div class="relative aspect-[4/3] overflow-hidden bg-muted">
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
								<div
									class="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground"
								>
									<ImageIcon class="size-8" aria-hidden="true" />
									<span class="text-xs">Noch keine Bilder</span>
								</div>
							{/if}
						</div>
						<div class="space-y-1.5 p-3">
							<p class="truncate font-semibold" title={g.title}>{g.title}</p>
							<div class="flex flex-wrap items-center justify-between gap-2">
								<span class="text-xs text-muted-foreground tabular-nums">
									{imageCountLabel(g.imageCount)}
								</span>
								<Badge variant={g.visibility === 'public' ? 'secondary' : 'outline'}>
									{#if g.visibility === 'public'}
										<Globe aria-hidden="true" />
									{:else}
										<Lock aria-hidden="true" />
									{/if}
									{VISIBILITY_LABELS[g.visibility]}
								</Badge>
							</div>
							<EventBadges events={g.events} max={1} compact />
						</div>
					</a>
				</li>
			{/each}
		</ul>
		{#if total > PAGE_SIZE}
			<Pagination {total} limit={PAGE_SIZE} {offset} />
		{/if}
	{/if}
</div>

<GalleryDialog bind:open={dialogOpen} mode="create" {onsaved} />
