<script lang="ts">
	// Dashboard-Kachel „Meine Materialreservierungen“: eigene laufende und kommende Reservierungen.
	import { onMount } from 'svelte';
	import Boxes from '@lucide/svelte/icons/boxes';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { Badge } from '$lib/components/ui/badge';
	import { DashboardCard } from '$lib/components/layout';
	import type { ReservationListItem } from '../../schemas';
	import {
		API,
		RESERVATION_STATE_LABELS,
		STATE_VARIANTS,
		errorText,
		formatPeriod,
		reservationHref
	} from '../helpers';

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
			items = await apiFetch<ReservationListItem[]>(`${API}/my/reservations`);
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
</script>

<DashboardCard
	title="Meine Materialreservierungen"
	icon={Boxes}
	href="/modules/material?tab=meine"
	{loading}
	{error}
	onretry={load}
	empty={!items.length}
	emptyText="Keine laufenden oder kommenden Reservierungen."
>
	<ul class="divide-y">
		{#each shown as r (r.id)}
			<li class="py-2">
				<a
					href={reservationHref(r.id, true)}
					class="flex items-start justify-between gap-2 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span class="min-w-0">
						<span class="block truncate font-medium">{r.title}</span>
						<span class="block truncate text-xs text-muted-foreground tabular-nums">
							{formatPeriod(r.startsOn, r.endsOn)}{r.itemSummary ? ` · ${r.itemSummary}` : ''}
						</span>
					</span>
					<Badge variant={r.handedOut ? 'success' : STATE_VARIANTS[r.state]} class="shrink-0">
						{r.handedOut ? 'Ausgegeben' : RESERVATION_STATE_LABELS[r.state]}
					</Badge>
				</a>
			</li>
		{/each}
	</ul>
	{#if items.length > LIMIT}
		<p class="pt-1 text-xs text-muted-foreground">und {items.length - LIMIT} weitere</p>
	{/if}
</DashboardCard>
