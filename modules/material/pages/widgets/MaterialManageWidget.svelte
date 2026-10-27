<script lang="ts">
	// Dashboard-Kachel „Material“ (Verwaltung): ausgegeben, überfällig, Schäden, Mindestbestand.
	import { onMount } from 'svelte';
	import Boxes from '@lucide/svelte/icons/boxes';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import type { Overview } from '../../schemas';
	import { API, errorText } from '../helpers';

	let { onstatus }: DashboardWidgetProps = $props();

	let data = $state<Overview | null>(null);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			data = await apiFetch<Overview>(`${API}/overview`);
			const relevant =
				data.issuedUnits +
				data.overdueReservations +
				data.damagedUnits +
				data.upcomingReservations +
				data.lowStock.length;
			onstatus?.(relevant ? 'ready' : 'empty');
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

	const tiles = $derived(
		data
			? [
					{ label: 'Ausgegeben', value: data.issuedUnits, tone: '' },
					{
						label: 'Überfällig',
						value: data.overdueReservations,
						tone: data.overdueReservations ? 'text-destructive' : ''
					},
					{
						label: 'Schäden',
						value: data.damagedUnits,
						tone: data.damagedUnits ? 'text-warning' : ''
					},
					{ label: 'Anstehend', value: data.upcomingReservations, tone: '' }
				]
			: []
	);
</script>

<DashboardCard
	title="Material"
	icon={Boxes}
	href="/modules/material"
	{loading}
	{error}
	onretry={load}
	empty={!data}
>
	{#if data}
		<dl class="grid grid-cols-2 gap-2">
			{#each tiles as t (t.label)}
				<div class="rounded-md border p-2">
					<dt class="text-xs text-muted-foreground">{t.label}</dt>
					<dd class="text-lg font-semibold tabular-nums {t.tone}">{t.value}</dd>
				</div>
			{/each}
		</dl>
		{#if data.lowStock.length}
			<div class="mt-3">
				<p class="text-xs font-medium text-warning">Unter Mindestbestand</p>
				<ul class="text-sm">
					{#each data.lowStock.slice(0, 4) as s (s.articleId)}
						<li class="flex justify-between gap-2">
							<a
								class="truncate text-link hover:underline"
								href={`/modules/material?article=${s.articleId}`}
							>
								{s.name}
							</a>
							<span class="tabular-nums text-muted-foreground">{s.total} / {s.min}</span>
						</li>
					{/each}
				</ul>
				{#if data.lowStock.length > 4}
					<p class="text-xs text-muted-foreground">und {data.lowStock.length - 4} weitere</p>
				{/if}
			</div>
		{/if}
	{/if}
</DashboardCard>
