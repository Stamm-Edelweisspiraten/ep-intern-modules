<script lang="ts">
	// Dashboard-Kachel „Meine Bestellungen“: noch nicht vollständig ausgegebene eigene Bestellungen.
	import { onMount } from 'svelte';
	import ShoppingBag from '@lucide/svelte/icons/shopping-bag';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { BASE_PATH, type Order, type OrderList } from '../../schemas';
	import { errorText, formatDate } from '../helpers';
	import OrderStatusBadge from '../OrderStatusBadge.svelte';

	let { onstatus }: DashboardWidgetProps = $props();

	const LIMIT = 5;

	let items = $state<Order[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			const r = await apiFetch<OrderList>(
				`${BASE_PATH}/orders?scope=mine&status=active&limit=${LIMIT}`
			);
			items = r.items.slice(0, LIMIT);
			total = r.total;
			onstatus?.(items.length ? 'ready' : 'empty');
		} catch (e) {
			error = errorText(e, 'Bestellungen konnten nicht geladen werden.');
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	const href = '/modules/orders?tab=meine';
	const more = $derived(Math.max(0, total - items.length));
</script>

<DashboardCard
	title="Meine Bestellungen"
	icon={ShoppingBag}
	{href}
	{loading}
	{error}
	onretry={load}
	empty={!items.length}
	emptyText="Keine offenen Bestellungen."
>
	<ul class="divide-y">
		{#each items as o (o.id)}
			<li class="py-2">
				<a
					{href}
					class="flex items-start justify-between gap-2 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span class="min-w-0">
						<span class="block truncate font-medium">
							<span class="tabular-nums">{o.number}</span> · {o.member.name}
						</span>
						<span class="block truncate text-xs text-muted-foreground tabular-nums">
							{formatDate(o.createdAt)} · {formatEuro(o.totalCents)}
						</span>
					</span>
					<OrderStatusBadge status={o.status} class="shrink-0" />
				</a>
			</li>
		{/each}
	</ul>
	{#if more}
		<p class="pt-1 text-xs text-muted-foreground">und {more} weitere</p>
	{/if}
</DashboardCard>
