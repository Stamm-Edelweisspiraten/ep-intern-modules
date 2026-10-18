<script lang="ts">
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Globe from '@lucide/svelte/icons/globe';
	import Lock from '@lucide/svelte/icons/lock';
	import Pencil from '@lucide/svelte/icons/pencil';
	import SquareCheck from '@lucide/svelte/icons/square-check';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import type { PrincipalInfo } from '$lib/sdk/types/sharing';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		ConfirmDialog,
		EmptyState,
		PageHeader,
		ShareMenu,
		type ShareCandidate,
		type ShareEntry,
		type ShareOwner
	} from '$lib/components/layout';
	import { shareKey } from '$lib/components/layout/share-types';
	import {
		SHARE_LEVELS,
		SHARE_LEVEL_LABELS,
		VISIBILITY_LABELS,
		type GalleryDetail,
		type GalleryInput,
		type ShareLevel
	} from '../schemas';
	import EventBadges from './EventBadges.svelte';
	import GalleryDialog from './GalleryDialog.svelte';
	import ImageBulkBar from './ImageBulkBar.svelte';
	import ImageGrid from './ImageGrid.svelte';
	import ImageViewer from './ImageViewer.svelte';
	import UploadZone from './UploadZone.svelte';

	let { params }: ModulePageProps = $props();
	const id = $derived(params.id ?? '');
	const BASE = '/modules/galleries';
	const LIST = '/modules/galleries';

	let detail = $state<GalleryDetail | null>(null);
	let loading = $state(true);
	let notFound = $state(false);
	let loadError = $state('');
	let stammName = $state('Stamm');

	let editOpen = $state(false);
	let deleteOpen = $state(false);
	let selecting = $state(false);
	let selected = $state<string[]>([]);
	let viewerOpen = $state(false);
	let viewerIndex = $state(0);

	const canEdit = $derived(detail?.access.level === 'edit');
	const images = $derived(detail?.images ?? []);
	const galleryUrl = $derived(`${BASE}/galleries/${id}`);

	const shareLevels = SHARE_LEVELS.map((l) => ({ value: l, label: SHARE_LEVEL_LABELS[l] }));
	const shareEntries = $derived<ShareEntry[]>(
		(detail?.shares ?? []).map((s) => ({
			userId: s.id,
			type: s.type,
			name: s.name,
			detail: s.detail,
			color: s.color,
			image: s.image ?? null,
			level: s.level
		}))
	);
	const owner = $derived<ShareOwner | undefined>(
		detail?.owner
			? {
					name: detail.access.isOwner ? `${detail.owner.name} (du)` : detail.owner.name,
					image: detail.owner.image
				}
			: undefined
	);

	function errMsg(e: unknown, fallback: string) {
		return e instanceof ApiClientError ? e.message : fallback;
	}

	async function load() {
		try {
			const d = await apiFetch<GalleryDetail>(galleryUrl);
			detail = d;
			notFound = false;
			loadError = '';
			// Auswahl/Ansicht an die neue Bildliste anpassen
			const ids = new Set(d.images.map((i) => i.id));
			if (selected.some((s) => !ids.has(s))) selected = selected.filter((s) => ids.has(s));
			if (d.images.length === 0) viewerOpen = false;
			else if (viewerIndex >= d.images.length) viewerIndex = d.images.length - 1;
		} catch (e) {
			if (e instanceof ApiClientError && (e.status === 404 || e.status === 403)) {
				notFound = true;
				detail = null;
			} else {
				loadError = errMsg(e, 'Laden fehlgeschlagen');
			}
		} finally {
			loading = false;
		}
	}

	async function loadStamm() {
		try {
			const res = await apiFetch<{ name: string }>(`${BASE}/settings/stamm`);
			if (res?.name) stammName = res.name;
		} catch {
			// Standardname bleibt
		}
	}

	$effect(() => {
		void id;
		loading = true;
		notFound = false;
		loadError = '';
		selecting = false;
		selected = [];
		viewerOpen = false;
		void load();
	});

	$effect(() => {
		void loadStamm();
	});

	// Freigaben: PUT ersetzt die komplette Galerie-Eingabe
	async function saveShares(next: ShareEntry[]) {
		if (!detail) return;
		const input: GalleryInput = {
			title: detail.title,
			description: detail.description,
			visibility: detail.visibility,
			eventIds: detail.events.map((e) => e.id),
			shares: next.map((s) => ({
				type: s.type ?? 'user',
				id: s.userId,
				level: s.level as ShareLevel
			}))
		};
		try {
			await apiFetch<GalleryDetail>(galleryUrl, { method: 'PUT', body: JSON.stringify(input) });
		} catch (e) {
			throw new Error(errMsg(e, 'Freigabe fehlgeschlagen'), { cause: e });
		}
		await load();
	}

	async function searchPrincipals(q: string): Promise<ShareCandidate[]> {
		const found = await apiFetch<PrincipalInfo[]>(
			`${BASE}/principals?search=${encodeURIComponent(q)}`
		);
		const ownerId = detail?.owner?.id ?? detail?.ownerId;
		return found
			.filter((p) => !(p.type === 'user' && p.id === ownerId))
			.map((p) => ({
				id: p.id,
				type: p.type,
				name: p.name,
				detail: p.detail ?? null,
				color: p.color ?? null,
				image: p.image ?? null
			}));
	}

	async function addShare(c: ShareCandidate, level: string) {
		const entry: ShareEntry = {
			userId: c.id,
			type: c.type ?? 'user',
			name: c.name,
			detail: c.detail ?? null,
			color: c.color ?? null,
			level
		};
		if (shareEntries.some((s) => shareKey(s) === shareKey(entry))) return;
		await saveShares([...shareEntries, entry]);
	}

	async function changeShare(key: string, level: string) {
		await saveShares(shareEntries.map((s) => (shareKey(s) === key ? { ...s, level } : s)));
	}

	async function removeShare(key: string) {
		await saveShares(shareEntries.filter((s) => shareKey(s) !== key));
	}

	async function confirmDelete() {
		try {
			await apiFetch(galleryUrl, { method: 'DELETE' });
			toast.success('Galerie gelöscht');
			await goto(LIST);
		} catch (e) {
			toast.error(errMsg(e, 'Löschen fehlgeschlagen'));
		}
	}

	function onSaved(d: GalleryDetail) {
		detail = d;
		void load();
	}

	function toggleSelecting() {
		selecting = !selecting;
		if (!selecting) selected = [];
	}

	function toggleAll() {
		selected = selected.length === images.length ? [] : images.map((i) => i.id);
	}

	function openImage(index: number) {
		viewerIndex = index;
		viewerOpen = true;
	}

	function imageCountLabel(n: number) {
		return n === 1 ? '1 Bild' : `${n.toLocaleString('de-DE')} Bilder`;
	}
</script>

<svelte:head><title>{detail?.title ?? 'Galerie'}</title></svelte:head>

{#if loading}
	<div class="space-y-4" aria-busy="true" aria-label="Lade Galerie">
		<Skeleton class="h-5 w-32" />
		<Skeleton class="h-8 w-64" />
		<Skeleton class="h-5 w-96 max-w-full" />
		<div class="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
			{#each Array.from({ length: 6 }, (_, i) => i) as i (i)}
				<Skeleton class="aspect-square w-full" />
			{/each}
		</div>
	</div>
{:else if notFound}
	<EmptyState
		title="Galerie nicht gefunden"
		description="Die Galerie existiert nicht oder du hast keinen Zugriff darauf."
	>
		<Button href={LIST} variant="outline"><ArrowLeft /> Zurück zu den Galerien</Button>
	</EmptyState>
{:else if loadError || !detail}
	<div class="space-y-4">
		<p class="text-sm text-destructive" role="alert">{loadError || 'Laden fehlgeschlagen'}</p>
		<div class="flex flex-wrap gap-2">
			<Button
				variant="outline"
				onclick={() => {
					loading = true;
					void load();
				}}>Erneut versuchen</Button
			>
			<Button href={LIST} variant="ghost"><ArrowLeft /> Zurück zu den Galerien</Button>
		</div>
	</div>
{:else}
	<div class={['space-y-6', selecting && selected.length > 0 && 'pb-20 sm:pb-0']}>
		<div>
			<nav aria-label="Navigation" class="mb-2">
				<a
					href={LIST}
					class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft class="size-4" aria-hidden="true" /> Galerien
				</a>
			</nav>

			<PageHeader title={detail.title} description={detail.description ?? undefined}>
				{#snippet actions()}
					{#if detail}
						<Badge variant={detail.visibility === 'public' ? 'secondary' : 'outline'}>
							{#if detail.visibility === 'public'}
								<Globe aria-hidden="true" />
							{:else}
								<Lock aria-hidden="true" />
							{/if}
							{VISIBILITY_LABELS[detail.visibility]}
						</Badge>
						{#if canEdit}
							<ShareMenu
								shares={shareEntries}
								{owner}
								levels={shareLevels}
								defaultLevel="read"
								canManage={canEdit}
								search={searchPrincipals}
								onadd={addShare}
								onchange={changeShare}
								onremove={removeShare}
								description="Wer diese Galerie sehen oder bearbeiten darf."
								everyoneLabel={stammName}
								placeholder="Suchen …"
								searchLabel="Freigabe hinzufügen"
								emptyResultText="Niemand gefunden"
							/>
							<Button variant="outline" onclick={() => (editOpen = true)}>
								<Pencil /> Bearbeiten
							</Button>
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button {...props} variant="outline" aria-label="Mehr Aktionen">
											<Ellipsis /> Mehr
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end" class="w-48">
									<DropdownMenu.Item variant="destructive" onclick={() => (deleteOpen = true)}>
										<Trash2 /> Löschen
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					{/if}
				{/snippet}
			</PageHeader>
			<EventBadges events={detail.events} class="mt-3" />
		</div>

		{#if canEdit}
			<UploadZone galleryId={detail.id} onuploaded={() => void load()} />
		{/if}

		<section class="space-y-3" aria-labelledby="gallery-images-heading">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h2 id="gallery-images-heading" class="text-sm font-medium text-muted-foreground">
					{imageCountLabel(images.length)}
					{#if selecting}
						· {selected.length} ausgewählt
					{/if}
				</h2>
				{#if canEdit && images.length > 0}
					<div class="flex flex-wrap gap-2">
						{#if selecting}
							<Button size="sm" variant="ghost" onclick={toggleAll}>
								{selected.length === images.length ? 'Keine auswählen' : 'Alle auswählen'}
							</Button>
						{/if}
						<Button
							size="sm"
							variant={selecting ? 'secondary' : 'outline'}
							aria-pressed={selecting}
							onclick={toggleSelecting}
						>
							{#if selecting}
								<X /> Auswahl beenden
							{:else}
								<SquareCheck /> Auswählen
							{/if}
						</Button>
					</div>
				{/if}
			</div>

			{#if images.length === 0}
				<EmptyState
					title="Noch keine Bilder"
					description={canEdit
						? 'Ziehe Bilder in das Feld oben oder wähle sie über „Bilder auswählen“ aus.'
						: 'In dieser Galerie gibt es noch keine Bilder.'}
				/>
			{:else}
				<ImageGrid
					galleryId={detail.id}
					{images}
					coverImageId={detail.coverImageId}
					selectable={selecting}
					bind:selected
					onopen={openImage}
				/>
			{/if}
		</section>
	</div>

	{#if canEdit && selecting && selected.length > 0}
		<ImageBulkBar
			galleryId={detail.id}
			{selected}
			onclear={() => (selected = [])}
			ondone={() => {
				selected = [];
				void load();
			}}
		/>
	{/if}

	<ImageViewer
		bind:open={viewerOpen}
		bind:index={viewerIndex}
		galleryId={detail.id}
		{images}
		coverImageId={detail.coverImageId}
		coverIsDefault={detail.coverIsDefault}
		{canEdit}
		onchanged={() => void load()}
	/>

	{#if canEdit}
		<GalleryDialog bind:open={editOpen} mode="edit" gallery={detail} onsaved={onSaved} />
		<ConfirmDialog
			bind:open={deleteOpen}
			title="Galerie löschen?"
			description={`„${detail.title}“ mit ${imageCountLabel(images.length)} wird endgültig gelöscht. Das lässt sich nicht rückgängig machen.`}
			confirmLabel="Löschen"
			destructive
			onconfirm={confirmDelete}
		/>
	{/if}
{/if}
