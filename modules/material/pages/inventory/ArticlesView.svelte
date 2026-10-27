<script lang="ts">
	// Artikel-Liste: Kategorie, Art, Zähler, Bild. Mengenartikel klappen ihren Bestand je Ort auf
	// (zählen, umlagern), Einzelstück-Artikel führen zur Stückliste.
	import { SvelteMap } from 'svelte/reactivity';
	import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ClipboardList from '@lucide/svelte/icons/clipboard-list';
	import ImageOff from '@lucide/svelte/icons/image-off';
	import List from '@lucide/svelte/icons/list';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import { Label } from '$lib/components/ui/label';
	import * as Table from '$lib/components/ui/table';
	import { DataTable, LoadingState } from '$lib/components/layout';
	import {
		ARTICLE_KIND_LABELS,
		type Article,
		type ArticleKind,
		type Category,
		type Location,
		type StockEntry
	} from '../../schemas';
	import { API, errorText } from '../helpers';
	import StockDialog from './StockDialog.svelte';

	let {
		articles,
		categories,
		locations,
		loading,
		error,
		canManage,
		onretry,
		onchanged,
		onedit,
		oncreate,
		onshowunits,
		oncreateunits
	}: {
		articles: Article[];
		categories: Category[];
		locations: Location[];
		loading: boolean;
		error: string;
		canManage: boolean;
		onretry: () => void | Promise<void>;
		/** Nach Bestandsänderungen (Zähler neu laden) */
		onchanged: () => void | Promise<void>;
		onedit: (article: Article) => void;
		oncreate: () => void;
		onshowunits: (articleId: string) => void;
		oncreateunits: (articleId: string) => void;
	} = $props();

	let search = $state('');
	let categoryId = $state<string | null>(null);
	let kind = $state<string | null>(null);
	let showArchived = $state(false);

	const categoryOptions = $derived(categories.map((c) => ({ value: c.id, label: c.name })));
	const kindOptions = (['unit', 'bulk'] as ArticleKind[]).map((k) => ({
		value: k,
		label: ARTICLE_KIND_LABELS[k]
	}));

	const visible = $derived.by(() => {
		const q = search.trim().toLocaleLowerCase('de');
		return articles.filter(
			(a) =>
				(showArchived || !a.archived) &&
				(!categoryId || a.categoryId === categoryId) &&
				(!kind || a.kind === kind) &&
				(!q ||
					a.name.toLocaleLowerCase('de').includes(q) ||
					(a.categoryName ?? '').toLocaleLowerCase('de').includes(q))
		);
	});
	const filtered = $derived(!!search.trim() || !!categoryId || !!kind);

	function resetFilters() {
		search = '';
		categoryId = null;
		kind = null;
	}

	// --- Bestand je Ort (Mengenartikel) ---
	type StockState = { loading: boolean; error: string; entries: StockEntry[] };
	const stock = new SvelteMap<string, StockState>();

	async function loadStock(articleId: string) {
		const prev = stock.get(articleId);
		stock.set(articleId, { loading: true, error: '', entries: prev?.entries ?? [] });
		try {
			const entries = await apiFetch<StockEntry[]>(`${API}/stock?articleId=${articleId}`);
			stock.set(articleId, { loading: false, error: '', entries });
		} catch (e) {
			stock.set(articleId, {
				loading: false,
				error: errorText(e, 'Bestand konnte nicht geladen werden'),
				entries: prev?.entries ?? []
			});
		}
	}

	function toggle(a: Article) {
		if (stock.has(a.id)) stock.delete(a.id);
		else void loadStock(a.id);
	}

	let stockOpen = $state(false);
	let stockKey = $state(0);
	let stockArticle = $state<Article | null>(null);
	let stockMode = $state<'set' | 'move'>('set');
	let stockEntry = $state<StockEntry | null>(null);

	async function openStock(a: Article, mode: 'set' | 'move', entry: StockEntry | null = null) {
		if (!stock.get(a.id)?.entries.length && !stock.get(a.id)?.loading) await loadStock(a.id);
		stockArticle = a;
		stockMode = mode;
		stockEntry = entry;
		stockKey++;
		stockOpen = true;
	}

	async function stockSaved() {
		if (stockArticle) await loadStock(stockArticle.id);
		await onchanged();
	}

	function rowClick(a: Article) {
		if (a.kind === 'bulk') toggle(a);
		else onshowunits(a.id);
	}
</script>

<DataTable
	caption="Artikel"
	mobile="cards"
	{loading}
	{error}
	{onretry}
	empty={!visible.length}
	emptyTitle={filtered ? 'Keine passenden Artikel' : 'Noch keine Artikel'}
	emptyDescription={filtered
		? 'Passe Suche oder Filter an.'
		: 'Ein Artikel beschreibt eine Art Material – z. B. „Kohtenbahn“ (Einzelstücke) oder „Tasse“ (Menge).'}
>
	{#snippet toolbar()}
		<Input
			type="search"
			class="w-full sm:w-56"
			placeholder="Artikel suchen …"
			aria-label="Artikel suchen"
			bind:value={search}
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
			options={kindOptions}
			bind:value={kind}
			label="Art"
			emptyLabel="Alle Arten"
			placeholder="Alle Arten"
			class="w-full sm:w-40"
		/>
		<div class="flex items-center gap-2">
			<Switch id="articles-archived" bind:checked={showArchived} />
			<Label for="articles-archived" class="font-normal">Archivierte</Label>
		</div>
		{#if canManage}
			<Button class="sm:ml-auto" onclick={oncreate}><Plus /> Artikel</Button>
		{/if}
	{/snippet}
	{#snippet emptyAction()}
		{#if filtered}
			<Button variant="outline" onclick={resetFilters}><X /> Filter zurücksetzen</Button>
		{:else if canManage}
			<Button onclick={oncreate}><Plus /> Artikel anlegen</Button>
		{/if}
	{/snippet}
	{#snippet head()}
		<Table.Row>
			<Table.Head class="w-14"><span class="sr-only">Bild</span></Table.Head>
			<Table.Head>Artikel</Table.Head>
			<Table.Head>Kategorie</Table.Head>
			<Table.Head>Art</Table.Head>
			<Table.Head class="text-right">Bestand</Table.Head>
			<Table.Head class="text-right">Ausgegeben</Table.Head>
			<Table.Head class="w-0"><span class="sr-only">Aktionen</span></Table.Head>
		</Table.Row>
	{/snippet}
	{#each visible as a (a.id)}
		{@const s = stock.get(a.id)}
		{@const low = a.kind === 'bulk' && a.minQuantity > 0 && a.stockTotal < a.minQuantity}
		<Table.Row class="cursor-pointer" onclick={() => rowClick(a)}>
			<Table.Cell>
				{#if a.images[0]}
					<img
						src={a.images[0].thumbUrl}
						alt=""
						loading="lazy"
						class="size-10 rounded-md border object-cover"
					/>
				{:else}
					<span
						class="flex size-10 items-center justify-center rounded-md border bg-muted text-muted-foreground"
						aria-hidden="true"
					>
						<ImageOff class="size-4" />
					</span>
				{/if}
			</Table.Cell>
			<Table.Cell>
				<span class="flex items-center gap-1.5">
					{#if a.kind === 'bulk'}
						{#if s}
							<ChevronDown class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						{:else}
							<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						{/if}
					{/if}
					<span class="font-medium">{a.name}</span>
					{#if a.archived}<Badge variant="outline">Archiviert</Badge>{/if}
				</span>
				{#if a.description}
					<span class="block max-w-xs truncate text-xs text-muted-foreground">
						{a.description}
					</span>
				{/if}
			</Table.Cell>
			<Table.Cell>
				{#if a.categoryName}
					<span class="inline-flex items-center gap-1.5">
						<span
							class="size-2.5 rounded-full border"
							style:background-color={a.categoryColor ?? undefined}
							aria-hidden="true"
						></span>
						{a.categoryName}
					</span>
				{:else}
					<span class="text-muted-foreground">–</span>
				{/if}
			</Table.Cell>
			<Table.Cell>{ARTICLE_KIND_LABELS[a.kind]}</Table.Cell>
			<Table.Cell class="text-right tabular-nums">
				{#if a.kind === 'unit'}
					{a.usableCount}{#if a.usableCount !== a.unitCount}<span class="text-muted-foreground"
							>&nbsp;/ {a.unitCount}</span
						>{/if}
					{a.unitLabel}
					{#if a.usableCount !== a.unitCount}
						<span class="block text-xs text-muted-foreground">nutzbar / gesamt</span>
					{/if}
				{:else}
					{a.stockTotal}
					{a.unitLabel}
					{#if low}
						<Badge variant="warning" class="ml-1">unter {a.minQuantity}</Badge>
					{/if}
				{/if}
			</Table.Cell>
			<Table.Cell class="text-right tabular-nums">{a.issuedCount || '–'}</Table.Cell>
			<Table.Cell>
				<div class="flex justify-end gap-1">
					{#if a.kind === 'unit'}
						<Button
							variant="ghost"
							size="icon"
							aria-label={`Stücke von ${a.name} zeigen`}
							onclick={(e) => {
								e.stopPropagation();
								onshowunits(a.id);
							}}
						>
							<List />
						</Button>
						{#if canManage && !a.archived}
							<Button
								variant="ghost"
								size="icon"
								aria-label={`Stücke von ${a.name} erfassen`}
								onclick={(e) => {
									e.stopPropagation();
									oncreateunits(a.id);
								}}
							>
								<Plus />
							</Button>
						{/if}
					{:else if canManage && !a.archived}
						<Button
							variant="ghost"
							size="icon"
							aria-label={`Bestand von ${a.name} zählen`}
							onclick={(e) => {
								e.stopPropagation();
								void openStock(a, 'set');
							}}
						>
							<ClipboardList />
						</Button>
					{/if}
					{#if canManage}
						<Button
							variant="ghost"
							size="icon"
							aria-label={`${a.name} bearbeiten`}
							onclick={(e) => {
								e.stopPropagation();
								onedit(a);
							}}
						>
							<Pencil />
						</Button>
					{/if}
				</div>
			</Table.Cell>
		</Table.Row>
		{#if a.kind === 'bulk' && s}
			<Table.Row class="bg-muted/30 hover:bg-muted/30">
				<Table.Cell colspan={7} data-label-manual>
					<div class="space-y-2 py-1 sm:pl-14">
						{#if s.loading && !s.entries.length}
							<LoadingState label="Bestand" rows={2} rowClass="h-6 w-full" />
						{:else if s.error}
							<p class="text-sm text-destructive" role="alert">
								{s.error}
								<Button size="sm" variant="link" onclick={() => loadStock(a.id)}>
									Erneut versuchen
								</Button>
							</p>
						{:else if !s.entries.length}
							<p class="text-sm text-muted-foreground">Noch kein Bestand erfasst.</p>
						{:else}
							<ul class="divide-y rounded-md border bg-card" aria-label={`Bestand von ${a.name}`}>
								{#each s.entries as e (e.id)}
									<li class="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
										<span class="min-w-0 flex-1 truncate">{e.holderName}</span>
										<span class="tabular-nums">{e.quantity} {a.unitLabel}</span>
										{#if canManage}
											<Button
												size="icon-sm"
												variant="ghost"
												aria-label={`${e.holderName}: zählen`}
												onclick={() => openStock(a, 'set', e)}
											>
												<ClipboardList />
											</Button>
											<Button
												size="icon-sm"
												variant="ghost"
												aria-label={`${e.holderName}: umlagern`}
												onclick={() => openStock(a, 'move', e)}
											>
												<ArrowRightLeft />
											</Button>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
						{#if canManage && !a.archived}
							<div class="flex flex-wrap gap-2">
								<Button size="sm" variant="outline" onclick={() => openStock(a, 'set')}>
									<ClipboardList /> Bestand zählen
								</Button>
								{#if s.entries.length}
									<Button size="sm" variant="outline" onclick={() => openStock(a, 'move')}>
										<ArrowRightLeft /> Umlagern
									</Button>
								{/if}
							</div>
						{/if}
					</div>
				</Table.Cell>
			</Table.Row>
		{/if}
	{/each}
</DataTable>

{#if stockArticle}
	{#key stockKey}
		<StockDialog
			bind:open={stockOpen}
			article={articles.find((x) => x.id === stockArticle?.id) ?? stockArticle}
			entries={stock.get(stockArticle.id)?.entries ?? []}
			{locations}
			mode={stockMode}
			entry={stockEntry}
			onsaved={stockSaved}
		/>
	{/key}
{/if}
