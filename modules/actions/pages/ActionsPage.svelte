<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Upload from '@lucide/svelte/icons/upload';
	import Plus from '@lucide/svelte/icons/plus';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Table from '$lib/components/ui/table';
	import { DataTable, PageHeader, Pagination, SearchInput } from '$lib/components/layout';
	import type { ActionList, ActionSummary } from '../schemas';
	import { fmtPeriod } from './format';
	import ActionForm from './ActionForm.svelte';
	import ImportActionDialog from './ImportActionDialog.svelte';

	const PAGE_SIZE = 20;

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canCreate = $derived(can(permissions, 'actions.action.create'));

	const search = $derived(page.url.searchParams.get('search') ?? '');
	const offset = $derived(Math.max(0, Number(page.url.searchParams.get('offset')) || 0));

	let items = $state<ActionSummary[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let loadError = $state('');
	let formOpen = $state(false);
	let importOpen = $state(false);

	$effect(() => {
		const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
		if (search) q.set('search', search);
		let stale = false;
		loading = true;
		apiFetch<ActionList>(`/modules/actions/actions?${q}`)
			.then((r) => {
				if (stale) return;
				items = r.items;
				total = r.total;
				loadError = '';
			})
			.catch((e) => {
				if (!stale) loadError = e instanceof ApiClientError ? e.message : 'Laden fehlgeschlagen';
			})
			.finally(() => {
				if (!stale) loading = false;
			});
		return () => {
			stale = true;
		};
	});

	function accessLabel(a: ActionSummary) {
		if (a.access.isOwner) return 'Eigene';
		return a.access.level === 'edit' ? 'Bearbeiten' : 'Lesen';
	}
</script>

<svelte:head><title>Aktionen</title></svelte:head>

<PageHeader title="Aktionen" description="Aktionen und Fahrten planen und verwalten.">
	{#snippet actions()}
		{#if canCreate}
			<Button variant="outline" onclick={() => (importOpen = true)}><Upload /> Importieren</Button>
			<Button onclick={() => (formOpen = true)}><Plus /> Aktion anlegen</Button>
		{/if}
	{/snippet}
</PageHeader>

<DataTable
	caption="Aktionen"
	mobile="cards"
	{loading}
	error={loadError}
	empty={!items.length}
	emptyTitle="Keine Aktionen gefunden"
	emptyDescription={search
		? 'Passe die Suche an.'
		: 'Es sind noch keine Aktionen vorhanden oder für dich freigegeben.'}
>
	{#snippet toolbar()}
		<SearchInput placeholder="Aktion suchen …" label="Aktionen suchen" />
	{/snippet}
	{#snippet head()}
		<Table.Row>
			<Table.Head>Name</Table.Head>
			<Table.Head>Zeitraum</Table.Head>
			<Table.Head>Ort</Table.Head>
			<Table.Head class="text-right">Teilnehmende</Table.Head>
			<Table.Head>Besitzer*in</Table.Head>
			<Table.Head>Zugriff</Table.Head>
		</Table.Row>
	{/snippet}
	{#each items as a (a.id)}
		<Table.Row>
			<Table.Cell class="font-medium">
				<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
					<a href={`/modules/actions/${a.id}`} class="text-link hover:underline">{a.name}</a>
					{#if a.isPast}<Badge variant="outline" class="shrink-0">Vergangen</Badge>{/if}
				</div>
			</Table.Cell>
			<Table.Cell class="whitespace-nowrap">{fmtPeriod(a)}</Table.Cell>
			<Table.Cell>{a.location ?? '–'}</Table.Cell>
			<Table.Cell class="text-right">{a.participantCount}</Table.Cell>
			<Table.Cell>{a.owner.name}</Table.Cell>
			<Table.Cell>
				<Badge variant={a.access.isOwner ? 'default' : 'secondary'}>{accessLabel(a)}</Badge>
			</Table.Cell>
		</Table.Row>
	{/each}
	{#snippet footer()}
		{#if items.length}<Pagination {total} limit={PAGE_SIZE} {offset} />{/if}
	{/snippet}
</DataTable>

<ActionForm bind:open={formOpen} onsaved={(saved) => goto(`/modules/actions/${saved.id}`)} />
{#if canCreate}<ImportActionDialog bind:open={importOpen} />{/if}
