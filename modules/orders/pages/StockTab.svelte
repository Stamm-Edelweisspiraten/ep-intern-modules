<script lang="ts">
	// Lager: Bestand je Artikel (Größen zusammengefasst, aufklappbar), Fehlmengen, Nachbestellen,
	// Korrektur, Lagerbewegungen; seitenweise.
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { page } from '$app/state';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import History from '@lucide/svelte/icons/history';
	import Pencil from '@lucide/svelte/icons/pencil';
	import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
	import X from '@lucide/svelte/icons/x';
	import { toast } from 'svelte-sonner';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Table from '$lib/components/ui/table';
	import { DataTable } from '$lib/components/layout';
	import {
		MOVEMENT_KIND_LABELS,
		PERMISSIONS,
		type StockMovement,
		type StockRow,
		type SupplierOrder,
		type SupplierSuggestion
	} from '../schemas';
	import {
		API,
		errorMessage,
		fmtDateTime,
		fmtDelta,
		itemName,
		safeUrl,
		urlHost
	} from './admin-helpers';
	import StockCorrectionDialog from './StockCorrectionDialog.svelte';
	import { groupStockRows, paginate } from './stock-groups';
	import SupplierOrderDialog from './SupplierOrderDialog.svelte';

	let {
		onsupplierorder
	}: {
		/** Optional: nach Anlegen einer Lieferantenbestellung (z. B. zum Tab „Einkauf“ wechseln) */
		onsupplierorder?: (order: SupplierOrder) => void;
	} = $props();

	const permissions = $derived((page.data.permissions as string[] | undefined) ?? []);
	const canStock = $derived(can(permissions, PERMISSIONS.stock));

	let rows = $state<StockRow[] | null>(null);
	let loading = $state(true);
	let error = $state('');
	let onlyDeficit = $state(false);
	let search = $state('');

	let correctionRow = $state<StockRow | null>(null);
	let correctionOpen = $state(false);
	let suggestion = $state<SupplierSuggestion | null>(null);
	let supplierOpen = $state(false);
	let suggestionBusy = $state(false);

	onMount(() => {
		void load();
	});

	async function load() {
		loading = !rows;
		error = '';
		try {
			rows = await apiFetch<StockRow[]>(`${API}/stock`);
		} catch (e) {
			error = errorMessage(e, 'Lager konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	const PAGE_SIZE = 20;
	let pageNo = $state(1);
	const expanded = new SvelteSet<string>();

	const deficitCount = $derived((rows ?? []).filter((r) => r.deficit > 0).length);
	const groups = $derived(groupStockRows(rows ?? [], { search, onlyDeficit }));
	const paged = $derived(paginate(groups, pageNo, PAGE_SIZE));
	/** Bei Suche oder Fehlmengen-Filter die passenden Größen gleich zeigen */
	const autoExpand = $derived(onlyDeficit || !!search.trim());

	function setFilter(deficit: boolean) {
		onlyDeficit = deficit;
		pageNo = 1;
	}

	function toggle(articleId: string) {
		if (expanded.has(articleId)) expanded.delete(articleId);
		else expanded.add(articleId);
	}

	async function startSuggestion() {
		suggestionBusy = true;
		try {
			const s = await apiFetch<SupplierSuggestion>(`${API}/supplier-orders/suggestion`);
			if (!s.items.length) {
				toast.info('Keine Fehlmengen – nichts nachzubestellen');
				return;
			}
			suggestion = s;
			supplierOpen = true;
		} catch (e) {
			toast.error(errorMessage(e, 'Bestellvorschlag konnte nicht geladen werden'));
		} finally {
			suggestionBusy = false;
		}
	}

	function startCorrection(r: StockRow) {
		correctionRow = r;
		correctionOpen = true;
	}

	async function supplierSaved(order: SupplierOrder) {
		await load();
		onsupplierorder?.(order);
	}

	// --- Lagerbewegungen ---------------------------------------------------------
	const MOVE_LIMIT = 50;
	let movesOpen = $state(false);
	let movesVariant = $state<StockRow | null>(null);
	let movesOffset = $state(0);
	let moves = $state<{ items: StockMovement[]; total: number } | null>(null);
	let movesLoading = $state(false);
	let movesError = $state('');

	function showMoves(r: StockRow | null) {
		movesVariant = r;
		movesOffset = 0;
		moves = null;
		movesOpen = true;
		void loadMoves();
	}

	async function loadMoves() {
		movesLoading = true;
		movesError = '';
		try {
			const p = new URLSearchParams({ limit: String(MOVE_LIMIT), offset: String(movesOffset) });
			if (movesVariant) p.set('variantId', movesVariant.variantId);
			moves = await apiFetch<{ items: StockMovement[]; total: number }>(
				`${API}/stock/movements?${p}`
			);
		} catch (e) {
			movesError = errorMessage(e, 'Lagerbewegungen konnten nicht geladen werden');
		} finally {
			movesLoading = false;
		}
	}

	function pageMoves(delta: number) {
		movesOffset = Math.max(0, movesOffset + delta);
		void loadMoves();
	}
</script>

<div class="space-y-4">
	<DataTable
		mobile="cards"
		caption="Lagerbestand je Artikel und Größe"
		{loading}
		{error}
		empty={!!rows && !groups.length}
		emptyTitle={rows?.length ? 'Keine Treffer' : 'Noch keine Artikel'}
		emptyDescription={onlyDeficit && !search
			? 'Es gibt keine Fehlmengen – alles ist ausreichend auf Lager oder bestellt.'
			: rows?.length
				? 'Kein Artikel passt zum Filter.'
				: 'Lege zuerst Artikel an, dann erscheint hier ihr Bestand.'}
	>
		{#snippet toolbar()}
			<div class="flex flex-wrap gap-1" role="group" aria-label="Lager filtern">
				<Button
					size="sm"
					variant={onlyDeficit ? 'outline' : 'default'}
					aria-pressed={!onlyDeficit}
					onclick={() => setFilter(false)}
				>
					Alle
				</Button>
				<Button
					size="sm"
					variant={onlyDeficit ? 'default' : 'outline'}
					aria-pressed={onlyDeficit}
					onclick={() => setFilter(true)}
				>
					Nur Fehlmengen
					{#if deficitCount > 0}<span class="tabular-nums opacity-70">{deficitCount}</span>{/if}
				</Button>
			</div>
			<Input
				class="h-8 min-w-40 flex-1 sm:max-w-60"
				placeholder="Artikel suchen …"
				aria-label="Lager durchsuchen"
				bind:value={search}
				oninput={() => (pageNo = 1)}
			/>
			<div class="ml-auto flex flex-wrap gap-2">
				<Button size="sm" variant="outline" onclick={() => showMoves(null)}>
					<History /> Lagerbewegungen
				</Button>
				{#if canStock}
					<Button
						size="sm"
						disabled={suggestionBusy || deficitCount === 0}
						title={deficitCount === 0 ? 'Keine Fehlmengen' : undefined}
						onclick={startSuggestion}
					>
						<ShoppingCart />
						{suggestionBusy ? 'Lädt …' : 'Bestellvorschlag übernehmen'}
					</Button>
				{/if}
			</div>
		{/snippet}
		{#snippet head()}
			<Table.Row>
				<Table.Head>Artikel</Table.Head>
				<Table.Head class="text-right">Bestand</Table.Head>
				<Table.Head class="text-right">Mindestbestand</Table.Head>
				<Table.Head class="text-right">Offen bestellt</Table.Head>
				<Table.Head class="text-right">Unterwegs</Table.Head>
				<Table.Head class="text-right">Fehlmenge</Table.Head>
				<Table.Head>Nachbestellen</Table.Head>
				<Table.Head><span class="sr-only">Aktionen</span></Table.Head>
			</Table.Row>
		{/snippet}
		{#each paged.items as g (g.articleId)}
			{#if !g.hasSizes}
				{@const r = g.variants[0]!}
				{@render variantRow(r, false)}
			{:else}
				{@const open = autoExpand || expanded.has(g.articleId)}
				{@const url = safeUrl(g.reorderUrl)}
				<Table.Row
					class={['cursor-pointer', g.deficit > 0 ? 'bg-destructive/5' : ''].join(' ')}
					onclick={() => toggle(g.articleId)}
				>
					<Table.Cell class="max-w-80">
						<div class="flex items-start gap-1.5">
							<Button
								size="icon"
								variant="ghost"
								class="-my-1 -ml-2 size-7 shrink-0"
								aria-expanded={open}
								aria-label={`${open ? 'Größen ausblenden' : 'Größen zeigen'}: ${g.articleTitle}`}
								disabled={autoExpand}
								onclick={(e) => {
									e.stopPropagation();
									toggle(g.articleId);
								}}
							>
								<ChevronDown
									class={['size-4 transition-transform', open ? '' : '-rotate-90'].join(' ')}
								/>
							</Button>
							<div class="min-w-0">
								<div class="truncate font-medium">{g.articleTitle}</div>
								<div class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
									<span>{g.variantCount} {g.variantCount === 1 ? 'Größe' : 'Größen'}</span>
									{#if g.lowCount > 0}
										<span class="text-warning">
											· {g.lowCount} unter Mindestbestand
										</span>
									{/if}
									{#if !g.articleActive}<Badge variant="outline">nicht im Katalog</Badge>{/if}
								</div>
								{#if !open}
									<div class="mt-1 flex flex-wrap gap-1" aria-hidden="true">
										{#each g.variants as v (v.variantId)}
											<span
												class={[
													'rounded border px-1.5 py-0.5 text-xs tabular-nums',
													v.deficit > 0
														? 'border-destructive/40 text-destructive'
														: v.stock < v.minStock
															? 'border-warning-border text-warning'
															: 'text-muted-foreground'
												].join(' ')}
											>
												{v.variantLabel || '–'}: {v.stock}
											</span>
										{/each}
									</div>
								{/if}
							</div>
						</div>
					</Table.Cell>
					<Table.Cell class="text-right font-medium tabular-nums">{g.stock}</Table.Cell>
					<Table.Cell class="text-right tabular-nums text-muted-foreground">{g.minStock}</Table.Cell
					>
					<Table.Cell class="text-right tabular-nums">{g.demand}</Table.Cell>
					<Table.Cell class="text-right tabular-nums">{g.inTransit}</Table.Cell>
					<Table.Cell class="text-right">{@render deficitBadge(g.deficit)}</Table.Cell>
					<Table.Cell>{@render reorderLink(url)}</Table.Cell>
					<Table.Cell class="text-right whitespace-nowrap">
						<span class="text-xs text-muted-foreground">Summe</span>
					</Table.Cell>
				</Table.Row>
				{#if open}
					{#each g.variants as r (r.variantId)}
						{@render variantRow(r, true)}
					{/each}
				{/if}
			{/if}
		{/each}
		{#snippet footer()}
			{#if rows && rows.length}
				<div class="space-y-3">
					{#if paged.pages > 1}
						<div class="flex items-center justify-between gap-2 text-sm text-muted-foreground">
							<span aria-live="polite" class="tabular-nums">
								{paged.from}–{paged.to} von {groups.length} Artikeln
							</span>
							<div class="flex items-center gap-2">
								<span class="hidden tabular-nums sm:inline">
									Seite {paged.page} von {paged.pages}
								</span>
								<Button
									variant="outline"
									size="sm"
									disabled={paged.page <= 1}
									onclick={() => (pageNo = paged.page - 1)}
								>
									<ChevronLeft /> Zurück
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={paged.page >= paged.pages}
									onclick={() => (pageNo = paged.page + 1)}
								>
									Weiter <ChevronRight />
								</Button>
							</div>
						</div>
					{/if}
					<p class="text-sm text-muted-foreground">
						Fehlmenge = offen bestellt + Mindestbestand − Bestand − unterwegs. Bei Artikeln mit
						Größen stehen in der ersten Zeile die Summen; aufklappen zeigt die einzelnen Größen.
					</p>
				</div>
			{/if}
		{/snippet}
	</DataTable>
</div>

{#snippet deficitBadge(deficit: number)}
	{#if deficit > 0}
		<Badge variant="destructive" class="tabular-nums"
			>{deficit} {deficit === 1 ? 'fehlt' : 'fehlen'}</Badge
		>
	{:else}
		<span class="text-muted-foreground">–</span>
	{/if}
{/snippet}

{#snippet reorderLink(url: string | null)}
	{#if url}
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			class="inline-flex min-h-9 items-center gap-1 text-sm underline-offset-4 hover:underline"
			onclick={(e) => e.stopPropagation()}
		>
			<ExternalLink class="size-4" aria-hidden="true" />
			{urlHost(url)}
			<span class="sr-only">(öffnet in neuem Tab)</span>
		</a>
	{:else}
		<span class="text-muted-foreground">–</span>
	{/if}
{/snippet}

<!-- Eine Größe bzw. ein Artikel ohne Größen; `nested` = eingerückt unter der Summenzeile -->
{#snippet variantRow(r: StockRow, nested: boolean)}
	<Table.Row
		class={[r.deficit > 0 ? 'bg-destructive/5' : '', nested ? 'bg-muted/30 text-sm' : ''].join(' ')}
	>
		<Table.Cell class={nested ? 'max-w-80 pl-10' : 'max-w-80'}>
			{#if nested}
				<div class="font-medium">
					<span class="sr-only">{r.articleTitle}, </span>Größe {r.variantLabel || '–'}
				</div>
			{:else}
				<div class="truncate font-medium">{r.articleTitle}</div>
				<div class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
					{#if r.variantLabel}<span>Größe {r.variantLabel}</span>{/if}
					{#if !r.articleActive}<Badge variant="outline">nicht im Katalog</Badge>{/if}
				</div>
			{/if}
		</Table.Cell>
		<Table.Cell
			class={[
				'text-right font-medium tabular-nums',
				r.stock < r.minStock ? 'text-warning' : ''
			].join(' ')}
		>
			{r.stock}
		</Table.Cell>
		<Table.Cell class="text-right tabular-nums text-muted-foreground">{r.minStock}</Table.Cell>
		<Table.Cell class="text-right tabular-nums">{r.demand}</Table.Cell>
		<Table.Cell class="text-right tabular-nums">{r.inTransit}</Table.Cell>
		<Table.Cell class="text-right">{@render deficitBadge(r.deficit)}</Table.Cell>
		<Table.Cell>{@render reorderLink(safeUrl(r.reorderUrl))}</Table.Cell>
		<Table.Cell class="text-right whitespace-nowrap">
			<Button
				size="icon"
				variant="ghost"
				aria-label={`Lagerbewegungen: ${itemName(r.articleTitle, r.variantLabel)}`}
				title="Lagerbewegungen"
				onclick={() => showMoves(r)}
			>
				<History />
			</Button>
			{#if canStock}
				<Button size="sm" variant="outline" onclick={() => startCorrection(r)}>
					<Pencil /> Korrigieren
				</Button>
			{/if}
		</Table.Cell>
	</Table.Row>
{/snippet}

<StockCorrectionDialog bind:open={correctionOpen} row={correctionRow} onsaved={load} />
<SupplierOrderDialog bind:open={supplierOpen} initial={suggestion} onsaved={supplierSaved} />

<Sheet.Root bind:open={movesOpen}>
	<Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-lg">
		<Sheet.Header class="border-b">
			<Sheet.Title>Lagerbewegungen</Sheet.Title>
			<Sheet.Description>
				{movesVariant
					? itemName(movesVariant.articleTitle, movesVariant.variantLabel)
					: 'Alle Artikel'}
			</Sheet.Description>
			{#if movesVariant}
				<Button size="sm" variant="outline" class="w-fit" onclick={() => showMoves(null)}>
					<X /> Alle Artikel zeigen
				</Button>
			{/if}
		</Sheet.Header>
		<div class="space-y-3 p-4">
			{#if movesLoading && !moves}
				{#each [1, 2, 3, 4] as n (n)}<Skeleton class="h-14 w-full" />{/each}
			{:else if movesError}
				<p class="text-sm text-destructive" role="alert">
					{movesError}
					<Button size="sm" variant="link" onclick={loadMoves}>Erneut versuchen</Button>
				</p>
			{:else if moves && !moves.items.length}
				<p class="text-sm text-muted-foreground">Noch keine Lagerbewegungen.</p>
			{:else if moves}
				<ul class="divide-y rounded-md border">
					{#each moves.items as m (m.id)}
						<li class="flex items-start justify-between gap-3 p-3 text-sm">
							<div class="min-w-0 space-y-0.5">
								<div class="flex flex-wrap items-center gap-1.5">
									<Badge variant="outline">{MOVEMENT_KIND_LABELS[m.kind] ?? m.kind}</Badge>
									{#if !movesVariant}
										<span class="font-medium">{itemName(m.articleTitle, m.variantLabel)}</span>
									{/if}
								</div>
								<div class="text-xs text-muted-foreground">
									{fmtDateTime(m.createdAt)}{m.createdBy ? ` · ${m.createdBy.name}` : ''}
									{#if m.orderNumber}· Bestellung {m.orderNumber}{/if}
									{#if m.supplierOrderNumber}· Einkauf {m.supplierOrderNumber}{/if}
								</div>
								{#if m.note}<p class="text-xs break-words">{m.note}</p>{/if}
							</div>
							<span
								class={[
									'shrink-0 font-semibold tabular-nums',
									m.delta > 0 ? 'text-success' : '',
									m.delta < 0 ? 'text-destructive' : ''
								].join(' ')}
							>
								{fmtDelta(m.delta)}
							</span>
						</li>
					{/each}
				</ul>
				{#if moves.total > MOVE_LIMIT}
					<div class="flex items-center justify-between gap-2 text-sm">
						<span class="text-muted-foreground tabular-nums">
							{movesOffset + 1}–{Math.min(movesOffset + MOVE_LIMIT, moves.total)} von {moves.total}
						</span>
						<div class="flex gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={movesOffset === 0 || movesLoading}
								onclick={() => pageMoves(-MOVE_LIMIT)}
							>
								Zurück
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={movesOffset + MOVE_LIMIT >= moves.total || movesLoading}
								onclick={() => pageMoves(MOVE_LIMIT)}
							>
								Weiter
							</Button>
						</div>
					</div>
				{/if}
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
