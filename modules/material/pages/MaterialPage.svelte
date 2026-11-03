<script lang="ts">
	// Materialseite mit Reitern wie „Bestellungen“: Reservieren · Meine · Alle · Lager · Vorrat · Etiketten (je nach Recht).
	import { page } from '$app/state';
	import { afterNavigate } from '$app/navigation';
	import { can } from '$lib/sdk/client';
	import * as Tabs from '$lib/components/ui/tabs';
	import { PageHeader, ScrollPills, deviceLayout } from '$lib/components/layout';
	import { PERMISSIONS } from '../schemas';
	import { safeReplaceState, type MaterialTab } from './helpers';
	import ReserveTab from './reserve/ReserveTab.svelte';
	import ReservationsTab from './reservations/ReservationsTab.svelte';
	import InventoryTab from './inventory/InventoryTab.svelte';
	import LabelsTab from './labels/LabelsTab.svelte';
	import PantryTab from './pantry/PantryTab.svelte';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const perm = $derived({
		view: can(permissions, PERMISSIONS.view),
		manage: can(permissions, PERMISSIONS.manage),
		reserve: can(permissions, PERMISSIONS.reserve),
		reservations: can(permissions, PERMISSIONS.reservations),
		labels: can(permissions, PERMISSIONS.labels),
		pantry: can(permissions, PERMISSIONS.pantry)
	});

	const TAB_LABELS: Record<MaterialTab, string> = {
		reservieren: 'Reservieren',
		meine: 'Meine Reservierungen',
		alle: 'Alle Reservierungen',
		lager: 'Lager',
		vorrat: 'Vorrat',
		etiketten: 'Etiketten'
	};

	/** Kurze Namen für die Pillenleiste auf dem Handy */
	const SHORT_LABELS: Record<MaterialTab, string> = {
		reservieren: 'Reservieren',
		meine: 'Meine',
		alle: 'Alle',
		lager: 'Lager',
		vorrat: 'Vorrat',
		etiketten: 'Etiketten'
	};
	const phone = $derived(deviceLayout() === 'phone');

	const visibleTabs = $derived(
		(
			[
				['reservieren', perm.view],
				['meine', perm.reserve],
				['alle', perm.reservations],
				['lager', perm.view],
				['vorrat', perm.view],
				['etiketten', perm.labels || perm.manage]
			] as [MaterialTab, boolean][]
		)
			.filter(([, ok]) => ok)
			.map(([t]) => t)
	);

	// `replaceState` (Reiterwechsel) ändert `page.url` nicht – daher eigener Zustand. Echte Navigationen
	// (Links auf `?tab=…&open=…`, Suche, Aktions-Karte) lesen die URL neu und bauen den Reiter frisch auf.
	const param = (key: string) => page.url.searchParams.get(key);
	let tab = $state(param('tab') ?? 'reservieren');
	let editId = $state<string | null>(param('edit'));
	let openId = $state<string | null>(param('open'));
	let navKey = $state(0);

	afterNavigate((nav) => {
		// Beim ersten Laden ist der Zustand schon aus der URL gesetzt – nicht doppelt aufbauen
		if (nav.type === 'enter') return;
		tab = param('tab') ?? 'reservieren';
		editId = param('edit');
		openId = param('open');
		navKey++;
	});
	const activeTab = $derived<MaterialTab | null>(
		(visibleTabs as string[]).includes(tab) ? (tab as MaterialTab) : (visibleTabs[0] ?? null)
	);

	/** Reiter wechseln; `params` setzt zusätzliche Suchparameter (z. B. `open`, `edit`) */
	function setTab(v: string, params: { open?: string; edit?: string } = {}) {
		tab = v;
		editId = params.edit ?? null;
		openId = params.open ?? null;
		const url = new URL(page.url);
		for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key);
		if (v !== 'reservieren') url.searchParams.set('tab', v);
		for (const [k, val] of Object.entries(params)) url.searchParams.set(k, val);
		safeReplaceState(url);
	}
</script>

<PageHeader
	title="Material"
	description={phone
		? undefined
		: 'Zelte, Kochkisten und alles andere aus dem Lager reservieren und verwalten – dazu der Vorrat an Lebensmitteln.'}
/>

{#if activeTab && phone}
	{#if visibleTabs.length > 1}
		<ScrollPills
			class="mb-4"
			label="Bereiche"
			options={visibleTabs.map((t) => ({ value: t, label: SHORT_LABELS[t] }))}
			value={activeTab}
			onchange={(v) => setTab(v)}
		/>
	{/if}
{:else if activeTab}
	<Tabs.Root value={activeTab} onValueChange={(v) => setTab(v)}>
		{#if visibleTabs.length > 1}
			<Tabs.List variant="line" class="mb-4" aria-label="Bereiche">
				{#each visibleTabs as t (t)}
					<Tabs.Trigger value={t}>{TAB_LABELS[t]}</Tabs.Trigger>
				{/each}
			</Tabs.List>
		{/if}
	</Tabs.Root>
{/if}

{#if activeTab}
	{#key navKey}
		{#if activeTab === 'reservieren'}
			{#key editId}
				<ReserveTab
					{editId}
					onsaved={(id, mine) =>
						setTab(mine || !perm.reservations ? 'meine' : 'alle', { open: id })}
					oncanceledit={() => setTab('reservieren')}
				/>
			{/key}
		{:else if activeTab === 'meine' || activeTab === 'alle'}
			{#key activeTab}
				<ReservationsTab
					scope={activeTab === 'meine' ? 'mine' : 'all'}
					{openId}
					onedit={(id) => setTab('reservieren', { edit: id })}
					onreserve={() => setTab('reservieren')}
				/>
			{/key}
		{:else if activeTab === 'lager'}
			<InventoryTab onreserve={() => setTab('reservieren')} />
		{:else if activeTab === 'vorrat'}
			<PantryTab {openId} canManage={perm.pantry} initialFilter={param('filter')} />
		{:else if activeTab === 'etiketten'}
			<LabelsTab />
		{/if}
	{/key}
{:else}
	<p class="text-sm text-muted-foreground">Dir fehlen die Rechte für dieses Modul.</p>
{/if}
