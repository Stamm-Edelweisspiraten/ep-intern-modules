<script lang="ts">
	// Stückliste mit Filtern (Suche, Kategorie, Lagerort inkl. Unterorte, Zustand, Kisten, ausgegeben,
	// ausgemustert), Mehrfachauswahl → Umlagern / Etiketten drucken.
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
	import Box from '@lucide/svelte/icons/box';
	import Plus from '@lucide/svelte/icons/plus';
	import Printer from '@lucide/svelte/icons/printer';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import * as Table from '$lib/components/ui/table';
	import { BUSY_LOAD, DataTable, MobileActionBar } from '$lib/components/layout';
	import {
		CONDITIONS,
		CONDITION_LABELS,
		MAX_BATCH_UNITS,
		type Article,
		type Category,
		type Location,
		type UnitSummary
	} from '../../schemas';
	import { API, errorText } from '../helpers';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';
	import MoveDialog from './MoveDialog.svelte';
	import { locationOptions } from './inventory';

	let {
		articleId = $bindable(null),
		locationId = $bindable(null),
		articles,
		categories,
		locations,
		canManage,
		canLabels,
		reloadToken = 0,
		onopen,
		oncreate,
		onchanged
	}: {
		/** Filter auf einen Artikel (aus `?article=` bzw. der Artikelliste) */
		articleId?: string | null;
		/** Filter auf einen Lagerort inkl. Unterorte */
		locationId?: string | null;
		articles: Article[];
		categories: Category[];
		locations: Location[];
		canManage: boolean;
		canLabels: boolean;
		/** Ändert sich → Liste neu laden (nach Änderungen im Blatt) */
		reloadToken?: number;
		onopen: (id: string) => void;
		oncreate: () => void;
		/** Nach Sammelaktionen (Zähler der Lagerorte/Artikel neu laden) */
		onchanged: () => void | Promise<void>;
	} = $props();

	const LIMIT = 100;

	let search = $state('');
	let categoryId = $state<string | null>(null);
	let condition = $state<string | null>(null);
	let containersOnly = $state(false);
	let issuedOnly = $state(false);
	let showRetired = $state(false);
	let moreFilters = $state(false);

	let items = $state<UnitSummary[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state('');
	let loaded = $state(false);
	const selected = new SvelteSet<string>();

	const categoryOptions = $derived(categories.map((c) => ({ value: c.id, label: c.name })));
	const locOptions = $derived(locationOptions(locations));
	const conditionOptions = CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }));
	const filterArticle = $derived(articles.find((a) => a.id === articleId) ?? null);

	const params = $derived.by(() => {
		const p = new URLSearchParams({ limit: String(LIMIT) });
		if (search.trim()) p.set('search', search.trim());
		if (articleId) p.set('articleId', articleId);
		if (categoryId) p.set('categoryId', categoryId);
		if (locationId) {
			p.set('locationId', locationId);
			p.set('deep', '1');
		}
		if (condition) p.set('condition', condition);
		if (containersOnly) p.set('containers', '1');
		if (issuedOnly) p.set('issued', '1');
		if (showRetired) p.set('retired', '1');
		return p.toString();
	});
	const filtered = $derived(
		!!(
			search.trim() ||
			articleId ||
			categoryId ||
			locationId ||
			condition ||
			containersOnly ||
			issuedOnly ||
			showRetired
		)
	);
	const extraFilterCount = $derived(
		[condition, containersOnly, issuedOnly, showRetired].filter(Boolean).length
	);

	let seq = 0;
	async function load(query: string) {
		const my = ++seq;
		loading = true;
		error = '';
		try {
			const res = await apiFetch<{ items: UnitSummary[]; total: number }>(`${API}/units?${query}`);
			if (my !== seq) return;
			items = res.items;
			total = res.total;
			loaded = true;
			// Auswahl auf sichtbare Treffer begrenzen
			const ids = new Set(res.items.map((u) => u.id));
			for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
		} catch (e) {
			if (my === seq) error = errorText(e, 'Stücke konnten nicht geladen werden');
		} finally {
			if (my === seq) loading = false;
		}
	}

	async function loadMore() {
		loadingMore = true;
		try {
			const res = await apiFetch<{ items: UnitSummary[]; total: number }>(
				`${API}/units?${params}&offset=${items.length}`
			);
			const known = new Set(items.map((u) => u.id));
			items = [...items, ...res.items.filter((u) => !known.has(u.id))];
			total = res.total;
		} catch (e) {
			error = errorText(e, 'Stücke konnten nicht geladen werden');
		} finally {
			loadingMore = false;
		}
	}

	// Neu laden bei Filteränderung (Suche verzögert) oder `reloadToken`
	let timer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const query = params;
		void reloadToken;
		clearTimeout(timer);
		timer = setTimeout(() => void load(query), untrack(() => loaded) ? 250 : 0);
		return () => clearTimeout(timer);
	});

	function resetFilters() {
		search = '';
		articleId = null;
		categoryId = null;
		locationId = null;
		condition = null;
		containersOnly = false;
		issuedOnly = false;
		showRetired = false;
	}

	const allSelected = $derived(items.length > 0 && items.every((u) => selected.has(u.id)));
	function toggleAll(on: boolean) {
		if (on) for (const u of items.slice(0, MAX_BATCH_UNITS)) selected.add(u.id);
		else selected.clear();
	}
	function toggle(id: string, on: boolean) {
		if (on) {
			if (selected.size < MAX_BATCH_UNITS) selected.add(id);
		} else selected.delete(id);
	}

	let moveOpen = $state(false);
	let moveKey = $state(0);
	let printOpen = $state(false);
	const selectedIds = $derived(items.filter((u) => selected.has(u.id)).map((u) => u.id));

	async function moved() {
		selected.clear();
		await load(params);
		await onchanged();
	}

	function placeOf(u: UnitSummary): string {
		if (u.containerId) return `In ${u.containerName ?? 'Kiste'}`;
		return u.locationPath || 'Ohne Ort';
	}
</script>

<div class="space-y-3 pb-20 sm:pb-0">
	{#if canManage || canLabels}
		<MobileActionBar
			show={selectedIds.length > 0}
			label="Sammelaktionen"
			class="sm:w-full sm:rounded-md sm:border sm:bg-muted/40 sm:px-3 sm:py-2"
		>
			<span class="text-sm font-medium" aria-live="polite">
				{selectedIds.length} ausgewählt
			</span>
			{#if canManage}
				<Button
					size="sm"
					variant="outline"
					onclick={() => {
						moveKey++;
						moveOpen = true;
					}}
				>
					<ArrowRightLeft /> Umlagern
				</Button>
			{/if}
			{#if canLabels}
				<Button size="sm" variant="outline" onclick={() => (printOpen = true)}>
					<Printer /> Etiketten drucken
				</Button>
			{/if}
			<Button size="sm" variant="ghost" onclick={() => selected.clear()}>
				<X /> Auswahl aufheben
			</Button>
		</MobileActionBar>
	{/if}

	<DataTable
		caption="Stücke und Kisten"
		mobile="cards"
		{loading}
		{error}
		onretry={() => load(params)}
		empty={!items.length}
		emptyTitle={filtered ? 'Keine passenden Stücke' : 'Noch keine Stücke'}
		emptyDescription={filtered
			? 'Passe Suche oder Filter an.'
			: 'Erfasse Einzelstücke wie Zeltbahnen, Kocher oder Kisten – jedes bekommt einen eigenen Code.'}
	>
		{#snippet toolbar()}
			<Input
				type="search"
				class="w-full sm:w-56"
				placeholder="Name oder Code …"
				aria-label="Stücke suchen"
				bind:value={search}
				data-scan-field
			/>
			<SelectField
				options={categoryOptions}
				bind:value={categoryId}
				label="Kategorie"
				emptyLabel="Alle Kategorien"
				placeholder="Alle Kategorien"
				class="w-full sm:w-44"
			/>
			<SelectField
				options={locOptions}
				bind:value={locationId}
				label="Lagerort (inkl. Unterorte)"
				emptyLabel="Alle Lagerorte"
				placeholder="Alle Lagerorte"
				class="w-full sm:w-56"
			/>
			<Button
				variant="outline"
				aria-expanded={moreFilters}
				aria-controls="units-more-filters"
				onclick={() => (moreFilters = !moreFilters)}
			>
				<SlidersHorizontal /> Filter{#if extraFilterCount}<Badge variant="secondary" class="ml-1"
						>{extraFilterCount}</Badge
					>{/if}
			</Button>
			{#if canManage}
				<Button class="sm:ml-auto" onclick={oncreate}><Plus /> Stücke erfassen</Button>
			{/if}
			{#if moreFilters}
				<div
					id="units-more-filters"
					class="flex w-full flex-wrap items-center gap-x-5 gap-y-2 rounded-md border bg-muted/30 p-3"
				>
					<SelectField
						options={conditionOptions}
						bind:value={condition}
						label="Zustand"
						emptyLabel="Jeder Zustand"
						placeholder="Jeder Zustand"
						class="w-full sm:w-44"
					/>
					<div class="flex items-center gap-2">
						<Switch id="units-containers" bind:checked={containersOnly} />
						<Label for="units-containers" class="font-normal">Nur Kisten</Label>
					</div>
					<div class="flex items-center gap-2">
						<Switch id="units-issued" bind:checked={issuedOnly} />
						<Label for="units-issued" class="font-normal">Nur ausgegebene</Label>
					</div>
					<div class="flex items-center gap-2">
						<Switch id="units-retired" bind:checked={showRetired} />
						<Label for="units-retired" class="font-normal">Ausgemusterte anzeigen</Label>
					</div>
				</div>
			{/if}
			{#if filterArticle || (articleId && !filterArticle)}
				<Badge variant="secondary" class="gap-1 pr-1">
					Artikel: {filterArticle?.name ?? 'gewählt'}
					<button
						type="button"
						class="rounded-full p-0.5 hover:bg-background"
						aria-label="Artikel-Filter entfernen"
						onclick={() => (articleId = null)}
					>
						<X class="size-3" aria-hidden="true" />
					</button>
				</Badge>
			{/if}
			{#if filtered}
				<Button variant="ghost" size="sm" onclick={resetFilters}>
					<X /> Filter zurücksetzen
				</Button>
			{/if}
		{/snippet}
		{#snippet emptyAction()}
			{#if loaded && filtered}
				<Button variant="outline" onclick={resetFilters}><X /> Filter zurücksetzen</Button>
			{:else if loaded && canManage}
				<Button onclick={oncreate}><Plus /> Stücke erfassen</Button>
			{/if}
		{/snippet}
		{#snippet head()}
			<Table.Row>
				{#if canManage || canLabels}
					<Table.Head class="w-10">
						<Checkbox
							checked={allSelected}
							onCheckedChange={(v) => toggleAll(v === true)}
							aria-label="Alle sichtbaren auswählen"
						/>
					</Table.Head>
				{/if}
				<Table.Head>Stück</Table.Head>
				<Table.Head>Code</Table.Head>
				<Table.Head>Ort</Table.Head>
				<Table.Head>Zustand</Table.Head>
				<Table.Head>Status</Table.Head>
			</Table.Row>
		{/snippet}
		{#each items as u (u.id)}
			<Table.Row
				class="cursor-pointer"
				data-state={selected.has(u.id) ? 'selected' : undefined}
				onclick={() => onopen(u.id)}
			>
				{#if canManage || canLabels}
					<Table.Cell onclick={(e) => e.stopPropagation()}>
						<Checkbox
							checked={selected.has(u.id)}
							onCheckedChange={(v) => toggle(u.id, v === true)}
							aria-label={`${u.name} auswählen`}
						/>
					</Table.Cell>
				{/if}
				<Table.Cell>
					<span class="flex items-center gap-1.5 font-medium">
						{#if u.isContainer}
							<Box class="size-4 shrink-0 text-muted-foreground" aria-label="Kiste" />
						{/if}
						{u.name}
					</span>
					<span class="block text-xs text-muted-foreground">
						{u.articleName}{u.categoryName ? ` · ${u.categoryName}` : ''}{u.setName
							? ` · Set ${u.setName}`
							: ''}
					</span>
				</Table.Cell>
				<Table.Cell class="font-mono text-xs">{u.code}</Table.Cell>
				<Table.Cell class="max-w-56 truncate">
					{placeOf(u)}
					{#if u.containerId && u.locationPath}
						<span class="block truncate text-xs text-muted-foreground">{u.locationPath}</span>
					{/if}
				</Table.Cell>
				<Table.Cell><ConditionBadge condition={u.condition} /></Table.Cell>
				<Table.Cell>
					<div class="flex flex-wrap gap-1">
						{#if u.retired}<Badge variant="outline">Ausgemustert</Badge>{/if}
						{#if u.issued}
							<Badge variant="warning" title={u.issued.title}>Ausgegeben</Badge>
						{/if}
						{#if !u.retired && !u.issued}<span class="text-muted-foreground">Im Lager</span>{/if}
					</div>
				</Table.Cell>
			</Table.Row>
		{/each}
		{#snippet footer()}
			{#if loaded && items.length}
				<div
					class="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground"
				>
					<span aria-live="polite">{items.length} von {total}</span>
					{#if total > items.length}
						<Button size="sm" variant="outline" disabled={loadingMore} onclick={loadMore}>
							{loadingMore ? BUSY_LOAD : 'Weitere laden'}
						</Button>
					{/if}
				</div>
			{/if}
		{/snippet}
	</DataTable>
</div>

{#key moveKey}
	<MoveDialog
		bind:open={moveOpen}
		unitIds={selectedIds}
		title={selectedIds.length === 1 ? '1 Stück' : `${selectedIds.length} Stücke`}
		{locations}
		onsaved={moved}
	/>
{/key}
<PrintLabelsDialog bind:open={printOpen} target="unit" ids={selectedIds} />
