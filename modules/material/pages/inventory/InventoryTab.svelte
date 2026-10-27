<script lang="ts">
	// Reiter „Bestand“: Ansichten Stücke | Artikel | Lagerorte, Detailblatt eines Stücks,
	// Dialoge für Artikel, Kategorien und das Erfassen von Stücken.
	// URL: `?open=<stück>` öffnet das Blatt, `?article=<id>` filtert die Stückliste.
	import { onMount, tick } from 'svelte';
	import Tags from '@lucide/svelte/icons/tags';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { ErrorState, LoadingState } from '$lib/components/layout';
	import {
		PERMISSIONS,
		type Article,
		type Category,
		type Location,
		type UnitSummary
	} from '../../schemas';
	import { API, errorText } from '../helpers';
	import ArticleDialog from './ArticleDialog.svelte';
	import ArticlesView from './ArticlesView.svelte';
	import CategoriesDialog from './CategoriesDialog.svelte';
	import LocationsView from './LocationsView.svelte';
	import ModeSwitch from './ModeSwitch.svelte';
	import UnitDialog from './UnitDialog.svelte';
	import UnitSheet from './UnitSheet.svelte';
	import UnitsView from './UnitsView.svelte';

	type View = 'units' | 'articles' | 'locations';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canManage = $derived(can(permissions, PERMISSIONS.manage));
	const canLabels = $derived(canManage || can(permissions, PERMISSIONS.labels));
	const canReport = $derived(canManage || can(permissions, PERMISSIONS.reserve));

	const views: { value: View; label: string }[] = [
		{ value: 'units', label: 'Stücke' },
		{ value: 'articles', label: 'Artikel' },
		{ value: 'locations', label: 'Lagerorte' }
	];

	let view = $state<View>('units');
	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const uuidOrNull = (v: string | null) => (v && UUID.test(v) ? v : null);

	let articleFilter = $state<string | null>(uuidOrNull(page.url.searchParams.get('article')));
	let locationFilter = $state<string | null>(null);
	let unitsReload = $state(0);

	// Stammdaten (für Filter, Auswahlfelder und Dialoge)
	let locations = $state<Location[]>([]);
	let categories = $state<Category[]>([]);
	let articles = $state<Article[]>([]);
	let baseLoading = $state(true);
	let baseError = $state('');
	let articlesLoading = $state(false);
	let articlesError = $state('');

	async function loadLocations() {
		locations = await apiFetch<Location[]>(`${API}/locations`);
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

	async function loadBase() {
		baseLoading = true;
		baseError = '';
		try {
			await Promise.all([loadLocations(), loadCategories(), loadArticles()]);
		} catch (e) {
			baseError = errorText(e, 'Bestand konnte nicht geladen werden');
		} finally {
			baseLoading = false;
		}
	}

	/** Zähler (Orte, Artikel) nach Änderungen auffrischen – Fehler hier nur still */
	async function refreshCounts() {
		await Promise.allSettled([loadLocations(), loadArticles()]);
	}

	onMount(() => {
		void loadBase();
		const url = new URL(page.url);
		const open = uuidOrNull(url.searchParams.get('open'));
		if (open) openUnit(open);
		if (url.searchParams.has('open') || url.searchParams.has('article')) {
			url.searchParams.delete('open');
			url.searchParams.delete('article');
			void tick().then(() => {
				try {
					replaceState(url, {});
				} catch {
					// Router beim ersten Rendern noch nicht bereit – Parameter bleiben dann stehen
				}
			});
		}
	});

	// --- Detailblatt ---
	let sheetOpen = $state(false);
	let sheetUnit = $state<string | null>(null);
	function openUnit(id: string) {
		sheetUnit = id;
		sheetOpen = true;
	}
	async function unitChanged() {
		unitsReload++;
		await refreshCounts();
	}

	// --- Artikel ---
	let articleOpen = $state(false);
	let articleKey = $state(0);
	let editingArticle = $state<Article | null>(null);
	function editArticle(a: Article | null) {
		editingArticle = a;
		articleKey++;
		articleOpen = true;
	}
	function articleSaved(a: Article) {
		const i = articles.findIndex((x) => x.id === a.id);
		if (i >= 0) articles[i] = a;
		else articles = [...articles, a].sort((x, y) => x.name.localeCompare(y.name, 'de'));
		void loadCategories().catch(() => undefined);
	}
	function articleDeleted(id: string) {
		articles = articles.filter((a) => a.id !== id);
		if (articleFilter === id) articleFilter = null;
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
		unitArticle = articleId ?? articleFilter;
		unitKey++;
		unitOpen = true;
	}
	async function unitsCreated(created: UnitSummary[]) {
		unitsReload++;
		await refreshCounts();
		if (created.length === 1) openUnit(created[0]!.id);
	}

	function showUnitsOfArticle(id: string) {
		articleFilter = id;
		locationFilter = null;
		view = 'units';
	}
	function showUnitsAt(id: string) {
		locationFilter = id;
		view = 'units';
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<ModeSwitch value={view} options={views} label="Ansicht" onchange={(v) => (view = v)} />
		{#if canManage}
			<Button variant="outline" onclick={() => (categoriesOpen = true)}>
				<Tags /> Kategorien
			</Button>
		{/if}
	</div>

	{#if baseLoading && !locations.length && !articles.length}
		<LoadingState label="Bestand" rows={6} rowClass="h-10 w-full" />
	{:else if baseError}
		<ErrorState message={baseError} onretry={loadBase} busy={baseLoading} />
	{:else if view === 'units'}
		<UnitsView
			bind:articleId={articleFilter}
			bind:locationId={locationFilter}
			{articles}
			{categories}
			{locations}
			{canManage}
			{canLabels}
			reloadToken={unitsReload}
			onopen={openUnit}
			oncreate={() => createUnits()}
			onchanged={refreshCounts}
		/>
	{:else if view === 'articles'}
		<ArticlesView
			{articles}
			{categories}
			{locations}
			loading={articlesLoading}
			error={articlesError}
			{canManage}
			onretry={loadArticles}
			onchanged={loadArticles}
			onedit={editArticle}
			oncreate={() => editArticle(null)}
			onshowunits={showUnitsOfArticle}
			oncreateunits={createUnits}
		/>
	{:else}
		<LocationsView
			{locations}
			{canManage}
			{canLabels}
			onchanged={async () => {
				await loadLocations().catch(() => undefined);
				unitsReload++;
			}}
			onshow={showUnitsAt}
		/>
	{/if}
</div>

<UnitSheet
	bind:open={sheetOpen}
	unitId={sheetUnit}
	{articles}
	{locations}
	{canManage}
	{canReport}
	{canLabels}
	onchanged={unitChanged}
	onopenunit={openUnit}
/>

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
			placement={locationFilter
				? { locationId: locationFilter, containerId: null, containerName: '' }
				: null}
			{articles}
			{locations}
			onsaved={unitsCreated}
		/>
	{/key}
{/if}
