<script lang="ts">
	// Bereichsleiste des Moduls: Desktop/Tablet als Reiter-Links oben, Handy als Leiste unten.
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import Boxes from '@lucide/svelte/icons/boxes';
	import CalendarCheck from '@lucide/svelte/icons/calendar-check';
	import ScanLine from '@lucide/svelte/icons/scan-line';
	import Warehouse from '@lucide/svelte/icons/warehouse';
	import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
	import { LinkTabs, MobileTabBar, deviceLayout, type MobileTabItem } from '$lib/components/layout';
	import { areaForPath, visibleAreas, type MaterialArea } from './nav';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const areas = $derived(visibleAreas(permissions));
	const active = $derived(areaForPath(page.url.pathname));
	const device = $derived(deviceLayout());

	const ICONS: Record<MaterialArea, MobileTabItem['icon']> = {
		borrow: Boxes,
		mine: CalendarCheck,
		scan: ScanLine,
		stock: Warehouse,
		handout: ArrowLeftRight,
		labels: Boxes
	};
	const SHORT: Partial<Record<MaterialArea, string>> = {
		mine: 'Meine',
		handout: 'Ausgabe'
	};

	const phoneItems = $derived(
		areas
			.filter((a) => a.phone)
			.map((a) => ({ value: a.area, label: SHORT[a.area] ?? a.label, icon: ICONS[a.area] }))
	);
</script>

{#if areas.length > 1}
	{#if device === 'phone'}
		<MobileTabBar
			items={phoneItems}
			value={active}
			label="Bereiche Material"
			onselect={(v) => {
				const target = areas.find((a) => a.area === v);
				if (target) void goto(target.href);
			}}
		/>
	{:else}
		<div class="mb-6">
			<LinkTabs
				tabs={areas.map((a) => ({ label: a.label, href: a.href }))}
				label="Bereiche Material"
			/>
		</div>
	{/if}
{/if}
