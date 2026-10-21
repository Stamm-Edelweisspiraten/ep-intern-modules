<script lang="ts">
	// Dashboard-Kachel „Aufgaben der Kasse“: offene Aufgaben aus der Kassen-Übersicht (`Overview.tasks`).
	import { onMount } from 'svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Info from '@lucide/svelte/icons/info';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Wallet from '@lucide/svelte/icons/wallet';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import type { Overview, OverviewTask } from '../../schemas';
	import { BASE, errorMessage } from '../helpers';
	import { taskView } from '../task-view';

	let { onstatus }: DashboardWidgetProps = $props();

	let tasks = $state<OverviewTask[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			tasks = (await apiFetch<Overview>(`${BASE}/overview`)).tasks;
			onstatus?.(tasks.length ? 'ready' : 'empty');
		} catch (e) {
			error = errorMessage(e, 'Aufgaben der Kasse konnten nicht geladen werden.');
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
	title="Aufgaben der Kasse"
	icon={Wallet}
	href="/modules/treasury"
	hrefLabel="Zur Kasse"
	{loading}
	{error}
	onretry={load}
	empty={!tasks.length}
	emptyText="Alles erledigt."
>
	<ul class="divide-y">
		{#each tasks as t (t.kind)}
			{@const v = taskView(t)}
			<li class="py-2">
				<a
					href={v.href}
					class="flex items-start gap-2 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
					aria-label={`${v.title} – ${v.action}`}
				>
					{#if t.severity === 'critical'}
						<CircleAlert class="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Dringend" />
					{:else if t.severity === 'warning'}
						<TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" aria-label="Wichtig" />
					{:else}
						<Info class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Hinweis" />
					{/if}
					<span class="min-w-0">
						<span class="block font-medium">{v.title}</span>
						<span class="block text-xs text-muted-foreground">{v.hint}</span>
					</span>
				</a>
			</li>
		{/each}
	</ul>
</DashboardCard>
