<script lang="ts">
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import ScanLine from '@lucide/svelte/icons/scan-line';
	import { can } from '$lib/sdk/client';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Button } from '$lib/components/ui/button';
	import { PageHeader } from '$lib/components/layout';
	import { BASE_PATH, PERMISSIONS } from '../schemas';
	import OverviewTab from './OverviewTab.svelte';
	import InventoryTab from './inventory/InventoryTab.svelte';
	import SetsTab from './sets/SetsTab.svelte';
	import ReservationsTab from './reservations/ReservationsTab.svelte';
	import LabelsTab from './labels/LabelsTab.svelte';

	type Tab = 'overview' | 'inventory' | 'sets' | 'reservations' | 'labels';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const perm = $derived({
		view: can(permissions, PERMISSIONS.view),
		manage: can(permissions, PERMISSIONS.manage),
		labels: can(permissions, PERMISSIONS.labels)
	});

	const TAB_LABELS: Record<Tab, string> = {
		overview: 'Übersicht',
		inventory: 'Bestand',
		sets: 'Zelte & Sets',
		reservations: 'Reservierungen',
		labels: 'Etiketten'
	};

	const visibleTabs = $derived(
		(
			[
				['overview', perm.view],
				['inventory', perm.view],
				['sets', perm.view],
				['reservations', perm.view],
				['labels', perm.manage || perm.labels]
			] as [Tab, boolean][]
		)
			.filter(([, ok]) => ok)
			.map(([t]) => t)
	);

	// `?open=<stück>` bzw. `?article=` gehören zum Bestand
	const initial =
		page.url.searchParams.get('tab') ??
		(page.url.searchParams.has('open') || page.url.searchParams.has('article')
			? 'inventory'
			: 'overview');
	let tab = $state<string>(initial);
	const activeTab = $derived<Tab | null>(
		(visibleTabs as string[]).includes(tab) ? (tab as Tab) : (visibleTabs[0] ?? null)
	);

	function setTab(v: string) {
		tab = v;
		const url = new URL(page.url);
		if (v === 'overview') url.searchParams.delete('tab');
		else url.searchParams.set('tab', v);
		for (const k of ['open', 'article', 'q']) url.searchParams.delete(k);
		replaceState(url, {});
	}
</script>

<PageHeader title="Material" description="Was hat der Stamm, wo liegt es und wer braucht es wann?">
	{#snippet actions()}
		<Button href={`${BASE_PATH}/scan`} variant="outline">
			<ScanLine aria-hidden="true" /> Scannen
		</Button>
	{/snippet}
</PageHeader>

{#if activeTab}
	<Tabs.Root value={activeTab} onValueChange={setTab}>
		<Tabs.List variant="line" class="mb-4" aria-label="Bereiche">
			{#each visibleTabs as t (t)}
				<Tabs.Trigger value={t}>{TAB_LABELS[t]}</Tabs.Trigger>
			{/each}
		</Tabs.List>
	</Tabs.Root>

	{#if activeTab === 'overview'}
		<OverviewTab onnavigate={setTab} />
	{:else if activeTab === 'inventory'}
		<InventoryTab />
	{:else if activeTab === 'sets'}
		<SetsTab />
	{:else if activeTab === 'reservations'}
		<ReservationsTab />
	{:else if activeTab === 'labels'}
		<LabelsTab />
	{/if}
{:else}
	<p class="text-sm text-muted-foreground">Dir fehlen die Rechte für dieses Modul.</p>
{/if}
