<script lang="ts">
	// Reiter „Vorrat“: Lebensmittel mit Bestand und Mindesthaltbarkeit. Scannen (Kamera oder USB-Scanner) des
	// Hersteller-Strichcodes → Einlagern/Entnehmen; unbekannte Codes mit Vorschlag aus Open Food Facts anlegen.
	import { onMount, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Plus from '@lucide/svelte/icons/plus';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Table from '$lib/components/ui/table';
	import {
		EmptyState,
		ErrorState,
		ListRow,
		LoadingState,
		ScrollPills,
		deviceLayout
	} from '$lib/components/layout';
	import { EXPIRY_LABELS, EXPIRY_WARN_DAYS, normalizeBarcode } from '../../pantry';
	import type { BarcodeResult, FoodProduct, Location } from '../../schemas';
	import {
		API,
		EXPIRY_VARIANTS,
		errorText,
		formatAmount,
		formatDate,
		safeReplaceState
	} from '../helpers';
	import ScanButton from '../shared/ScanButton.svelte';
	import { resolveScan } from '../shared/scan';
	import PantryScanDialog, { type PantryMode } from './PantryScanDialog.svelte';
	import ProductDetailDialog from './ProductDetailDialog.svelte';
	import ProductDialog, { type ProductPreset } from './ProductDialog.svelte';

	type Filter = 'all' | 'stock' | 'soon' | 'expired';
	const FILTERS: { value: Filter; label: string }[] = [
		{ value: 'all', label: 'Alle' },
		{ value: 'stock', label: 'Mit Bestand' },
		{ value: 'soon', label: 'Läuft bald ab' },
		{ value: 'expired', label: 'Abgelaufen' }
	];

	let {
		openId = null,
		canManage,
		initialFilter = null
	}: {
		openId?: string | null;
		canManage: boolean;
		initialFilter?: string | null;
	} = $props();

	const phone = $derived(deviceLayout() === 'phone');

	let products = $state<FoodProduct[] | null>(null);
	let locations = $state<Location[]>([]);
	let loading = $state(true);
	let error = $state('');
	let search = $state('');
	const startFilter = untrack(() => initialFilter);
	let filter = $state<Filter>(
		FILTERS.some((f) => f.value === startFilter) ? (startFilter as Filter) : 'all'
	);
	let showArchived = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	async function load() {
		loading = !products;
		error = '';
		const q = new URLSearchParams({ filter });
		if (search.trim()) q.set('search', search.trim());
		if (showArchived) q.set('archived', '1');
		try {
			products = await apiFetch<FoodProduct[]>(`${API}/pantry?${q}`);
		} catch (e) {
			error = errorText(e, 'Vorrat konnte nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => void load(), 250);
	}

	function setFilter(v: string) {
		filter = v as Filter;
		const url = new URL(window.location.href);
		if (filter === 'all') url.searchParams.delete('filter');
		else url.searchParams.set('filter', filter);
		safeReplaceState(url);
		void load();
	}

	onMount(() => {
		void load();
		void apiFetch<Location[]>(`${API}/locations`)
			.then((l) => (locations = l))
			.catch(() => {});
		if (openId) openDetail(openId);
		return () => clearTimeout(searchTimer);
	});

	const filtered = $derived(!!search.trim() || filter !== 'all' || showArchived);
	const counts = $derived.by(() => {
		const list = products ?? [];
		return {
			soon: list.filter((p) => p.state === 'soon').length,
			expired: list.filter((p) => p.state === 'expired').length
		};
	});

	// --- Dialoge -------------------------------------------------------------------
	let detailId = $state<string | null>(null);
	let detailOpen = $state(false);
	let formOpen = $state(false);
	let formProduct = $state<FoodProduct | null>(null);
	let formPreset = $state<ProductPreset>({});
	/** Nach dem Anlegen aus einem Scan direkt einlagern */
	let afterCreateScan = false;
	let scanProduct = $state<FoodProduct | null>(null);
	let scanDialogOpen = $state(false);
	let scannerOpen = $state(false);
	let mode = $state<PantryMode>('in');
	let scanBusy = $state(false);

	function openDetail(id: string) {
		detailId = id;
		detailOpen = true;
	}

	function newProduct(preset: ProductPreset = {}, fromScan = false) {
		formProduct = null;
		formPreset = preset;
		afterCreateScan = fromScan;
		formOpen = true;
	}

	function editProduct(p: FoodProduct) {
		formProduct = p;
		formPreset = {};
		afterCreateScan = false;
		formOpen = true;
	}

	function replaceProduct(p: FoodProduct) {
		if (!products) return;
		const i = products.findIndex((x) => x.id === p.id);
		if (i >= 0) products[i] = p;
		else void load();
	}

	function showScanned(p: FoodProduct) {
		if (canManage && !p.archived) {
			if (mode === 'out' && p.quantity === 0) mode = 'in';
			scanProduct = p;
			scanDialogOpen = true;
		} else {
			openDetail(p.id);
		}
	}

	async function onscan(raw: string) {
		const text = raw.trim();
		scanBusy = true;
		try {
			const barcode = normalizeBarcode(text);
			if (!barcode) {
				// QR-Code oder Code eines Lagerartikels?
				const target =
					/^https?:\/\//i.test(text) || /^[A-Z]-/i.test(text) ? await resolveScan(text) : null;
				if (target?.type === 'food') return openDetail(target.id);
				toast.error(
					target && target.type !== 'reserved'
						? `${target.name} gehört ins Lager, nicht in den Vorrat.`
						: 'Kein gültiger Strichcode (EAN) erkannt.'
				);
				return;
			}
			const result = await apiFetch<BarcodeResult>(
				`${API}/pantry/barcode/${encodeURIComponent(barcode)}`
			);
			if (result.product) {
				showScanned(result.product);
			} else if (canManage) {
				const s = result.suggestion;
				newProduct(
					{
						barcode: result.barcode,
						name: s?.name,
						brand: s?.brand,
						packageSize: s?.packageSize,
						suggested: !!s?.found
					},
					true
				);
			} else {
				toast.error(`Den Strichcode ${result.barcode} gibt es im Vorrat noch nicht.`);
			}
		} catch (e) {
			toast.error(errorText(e, 'Der Code konnte nicht geprüft werden.'));
		} finally {
			scanBusy = false;
		}
	}

	function stockText(p: FoodProduct): string {
		return p.quantity > 0 ? formatAmount(p.quantity, p.unit) : 'leer';
	}

	function subtitle(p: FoodProduct): string {
		return [
			p.brand,
			p.nextBestBefore ? `MHD ${formatDate(p.nextBestBefore)}` : '',
			p.locationName ?? ''
		]
			.filter(Boolean)
			.join(' · ');
	}
</script>

{#snippet modeSwitch()}
	{#if canManage}
		<div class="grid grid-cols-2 gap-2" role="group" aria-label="Beim Scannen">
			<Button
				variant={mode === 'in' ? 'default' : 'outline'}
				size="sm"
				aria-pressed={mode === 'in'}
				onclick={() => (mode = 'in')}
			>
				Einlagern
			</Button>
			<Button
				variant={mode === 'out' ? 'default' : 'outline'}
				size="sm"
				aria-pressed={mode === 'out'}
				onclick={() => (mode = 'out')}
			>
				Entnehmen
			</Button>
		</div>
	{/if}
{/snippet}

{#snippet expiryBadge(p: FoodProduct)}
	{#if p.quantity > 0 && p.state !== 'ok' && p.state !== 'none'}
		<Badge variant={EXPIRY_VARIANTS[p.state]}>{EXPIRY_LABELS[p.state]}</Badge>
	{/if}
	{#if p.archived}<Badge variant="outline">Archiviert</Badge>{/if}
{/snippet}

<div class="space-y-4">
	<div class="flex flex-wrap items-center gap-2">
		<Input
			type="search"
			class="min-w-0 flex-1 sm:max-w-xs"
			placeholder="Name, Marke oder Strichcode …"
			aria-label="Vorrat durchsuchen"
			bind:value={search}
			oninput={onSearchInput}
		/>
		<ScanButton
			bind:open={scannerOpen}
			{onscan}
			busy={scanBusy}
			compact={phone}
			label="Scannen"
			title="Lebensmittel scannen"
			description="Halte den Strichcode der Packung vor die Kamera. Ein USB-Handscanner funktioniert überall auf der Seite."
			placeholder="Strichcode eingeben, z. B. 4001234567890"
		>
			{@render modeSwitch()}
		</ScanButton>
		{#if canManage}
			{#if phone}
				<Button
					size="icon"
					class="size-10"
					aria-label="Lebensmittel anlegen"
					onclick={() => newProduct()}
				>
					<Plus />
				</Button>
			{:else}
				<Button onclick={() => newProduct()}><Plus /> Lebensmittel anlegen</Button>
			{/if}
		{/if}
	</div>

	<div class="flex flex-wrap items-center justify-between gap-2">
		<ScrollPills label="Filter" options={FILTERS} value={filter} onchange={setFilter} />
		<div class="flex items-center gap-3">
			{#if canManage && !phone}
				<span class="text-xs text-muted-foreground">Beim Scannen:</span>
				<div class="w-52">{@render modeSwitch()}</div>
			{/if}
			<Button
				variant="ghost"
				size="sm"
				aria-pressed={showArchived}
				onclick={() => {
					showArchived = !showArchived;
					void load();
				}}
			>
				{showArchived ? 'Archivierte ausblenden' : 'Archivierte zeigen'}
			</Button>
		</div>
	</div>

	{#if filter === 'all' && !search.trim() && (counts.soon || counts.expired)}
		<p class="text-sm text-muted-foreground">
			{#if counts.expired}<span class="font-medium text-destructive"
					>{counts.expired} abgelaufen</span
				>{/if}
			{#if counts.expired && counts.soon}·{/if}
			{#if counts.soon}
				<span class="font-medium text-warning"
					>{counts.soon} laufen in {EXPIRY_WARN_DAYS} Tagen ab</span
				>
			{/if}
		</p>
	{/if}

	{#if loading && !products}
		<LoadingState rows={6} />
	{:else if error}
		<ErrorState title="Vorrat konnte nicht geladen werden" message={error} onretry={load} />
	{:else if products && !products.length}
		<EmptyState
			title={filtered ? 'Keine Treffer' : 'Der Vorrat ist noch leer'}
			description={filtered
				? 'Kein Lebensmittel passt zu Suche oder Filter.'
				: canManage
					? 'Scanne den Strichcode einer Packung – unbekannte Produkte legst du dabei einmal an.'
					: 'Hier erscheinen Lebensmittel, sobald sie eingelagert sind.'}
		>
			{#if filtered}
				<Button
					variant="outline"
					onclick={() => {
						search = '';
						showArchived = false;
						setFilter('all');
					}}><X /> Filter zurücksetzen</Button
				>
			{/if}
		</EmptyState>
	{:else if products && phone}
		<div class="overflow-hidden rounded-xl border bg-card" role="list" aria-label="Vorrat">
			{#each products as p (p.id)}
				<div role="listitem">
					<ListRow
						title={p.name}
						subtitle={subtitle(p)}
						amount={stockText(p)}
						amountClass={p.quantity ? undefined : 'text-muted-foreground'}
						onclick={() => openDetail(p.id)}
					>
						{#snippet trailing()}{@render expiryBadge(p)}{/snippet}
					</ListRow>
				</div>
			{/each}
		</div>
	{:else if products}
		<div class="overflow-x-auto rounded-xl border bg-card">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Lebensmittel</Table.Head>
						<Table.Head class="text-right">Bestand</Table.Head>
						<Table.Head>Nächstes MHD</Table.Head>
						<Table.Head>Lagerort</Table.Head>
						<Table.Head>Strichcode</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each products as p (p.id)}
						<Table.Row
							class="cursor-pointer"
							tabindex={0}
							onclick={() => openDetail(p.id)}
							onkeydown={(e: KeyboardEvent) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									openDetail(p.id);
								}
							}}
						>
							<Table.Cell>
								<div class="font-medium">{p.name}</div>
								<div class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
									{[p.brand, p.packageSize].filter(Boolean).join(' · ')}
									{@render expiryBadge(p)}
								</div>
							</Table.Cell>
							<Table.Cell
								class={[
									'text-right font-medium tabular-nums',
									p.quantity ? '' : 'text-muted-foreground'
								].join(' ')}>{stockText(p)}</Table.Cell
							>
							<Table.Cell class="tabular-nums">
								{p.nextBestBefore ? formatDate(p.nextBestBefore) : '–'}
							</Table.Cell>
							<Table.Cell>{p.locationName ?? '–'}</Table.Cell>
							<Table.Cell class="font-mono text-xs text-muted-foreground"
								>{p.barcode ?? '–'}</Table.Cell
							>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>

<ProductDialog
	bind:open={formOpen}
	product={formProduct}
	preset={formPreset}
	{locations}
	onsaved={(p) => {
		if (formProduct) replaceProduct(p);
		else void load();
		if (afterCreateScan) {
			afterCreateScan = false;
			mode = 'in';
			showScanned(p);
		}
	}}
/>

<ProductDetailDialog
	bind:open={detailOpen}
	productId={detailId}
	{canManage}
	{locations}
	onedit={editProduct}
	onchanged={load}
/>

{#if scanProduct}
	<PantryScanDialog
		bind:open={scanDialogOpen}
		bind:mode
		product={scanProduct}
		onsaved={replaceProduct}
		onnext={() => (scannerOpen = true)}
		ondetails={(id) => {
			scanDialogOpen = false;
			openDetail(id);
		}}
	/>
{/if}
