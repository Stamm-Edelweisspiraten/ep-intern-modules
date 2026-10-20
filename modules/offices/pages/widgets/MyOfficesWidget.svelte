<script lang="ts">
	// Dashboard-Kachel „Meine Ämter“: eigene Ämter, Hinweis auf die Benachrichtigungen im Profil.
	import { onMount } from 'svelte';
	import Briefcase from '@lucide/svelte/icons/briefcase';
	import Bell from '@lucide/svelte/icons/bell';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { Badge } from '$lib/components/ui/badge';
	import { DashboardCard } from '$lib/components/layout';
	import type { MyOffices } from '../../schemas';
	import { BASE } from '../helpers';

	let { onstatus }: DashboardWidgetProps = $props();

	const MAX = 5;

	let offices = $state<MyOffices['offices']>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			const r = await apiFetch<MyOffices>(`${BASE}/me`);
			offices = r.offices;
			onstatus?.(offices.length ? 'ready' : 'empty');
		} catch (e) {
			error =
				e instanceof ApiClientError && e.message
					? e.message
					: 'Ämter konnten nicht geladen werden.';
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	const shown = $derived(offices.slice(0, MAX));
	const more = $derived(Math.max(0, offices.length - MAX));
</script>

<DashboardCard
	title="Meine Ämter"
	icon={Briefcase}
	href={BASE}
	{loading}
	{error}
	onretry={load}
	empty={!offices.length}
	emptyText="Du hast kein Amt."
	skeletonRows={2}
>
	<div class="space-y-3">
		<ul class="flex flex-wrap gap-1.5" aria-label="Deine Ämter">
			{#each shown as o (o.id)}
				<li><Badge variant="secondary">{o.name}</Badge></li>
			{/each}
			{#if more}
				<li><Badge variant="outline">+{more} weitere</Badge></li>
			{/if}
		</ul>
		<p class="flex items-start gap-1.5 text-xs text-muted-foreground">
			<Bell class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
			<span>
				Benachrichtigungen zu deinen Ämtern stellst du im
				<a href="/profile" class="font-medium text-foreground underline-offset-2 hover:underline"
					>Profil</a
				> ein.
			</span>
		</p>
	</div>
</DashboardCard>
