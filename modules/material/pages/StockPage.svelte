<script lang="ts">
	// Lager: „Wo ist …?“-Suche, Ansichten Orte (Baum + Inhalt) · Artikel · Zelte & Sets (`?view=`).
	// Deep-Links: `?open=<stück>` öffnet das Stück, `?view=articles&open=<artikel>` den Artikel,
	// `?view=sets&open=<set>` das Set. Lesen für alle mit `inventory.view`, Pflege mit `inventory.manage`.
	import { onMount, tick, untrack } from 'svelte';
	import FileDown from '@lucide/svelte/icons/file-down';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Plus from '@lucide/svelte/icons/plus';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import {
		BottomSheet,
		ErrorState,
		LoadingState,
		PageHeader,
		deviceLayout,
		listenForScanner
	} from '$lib/components/layout';
	import {
		PERMISSIONS,
		type Article,
		type Category,
		type FindHit,
		type Location,
		type Overview,
		type UnitSummary
	} from '../schemas';
	import { API, UNPLACED, errorText } from './helpers';
	import MaterialNav from './MaterialNav.svelte';
	import ArticleDialog from './inventory/ArticleDialog.svelte';
	import ArticlesView from './inventory/ArticlesView.svelte';
	import CategoriesDialog from './inventory/CategoriesDialog.svelte';
	import ModeSwitch from './inventory/ModeSwitch.svelte';
	import UnitDialog from './inventory/UnitDialog.svelte';
	import UnitSheet from './inventory/UnitSheet.svelte';
	import SetsView from './sets/SetsView.svelte';
	import ArticleSheet from './stock/ArticleSheet.svelte';
	import FindSearch from './stock/FindSearch.svelte';
	import InventoryPdfDialog from './stock/InventoryPdfDialog.svelte';
	import LocationTree from './stock/LocationTree.svelte';
	import PlaceContents from './stock/PlaceContents.svelte';

	type View = 'places' | 'articles' | 'sets';
	const VIEWS: { value: View; label: string }[] = [
		{ value: 'places', label: 'Orte' },
		{ value: 'articles', label: 'Artikel' },
		{ value: 'sets', label: 'Zelte & Sets' }
	];
	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const uuidOrNull = (v: string | null) => (v && UUID.test(v) ? v : null);
	const parseView = (v: string | null): View => (v === 'articles' || v === 'sets' ? v : 'places');

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canManage = $derived(can(permissions, PERMISSIONS.manage));
	const canLabels = $derived(canManage || can(permissions, PERMISSIONS.labels));
	const canReport = $derived(canManage || can(permissions, PERMISSIONS.reserve));
	const device = $derived(deviceLayout());

	let view = $state<View>(parseView(page.url.searchParams.get('view')));
	let query = $state('');
	let locationId = $state<string | null>(null);
	let placesReload = $state(0);

	// --- Stammdaten ---
	let locations = $state<Location[]>([]);
	let categories = $state<Category[]>([]);
	let articles = $state<Article[]>([]);
	let overview = $state<Overview | null>(null);
	let baseLoading = $state(true);
	let baseError = $state('');
	let articlesLoading = $state(false);
	let articlesError = $state('');

	async function loadLocations() {
		locations = await apiFetch<Location[]>(`${API}/locations`);
		if (locationId && locationId !== UNPLACED && !locations.some((l) => l.id === locationId))
			locationId = null;
	}
	async function loadCategories() {
		categories = await apiFetch<Category[]>(`${API}/categories`);
	}
	async function loadArticles() {
		articlesLoading = true;
		articlesError = '';
		try {
			articles = await apiFetch<Article[]>(`${API}/articles?archived=1`);
		} catch (e) {
			articlesError = errorText(e, 'Artikel konnten nicht geladen werden');
		} finally {
			articlesLoading = false;
		}
	}
	async function loadOverview() {
		try {
			overview = await apiFetch<Overview>(`${API}/overview`);
		} catch {
			overview = null; // Befund-Satz ist nur Zusatz
		}
	}
	async function loadBase() {
		baseLoading = true;
		baseError = '';
		try {
			await Promise.all([loadLocations(), loadCategories(), loadArticles(), loadOverview()]);
		} catch (e) {
			baseError = errorText(e, 'Lager konnte nicht geladen werden');
		} finally {
			baseLoading = false;
		}
	}
	/** Nach Änderungen: Orte (Zähler), Artikel, Befund und Ortsinhalt auffrischen */
	async function refresh() {
		placesReload++;
		await Promise.allSettled([loadLocations(), loadArticles(), loadOverview()]);
	}

	const n = (v: number) => v.toLocaleString('de-DE');
	const finding = $derived.by(() => {
		if (!overview) return 'Was wo liegt – Orte, Kisten, Mengen und Zelte.';
		const o = overview;
		const parts = [
			`${o.units === 1 ? '1 Stück' : `${n(o.units)} Stücke`} an ${o.locations === 1 ? '1 Ort' : `${n(o.locations)} Orten`}`
		];
		if (o.issuedUnits) parts.push(`${n(o.issuedUnits)} unterwegs`);
		if (o.damagedUnits) parts.push(`${n(o.damagedUnits)} beschädigt`);
		if (o.lowStock.length)
			parts.push(
				o.lowStock.length === 1
					? '1 Artikel unter Mindestbestand'
					: `${o.lowStock.length} Artikel unter Mindestbestand`
			);
		return parts.join(' · ');
	});

	// --- URL: Ansicht und Deep-Links ---
	let setOpenId = $state<string | null>(null);

	function writeUrl(mutate: (url: URL) => void) {
		const url = new URL(page.url);
		mutate(url);
		if (url.search === page.url.search) return;
		void tick().then(() => {
			try {
				replaceState(url, {});
			} catch {
				// Router beim ersten Rendern noch nicht bereit – Parameter bleiben dann stehen
			}
		});
	}

	$effect(() => {
		const sp = page.url.searchParams;
		const v = parseView(sp.get('view'));
		const open = uuidOrNull(sp.get('open'));
		const hasOpen = sp.has('open');
		untrack(() => {
			if (v !== view) view = v;
			if (open) {
				query = '';
				if (v === 'sets') setOpenId = open;
				else if (v === 'articles') openArticle(open);
				else openUnit(open);
			}
			if (hasOpen) writeUrl((url) => url.searchParams.delete('open'));
		});
	});

	function setView(v: View) {
		view = v;
		writeUrl((url) => {
			url.searchParams.delete('open');
			if (v === 'places') url.searchParams.delete('view');
			else url.searchParams.set('view', v);
		});
	}

	onMount(() => {
		void loadBase();
		// USB-Scanner außerhalb von Eingabefeldern → in die Suche (nicht bei offenen Dialogen)
		return listenForScanner((code) => {
			if (document.querySelector('[role="dialog"]')) return;
			query = code;
		});
	});

	// --- Stück-Blatt ---
	let sheetOpen = $state(false);
	let sheetUnit = $state<string | null>(null);
	function openUnit(id: string) {
		articleSheetOpen = false;
		sheetUnit = id;
		sheetOpen = true;
	}

	// --- Artikel-Blatt ---
	let articleSheetOpen = $state(false);
	let articleSheetId = $state<string | null>(null);
	let articleSheetReload = $state(0);
	function openArticle(id: string) {
		sheetOpen = false;
		articleSheetId = id;
		articleSheetOpen = true;
	}

	// --- Treffer der Suche öffnen ---
	function openHit(h: FindHit) {
		if (h.type === 'unit' || h.type === 'container') openUnit(h.id);
		else if (h.type === 'article') openArticle(h.id);
		else if (h.type === 'set') {
			query = '';
			setView('sets');
			setOpenId = h.id;
		} else {
			query = '';
			setView('places');
			locationId = h.id;
		}
	}

	// --- Artikel anlegen/bearbeiten ---
	let articleOpen = $state(false);
	let articleKey = $state(0);
	let editingArticle = $state<Article | null>(null);
	function editArticle(a: Article | null) {
		articleSheetOpen = false;
		editingArticle = a;
		articleKey++;
		articleOpen = true;
	}
	function articleSaved(a: Article) {
		const i = articles.findIndex((x) => x.id === a.id);
		if (i >= 0) articles[i] = a;
		else articles = [...articles, a].sort((x, y) => x.name.localeCompare(y.name, 'de'));
		articleSheetReload++;
		void loadCategories().catch(() => undefined);
	}
	function articleDeleted(id: string) {
		articles = articles.filter((a) => a.id !== id);
	}

	let categoriesOpen = $state(false);
	async function categoriesChanged() {
		await Promise.allSettled([loadCategories(), loadArticles()]);
	}

	// --- Stücke erfassen ---
	let unitOpen = $state(false);
	let unitKey = $state(0);
	let unitArticle = $state<string | null>(null);
	function createUnits(articleId: string | null = null) {
		articleSheetOpen = false;
		unitArticle = articleId;
		unitKey++;
		unitOpen = true;
	}
	async function unitsCreated(created: UnitSummary[]) {
		await refresh();
		articleSheetReload++;
		if (created.length === 1) openUnit(created[0]!.id);
	}

	// --- Bestandsliste ---
	let pdfOpen = $state(false);
	let pdfKey = $state(0);
	function openPdf() {
		pdfKey++;
		pdfOpen = true;
	}

	// --- Ort wählen (Handy) ---
	let placeSheetOpen = $state(false);
	const selectedLocation = $derived(locations.find((l) => l.id === locationId) ?? null);
	function selectLocation(id: string | null) {
		locationId = id;
		placeSheetOpen = false;
	}
</script>

<PageHeader title="Lager" description={finding}>
	{#snippet actions()}
		<Button variant="outline" onclick={openPdf} disabled={baseLoading && !locations.length}>
			<FileDown /> Bestandsliste (PDF)
		</Button>
		{#if canManage}
			<Button onclick={() => createUnits()}><Plus /> Stück erfassen</Button>
		{/if}
	{/snippet}
</PageHeader>
<MaterialNav />

<div class="space-y-6 pb-24 sm:pb-0">
	<FindSearch bind:query autofocus={device === 'desktop'} onopen={openHit} />

	{#if !query.trim()}
		{#if baseLoading && !locations.length && !articles.length}
			<LoadingState label="Lager" rows={6} rowClass="h-12 w-full" />
		{:else if baseError}
			<ErrorState message={baseError} onretry={loadBase} busy={baseLoading} />
		{:else}
			<div class="space-y-4">
				<ModeSwitch value={view} options={VIEWS} label="Ansicht" onchange={setView} />

				{#if view === 'places'}
					{#if device === 'phone'}
						<Button
							variant="outline"
							class="w-full justify-start"
							onclick={() => (placeSheetOpen = true)}
							aria-haspopup="dialog"
						>
							<MapPin />
							<span class="min-w-0 truncate">
								{selectedLocation ? selectedLocation.path : 'Ort wählen'}
							</span>
						</Button>
						<PlaceContents
							{locationId}
							{locations}
							{canManage}
							{canLabels}
							reloadToken={placesReload}
							onselect={(id) => (locationId = id)}
							onopenunit={openUnit}
							onopenarticle={openArticle}
							onchanged={refresh}
						/>
					{:else}
						<div class="grid gap-6 md:grid-cols-[16.25rem_minmax(0,1fr)]">
							<aside class="md:border-r md:pr-4" aria-label="Orte">
								<LocationTree
									unplaced={overview?.unplacedUnits ?? 0}
									{locations}
									selected={locationId}
									onselect={(id) => (locationId = id)}
								/>
							</aside>
							<PlaceContents
								{locationId}
								{locations}
								{canManage}
								{canLabels}
								reloadToken={placesReload}
								onselect={(id) => (locationId = id)}
								onopenunit={openUnit}
								onopenarticle={openArticle}
								onchanged={refresh}
							/>
						</div>
					{/if}
				{:else if view === 'articles'}
					<ArticlesView
						{articles}
						{categories}
						loading={articlesLoading}
						error={articlesError}
						{canManage}
						{canLabels}
						onretry={loadArticles}
						onopen={(a) => openArticle(a.id)}
						onedit={editArticle}
						oncreate={() => editArticle(null)}
						oncategories={() => (categoriesOpen = true)}
						oncreateunits={createUnits}
					/>
				{:else}
					<SetsView {canManage} canPrint={canLabels} bind:openId={setOpenId} />
				{/if}
			</div>
		{/if}
	{/if}
</div>

{#if device === 'phone'}
	<BottomSheet bind:open={placeSheetOpen} title="Ort wählen" size="tall">
		<LocationTree
			{locations}
			selected={locationId}
			onselect={selectLocation}
			unplaced={overview?.unplacedUnits ?? 0}
		/>
	</BottomSheet>
{/if}

<UnitSheet
	bind:open={sheetOpen}
	unitId={sheetUnit}
	{articles}
	{locations}
	{canManage}
	{canReport}
	{canLabels}
	onchanged={refresh}
	onopenunit={openUnit}
/>

<ArticleSheet
	bind:open={articleSheetOpen}
	articleId={articleSheetId}
	{locations}
	{canManage}
	{canLabels}
	reloadToken={articleSheetReload}
	onedit={editArticle}
	oncreateunits={createUnits}
	onopenunit={openUnit}
	onchanged={refresh}
/>

{#key pdfKey}
	<InventoryPdfDialog
		bind:open={pdfOpen}
		locationId={locationId === UNPLACED ? null : locationId}
		{locations}
		{categories}
	/>
{/key}

{#if canManage}
	{#key articleKey}
		<ArticleDialog
			bind:open={articleOpen}
			article={editingArticle}
			{categories}
			onsaved={articleSaved}
			ondeleted={articleDeleted}
		/>
	{/key}
	<CategoriesDialog bind:open={categoriesOpen} {categories} onchanged={categoriesChanged} />
	{#key unitKey}
		<UnitDialog
			bind:open={unitOpen}
			articleId={unitArticle}
			placement={locationId && locationId !== UNPLACED && view === 'places'
				? { locationId, containerId: null, containerName: '' }
				: null}
			{articles}
			{locations}
			onsaved={unitsCreated}
		/>
	{/key}
{/if}
