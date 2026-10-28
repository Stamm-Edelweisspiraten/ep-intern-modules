<script lang="ts">
	// Materialseite mit Reitern wie „Bestellungen“: Reservieren · Meine · Alle · Lager · Etiketten (je nach Recht).
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { can } from '$lib/sdk/client';
	import * as Tabs from '$lib/components/ui/tabs';
	import { PageHeader } from '$lib/components/layout';
	import { PERMISSIONS } from '../schemas';
	import type { MaterialTab } from './helpers';
	import ReserveTab from './reserve/ReserveTab.svelte';
	import ReservationsTab from './reservations/ReservationsTab.svelte';
	import InventoryTab from './inventory/InventoryTab.svelte';
	import LabelsTab from './labels/LabelsTab.svelte';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const perm = $derived({
		view: can(permissions, PERMISSIONS.view),
		manage: can(permissions, PERMISSIONS.manage),
		reserve: can(permissions, PERMISSIONS.reserve),
		reservations: can(permissions, PERMISSIONS.reservations),
		labels: can(permissions, PERMISSIONS.labels)
	});

	const TAB_LABELS: Record<MaterialTab, string> = {
		reservieren: 'Reservieren',
		meine: 'Meine Reservierungen',
		alle: 'Alle Reservierungen',
		lager: 'Lager',
		etiketten: 'Etiketten'
	};

	const visibleTabs = $derived(
		(
			[
				['reservieren', perm.view],
				['meine', perm.reserve],
				['alle', perm.reservations],
				['lager', perm.view],
				['etiketten', perm.labels || perm.manage]
			] as [MaterialTab, boolean][]
		)
			.filter(([, ok]) => ok)
			.map(([t]) => t)
	);

	// Aus der URL abgeleitet: Links auf `?tab=…` (Artikel → Reservierung, Kacheln) wechseln den Reiter mit
	const tab = $derived(page.url.searchParams.get('tab') ?? 'reservieren');
	const activeTab = $derived<MaterialTab | null>(
		(visibleTabs as string[]).includes(tab) ? (tab as MaterialTab) : (visibleTabs[0] ?? null)
	);

	/** Reiter wechseln; `params` setzt zusätzliche Suchparameter (z. B. `open`, `edit`) */
	function setTab(v: string, params: Record<string, string> = {}) {
		const url = new URL(page.url);
		for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key);
		if (v !== 'reservieren') url.searchParams.set('tab', v);
		for (const [k, val] of Object.entries(params)) url.searchParams.set(k, val);
		replaceState(url, {});
	}
</script>

<PageHeader
	title="Material"
	description="Zelte, Kochkisten und alles andere aus dem Lager reservieren und verwalten."
/>

{#if activeTab}
	<Tabs.Root value={activeTab} onValueChange={(v) => setTab(v)}>
		{#if visibleTabs.length > 1}
			<Tabs.List variant="line" class="mb-4" aria-label="Bereiche">
				{#each visibleTabs as t (t)}
					<Tabs.Trigger value={t}>{TAB_LABELS[t]}</Tabs.Trigger>
				{/each}
			</Tabs.List>
		{/if}
	</Tabs.Root>

	{#if activeTab === 'reservieren'}
		{#key page.url.searchParams.get('edit')}
			<ReserveTab
				editId={page.url.searchParams.get('edit')}
				onsaved={(id, mine) => setTab(mine || !perm.reservations ? 'meine' : 'alle', { open: id })}
			/>
		{/key}
	{:else if activeTab === 'meine' || activeTab === 'alle'}
		{#key activeTab}
			<ReservationsTab
				scope={activeTab === 'meine' ? 'mine' : 'all'}
				onedit={(id) => setTab('reservieren', { edit: id })}
				onreserve={() => setTab('reservieren')}
			/>
		{/key}
	{:else if activeTab === 'lager'}
		<InventoryTab onreserve={() => setTab('reservieren')} />
	{:else if activeTab === 'etiketten'}
		<LabelsTab />
	{/if}
{:else}
	<p class="text-sm text-muted-foreground">Dir fehlen die Rechte für dieses Modul.</p>
{/if}
