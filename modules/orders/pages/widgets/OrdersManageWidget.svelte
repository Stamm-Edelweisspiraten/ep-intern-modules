<script lang="ts">
	// Dashboard-Kachel „Bestellungen & Lager“: Kopfzahlen für Kämmerer*innen (je nach Recht).
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Package from '@lucide/svelte/icons/package';
	import { apiFetch, can } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import { BASE_PATH, PERMISSIONS, type OrdersOverview } from '../../schemas';
	import { errorText } from '../helpers';

	let { onstatus }: DashboardWidgetProps = $props();

	interface Metric {
		key: string;
		label: string;
		value: number;
		href: string;
		hint?: string;
	}

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canManage = $derived(can(permissions, PERMISSIONS.manage));
	const canStock = $derived(can(permissions, PERMISSIONS.stock));

	let overview = $state<OrdersOverview | null>(null);
	let loading = $state(true);
	let error = $state('');

	function metricsOf(o: OrdersOverview): Metric[] {
		const out: Metric[] = [];
		if (canManage) {
			out.push({
				key: 'orders',
				label: 'Offene Bestellungen',
				value: o.openOrders,
				href: `${BASE_PATH}?tab=bestellungen`,
				hint: o.openItems ? `${o.openItems} Stück auszugeben` : undefined
			});
		}
		if (canStock) {
			out.push(
				{
					key: 'deficit',
					label: 'Fehlmengen',
					value: o.deficitVariants,
					href: `${BASE_PATH}?tab=lager`
				},
				{
					key: 'supplier',
					label: 'Offene Einkäufe',
					value: o.openSupplierOrders,
					href: `${BASE_PATH}?tab=einkauf`
				}
			);
			if (o.treasuryActive) {
				out.push({
					key: 'unpaid',
					label: 'Unbezahlte Lieferantenrechnungen',
					value: o.unpaidSupplierInvoices,
					href: `${BASE_PATH}?tab=einkauf`
				});
			}
		}
		return out;
	}

	const metrics = $derived(overview ? metricsOf(overview) : []);
	const isEmpty = $derived(metrics.every((m) => m.value === 0));

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			const o = await apiFetch<OrdersOverview>(`${BASE_PATH}/overview`);
			overview = o;
			onstatus?.(metricsOf(o).some((m) => m.value > 0) ? 'ready' : 'empty');
		} catch (e) {
			error = errorText(e, 'Kennzahlen konnten nicht geladen werden.');
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<DashboardCard
	title="Bestellungen & Lager"
	icon={Package}
	href={BASE_PATH}
	{loading}
	{error}
	onretry={load}
	empty={isEmpty}
	emptyText="Nichts zu tun: keine offenen Bestellungen, Fehlmengen oder Einkäufe."
	skeletonRows={2}
>
	<ul class="grid grid-cols-2 gap-2">
		{#each metrics as m (m.key)}
			<li>
				<a
					href={m.href}
					class="block h-full rounded-md border p-2.5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span
						class={[
							'block text-2xl font-semibold tabular-nums',
							m.value === 0 && 'text-muted-foreground'
						]}>{m.value}</span
					>
					<span class="block text-xs leading-snug text-muted-foreground">{m.label}</span>
					{#if m.hint}
						<span class="block text-xs text-muted-foreground tabular-nums">{m.hint}</span>
					{/if}
				</a>
			</li>
		{/each}
	</ul>
</DashboardCard>
