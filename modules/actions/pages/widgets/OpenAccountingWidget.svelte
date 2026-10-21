<script lang="ts">
	// Dashboard-Kachel „Offene Abrechnungen“: vergangene Aktionen (mit Bearbeiten-Zugriff), deren
	// Abrechnung noch nicht abgeschlossen ist – mit fehlenden Belegen und offenen Auslagen.
	import { onMount } from 'svelte';
	import Calculator from '@lucide/svelte/icons/calculator';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import type { OpenAccounting } from '../../schemas';
	import { fmtDate } from '../format';

	let { onstatus }: DashboardWidgetProps = $props();

	const LIMIT = 5;

	let items = $state<OpenAccounting[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			const list = await apiFetch<OpenAccounting[]>('/modules/actions/accounting/open');
			total = list.length;
			items = list.slice(0, LIMIT);
			onstatus?.(items.length ? 'ready' : 'empty');
		} catch (e) {
			error =
				e instanceof ApiClientError && e.message
					? e.message
					: 'Abrechnungen konnten nicht geladen werden.';
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	const more = $derived(Math.max(0, total - items.length));
</script>

<DashboardCard
	title="Offene Abrechnungen"
	icon={Calculator}
	href="/modules/actions"
	{loading}
	{error}
	onretry={load}
	empty={!items.length}
	emptyText="Alle Abrechnungen sind abgeschlossen."
>
	<ul class="divide-y">
		{#each items as a (a.actionId)}
			<li class="py-2">
				<a
					href={`/modules/actions/${a.actionId}?tab=accounting`}
					class="block rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span class="block truncate font-medium">{a.name}</span>
					<span class="block text-xs text-muted-foreground tabular-nums">
						Ende {fmtDate(a.endsOn)} · {a.entryCount
							? plural(a.entryCount, 'Buchung', 'Buchungen')
							: 'noch keine Buchungen'}
					</span>
					{#if a.missingReceipts || a.openReimbursements}
						<span class="block text-xs text-warning tabular-nums">
							{[
								a.missingReceipts ? plural(a.missingReceipts, 'Beleg fehlt', 'Belege fehlen') : '',
								a.openReimbursements
									? plural(a.openReimbursements, 'Auslage offen', 'Auslagen offen')
									: ''
							]
								.filter(Boolean)
								.join(' · ')}
						</span>
					{/if}
				</a>
			</li>
		{/each}
	</ul>
	{#if more}
		<p class="pt-1 text-xs text-muted-foreground">und {more} weitere</p>
	{/if}
</DashboardCard>
