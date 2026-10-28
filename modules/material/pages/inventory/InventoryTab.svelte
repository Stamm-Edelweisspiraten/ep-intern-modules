<script lang="ts">
	// Reiter „Lager“: Ansichten Artikel · Sets · Zelte. Artikel = große Lagertabelle (Typen aufklappbar mit
	// ihren Artikeln, Artikel ohne Typ), Filter, Scannen (Kamera/USB), Mehrfachauswahl (Etiketten, Umlagern)
	// und Pflege-Dialoge; Sets = zusammengehörige Artikel; Zelte = Baupläne.
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { page } from '$app/state';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Download from '@lucide/svelte/icons/download';
	import FolderTree from '@lucide/svelte/icons/folder-tree';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import PackagePlus from '@lucide/svelte/icons/package-plus';
	import Plus from '@lucide/svelte/icons/plus';
	import Printer from '@lucide/svelte/icons/printer';
	import Layers from '@lucide/svelte/icons/layers';
	import Shapes from '@lucide/svelte/icons/shapes';
	import TentIcon from '@lucide/svelte/icons/tent';
	import Truck from '@lucide/svelte/icons/truck';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import * as Tabs from '$lib/components/ui/tabs';
	import { DataTable, MobileActionBar } from '$lib/components/layout';
	import type {
		Category,
		Condition,
		Inventory,
		Item,
		Location,
		MaterialSet,
		MaterialType,
		Tent
	} from '../../schemas';
	import { API, errorText, safeReplaceState } from '../helpers';
	import CategoryGlyph from '../shared/CategoryGlyph.svelte';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';
	import ScanButton from '../shared/ScanButton.svelte';
	import { resolveScan } from '../shared/scan';
	import CategoriesDialog from './CategoriesDialog.svelte';
	import ExportDialog from './ExportDialog.svelte';
	import ItemDialog from './ItemDialog.svelte';
	import ItemFormDialog from './ItemFormDialog.svelte';
	import LocationsDialog from './LocationsDialog.svelte';
	import MoveDialog from './MoveDialog.svelte';
	import SetsView from './SetsView.svelte';
	import TentsView from './TentsView.svelte';
	import TypeDialog from './TypeDialog.svelte';
	import TypeFormDialog from './TypeFormDialog.svelte';
	import {
		categoryOptions,
		conditionOptions,
		inventoryPermissions,
		locationOptions,
		locationSummary,
		problemCount,
		setOptions,
		type ItemPreset
	} from './options';

	let { onreserve }: { onreserve: () => void } = $props();

	const perm = $derived(inventoryPermissions());
	const canSelect = $derived(perm.manage || perm.labels);

	// --- Daten -------------------------------------------------------------------
	let inventory = $state<Inventory | null>(null);
	let categories = $state<Category[]>([]);
	let locations = $state<Location[]>([]);
	let sets = $state<MaterialSet[]>([]);
	let tents = $state<Tent[]>([]);
	let listsLoading = $state(true);
	let listsError = $state('');
	let loading = $state(true);
	let error = $state('');
	let seq = 0;

	// --- Filter --------------------------------------------------------------------
	let searchInput = $state('');
	let search = $state('');
	let categoryId = $state<string | null>(null);
	let locationId = $state<string | null>(null);
	let condition = $state<string | null>(null);
	let setId = $state<string | null>(null);
	let archived = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	const filtered = $derived(!!(search || categoryId || locationId || condition || setId));
	const query = $derived.by(() => {
		const q = new URLSearchParams();
		if (search) q.set('search', search);
		if (categoryId) q.set('categoryId', categoryId);
		if (locationId) q.set('locationId', locationId);
		if (condition) q.set('condition', condition);
		if (setId) q.set('setId', setId);
		if (archived) q.set('archived', '1');
		return q.toString();
	});

	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => (search = searchInput.trim()), 300);
	}

	function resetFilters() {
		clearTimeout(searchTimer);
		searchInput = '';
		search = '';
		categoryId = null;
		locationId = null;
		condition = null;
		setId = null;
	}

	async function loadInventory(q = query) {
		const mine = ++seq;
		loading = true;
		error = '';
		try {
			const res = await apiFetch<Inventory>(`${API}/inventory${q ? `?${q}` : ''}`);
			if (mine !== seq) return;
			inventory = res;
			// Auswahl auf sichtbare Artikel beschränken
			const visible = new Set(allItems(res).map((i) => i.id));
			selected = selected.filter((id) => visible.has(id));
		} catch (e) {
			if (mine === seq) error = errorText(e, 'Lager konnte nicht geladen werden');
		} finally {
			if (mine === seq) loading = false;
		}
	}

	async function loadLists() {
		listsError = '';
		try {
			const [c, l, s, z] = await Promise.all([
				apiFetch<Category[]>(`${API}/categories`),
				apiFetch<Location[]>(`${API}/locations`),
				apiFetch<MaterialSet[]>(`${API}/sets`),
				apiFetch<Tent[]>(`${API}/tents`)
			]);
			categories = c;
			locations = l;
			sets = s;
			tents = z;
		} catch (e) {
			listsError = errorText(
				e,
				'Kategorien, Lagerorte, Sets und Zelte konnten nicht geladen werden'
			);
			toast.error(listsError);
		} finally {
			listsLoading = false;
		}
	}

	// --- Ansicht -----------------------------------------------------------------------
	let view = $state<'items' | 'sets' | 'tents'>('items');
	let setsView = $state<ReturnType<typeof SetsView> | null>(null);
	let tentsView = $state<ReturnType<typeof TentsView> | null>(null);

	function newSet() {
		view = 'sets';
		setTimeout(() => setsView?.create(), 0);
	}
	function newTent() {
		view = 'tents';
		setTimeout(() => tentsView?.create(), 0);
	}

	function reloadAll() {
		void loadInventory();
		void loadLists();
	}

	$effect(() => {
		void loadInventory(query);
	});

	// --- Aufklappen ------------------------------------------------------------------
	let expanded = $state<string[]>([]);
	const isOpen = (id: string) => filtered || expanded.includes(id);
	function toggleType(id: string) {
		if (filtered) return;
		expanded = expanded.includes(id) ? expanded.filter((x) => x !== id) : [...expanded, id];
	}

	// --- Auswahl ---------------------------------------------------------------------
	let selected = $state<string[]>([]);
	const allItems = (inv: Inventory | null): Item[] =>
		inv ? [...inv.types.flatMap((t) => t.items), ...inv.items] : [];
	const visibleIds = $derived(allItems(inventory).map((i) => i.id));
	const allSelected = $derived(
		visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id))
	);
	const someSelected = $derived(selected.length > 0 && !allSelected);

	function setSelected(ids: string[], on: boolean) {
		const set = new Set(selected);
		for (const id of ids) {
			if (on) set.add(id);
			else set.delete(id);
		}
		selected = [...set];
	}

	// --- Dialoge ------------------------------------------------------------------------
	let itemOpen = $state(false);
	let itemId = $state<string | null>(null);
	let formOpen = $state(false);
	let formItem = $state<Item | null>(null);
	let formPreset = $state<ItemPreset>({});
	let typeOpen = $state(false);
	let typeId = $state<string | null>(null);
	let typeFormOpen = $state(false);
	let typeFormType = $state<MaterialType | null>(null);
	let categoriesOpen = $state(false);
	let locationsOpen = $state(false);
	let exportOpen = $state(false);
	let moveOpen = $state(false);
	let printOpen = $state(false);
	let printTarget = $state<'item' | 'location'>('item');
	let printIds = $state<string[]>([]);
	let printTitle = $state<string | undefined>(undefined);

	function openItem(id: string) {
		typeOpen = false;
		itemId = id;
		itemOpen = true;
	}
	function openType(id: string) {
		itemOpen = false;
		typeId = id;
		typeOpen = true;
	}
	function newItem(preset: ItemPreset = {}) {
		itemOpen = false;
		typeOpen = false;
		formItem = null;
		formPreset = preset;
		formOpen = true;
	}
	function editItem(item: Item) {
		itemOpen = false;
		formItem = item;
		formPreset = {};
		formOpen = true;
	}
	function newType() {
		typeFormType = null;
		typeFormOpen = true;
	}
	function editType(t: MaterialType) {
		typeOpen = false;
		typeFormType = t;
		typeFormOpen = true;
	}
	function printLabels(target: 'item' | 'location', ids: string[], title?: string) {
		if (!ids.length) return;
		printTarget = target;
		printIds = ids;
		printTitle = title;
		printOpen = true;
	}

	// --- Scannen ------------------------------------------------------------------------
	let scanBusy = $state(false);
	async function onscan(raw: string) {
		scanBusy = true;
		try {
			const target = await resolveScan(raw);
			if (!target) {
				toast.error('Unbekannter Code – kein Artikel und kein Lagerort.');
			} else if (target.type === 'item') {
				openItem(target.id);
			} else if (target.type === 'location') {
				locationId = target.id;
				toast.info(`Lagerort „${target.name}“ – zeige die Artikel dort.`);
			} else if (perm.manage) {
				toast.info(`Code ${target.code} ist noch frei.`, {
					action: { label: 'Lagerartikel anlegen', onClick: () => newItem({ code: target.code }) }
				});
			} else {
				toast.info(`Code ${target.code} ist noch keinem Artikel zugeordnet.`);
			}
		} catch (e) {
			toast.error(errorText(e, 'Code konnte nicht geprüft werden'));
		} finally {
			scanBusy = false;
		}
	}

	// --- URL-Parameter (?open, ?location, ?type) ----------------------------------------
	onMount(() => {
		void loadLists();
		const url = new URL(page.url);
		const open = url.searchParams.get('open');
		const loc = url.searchParams.get('location');
		const type = url.searchParams.get('type');
		const set = url.searchParams.get('set');
		const v = url.searchParams.get('view');
		const tent = url.searchParams.get('tent');
		if (loc) locationId = loc;
		if (set) setId = set;
		if (v === 'sets' || v === 'tents') view = v;
		if (tent) {
			view = 'tents';
			void loadLists().then(() => tentsView?.openTent(tent));
		}
		if (type) {
			expanded = [...expanded, type];
			openType(type);
		}
		if (open) openItem(open);
		if (open || loc || type || set || v || tent) {
			for (const key of ['open', 'location', 'type', 'set', 'view', 'tent'])
				url.searchParams.delete(key);
			safeReplaceState(url);
		}
	});

	const locFilterOptions = $derived([
		{ value: 'none', label: 'Ohne Lagerort' },
		...locationOptions(locations)
	]);
	const isEmpty = $derived(
		!!inventory && inventory.types.length === 0 && inventory.items.length === 0
	);
	const colCount = $derived(canSelect ? 7 : 6);
</script>

<div class={['space-y-4', selected.length ? 'pb-20 sm:pb-0' : ''].join(' ')}>
	<div class="flex flex-wrap items-center justify-end gap-2">
		<Tabs.Root bind:value={view} class="mr-auto">
			<Tabs.List aria-label="Ansicht">
				<Tabs.Trigger value="items">Artikel</Tabs.Trigger>
				<Tabs.Trigger value="sets">
					Sets{#if sets.length}<span class="text-muted-foreground tabular-nums">
							({sets.length})</span
						>{/if}
				</Tabs.Trigger>
				<Tabs.Trigger value="tents">
					Zelte{#if tents.length}<span class="text-muted-foreground tabular-nums">
							({tents.filter((t) => !t.archived).length})</span
						>{/if}
				</Tabs.Trigger>
			</Tabs.List>
		</Tabs.Root>
		{#if perm.manage}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props}><Plus /> Erstellen <ChevronDown /></Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end">
					<DropdownMenu.Item onclick={newType}><Shapes /> Typ</DropdownMenu.Item>
					<DropdownMenu.Item onclick={() => newItem()}>
						<PackagePlus /> Lagerartikel
					</DropdownMenu.Item>
					<DropdownMenu.Item onclick={newSet}><Layers /> Set</DropdownMenu.Item>
					<DropdownMenu.Item onclick={newTent}><TentIcon /> Zelt</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<Button variant="outline" onclick={() => (categoriesOpen = true)}>
				<FolderTree /> Kategorien
			</Button>
		{/if}
		<Button variant="outline" onclick={() => (locationsOpen = true)}>
			<MapPin /> Lagerorte
		</Button>
		<Button variant="outline" onclick={() => (exportOpen = true)}><Download /> Export</Button>
	</div>

	{#if view === 'sets'}
		<SetsView
			bind:this={setsView}
			{sets}
			loading={listsLoading}
			error={listsError}
			canManage={perm.manage}
			onretry={loadLists}
			onchanged={reloadAll}
			onopenitem={openItem}
			onfilter={(id) => {
				setId = id;
				view = 'items';
			}}
		/>
	{:else if view === 'tents'}
		<TentsView
			bind:this={tentsView}
			{tents}
			{categories}
			loading={listsLoading}
			error={listsError}
			canManage={perm.manage}
			onretry={loadLists}
			onchanged={reloadAll}
			{onreserve}
		/>
	{:else}
		<DataTable
			mobile="cards"
			caption="Lager: Typen mit ihren Artikeln und Artikel ohne Typ"
			loading={loading && !inventory}
			{error}
			onretry={() => loadInventory()}
			empty={isEmpty}
			emptyTitle={filtered ? 'Keine Treffer' : 'Das Lager ist noch leer'}
			emptyDescription={filtered
				? 'Kein Typ und kein Artikel passt zu Suche oder Filter.'
				: perm.manage
					? 'Lege einen Typ (z. B. „Kohtenbahn“) oder direkt einen Lagerartikel an.'
					: 'Hier erscheinen Zelte, Kisten und alles andere, sobald die Materialwart*innen es erfasst haben.'}
		>
			{#snippet toolbar()}
				<Input
					class="h-8 min-w-40 flex-1 sm:max-w-60"
					placeholder="Name oder Code suchen …"
					aria-label="Lager durchsuchen"
					bind:value={searchInput}
					oninput={onSearchInput}
				/>
				<SelectField
					size="sm"
					class="w-full sm:w-44"
					label="Kategorie filtern"
					options={categoryOptions(categories)}
					emptyLabel="Alle Kategorien"
					bind:value={categoryId}
				/>
				<SelectField
					size="sm"
					class="w-full sm:w-44"
					label="Lagerort filtern"
					options={locFilterOptions}
					emptyLabel="Alle Lagerorte"
					bind:value={locationId}
				/>
				<SelectField
					size="sm"
					class="w-full sm:w-40"
					label="Zustand filtern"
					options={conditionOptions}
					emptyLabel="Alle Zustände"
					bind:value={condition}
				/>
				{#if sets.length || setId}
					<SelectField
						size="sm"
						class="w-full sm:w-36"
						label="Set filtern"
						options={[{ value: 'none', label: 'Ohne Set' }, ...setOptions(sets)]}
						emptyLabel="Alle Sets"
						bind:value={setId}
					/>
				{/if}
				<label class="flex items-center gap-2 text-sm">
					<Checkbox checked={archived} onCheckedChange={(v) => (archived = v === true)} />
					Archivierte zeigen
				</label>
				{#if filtered}
					<Button size="sm" variant="ghost" onclick={resetFilters}><X /> Filter zurücksetzen</Button
					>
				{/if}
				<div class="ml-auto">
					<ScanButton {onscan} busy={scanBusy} />
				</div>
			{/snippet}
			{#snippet head()}
				<Table.Row>
					{#if canSelect}
						<Table.Head class="w-10">
							<Checkbox
								aria-label="Alle sichtbaren Artikel auswählen"
								checked={allSelected}
								indeterminate={someSelected}
								disabled={!visibleIds.length}
								onCheckedChange={(v) => setSelected(visibleIds, v === true)}
							/>
						</Table.Head>
					{/if}
					<Table.Head>Name</Table.Head>
					<Table.Head>Kategorie</Table.Head>
					<Table.Head class="text-right">Anzahl</Table.Head>
					<Table.Head>Lagerort</Table.Head>
					<Table.Head>Zustand</Table.Head>
					<Table.Head>Code</Table.Head>
				</Table.Row>
			{/snippet}
			{#if inventory}
				{#each inventory.types as t (t.id)}
					{@const open = isOpen(t.id)}
					{@const ids = t.items.map((i) => i.id)}
					{@const chosen = ids.filter((id) => selected.includes(id)).length}
					{@const problems = problemCount(t.items)}
					<Table.Row class="cursor-pointer bg-muted/30" onclick={() => toggleType(t.id)}>
						{#if canSelect}
							<Table.Cell onclick={(e) => e.stopPropagation()}>
								<Checkbox
									aria-label={`Alle Artikel von ${t.name} auswählen`}
									checked={ids.length > 0 && chosen === ids.length}
									indeterminate={chosen > 0 && chosen < ids.length}
									disabled={!ids.length}
									onCheckedChange={(v) => setSelected(ids, v === true)}
								/>
							</Table.Cell>
						{/if}
						<Table.Cell class="max-w-80">
							<div class="flex items-center gap-2">
								<Button
									size="icon"
									variant="ghost"
									class="-my-1 -ml-2 size-7 shrink-0"
									aria-expanded={open}
									aria-label={`${open ? 'Artikel ausblenden' : 'Artikel zeigen'}: ${t.name}`}
									disabled={filtered}
									onclick={(e) => {
										e.stopPropagation();
										toggleType(t.id);
									}}
								>
									<ChevronDown
										class={['size-4 transition-transform', open ? '' : '-rotate-90'].join(' ')}
									/>
								</Button>
								{#if t.images[0]}
									<img
										src={t.images[0].thumbUrl}
										alt=""
										class="size-8 shrink-0 rounded-md object-cover"
										loading="lazy"
									/>
								{:else}
									<CategoryGlyph category={t.category} />
								{/if}
								<div class="min-w-0">
									<button
										type="button"
										class="truncate text-left font-medium hover:underline"
										onclick={(e) => {
											e.stopPropagation();
											openType(t.id);
										}}
									>
										{t.name}
									</button>
									<div class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
										<span>Typ · {t.itemCount === 1 ? '1 Artikel' : `${t.itemCount} Artikel`}</span>
										{#if t.archived}<Badge variant="outline">Archiviert</Badge>{/if}
									</div>
								</div>
							</div>
						</Table.Cell>
						<Table.Cell>{t.category?.name ?? '–'}</Table.Cell>
						<Table.Cell class="text-right tabular-nums">
							<span class="font-medium">{t.totalQuantity}</span>
							{#if t.usableQuantity !== t.totalQuantity}
								<span class="block text-xs text-muted-foreground">{t.usableQuantity} nutzbar</span>
							{/if}
						</Table.Cell>
						<Table.Cell>{locationSummary(t.items)}</Table.Cell>
						<Table.Cell>
							{#if problems}
								<Badge variant="warning">{problems} mit Mängeln</Badge>
							{/if}
						</Table.Cell>
						<Table.Cell><span class="text-muted-foreground">–</span></Table.Cell>
					</Table.Row>
					{#if open}
						{#each t.items as item (item.id)}
							{@render itemRow(item, true)}
						{:else}
							<Table.Row>
								<Table.Cell colspan={colCount} class="pl-12 text-sm text-muted-foreground">
									{filtered ? 'Keine passenden Artikel.' : 'Noch keine Artikel.'}
									{#if perm.manage && !t.archived}
										<button
											type="button"
											class="ml-1 text-link hover:underline"
											onclick={() => newItem({ typeId: t.id })}
										>
											Artikel hinzufügen
										</button>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					{/if}
				{/each}
				{#each inventory.items as item (item.id)}
					{@render itemRow(item, false)}
				{/each}
			{/if}
		</DataTable>
	{/if}

	<MobileActionBar show={canSelect && selected.length > 0} label="Aktionen für die Auswahl">
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-sm font-medium tabular-nums">
				{selected.length === 1 ? '1 Artikel gewählt' : `${selected.length} Artikel gewählt`}
			</span>
			{#if perm.labels}
				<Button size="sm" variant="outline" onclick={() => printLabels('item', selected)}>
					<Printer /> Etiketten drucken
				</Button>
			{/if}
			{#if perm.manage}
				<Button size="sm" variant="outline" onclick={() => (moveOpen = true)}>
					<Truck /> Umlagern
				</Button>
			{/if}
			<Button size="sm" variant="ghost" onclick={() => (selected = [])}>
				<X /> Auswahl aufheben
			</Button>
		</div>
	</MobileActionBar>
</div>

{#snippet itemRow(item: Item, nested: boolean)}
	<Table.Row
		data-state={selected.includes(item.id) ? 'selected' : undefined}
		class={[
			'cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
			nested ? 'text-sm' : ''
		].join(' ')}
		tabindex={0}
		aria-label={`${item.name} anzeigen`}
		onclick={() => openItem(item.id)}
		onkeydown={(e) => {
			if (e.target !== e.currentTarget) return;
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				openItem(item.id);
			}
		}}
	>
		{#if canSelect}
			<Table.Cell onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
				<Checkbox
					aria-label={`${item.name} auswählen`}
					checked={selected.includes(item.id)}
					onCheckedChange={(v) => setSelected([item.id], v === true)}
				/>
			</Table.Cell>
		{/if}
		<Table.Cell class="max-w-80">
			<div class={['flex items-center gap-2', nested ? 'sm:pl-7' : ''].join(' ')}>
				{#if item.thumbUrl}
					<img
						src={item.thumbUrl}
						alt=""
						class={[nested ? 'size-6' : 'size-8', 'shrink-0 rounded-md object-cover'].join(' ')}
						loading="lazy"
					/>
				{:else}
					<CategoryGlyph category={item.category} size={nested ? 'sm' : 'md'} />
				{/if}
				<div class="min-w-0">
					<div class="truncate font-medium">{item.name}</div>
					{#if item.setName}
						<div class="truncate text-xs text-muted-foreground">Set {item.setName}</div>
					{/if}
					{#if item.archived}<Badge variant="outline">Archiviert</Badge>{/if}
				</div>
			</div>
		</Table.Cell>
		<Table.Cell>{item.category?.name ?? '–'}</Table.Cell>
		<Table.Cell class="text-right font-medium tabular-nums">{item.quantity}</Table.Cell>
		<Table.Cell>
			{#if item.locationName}{item.locationName}{:else}<span class="text-muted-foreground"
					>Ohne Lagerort</span
				>{/if}
		</Table.Cell>
		<Table.Cell><ConditionBadge condition={item.condition as Condition} /></Table.Cell>
		<Table.Cell class="font-mono text-xs">{item.code}</Table.Cell>
	</Table.Row>
{/snippet}

<ItemDialog
	bind:open={itemOpen}
	{itemId}
	onedit={editItem}
	onprint={(id) => printLabels('item', [id])}
	onopentype={openType}
	onchanged={reloadAll}
	{onreserve}
/>

<ItemFormDialog
	bind:open={formOpen}
	item={formItem}
	preset={formPreset}
	{categories}
	{locations}
	{sets}
	onsaved={reloadAll}
/>

<TypeDialog
	bind:open={typeOpen}
	{typeId}
	onedit={editType}
	onadditem={(t) => newItem({ typeId: t.id })}
	onopenitem={openItem}
	onprint={(ids) => printLabels('item', ids)}
	onchanged={reloadAll}
	{onreserve}
/>

<TypeFormDialog
	bind:open={typeFormOpen}
	type={typeFormType}
	{categories}
	onsaved={(t) => {
		if (!expanded.includes(t.id)) expanded = [...expanded, t.id];
		reloadAll();
	}}
	onadditems={(t) => newItem({ typeId: t.id })}
/>

<CategoriesDialog bind:open={categoriesOpen} {categories} onchanged={reloadAll} />

<LocationsDialog
	bind:open={locationsOpen}
	{locations}
	canManage={perm.manage}
	canPrint={perm.labels}
	onchanged={reloadAll}
	onprint={(ids) => printLabels('location', ids, 'Etiketten für Lagerorte')}
	onfilter={(id) => {
		locationsOpen = false;
		locationId = id;
	}}
/>

<ExportDialog
	bind:open={exportOpen}
	{categories}
	{locations}
	initial={{
		categoryId,
		locationId,
		condition: condition as Condition | null,
		archived
	}}
/>

<MoveDialog
	bind:open={moveOpen}
	itemIds={selected}
	{locations}
	onmoved={() => {
		selected = [];
		reloadAll();
	}}
/>

<PrintLabelsDialog bind:open={printOpen} target={printTarget} ids={printIds} title={printTitle} />
