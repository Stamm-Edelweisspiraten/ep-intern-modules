<script lang="ts">
	// Dashboard-Kachel „Meine Anmeldungen“: kommende Aktionen, bei denen ich oder meine verknüpften
	// Mitglieder angemeldet sind. Link auf die Aktion nur mit `actions.action.view`.
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Tent from '@lucide/svelte/icons/tent';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { MyRegistration } from '../../schemas';
	import { fmtPeriod } from '../format';

	let { onstatus }: DashboardWidgetProps = $props();

	const LIMIT = 5;

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canOpen = $derived(can(permissions, 'actions.action.view'));

	let items = $state<MyRegistration[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			const list = await apiFetch<MyRegistration[]>('/modules/actions/my/registrations');
			total = list.length;
			items = list.slice(0, LIMIT);
			onstatus?.(items.length ? 'ready' : 'empty');
		} catch (e) {
			error =
				e instanceof ApiClientError && e.message
					? e.message
					: 'Anmeldungen konnten nicht geladen werden.';
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	const more = $derived(Math.max(0, total - items.length));
</script>

{#snippet body(r: MyRegistration)}
	<span class="flex items-start justify-between gap-2">
		<span class="min-w-0">
			<span class="block truncate font-medium">{r.name}</span>
			<span class="block truncate text-xs text-muted-foreground tabular-nums">
				{fmtPeriod(r)}{r.location ? ` · ${r.location}` : ''}
			</span>
			<span class="block truncate text-xs text-muted-foreground">{r.people.join(', ')}</span>
		</span>
		{#if r.feeCents !== null}
			<span class="shrink-0 text-right text-xs tabular-nums">
				<span class="block font-medium text-foreground">{formatEuro(r.feeCents)}</span>
				<span class="block text-muted-foreground">Beitrag</span>
			</span>
		{/if}
	</span>
{/snippet}

<DashboardCard
	title="Meine Anmeldungen"
	icon={Tent}
	href={canOpen ? '/modules/actions' : undefined}
	{loading}
	{error}
	onretry={load}
	empty={!items.length}
	emptyText="Keine kommenden Anmeldungen."
>
	<ul class="divide-y">
		{#each items as r (r.actionId)}
			<li class="py-2">
				{#if canOpen}
					<a
						href={`/modules/actions/${r.actionId}`}
						class="block rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
					>
						{@render body(r)}
					</a>
				{:else}
					{@render body(r)}
				{/if}
			</li>
		{/each}
	</ul>
	{#if more}
		<p class="pt-1 text-xs text-muted-foreground">und {more} weitere</p>
	{/if}
</DashboardCard>
