<script lang="ts">
	// Reservierung als Dialog (z. B. aus Listen, die nicht zur Seite wechseln sollen). Inhalt und
	// Aktionen kommen aus `ReservationView`; die eigene Seite ist `reservierung/:id`.
	import { apiFetch } from '$lib/sdk/client';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ErrorState, LoadingState } from '$lib/components/layout';
	import type { Reservation } from '../../schemas';
	import { API, errorText, formatPeriod, reservationHref } from '../helpers';
	import StatusBadge from '../shared/StatusBadge.svelte';
	import ReservationView from './ReservationView.svelte';

	let {
		open = $bindable(false),
		id,
		onchanged
	}: {
		open?: boolean;
		id: string | null;
		/** Reservierung geändert/gelöscht (Liste neu laden) */
		onchanged?: () => void | Promise<void>;
	} = $props();

	let r = $state<Reservation | null>(null);
	let loading = $state(false);
	let error = $state('');

	$effect(() => {
		if (open && id) void load(id);
	});

	async function load(rid = id) {
		if (!rid) return;
		loading = true;
		error = '';
		try {
			r = await apiFetch<Reservation>(`${API}/reservations/${rid}`);
		} catch (e) {
			r = null;
			error = errorText(e, 'Reservierung konnte nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	async function changed(next: Reservation) {
		r = next;
		await onchanged?.();
	}

	async function deleted() {
		open = false;
		r = null;
		await onchanged?.();
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		{#if loading && !r}
			<Dialog.Header>
				<Dialog.Title>Reservierung</Dialog.Title>
			</Dialog.Header>
			<LoadingState label="Reservierung" rows={4} />
		{:else if error || !r}
			<Dialog.Header>
				<Dialog.Title>Reservierung</Dialog.Title>
			</Dialog.Header>
			<ErrorState message={error} onretry={() => load()} compact />
		{:else}
			<Dialog.Header>
				<Dialog.Title class="flex flex-wrap items-center gap-2">
					{r.title}
					<StatusBadge status={r.status} overdue={r.overdue} />
				</Dialog.Title>
				<Dialog.Description>
					<span class="tabular-nums">{formatPeriod(r.startsOn, r.endsOn)}</span> · von {r.createdByName}
					· <a class="text-link hover:underline" href={reservationHref(r.id)}>Als Seite öffnen</a>
				</Dialog.Description>
			</Dialog.Header>
			<ReservationView reservation={r} onchanged={changed} ondeleted={deleted} headingLevel={3} />
		{/if}
	</Dialog.Content>
</Dialog.Root>
