<script lang="ts">
	// Dashboard-Kachel „Material“ (Verwaltung): Kennzahlen, anstehende Reservierungen, gemeldete Schäden.
	import { onMount } from 'svelte';
	import Boxes from '@lucide/svelte/icons/boxes';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import type { Overview } from '../../schemas';
	import { API, errorText, formatPeriod, itemHref, reservationHref } from '../helpers';
	import ConditionBadge from '../shared/ConditionBadge.svelte';

	let { onstatus }: DashboardWidgetProps = $props();

	const LIMIT = 4;

	let data = $state<Overview | null>(null);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			data = await apiFetch<Overview>(`${API}/overview`);
			onstatus?.(data.upcomingCount || data.damagedCount ? 'ready' : 'empty');
		} catch (e) {
			error = errorText(e, 'Übersicht konnte nicht geladen werden.');
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	const tiles = $derived(
		data
			? [
					{ label: 'Anstehend', value: data.upcomingCount, tone: '' },
					{
						label: 'Schäden',
						value: data.damagedCount,
						tone: data.damagedCount ? 'text-warning' : ''
					},
					{ label: 'Artikel', value: data.items, tone: '' }
				]
			: []
	);
</script>

<DashboardCard
	title="Material"
	icon={Boxes}
	href="/modules/material?tab=alle"
	{loading}
	{error}
	onretry={load}
	empty={!data}
>
	{#if data}
		<dl class="grid grid-cols-3 gap-2">
			{#each tiles as t (t.label)}
				<div class="rounded-md border p-2">
					<dt class="text-xs text-muted-foreground">{t.label}</dt>
					<dd class="text-lg font-semibold tabular-nums {t.tone}">{t.value}</dd>
				</div>
			{/each}
		</dl>

		{#if data.upcoming.length}
			<div class="mt-3">
				<p class="text-xs font-medium text-muted-foreground">Nächste 14 Tage</p>
				<ul class="divide-y">
					{#each data.upcoming.slice(0, LIMIT) as r (r.id)}
						<li class="py-1.5">
							<a
								href={reservationHref(r.id, r.mine)}
								class="block rounded-sm text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
							>
								<span class="block truncate font-medium">{r.title}</span>
								<span class="block truncate text-xs text-muted-foreground tabular-nums">
									{formatPeriod(r.startsOn, r.endsOn)} · {r.createdByName}
								</span>
							</a>
						</li>
					{/each}
				</ul>
				{#if data.upcomingCount > LIMIT}
					<p class="text-xs text-muted-foreground">und {data.upcomingCount - LIMIT} weitere</p>
				{/if}
			</div>
		{/if}

		{#if data.damaged.length}
			<div class="mt-3">
				<p class="text-xs font-medium text-warning">Gemeldete Schäden</p>
				<ul class="text-sm">
					{#each data.damaged.slice(0, LIMIT) as d (d.id)}
						<li class="flex items-center justify-between gap-2 py-0.5">
							<a class="min-w-0 truncate text-link hover:underline" href={itemHref(d.id)}>
								{d.name}
							</a>
							<ConditionBadge condition={d.condition} class="shrink-0" />
						</li>
					{/each}
				</ul>
				{#if data.damagedCount > LIMIT}
					<p class="text-xs text-muted-foreground">und {data.damagedCount - LIMIT} weitere</p>
				{/if}
			</div>
		{/if}
	{/if}
</DashboardCard>
