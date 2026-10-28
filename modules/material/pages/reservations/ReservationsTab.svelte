<script lang="ts">
	// Reiter „Meine Reservierungen“ / „Alle Reservierungen“ (Muster `orders/MyOrdersTab`):
	// Tabelle mit Filtern, Seitenwechsel, Detail-Dialog per Zeilenklick (`?open=`), Export.
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import FileDown from '@lucide/svelte/icons/file-down';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import { DataTable } from '$lib/components/layout';
	import {
		PERMISSIONS,
		PURPOSE_LABELS,
		PURPOSES,
		type ReservationListItem,
		type ReservationPage
	} from '../../schemas';
	import {
		API,
		RESERVATION_STATE_LABELS,
		STATE_VARIANTS,
		errorText,
		formatPeriod,
		safeReplaceState
	} from '../helpers';
	import ReservationDetailDialog from './ReservationDetailDialog.svelte';
	import ReservationsExportDialog from './ReservationsExportDialog.svelte';

	let {
		scope,
		openId = null,
		onedit,
		onreserve
	}: {
		scope: 'mine' | 'all';
		/** Reservierung direkt öffnen (nach dem Speichern oder per `?open=`) */
		openId?: string | null;
		onedit: (id: string) => void;
		onreserve: () => void;
	} = $props();

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canReserve = $derived(can(permissions, PERMISSIONS.reserve));

	const LIMIT = 50;
	let stateFilter = $state<string | null>('open');
	let purpose = $state<string | null>(null);
	let search = $state('');
	let offset = $state(0);
	let data = $state<ReservationPage | null>(null);
	let loading = $state(true);
	let error = $state('');

	const stateOptions = [
		{ value: 'open', label: 'Offen' },
		{ value: 'past', label: 'Vergangen' },
		{ value: 'cancelled', label: 'Storniert' },
		{ value: 'all', label: 'Alle' }
	];
	const purposeOptions = PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABELS[p] }));

	const query = $derived.by(() => {
		const p = new URLSearchParams({
			scope,
			state: stateFilter ?? 'open',
			limit: String(LIMIT),
			offset: String(offset)
		});
		if (scope === 'all' && purpose) p.set('purpose', purpose);
		if (search.trim()) p.set('search', search.trim());
		return p.toString();
	});

	let seq = 0;
	async function load(q = query) {
		const mySeq = ++seq;
		loading = !data;
		error = '';
		try {
			const result = await apiFetch<ReservationPage>(`${API}/reservations?${q}`);
			if (mySeq === seq) data = result;
		} catch (e) {
			if (mySeq === seq) error = errorText(e, 'Reservierungen konnten nicht geladen werden.');
		} finally {
			if (mySeq === seq) loading = false;
		}
	}

	$effect(() => {
		const q = query;
		const t = setTimeout(() => void load(q), search ? 250 : 0);
		return () => clearTimeout(t);
	});

	// --- Detail ------------------------------------------------------------------
	let detailId = $state<string | null>(null);
	let detailOpen = $state(false);
	let detailKey = $state(0);
	let exportOpen = $state(false);

	function openDetail(id: string) {
		detailId = id;
		detailKey++;
		detailOpen = true;
	}

	onMount(() => {
		const id = openId ?? page.url.searchParams.get('open');
		if (id) {
			openDetail(id);
			const url = new URL(page.url);
			url.searchParams.delete('open');
			safeReplaceState(url);
		}
	});

	function purposeText(r: ReservationListItem): string {
		if (r.purpose === 'action') return r.actionName ?? PURPOSE_LABELS.action;
		if (r.purpose === 'group') return r.groupName ?? PURPOSE_LABELS.group;
		return PURPOSE_LABELS.other;
	}

	const pages = $derived(data ? Math.max(1, Math.ceil(data.total / LIMIT)) : 1);
	const current = $derived(Math.floor(offset / LIMIT) + 1);
	const filtered = $derived(stateFilter !== 'open' || !!purpose || !!search.trim());
</script>

<DataTable
	mobile="cards"
	caption={scope === 'mine' ? 'Meine Reservierungen' : 'Alle Reservierungen'}
	{loading}
	{error}
	onretry={() => load()}
	empty={!!data && !data.items.length}
	emptyTitle="Keine Reservierungen"
	emptyDescription={filtered
		? 'Keine Reservierung passt zum Filter.'
		: scope === 'mine'
			? 'Du hast noch kein Material reserviert.'
			: 'Es gibt noch keine Reservierungen.'}
>
	{#snippet toolbar()}
		<div class="relative w-full sm:w-56">
			<Search
				class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
				aria-hidden="true"
			/>
			<Input
				type="search"
				class="h-8 pl-8"
				placeholder="Titel suchen …"
				aria-label="Reservierungen suchen"
				bind:value={search}
				oninput={() => (offset = 0)}
			/>
		</div>
		<SelectField
			class="w-full sm:w-40"
			size="sm"
			label="Status"
			options={stateOptions}
			bind:value={stateFilter}
			onchange={() => (offset = 0)}
		/>
		{#if scope === 'all'}
			<SelectField
				class="w-full sm:w-40"
				size="sm"
				label="Zweck"
				options={purposeOptions}
				bind:value={purpose}
				emptyLabel="Alle Zwecke"
				placeholder="Alle Zwecke"
				onchange={() => (offset = 0)}
			/>
		{/if}
		<div class="flex gap-2 sm:ml-auto">
			<Button variant="outline" size="sm" onclick={() => (exportOpen = true)}>
				<FileDown /> Export
			</Button>
			{#if canReserve}
				<Button size="sm" onclick={onreserve}><Plus /> Reservieren</Button>
			{/if}
		</div>
	{/snippet}
	{#snippet emptyAction()}
		{#if canReserve && !filtered}
			<Button onclick={onreserve}><Plus /> Material reservieren</Button>
		{/if}
	{/snippet}
	{#snippet head()}
		<Table.Row>
			<Table.Head>Zeitraum</Table.Head>
			<Table.Head>Titel</Table.Head>
			<Table.Head>Zweck</Table.Head>
			<Table.Head>Material</Table.Head>
			{#if scope === 'all'}<Table.Head>Reserviert von</Table.Head>{/if}
			<Table.Head>Status</Table.Head>
		</Table.Row>
	{/snippet}
	{#each data?.items ?? [] as r (r.id)}
		<Table.Row class="cursor-pointer" onclick={() => openDetail(r.id)}>
			<Table.Cell class="whitespace-nowrap tabular-nums">
				{formatPeriod(r.startsOn, r.endsOn)}
			</Table.Cell>
			<Table.Cell class="font-medium">
				<button
					type="button"
					class="text-left hover:underline"
					onclick={(e) => {
						e.stopPropagation();
						openDetail(r.id);
					}}
				>
					{r.title}
				</button>
			</Table.Cell>
			<Table.Cell>
				<span class="text-xs text-muted-foreground">{PURPOSE_LABELS[r.purpose]}</span>
				{#if r.purpose !== 'other'}<div class="truncate">{purposeText(r)}</div>{/if}
			</Table.Cell>
			<Table.Cell class="max-w-80">
				<div class="line-clamp-2" title={r.itemSummary}>{r.itemSummary}</div>
			</Table.Cell>
			{#if scope === 'all'}<Table.Cell>{r.createdByName}</Table.Cell>{/if}
			<Table.Cell>
				<span class="flex flex-wrap gap-1">
					<Badge variant={STATE_VARIANTS[r.state]}>{RESERVATION_STATE_LABELS[r.state]}</Badge>
					{#if r.handedOut && r.state !== 'cancelled'}<Badge variant="success">Ausgegeben</Badge
						>{/if}
				</span>
			</Table.Cell>
		</Table.Row>
	{/each}
	{#snippet footer()}
		{#if data && data.total > LIMIT}
			<div class="flex items-center justify-between gap-2 text-sm">
				<span class="text-muted-foreground tabular-nums">
					Seite {current} von {pages} · {data.total} Reservierungen
				</span>
				<div class="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={offset === 0}
						onclick={() => (offset = Math.max(0, offset - LIMIT))}>Zurück</Button
					>
					<Button
						variant="outline"
						size="sm"
						disabled={current >= pages}
						onclick={() => (offset += LIMIT)}>Weiter</Button
					>
				</div>
			</div>
		{/if}
	{/snippet}
</DataTable>

{#if detailId}
	{#key detailKey}
		<ReservationDetailDialog
			bind:open={detailOpen}
			id={detailId}
			{onedit}
			onchanged={() => load()}
		/>
	{/key}
{/if}

<ReservationsExportDialog bind:open={exportOpen} />
