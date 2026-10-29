<script lang="ts">
	// Dashboard-Kachel „Kasse“: Kontostände je Konto mit Summe und offene Forderungen
	// (aus der Kassen-Übersicht `GET /overview`, Recht `treasury.cash.view`).
	import { onMount } from 'svelte';
	import Wallet from '@lucide/svelte/icons/wallet';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { Account, Overview } from '../../schemas';
	import { BASE, errorMessage } from '../helpers';

	let { onstatus }: DashboardWidgetProps = $props();

	let accounts = $state<Account[]>([]);
	let openCents = $state(0);
	let overdueCents = $state(0);
	let overdueCount = $state(0);
	let loadedAt = $state<Date | null>(null);
	let loading = $state(true);
	let error = $state('');

	// Summe aus den angezeigten Zeilen (nicht aus einem getrennten Serverwert)
	const total = $derived(accounts.reduce((s, a) => s + a.balanceCents, 0));
	const stand = $derived(
		loadedAt
			? loadedAt.toLocaleTimeString('de-DE', {
					hour: '2-digit',
					minute: '2-digit',
					timeZone: 'Europe/Berlin'
				})
			: ''
	);

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			const o = await apiFetch<Overview>(`${BASE}/overview`);
			accounts = o.accounts;
			openCents = o.openCents;
			overdueCents = o.overdueCents;
			overdueCount = o.overdueCount;
			loadedAt = new Date();
			onstatus?.(accounts.length || openCents ? 'ready' : 'empty');
		} catch (e) {
			error = errorMessage(e, 'Kontostände konnten nicht geladen werden.');
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
	title="Kasse"
	description={stand ? `Stand ${stand} Uhr` : undefined}
	icon={Wallet}
	href={BASE}
	hrefLabel="Zur Kasse"
	{loading}
	{error}
	onretry={load}
	empty={!accounts.length && !openCents}
	emptyText="Noch keine Konten angelegt."
	skeletonRows={4}
>
	{#if accounts.length}
		<table class="w-full">
			<caption class="sr-only">Kontostände</caption>
			<thead class="sr-only">
				<tr><th scope="col">Konto</th><th scope="col">Stand</th></tr>
			</thead>
			<tbody class="divide-y">
				{#each accounts as a (a.id)}
					<tr>
						<th scope="row" class="max-w-0 truncate py-1.5 pr-2 text-left font-normal">
							{a.name}
						</th>
						<td
							class={[
								'py-1.5 text-right whitespace-nowrap tabular-nums',
								a.balanceCents < 0 && 'text-destructive'
							]}
						>
							{formatEuro(a.balanceCents)}
						</td>
					</tr>
				{/each}
			</tbody>
			{#if accounts.length > 1}
				<tfoot class="border-t">
					<tr>
						<th scope="row" class="py-1.5 pr-2 text-left font-medium">Gesamt</th>
						<td
							class={[
								'py-1.5 text-right font-semibold whitespace-nowrap tabular-nums',
								total < 0 && 'text-destructive'
							]}
						>
							{formatEuro(total)}
						</td>
					</tr>
				</tfoot>
			{/if}
		</table>
	{/if}
	<a
		href={`${BASE}?tab=income&view=open`}
		class="mt-3 flex items-baseline justify-between gap-2 rounded-md border p-2.5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
	>
		<span class="min-w-0">
			<span class="block text-xs text-muted-foreground">Offene Forderungen</span>
			{#if overdueCount > 0}
				<span class="block text-xs font-medium text-destructive tabular-nums">
					{overdueCount}
					{overdueCount === 1 ? 'Rechnung' : 'Rechnungen'} überfällig ({formatEuro(overdueCents)})
				</span>
			{:else}
				<span class="block text-xs text-muted-foreground">nichts überfällig</span>
			{/if}
		</span>
		<span class="shrink-0 text-lg font-semibold tabular-nums">{formatEuro(openCents)}</span>
	</a>
</DashboardCard>
