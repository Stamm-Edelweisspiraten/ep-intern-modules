<script lang="ts">
	// Reiter „Reservierungen“: Liste (Filter, Suche, Zeitraum) oder Monatsansicht, Detail, neue Reservierung.
	// URL: `?open=<id>` öffnet eine Reservierung, `?newFor=<aktion>&from=&to=&title=` den vorbelegten Dialog.
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import List from '@lucide/svelte/icons/list';
	import Plus from '@lucide/svelte/icons/plus';
	import { apiFetch, can, isRealDate, todayBerlin } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import { DataTable, ErrorState, MonthCalendar } from '$lib/components/layout';
	import type { CalendarItem } from '$lib/components/layout/month-calendar';
	import {
		PERMISSIONS,
		RESERVATION_STATUSES,
		RESERVATION_STATUS_LABELS,
		type Reservation,
		type ReservationListItem
	} from '../../schemas';
	import { API, errorText, formatPeriod } from '../helpers';
	import StatusBadge from '../shared/StatusBadge.svelte';
	import ReservationDetailDialog from './ReservationDetailDialog.svelte';
	import ReservationDialog from './ReservationDialog.svelte';
	import type { ReservationPrefill } from './scan';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canCreate = $derived(can(permissions, PERMISSIONS.reserve));

	type View = 'list' | 'month';

	let view = $state<View>('list');
	let status = $state<string | null>('open');
	let mine = $state(false);
	let search = $state('');
	let from = $state('');
	let to = $state('');
	let month = $state(todayBerlin().slice(0, 7));

	let items = $state<ReservationListItem[]>([]);
	let loading = $state(true);
	let error = $state('');

	let detailOpen = $state(false);
	let detailId = $state<string | null>(null);
	let createOpen = $state(false);
	let prefill = $state<ReservationPrefill | null>(null);

	const statusOptions = [
		{ value: 'open', label: 'Offen (reserviert + ausgegeben)' },
		{ value: 'all', label: 'Alle' },
		...RESERVATION_STATUSES.map((s) => ({ value: s, label: RESERVATION_STATUS_LABELS[s] }))
	];

	/** Zeitraum des angezeigten Monats (mit Rand für durchlaufende Wochen) */
	function monthRange(m: string): { from: string; to: string } {
		const [y, mo] = m.split('-').map(Number) as [number, number];
		const first = new Date(Date.UTC(y, mo - 1, 1));
		const last = new Date(Date.UTC(y, mo, 0));
		first.setUTCDate(first.getUTCDate() - 7);
		last.setUTCDate(last.getUTCDate() + 14);
		return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
	}

	let seq = 0;
	$effect(() => {
		const params = new URLSearchParams();
		params.set('status', status ?? 'open');
		if (mine) params.set('mine', '1');
		const q = search.trim();
		if (q) params.set('search', q);
		if (view === 'month') {
			const r = monthRange(month);
			params.set('from', r.from);
			params.set('to', r.to);
		} else {
			if (from && isRealDate(from)) params.set('from', from);
			if (to && isRealDate(to)) params.set('to', to);
		}
		const my = ++seq;
		const t = setTimeout(() => void load(params, my), q ? 250 : 0);
		return () => clearTimeout(t);
	});

	let lastParams: URLSearchParams | null = null;
	async function load(params: URLSearchParams | null = lastParams, my = ++seq) {
		if (!params) return;
		lastParams = params;
		loading = true;
		error = '';
		try {
			const list = await apiFetch<ReservationListItem[]>(`${API}/reservations?${params}`);
			if (my === seq) items = list;
		} catch (e) {
			if (my === seq) error = errorText(e, 'Reservierungen konnten nicht geladen werden.');
		} finally {
			if (my === seq) loading = false;
		}
	}
	const reload = () => load(lastParams);

	function openDetail(id: string) {
		detailId = id;
		detailOpen = true;
	}

	function startCreate(p: ReservationPrefill | null = null) {
		prefill = p;
		createOpen = true;
	}

	async function created(r: Reservation) {
		await reload();
		openDetail(r.id);
	}

	onMount(() => {
		const sp = page.url.searchParams;
		const open = sp.get('open');
		const newFor = sp.get('newFor');
		const keys = ['open', 'newFor', 'from', 'to', 'title'];
		if (open) openDetail(open);
		else if (newFor && canCreate) {
			const date = (v: string | null) => (v && isRealDate(v) ? v : null);
			const p: ReservationPrefill = {
				actionId: newFor,
				from: date(sp.get('from')),
				to: date(sp.get('to')),
				title: sp.get('title')
			};
			// Aktionsname für die Anzeige (falls die Aktion sichtbar ist)
			void apiFetch<{ action: { name: string } }>(`${API}/reservations/by-action/${newFor}`)
				.then((res) => {
					p.actionName = res.action.name;
				})
				.catch(() => undefined)
				.finally(() => startCreate(p));
		}
		if (keys.some((k) => sp.has(k))) {
			const url = new URL(page.url);
			for (const k of keys) url.searchParams.delete(k);
			void tick().then(() => {
				try {
					replaceState(url, {});
				} catch {
					// Router noch nicht bereit – Parameter bleiben dann stehen
				}
			});
		}
	});

	const calendarItems = $derived<CalendarItem[]>(
		items.map((r) => ({
			id: r.id,
			title: r.overdue ? `${r.title} (überfällig)` : r.title,
			startsOn: r.startsOn,
			endsOn: r.endsOn
		}))
	);
	const filtered = $derived(!!(search.trim() || from || to || mine || status !== 'open'));
</script>

{#snippet filters()}
	<div class="flex w-full flex-col gap-2">
		<div class="flex flex-wrap items-center gap-2">
			<SelectField
				size="sm"
				class="w-full sm:w-60"
				label="Status"
				options={statusOptions}
				bind:value={status}
			/>
			<Button
				size="sm"
				variant={mine ? 'default' : 'outline'}
				aria-pressed={mine}
				onclick={() => (mine = !mine)}
			>
				Nur meine
			</Button>
			<Input
				type="search"
				class="h-8 min-w-40 flex-1 sm:max-w-60"
				placeholder="Titel suchen …"
				aria-label="Reservierungen durchsuchen"
				bind:value={search}
			/>
			<div class="flex gap-1" role="group" aria-label="Ansicht">
				<Button
					size="icon-sm"
					variant={view === 'list' ? 'default' : 'outline'}
					aria-pressed={view === 'list'}
					aria-label="Liste"
					onclick={() => (view = 'list')}
				>
					<List />
				</Button>
				<Button
					size="icon-sm"
					variant={view === 'month' ? 'default' : 'outline'}
					aria-pressed={view === 'month'}
					aria-label="Monatsansicht"
					onclick={() => (view = 'month')}
				>
					<CalendarDays />
				</Button>
			</div>
			{#if canCreate}
				<Button size="sm" class="sm:ml-auto" onclick={() => startCreate()}>
					<Plus /> Neue Reservierung
				</Button>
			{/if}
		</div>
		{#if view === 'list'}
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<label class="flex items-center gap-2">
					<span class="text-muted-foreground">Zeitraum von</span>
					<Input type="date" class="h-8 w-40" bind:value={from} aria-label="Zeitraum von" />
				</label>
				<label class="flex items-center gap-2">
					<span class="text-muted-foreground">bis</span>
					<Input type="date" class="h-8 w-40" bind:value={to} min={from || undefined} />
				</label>
				{#if from || to}
					<Button
						size="sm"
						variant="ghost"
						onclick={() => {
							from = '';
							to = '';
						}}
					>
						Zurücksetzen
					</Button>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#if view === 'month'}
	<div class="space-y-4 rounded-lg border bg-card p-3 sm:p-4">
		<div class="flex flex-wrap items-center gap-2">{@render filters()}</div>
		{#if error}
			<ErrorState message={error} onretry={reload} compact />
		{:else}
			<MonthCalendar
				items={calendarItems}
				bind:month
				{loading}
				onselect={(it) => openDetail(it.id)}
				onday={canCreate ? (d) => startCreate({ from: d, to: d }) : undefined}
			/>
		{/if}
	</div>
{:else}
	<DataTable
		mobile="cards"
		caption="Materialreservierungen"
		loading={loading && !items.length}
		{error}
		onretry={reload}
		empty={!loading && !error && !items.length}
		emptyTitle="Keine Reservierungen"
		toolbar={filters}
		emptyDescription={filtered
			? 'Keine Reservierung passt zum Filter.'
			: 'Es gibt gerade keine offenen Reservierungen.'}
	>
		{#snippet head()}
			<Table.Row>
				<Table.Head>Titel</Table.Head>
				<Table.Head>Zeitraum</Table.Head>
				<Table.Head>Aktion</Table.Head>
				<Table.Head>Positionen</Table.Head>
				<Table.Head>Von</Table.Head>
				<Table.Head>Status</Table.Head>
			</Table.Row>
		{/snippet}
		{#each items as r (r.id)}
			<Table.Row class="cursor-pointer" onclick={() => openDetail(r.id)}>
				<Table.Cell class="font-medium">
					<button
						type="button"
						class="min-h-9 text-left underline-offset-4 hover:underline"
						onclick={(e) => {
							e.stopPropagation();
							openDetail(r.id);
						}}
					>
						{r.title}
					</button>
				</Table.Cell>
				<Table.Cell class="whitespace-nowrap tabular-nums">
					{formatPeriod(r.startsOn, r.endsOn)}
				</Table.Cell>
				<Table.Cell>
					{#if r.actionId}
						<a
							class="text-link hover:underline"
							href={`/modules/actions/${r.actionId}`}
							onclick={(e) => e.stopPropagation()}
						>
							{r.actionName ?? 'Aktion'}
						</a>
					{:else}
						<span class="text-muted-foreground">–</span>
					{/if}
				</Table.Cell>
				<Table.Cell class="max-w-72">
					<span class="line-clamp-2 text-sm" title={r.itemSummary}>
						{r.itemSummary || '–'}
					</span>
				</Table.Cell>
				<Table.Cell class="whitespace-nowrap">{r.createdByName}</Table.Cell>
				<Table.Cell>
					<StatusBadge status={r.status} overdue={r.overdue} />
				</Table.Cell>
			</Table.Row>
		{/each}
	</DataTable>
{/if}

<ReservationDetailDialog bind:open={detailOpen} id={detailId} onchanged={reload} />
{#if canCreate}
	<ReservationDialog bind:open={createOpen} {prefill} onsaved={created} />
{/if}
