<script lang="ts">
	// „Alle Reservierungen“ auf der Seite „Ausgabe & Rückgabe“: Liste (Status, nur meine, Suche,
	// Zeitraum) oder Monatsansicht. Ein Klick öffnet die Seite der Reservierung.
	import { goto } from '$app/navigation';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import List from '@lucide/svelte/icons/list';
	import { apiFetch, isRealDate, todayBerlin } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import { DataTable, ErrorState, MonthCalendar } from '$lib/components/layout';
	import type { CalendarItem } from '$lib/components/layout/month-calendar';
	import {
		RESERVATION_STATUSES,
		RESERVATION_STATUS_LABELS,
		type ReservationListItem
	} from '../../schemas';
	import { API, errorText, formatPeriod, reservationHref } from '../helpers';
	import StatusBadge from '../shared/StatusBadge.svelte';

	let {
		refreshKey = 0
	}: {
		/** Hochzählen lädt die Liste neu (z. B. nach Ausgabe/Rückgabe) */
		refreshKey?: number;
	} = $props();

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
		void refreshKey;
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

	const open = (id: string) => goto(reservationHref(id));

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
				variant={mine ? 'secondary' : 'outline'}
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
				name="q"
				autocomplete="off"
				spellcheck={false}
				bind:value={search}
			/>
			<div class="flex gap-1 sm:ml-auto" role="group" aria-label="Ansicht">
				<Button
					size="icon-sm"
					variant={view === 'list' ? 'secondary' : 'ghost'}
					aria-pressed={view === 'list'}
					aria-label="Liste"
					onclick={() => (view = 'list')}
				>
					<List />
				</Button>
				<Button
					size="icon-sm"
					variant={view === 'month' ? 'secondary' : 'ghost'}
					aria-pressed={view === 'month'}
					aria-label="Monatsansicht"
					onclick={() => (view = 'month')}
				>
					<CalendarDays />
				</Button>
			</div>
		</div>
		{#if view === 'list'}
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<label class="flex items-center gap-2">
					<span class="text-muted-foreground">Zeitraum von</span>
					<Input type="date" class="h-8 w-40" bind:value={from} />
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
			<MonthCalendar items={calendarItems} bind:month {loading} onselect={(it) => open(it.id)} />
		{/if}
	</div>
{:else}
	<DataTable
		mobile="cards"
		caption="Alle Materialreservierungen"
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
			<Table.Row class="cursor-pointer" onclick={() => open(r.id)}>
				<Table.Cell class="font-medium">
					<a
						href={reservationHref(r.id)}
						class="inline-flex min-h-9 items-center underline-offset-4 hover:underline"
						onclick={(e) => e.stopPropagation()}
					>
						{r.title}
					</a>
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
