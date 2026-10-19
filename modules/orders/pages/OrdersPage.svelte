<script lang="ts">
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { can } from '$lib/sdk/client';
	import * as Tabs from '$lib/components/ui/tabs';
	import { PageHeader } from '$lib/components/layout';
	import { PERMISSIONS } from '../schemas';
	import CatalogTab from './CatalogTab.svelte';
	import MyOrdersTab from './MyOrdersTab.svelte';
	import ArticlesTab from './ArticlesTab.svelte';
	import OrdersAdminTab from './OrdersAdminTab.svelte';
	import StockTab from './StockTab.svelte';
	import SupplierOrdersTab from './SupplierOrdersTab.svelte';

	type Tab = 'bestellen' | 'meine' | 'bestellungen' | 'lager' | 'einkauf' | 'artikel';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const perm = $derived({
		view: can(permissions, PERMISSIONS.view),
		manage: can(permissions, PERMISSIONS.manage),
		stock: can(permissions, PERMISSIONS.stock),
		articles: can(permissions, PERMISSIONS.articles)
	});

	const TAB_LABELS: Record<Tab, string> = {
		bestellen: 'Bestellen',
		meine: 'Meine Bestellungen',
		bestellungen: 'Bestellungen',
		lager: 'Lager',
		einkauf: 'Einkauf',
		artikel: 'Artikel'
	};

	const visibleTabs = $derived(
		(
			[
				['bestellen', perm.view],
				['meine', perm.view],
				['bestellungen', perm.manage],
				['lager', perm.stock],
				['einkauf', perm.stock],
				['artikel', perm.articles]
			] as [Tab, boolean][]
		)
			.filter(([, ok]) => ok)
			.map(([t]) => t)
	);

	let tab = $state<string>(page.url.searchParams.get('tab') ?? 'bestellen');
	/** Unbekannter oder nicht erlaubter Tab → erster sichtbarer */
	const activeTab = $derived<Tab | null>(
		(visibleTabs as string[]).includes(tab) ? (tab as Tab) : (visibleTabs[0] ?? null)
	);

	function setTab(v: string) {
		tab = v;
		const url = new URL(page.url);
		if (v === 'bestellen') url.searchParams.delete('tab');
		else url.searchParams.set('tab', v);
		// Suche des Katalogs gehört nur zum Katalog
		if (v !== 'bestellen') url.searchParams.delete('q');
		replaceState(url, {});
	}
</script>

<PageHeader
	title="Bestellungen"
	description="Stammesartikel wie Halstuch, Liederbuch oder Abzeichen bestellen."
/>

{#if activeTab}
	<Tabs.Root value={activeTab} onValueChange={setTab}>
		{#if visibleTabs.length > 1}
			<Tabs.List variant="line" class="mb-4" aria-label="Bereiche">
				{#each visibleTabs as t (t)}
					<Tabs.Trigger value={t}>{TAB_LABELS[t]}</Tabs.Trigger>
				{/each}
			</Tabs.List>
		{/if}
	</Tabs.Root>

	{#if activeTab === 'bestellen'}
		<CatalogTab onordered={() => setTab('meine')} onmanage={() => setTab('bestellungen')} />
	{:else if activeTab === 'meine'}
		<MyOrdersTab />
	{:else if activeTab === 'bestellungen'}
		<OrdersAdminTab onnavigate={(t) => setTab(t === 'stock' ? 'lager' : 'einkauf')} />
	{:else if activeTab === 'lager'}
		<StockTab onsupplierorder={() => setTab('einkauf')} />
	{:else if activeTab === 'einkauf'}
		<SupplierOrdersTab />
	{:else if activeTab === 'artikel'}
		<ArticlesTab />
	{/if}
{:else}
	<p class="text-sm text-muted-foreground">Dir fehlen die Rechte für dieses Modul.</p>
{/if}
