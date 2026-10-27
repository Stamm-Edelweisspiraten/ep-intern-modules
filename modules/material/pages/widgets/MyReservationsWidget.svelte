<script lang="ts">
	// Dashboard-Kachel „Meine Materialreservierungen“: offene eigene Reservierungen, überfällige zuerst.
	import { onMount } from 'svelte';
	import Boxes from '@lucide/svelte/icons/boxes';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import type { ReservationListItem } from '../../schemas';
	import { API, errorText, formatPeriod, reservationHref } from '../helpers';
	import StatusBadge from '../shared/StatusBadge.svelte';

	let { onstatus }: DashboardWidgetProps = $props();

	const LIMIT = 5;

	let items = $state<ReservationListItem[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			const list = await apiFetch<ReservationListItem[]>(`${API}/my/reservations`);
			items = [...list].sort((a, b) => Number(b.overdue) - Number(a.overdue));
			onstatus?.(items.length ? 'ready' : 'empty');
		} catch (e) {
			error = errorText(e, 'Reservierungen konnten nicht geladen werden.');
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	const shown = $derived(items.slice(0, LIMIT));
	const overdue = $derived(items.filter((r) => r.overdue).length);
</script>

<DashboardCard
	title="Meine Materialreservierungen"
	icon={Boxes}
	href="/modules/material?tab=reservations"
	{loading}
	{error}
	onretry={load}
	empty={!items.length}
	emptyText="Keine offenen Reservierungen."
>
	{#if overdue}
		<p class="mb-2 text-sm text-destructive">
			{overdue === 1 ? 'Eine Rückgabe ist' : `${overdue} Rückgaben sind`} überfällig.
		</p>
	{/if}
	<ul class="divide-y">
		{#each shown as r (r.id)}
			<li class="py-2">
				<a
					href={reservationHref(r.id)}
					class="flex items-start justify-between gap-2 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span class="min-w-0">
						<span class="block truncate font-medium">{r.title}</span>
						<span class="block truncate text-xs text-muted-foreground tabular-nums">
							{formatPeriod(r.startsOn, r.endsOn)}{r.itemSummary ? ` · ${r.itemSummary}` : ''}
						</span>
					</span>
					<StatusBadge status={r.status} overdue={r.overdue} class="shrink-0" />
				</a>
			</li>
		{/each}
	</ul>
	{#if items.length > LIMIT}
		<p class="pt-1 text-xs text-muted-foreground">und {items.length - LIMIT} weitere</p>
	{/if}
</DashboardCard>
