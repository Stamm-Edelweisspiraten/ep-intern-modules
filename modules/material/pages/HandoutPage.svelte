<script lang="ts">
	// „Ausgabe & Rückgabe“ für die Materialverwaltung: Befund, anstehende Ausgaben (7 Tage) und
	// erwartete Rückgaben nebeneinander (Handy untereinander), darunter alle Reservierungen.
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import { apiFetch, can, todayBerlin } from '$lib/sdk/client';
	import * as Alert from '$lib/components/ui/alert';
	import { PageHeader } from '$lib/components/layout';
	import { BASE_PATH, PERMISSIONS, type Reservation, type ReservationListItem } from '../schemas';
	import { API, errorText } from './helpers';
	import MaterialNav from './MaterialNav.svelte';
	import AllReservations from './handout/AllReservations.svelte';
	import HandoutQueue from './handout/HandoutQueue.svelte';
	import { handoutFinding, issueQuery, sortIssueQueue, sortReturnQueue } from './handout/handout';
	import IssueDialog from './reservations/IssueDialog.svelte';
	import ReturnDialog from './reservations/ReturnDialog.svelte';
	import { downloadHandoutPdf } from './reservations/handout-pdf';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const allowed = $derived(can(permissions, PERMISSIONS.reservations));
	const today = todayBerlin();

	let issues = $state<ReservationListItem[]>([]);
	let returns = $state<ReservationListItem[]>([]);
	let loading = $state(true);
	let issueError = $state('');
	let returnError = $state('');
	let refreshKey = $state(0);

	let active = $state<Reservation | null>(null);
	let issueOpen = $state(false);
	let returnOpen = $state(false);
	let busyId = $state<string | null>(null);
	let pdfBusyId = $state<string | null>(null);

	async function loadIssues() {
		issueError = '';
		try {
			const list = await apiFetch<ReservationListItem[]>(
				`${API}/reservations?${issueQuery(today)}`
			);
			issues = sortIssueQueue(list, today);
		} catch (e) {
			issueError = errorText(e, 'Anstehende Ausgaben konnten nicht geladen werden.');
		}
	}

	async function loadReturns() {
		returnError = '';
		try {
			const list = await apiFetch<ReservationListItem[]>(`${API}/reservations?status=issued`);
			returns = sortReturnQueue(list);
		} catch (e) {
			returnError = errorText(e, 'Erwartete Rückgaben konnten nicht geladen werden.');
		}
	}

	async function load() {
		loading = true;
		await Promise.all([loadIssues(), loadReturns()]);
		loading = false;
	}

	$effect(() => {
		if (allowed) void load();
	});

	const finding = $derived(handoutFinding(issues, returns, today));

	async function openDialog(item: ReservationListItem, kind: 'issue' | 'return') {
		busyId = item.id;
		try {
			active = await apiFetch<Reservation>(`${API}/reservations/${item.id}`);
			if (kind === 'issue') issueOpen = true;
			else returnOpen = true;
		} catch (e) {
			toast.error(errorText(e, 'Reservierung konnte nicht geladen werden'));
		} finally {
			busyId = null;
		}
	}

	async function pdf(item: ReservationListItem) {
		pdfBusyId = item.id;
		try {
			await downloadHandoutPdf(item.id, item.title);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'PDF konnte nicht erstellt werden');
		} finally {
			pdfBusyId = null;
		}
	}

	async function changed(next: Reservation) {
		active = next;
		refreshKey++;
		await load();
	}
</script>

<PageHeader title="Ausgabe & Rückgabe" />
<MaterialNav />

<div class="space-y-8 pb-24 sm:pb-0">
	{#if !allowed}
		<Alert.Root variant="info">
			<Alert.Title>Nur für die Materialverwaltung</Alert.Title>
			<Alert.Description>
				Ausgabe und Rückgabe aller Reservierungen erledigt die Materialverwaltung. Deine eigenen
				Reservierungen findest du unter
				<a class="text-link underline-offset-4 hover:underline" href={`${BASE_PATH}/meine`}>
					Meine Reservierungen</a
				>.
			</Alert.Description>
		</Alert.Root>
	{:else}
		<p class="-mt-2 text-base" aria-live="polite">
			{#if loading && !issues.length && !returns.length}
				<span class="text-muted-foreground">Lädt …</span>
			{:else if issueError || returnError}
				<span class="text-muted-foreground">Nicht alles konnte geladen werden.</span>
			{:else}
				{#each finding as part, i (i)}
					{#if i > 0},
					{/if}<span class={part.tone === 'destructive' ? 'font-medium text-destructive' : ''}
						>{part.text}</span
					>
				{/each}
			{/if}
		</p>

		<div class="grid gap-8 lg:grid-cols-2">
			<HandoutQueue
				kind="issue"
				title="Ausgeben"
				items={issues}
				{today}
				loading={loading && !issues.length}
				error={issueError}
				{busyId}
				{pdfBusyId}
				emptyText="In den nächsten 7 Tagen ist nichts auszugeben."
				onretry={loadIssues}
				onaction={(r) => openDialog(r, 'issue')}
				onpdf={pdf}
			/>
			<HandoutQueue
				kind="return"
				title="Zurück erwartet"
				items={returns}
				{today}
				loading={loading && !returns.length}
				error={returnError}
				{busyId}
				{pdfBusyId}
				emptyText="Gerade ist kein Material draußen."
				onretry={loadReturns}
				onaction={(r) => openDialog(r, 'return')}
				onpdf={pdf}
			/>
		</div>

		<section class="space-y-3" aria-labelledby="handout-all">
			<h2 id="handout-all" class="text-section">Alle Reservierungen</h2>
			<AllReservations {refreshKey} />
		</section>
	{/if}
</div>

{#if active}
	{#if issueOpen}
		<IssueDialog bind:open={issueOpen} reservation={active} onchanged={changed} />
	{/if}
	{#if returnOpen}
		<ReturnDialog bind:open={returnOpen} reservation={active} onchanged={changed} />
	{/if}
{/if}
