<script lang="ts">
	// Meine Reservierungen: offene (reserviert/ausgegeben) als Liste, erledigte eingeklappt.
	import { onMount } from 'svelte';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { Button } from '$lib/components/ui/button';
	import {
		EmptyState,
		ErrorState,
		LoadingState,
		PageHeader,
		deviceLayout
	} from '$lib/components/layout';
	import { apiFetch, todayBerlin } from '$lib/sdk/client';
	import { BASE_PATH, type ReservationListItem } from '../schemas';
	import { API, errorText, formatDate, formatPeriod, reservationHref } from './helpers';
	import MaterialNav from './MaterialNav.svelte';
	import StatusBadge from './shared/StatusBadge.svelte';

	let items = $state<ReservationListItem[]>([]);
	let loading = $state(true);
	let error = $state('');

	let doneOpen = $state(false);
	let done = $state<ReservationListItem[] | null>(null);
	let doneLoading = $state(false);
	let doneError = $state('');

	const phone = $derived(deviceLayout() === 'phone');

	async function load() {
		loading = true;
		error = '';
		try {
			const list = await apiFetch<ReservationListItem[]>(`${API}/my/reservations`);
			// Überfällige zuerst, dann nach Beginn
			items = [...list].sort(
				(a, b) => Number(b.overdue) - Number(a.overdue) || a.startsOn.localeCompare(b.startsOn)
			);
		} catch (e) {
			error = errorText(e, 'Deine Reservierungen konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	async function loadDone() {
		doneLoading = true;
		doneError = '';
		try {
			const list = await apiFetch<ReservationListItem[]>(
				`${API}/reservations?mine=1&status=returned`
			);
			done = [...list].sort((a, b) => b.endsOn.localeCompare(a.endsOn));
		} catch (e) {
			doneError = errorText(e, 'Erledigte Reservierungen konnten nicht geladen werden.');
		} finally {
			doneLoading = false;
		}
	}

	function toggleDone() {
		doneOpen = !doneOpen;
		if (doneOpen && !done && !doneLoading) void loadDone();
	}

	onMount(() => {
		void load();
	});

	const today = todayBerlin();
	const overdue = $derived(items.filter((r) => r.overdue).length);
	const issued = $derived(items.filter((r) => r.status === 'issued' && !r.overdue).length);
	const startsSoon = $derived(
		items
			.filter((r) => r.status === 'reserved' && r.startsOn >= today)
			.sort((a, b) => a.startsOn.localeCompare(b.startsOn))[0]
	);

	const finding = $derived.by(() => {
		if (loading) return 'Deine Reservierungen werden geladen.';
		if (error) return 'Deine Reservierungen konnten nicht geladen werden.';
		if (!items.length) return 'Du hast gerade keine offenen Reservierungen.';
		const parts = [
			`Du hast ${items.length} offene ${items.length === 1 ? 'Reservierung' : 'Reservierungen'}`
		];
		if (issued) parts.push(`${issued} ausgegeben`);
		if (overdue) parts.push(`${overdue} ${overdue === 1 ? 'Rückgabe' : 'Rückgaben'} überfällig`);
		else if (startsSoon) parts.push(`die nächste beginnt am ${formatDate(startsSoon.startsOn)}`);
		return `${parts.join(', ')}.`;
	});
</script>

<PageHeader title="Meine Reservierungen" description={finding}>
	{#snippet actions()}
		<Button href={BASE_PATH}>Material ausleihen</Button>
	{/snippet}
</PageHeader>
<MaterialNav />

{#snippet row(r: ReservationListItem)}
	<li>
		<a
			href={reservationHref(r.id)}
			class="flex min-h-16 items-center gap-3 rounded-md py-2 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
		>
			<span class="min-w-0 flex-1">
				<span class="block truncate font-medium">{r.title}</span>
				<span class="block truncate text-sm text-muted-foreground">
					<span class="tabular-nums">{formatPeriod(r.startsOn, r.endsOn)}</span>{r.actionName
						? ` · ${r.actionName}`
						: ''}
				</span>
				{#if r.itemSummary}
					<span class="block truncate text-xs text-muted-foreground">{r.itemSummary}</span>
				{/if}
			</span>
			<StatusBadge status={r.status} overdue={r.overdue} class="shrink-0" />
			<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		</a>
	</li>
{/snippet}

<div class={['space-y-8', phone && 'pb-24']}>
	<section aria-labelledby="mine-open">
		<h2 id="mine-open" class="text-section">Offen</h2>
		{#if loading}
			<LoadingState label="Reservierungen" rows={3} rowClass="h-16 w-full" class="mt-2" />
		{:else if error}
			<ErrorState message={error} onretry={load} busy={loading} class="mt-2" />
		{:else if !items.length}
			<EmptyState
				title="Keine offenen Reservierungen"
				description="Unter „Ausleihen“ siehst du, was im Zeitraum frei ist, und reservierst mit einem Klick."
			>
				<Button href={BASE_PATH}>Material ausleihen</Button>
			</EmptyState>
		{:else}
			<ul class="mt-2 divide-y border-y">
				{#each items as r (r.id)}
					{@render row(r)}
				{/each}
			</ul>
		{/if}
	</section>

	<section aria-labelledby="mine-done">
		<h2 id="mine-done" class="text-section">
			<button
				type="button"
				class="flex items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
				aria-expanded={doneOpen}
				aria-controls="mine-done-list"
				onclick={toggleDone}
			>
				<ChevronDown
					class={['size-4 transition-transform', !doneOpen && '-rotate-90']}
					aria-hidden="true"
				/>
				Erledigt
			</button>
		</h2>
		<div id="mine-done-list" hidden={!doneOpen}>
			{#if doneOpen}
				{#if doneLoading}
					<LoadingState
						label="erledigte Reservierungen"
						rows={2}
						rowClass="h-16 w-full"
						class="mt-2"
					/>
				{:else if doneError}
					<ErrorState compact message={doneError} onretry={loadDone} class="mt-2" />
				{:else if done && !done.length}
					<p class="mt-2 text-sm text-muted-foreground">Noch nichts zurückgegeben.</p>
				{:else if done}
					<ul class="mt-2 divide-y border-y">
						{#each done as r (r.id)}
							{@render row(r)}
						{/each}
					</ul>
				{/if}
			{/if}
		</div>
	</section>
</div>
