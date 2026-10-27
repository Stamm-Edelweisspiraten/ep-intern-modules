<script lang="ts">
	// Artikel im Seitenblatt: Code, Kategorie, Bild, Beschreibung. Mengenartikel: Bestand je Ort mit
	// Zählen/Umlagern. Einzelstück-Artikel: Stückliste (Klick öffnet das Stück). Etikett mit Ziel `article`.
	import { untrack } from 'svelte';
	import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
	import ClipboardList from '@lucide/svelte/icons/clipboard-list';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Printer from '@lucide/svelte/icons/printer';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Sheet from '$lib/components/ui/sheet';
	import { ErrorState, LoadingState } from '$lib/components/layout';
	import {
		ARTICLE_KIND_LABELS,
		type Article,
		type Location,
		type StockEntry,
		type UnitSummary
	} from '../../schemas';
	import { API, errorText } from '../helpers';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';
	import StockDialog from '../inventory/StockDialog.svelte';

	let {
		open = $bindable(false),
		articleId,
		locations,
		canManage,
		canLabels,
		reloadToken = 0,
		onedit,
		oncreateunits,
		onopenunit,
		onchanged
	}: {
		open?: boolean;
		articleId: string | null;
		locations: Location[];
		canManage: boolean;
		canLabels: boolean;
		/** Ändert sich → neu laden (z. B. nach Bearbeiten) */
		reloadToken?: number;
		onedit: (article: Article) => void;
		oncreateunits: (articleId: string) => void;
		onopenunit: (id: string) => void;
		onchanged: () => void | Promise<void>;
	} = $props();

	let article = $state<Article | null>(null);
	let stock = $state<StockEntry[]>([]);
	let units = $state<UnitSummary[]>([]);
	let unitsTotal = $state(0);
	let loading = $state(false);
	let error = $state('');
	let seq = 0;

	async function load(id: string) {
		const my = ++seq;
		if (untrack(() => article?.id) !== id) {
			article = null;
			stock = [];
			units = [];
		}
		loading = true;
		error = '';
		try {
			const a = await apiFetch<Article>(`${API}/articles/${id}`);
			if (a.kind === 'bulk') {
				const s = await apiFetch<StockEntry[]>(`${API}/stock?articleId=${id}`);
				if (my !== seq) return;
				stock = s;
				units = [];
			} else {
				const u = await apiFetch<{ items: UnitSummary[]; total: number }>(
					`${API}/units?articleId=${id}&limit=200`
				);
				if (my !== seq) return;
				units = u.items;
				unitsTotal = u.total;
				stock = [];
			}
			article = a;
		} catch (e) {
			if (my === seq) {
				article = null;
				error = errorText(e, 'Artikel konnte nicht geladen werden');
			}
		} finally {
			if (my === seq) loading = false;
		}
	}

	$effect(() => {
		void reloadToken;
		if (open && articleId) void load(articleId);
	});

	// --- Zählen / Umlagern ---
	let stockOpen = $state(false);
	let stockKey = $state(0);
	let stockMode = $state<'set' | 'move'>('set');
	let stockEntry = $state<StockEntry | null>(null);
	function openStock(mode: 'set' | 'move', entry: StockEntry | null = null) {
		stockMode = mode;
		stockEntry = entry;
		stockKey++;
		stockOpen = true;
	}
	async function stockSaved() {
		if (articleId) await load(articleId);
		await onchanged();
	}

	let printOpen = $state(false);

	const low = $derived(
		!!article &&
			article.kind === 'bulk' &&
			article.minQuantity > 0 &&
			article.stockTotal < article.minQuantity
	);
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-lg">
		<Sheet.Header class="border-b">
			<Sheet.Title class="pr-8">{article?.name ?? 'Artikel'}</Sheet.Title>
			<Sheet.Description>
				{#if article}
					<span class="font-mono">{article.code}</span> · {ARTICLE_KIND_LABELS[
						article.kind
					]}{article.categoryName ? ` · ${article.categoryName}` : ''}
				{:else}
					Details
				{/if}
			</Sheet.Description>
			{#if article}
				{#if article.archived || low}
					<div class="flex flex-wrap gap-1.5">
						{#if article.archived}<Badge variant="outline">Archiviert</Badge>{/if}
						{#if low}<Badge variant="warning">Unter Mindestbestand</Badge>{/if}
					</div>
				{/if}
				{#if canManage || canLabels}
					<div class="flex flex-wrap gap-2 pt-1">
						{#if canManage && article.kind === 'bulk' && !article.archived}
							<Button size="sm" variant="outline" onclick={() => openStock('set')}>
								<ClipboardList /> Zählen
							</Button>
							{#if stock.some((s) => s.quantity > 0)}
								<Button size="sm" variant="outline" onclick={() => openStock('move')}>
									<ArrowRightLeft /> Umlagern
								</Button>
							{/if}
						{/if}
						{#if canManage && article.kind === 'unit' && !article.archived}
							<Button size="sm" variant="outline" onclick={() => oncreateunits(article!.id)}>
								<Plus /> Stücke erfassen
							</Button>
						{/if}
						{#if canLabels}
							<Button size="sm" variant="outline" onclick={() => (printOpen = true)}>
								<Printer /> Etikett
							</Button>
						{/if}
						{#if canManage}
							<Button size="sm" variant="outline" onclick={() => onedit(article!)}>
								<Pencil /> Bearbeiten
							</Button>
						{/if}
					</div>
				{/if}
			{/if}
		</Sheet.Header>

		<div class="space-y-6 p-4">
			{#if loading && !article}
				<LoadingState label="Artikel" rows={5} rowClass="h-8 w-full" />
			{:else if error}
				<ErrorState
					message={error}
					onretry={async () => {
						if (articleId) await load(articleId);
					}}
					busy={loading}
				/>
			{:else if article}
				{#if article.images[0]}
					<img
						src={article.images[0].webUrl}
						alt={article.name}
						width={article.images[0].width}
						height={article.images[0].height}
						class="max-h-56 w-full rounded-md border object-contain"
					/>
				{/if}

				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
					<dt class="text-muted-foreground">Code</dt>
					<dd class="font-mono">{article.code}</dd>
					{#if article.kind === 'bulk'}
						<dt class="text-muted-foreground">Bestand</dt>
						<dd class="tabular-nums">
							{article.stockTotal.toLocaleString(
								'de-DE'
							)}&nbsp;{article.unitLabel}{article.minQuantity
								? ` (Mindestbestand ${article.minQuantity.toLocaleString('de-DE')})`
								: ''}
						</dd>
					{:else}
						<dt class="text-muted-foreground">Stücke</dt>
						<dd class="tabular-nums">
							{article.usableCount} nutzbar{article.usableCount !== article.unitCount
								? ` von ${article.unitCount}`
								: ''}
						</dd>
					{/if}
					{#if article.issuedCount}
						<dt class="text-muted-foreground">Unterwegs</dt>
						<dd class="tabular-nums">{article.issuedCount}&nbsp;{article.unitLabel}</dd>
					{/if}
					{#if article.description}
						<dt class="text-muted-foreground">Beschreibung</dt>
						<dd class="whitespace-pre-line">{article.description}</dd>
					{/if}
					{#if canManage && article.notes}
						<dt class="text-muted-foreground">Interne Notiz</dt>
						<dd class="whitespace-pre-line">{article.notes}</dd>
					{/if}
				</dl>

				{#if article.kind === 'bulk'}
					<section class="space-y-2" aria-labelledby="article-stock">
						<h3 id="article-stock" class="text-sm font-semibold">Bestand je Ort</h3>
						{#if !stock.length}
							<p class="text-sm text-muted-foreground">Noch kein Bestand erfasst.</p>
						{:else}
							<ul class="divide-y border-y">
								{#each stock as e (e.id)}
									<li class="flex min-h-12 items-center gap-2 py-1.5 text-sm">
										<span class="min-w-0 flex-1 truncate">{e.holderName}</span>
										<span class="tabular-nums whitespace-nowrap">
											{e.quantity.toLocaleString('de-DE')}
											<span class="text-muted-foreground">{article.unitLabel}</span>
										</span>
										{#if canManage && !article.archived}
											<Button
												size="icon"
												variant="ghost"
												aria-label={`${e.holderName}: zählen`}
												onclick={() => openStock('set', e)}
											>
												<ClipboardList />
											</Button>
											<Button
												size="icon"
												variant="ghost"
												aria-label={`${e.holderName}: umlagern`}
												onclick={() => openStock('move', e)}
											>
												<ArrowRightLeft />
											</Button>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				{:else}
					<section class="space-y-2" aria-labelledby="article-units">
						<h3 id="article-units" class="text-sm font-semibold">Stücke</h3>
						{#if !units.length}
							<p class="text-sm text-muted-foreground">Noch keine Stücke erfasst.</p>
						{:else}
							<ul class="divide-y border-y">
								{#each units as u (u.id)}
									<li>
										<button
											type="button"
											class="focus-ring flex min-h-12 w-full items-center gap-3 py-1.5 text-left text-sm hover:bg-muted/50"
											onclick={() => onopenunit(u.id)}
										>
											<span class="min-w-0 flex-1">
												<span class="block truncate font-medium">{u.name}</span>
												<span class="block truncate text-xs text-muted-foreground">
													<span class="font-mono">{u.code}</span> · {u.issued
														? `unterwegs: ${u.issued.title}`
														: u.containerId
															? `In ${u.containerName ?? 'Kiste'}${u.locationPath ? ` · ${u.locationPath}` : ''}`
															: u.locationPath || 'Ohne Ort'}
												</span>
											</span>
											<ConditionBadge condition={u.condition} hideOk />
										</button>
									</li>
								{/each}
							</ul>
							{#if unitsTotal > units.length}
								<p class="text-xs text-muted-foreground">
									{units.length} von {unitsTotal} angezeigt.
								</p>
							{/if}
						{/if}
					</section>
				{/if}
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>

{#if article}
	{#if article.kind === 'bulk'}
		{#key stockKey}
			<StockDialog
				bind:open={stockOpen}
				{article}
				entries={stock}
				{locations}
				mode={stockMode}
				entry={stockEntry}
				onsaved={stockSaved}
			/>
		{/key}
	{/if}
	<PrintLabelsDialog bind:open={printOpen} target="article" ids={[article.id]} />
{/if}
