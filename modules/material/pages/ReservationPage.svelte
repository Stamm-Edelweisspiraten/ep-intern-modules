<script lang="ts">
	// Eine Reservierung als eigene Seite (`reservierung/:id`): Rücklink je Recht, Objektkopf,
	// danach Befund, Positionen, ausgegebene Stücke und Aktionen aus `ReservationView`.
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { apiFetch, can } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import { Button } from '$lib/components/ui/button';
	import { ErrorState, LoadingState, PageTitle } from '$lib/components/layout';
	import { BASE_PATH, PERMISSIONS, type Reservation } from '../schemas';
	import { API, errorText, formatPeriod } from './helpers';
	import StatusBadge from './shared/StatusBadge.svelte';
	import ReservationView from './reservations/ReservationView.svelte';

	let { params }: ModulePageProps = $props();

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const back = $derived(
		can(permissions, PERMISSIONS.reservations)
			? { href: `${BASE_PATH}/ausgabe`, label: 'Ausgabe & Rückgabe' }
			: can(permissions, PERMISSIONS.reserve)
				? { href: `${BASE_PATH}/meine`, label: 'Meine Reservierungen' }
				: { href: BASE_PATH, label: 'Ausleihen' }
	);

	let r = $state<Reservation | null>(null);
	let loading = $state(true);
	let error = $state('');

	let loadedId: string | null = null;
	$effect(() => {
		const id = params.id ?? '';
		if (id === loadedId) return;
		loadedId = id;
		void load(id);
	});

	async function load(id = loadedId ?? '') {
		loading = true;
		error = '';
		try {
			r = await apiFetch<Reservation>(`${API}/reservations/${encodeURIComponent(id)}`);
		} catch (e) {
			r = null;
			error = errorText(e, 'Die Reservierung konnte nicht geladen werden.');
		} finally {
			loading = false;
		}
	}
</script>

<PageTitle title={r ? `Reservierung ${r.title}` : 'Reservierung'} />

<div class="mx-auto max-w-4xl pb-24 sm:pb-0">
	<a
		href={back.href}
		class="mb-4 inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" aria-hidden="true" />
		{back.label}
	</a>

	{#if loading && !r}
		<LoadingState label="Reservierung" rows={5} />
	{:else if error || !r}
		<ErrorState message={error} onretry={() => load()}>
			{#snippet details()}
				<Button href={back.href} variant="outline">Zu „{back.label}“</Button>
			{/snippet}
		</ErrorState>
	{:else}
		<header class="mb-6 space-y-1">
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h1 class="text-title break-words">{r.title}</h1>
				<StatusBadge status={r.status} overdue={r.overdue} />
			</div>
			<p class="text-sm text-muted-foreground">
				<span class="tabular-nums">{formatPeriod(r.startsOn, r.endsOn)}</span>
				{#if r.actionId}
					· Aktion
					<a class="text-link hover:underline" href={`/modules/actions/${r.actionId}`}>
						{r.actionName ?? 'Aktion'}
					</a>
				{/if}
				· von {r.createdByName}
			</p>
		</header>

		<ReservationView
			reservation={r}
			showAction={false}
			onchanged={(next) => {
				r = next;
			}}
			ondeleted={() => goto(back.href)}
		/>
	{/if}
</div>
