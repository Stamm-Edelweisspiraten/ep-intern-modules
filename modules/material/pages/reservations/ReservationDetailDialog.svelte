<script lang="ts">
	// Reservierung ansehen (zentriert): Positionen mit Bild/Ort/Code und zugeteilten Artikeln (Zelte mit
	// ihren Teilen), Hinweise zur Zuteilung, Angaben, Aktionen Bearbeiten, Stornieren, Löschen, Packliste
	// (PDF/CSV); mit Verwaltungsrecht Ausgabe markieren, Zuteilung ändern, neu zuteilen und zurücknehmen
	// (Verbrauch eintragen).
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Boxes from '@lucide/svelte/icons/boxes';
	import FileDown from '@lucide/svelte/icons/file-down';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import PackageCheck from '@lucide/svelte/icons/package-check';
	import PackageOpen from '@lucide/svelte/icons/package-open';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Pin from '@lucide/svelte/icons/pin';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import * as Alert from '$lib/components/ui/alert';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ConfirmDialog, ErrorState, LoadingState, SummaryList } from '$lib/components/layout';
	import { downloadPdf } from '$lib/components/layout/download';
	import {
		PURPOSE_LABELS,
		type LineAssignment,
		type Reservation,
		type ReservationLine
	} from '../../schemas';
	import {
		API,
		RESERVATION_STATE_LABELS,
		STATE_VARIANTS,
		errorText,
		formatAmount,
		formatDate,
		formatPeriod
	} from '../helpers';
	import AssignmentDialog from './AssignmentDialog.svelte';
	import ReturnDialog from './ReturnDialog.svelte';

	let {
		open = $bindable(false),
		id,
		onedit,
		onchanged
	}: {
		open?: boolean;
		id: string;
		onedit: (id: string) => void;
		/** Nach Stornieren/Löschen (Liste neu laden) */
		onchanged: () => void;
	} = $props();

	let data = $state<Reservation | null>(null);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = !data;
		error = '';
		try {
			data = await apiFetch<Reservation>(`${API}/reservations/${id}`);
		} catch (e) {
			error = errorText(e, 'Reservierung konnte nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	// Beim Öffnen laden (ohne `data` zu verfolgen, sonst lädt jede Antwort erneut)
	$effect(() => {
		if (open && id) untrack(() => void load());
	});

	const r = $derived(data);
	const active = $derived(!!r && (r.state === 'upcoming' || r.state === 'running'));
	const canChange = $derived(!!r?.canEdit && active);
	const canDelete = $derived(!!r?.canEdit && (r.state === 'cancelled' || r.state === 'past'));

	const purposeText = $derived.by(() => {
		if (!r) return '';
		if (r.purpose === 'action') return `Aktion: ${r.actionName ?? 'unbekannt'}`;
		if (r.purpose === 'group') return `Gruppe: ${r.groupName ?? 'unbekannt'}`;
		return PURPOSE_LABELS.other;
	});

	const summary = $derived(
		r
			? [
					{ label: 'Zeitraum', value: formatPeriod(r.startsOn, r.endsOn) },
					{ label: 'Zweck', value: purposeText },
					{ label: 'Reserviert von', value: r.createdByName },
					{ label: 'Angelegt am', value: formatDate(r.createdAt) },
					...(r.handedOutAt
						? [
								{
									label: 'Ausgegeben',
									value: `${formatDate(r.handedOutAt)}${r.handedOutByName ? ` von ${r.handedOutByName}` : ''}`
								}
							]
						: []),
					...(r.returnedAt
						? [
								{
									label: 'Zurückgenommen',
									value: `${formatDate(r.returnedAt)}${r.returnedByName ? ` von ${r.returnedByName}` : ''}`
								}
							]
						: [])
				]
			: []
	);
	const canHandOut = $derived(!!r?.canHandOut && active);
	/** Zuteilung ändern: Verwaltung, offen, nicht ausgegeben */
	const canAssign = $derived(canHandOut && !r?.handedOutAt);
	/** Rücknahme: nach der Ausgabe, auch wenn die Reservierung schon vorbei ist */
	const canReturn = $derived(!!r?.canHandOut && r.status === 'reserved' && !!r.handedOutAt);

	let returnOpen = $state(false);

	async function undoReturn() {
		busy = 'return';
		try {
			data = await apiFetch<Reservation>(`${API}/reservations/${id}/return`, { method: 'DELETE' });
			toast.success('Rücknahme aufgehoben – der Verbrauch ist wieder im Bestand');
			onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Das hat nicht geklappt'));
		} finally {
			busy = null;
		}
	}

	/** Zuteilungen nach Zelt-Nummer (bei Zelt-Teilen) */
	function bySlot(l: ReservationLine): { slot: number; items: LineAssignment[] }[] {
		const map = new Map<number, LineAssignment[]>();
		for (const a of l.assignments) {
			const list = map.get(a.slot) ?? [];
			list.push(a);
			map.set(a.slot, list);
		}
		return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([slot, items]) => ({ slot, items }));
	}

	function setsText(items: LineAssignment[]): string {
		const names = [...new Set(items.map((a) => a.setName ?? ''))];
		if (names.length === 1 && names[0]) return `Set ${names[0]}`;
		return names.some(Boolean) ? 'gemischt' : '';
	}

	// --- Ausgabe und Zuteilung -----------------------------------------------------
	let assignLine = $state<ReservationLine | null>(null);
	let assignOpen = $state(false);
	let assignKey = $state(0);

	function openAssign(l: ReservationLine) {
		assignLine = l;
		assignKey++;
		assignOpen = true;
	}

	async function handOut(on: boolean) {
		busy = 'handout';
		try {
			data = await apiFetch<Reservation>(`${API}/reservations/${id}/hand-out`, {
				method: on ? 'POST' : 'DELETE',
				...(on ? { body: JSON.stringify({}) } : {})
			});
			toast.success(on ? 'Als ausgegeben markiert' : 'Ausgabe zurückgenommen');
			onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Das hat nicht geklappt'));
		} finally {
			busy = null;
		}
	}

	async function reassign() {
		busy = 'reassign';
		try {
			data = await apiFetch<Reservation>(`${API}/reservations/${id}/reassign`, {
				method: 'POST',
				body: JSON.stringify({})
			});
			toast.success('Neu zugeteilt');
		} catch (e) {
			toast.error(errorText(e, 'Neu zuteilen fehlgeschlagen'));
		} finally {
			busy = null;
		}
	}

	// --- Aktionen ------------------------------------------------------------------
	let busy = $state<'cancel' | 'delete' | 'pdf' | 'csv' | 'handout' | 'reassign' | 'return' | null>(
		null
	);
	let cancelOpen = $state(false);
	let deleteOpen = $state(false);

	async function cancel() {
		busy = 'cancel';
		try {
			data = await apiFetch<Reservation>(`${API}/reservations/${id}/cancel`, {
				method: 'POST',
				body: JSON.stringify({})
			});
			toast.success('Reservierung storniert');
			onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Stornieren fehlgeschlagen'));
		} finally {
			busy = null;
		}
	}

	async function remove() {
		busy = 'delete';
		try {
			await apiFetch(`${API}/reservations/${id}`, { method: 'DELETE' });
			toast.success('Reservierung gelöscht');
			open = false;
			onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		} finally {
			busy = null;
		}
	}

	async function packingList(format: 'pdf' | 'csv') {
		busy = format;
		try {
			await downloadPdf(
				`/api/v1${API}/reservations/${id}/packing-list?format=${format}`,
				{},
				`packliste.${format}`
			);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Packliste konnte nicht erstellt werden');
		} finally {
			busy = null;
		}
	}
</script>

{#snippet lineHead(l: ReservationLine, part = false)}
	<div class="flex items-center gap-3">
		{#if !part}
			<div class="size-10 shrink-0 overflow-hidden rounded-md bg-muted">
				{#if l.thumbUrl}
					<img src={l.thumbUrl} alt="" loading="lazy" class="size-full object-cover" />
				{:else}
					<span class="flex size-full items-center justify-center text-muted-foreground">
						<Boxes class="size-4" aria-hidden="true" />
					</span>
				{/if}
			</div>
		{/if}
		<div class="min-w-0 flex-1">
			<p class={['truncate text-sm', part ? '' : 'font-medium']}>
				{#if l.label}<span class="font-medium">{l.label}:</span>{/if}
				{l.name}
				{#if l.kind !== 'item'}
					<span class="font-normal text-muted-foreground">
						{l.kind === 'tent' ? '(Zelt)' : '(beliebige)'}
					</span>
				{/if}
			</p>
			{#if l.code || l.locationName}
				<p class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
					{#if l.code}<span class="font-mono">{l.code}</span>{/if}
					{#if l.locationName}
						<span class="inline-flex items-center gap-1">
							<MapPin class="size-3" aria-hidden="true" />{l.locationName}
						</span>
					{/if}
				</p>
			{/if}
		</div>
		{#if l.kind === 'type' && canAssign}
			<Button
				variant="ghost"
				size="sm"
				class="shrink-0"
				disabled={!!busy}
				onclick={() => openAssign(l)}
				aria-label={`Zuteilung ${l.label || l.name} ändern`}
			>
				Ändern
			</Button>
		{/if}
		<span class="shrink-0 text-sm font-medium tabular-nums">
			{l.unit ? formatAmount(l.quantity, l.unit) : `× ${l.quantity}`}
		</span>
	</div>
{/snippet}

{#snippet assignments(l: ReservationLine)}
	{#if l.kind === 'type'}
		{#if l.assignments.length}
			<div class="space-y-1">
				{#each l.slotSize ? bySlot(l) : [{ slot: 0, items: l.assignments }] as group (group.slot)}
					<div class="flex flex-wrap items-center gap-1.5">
						{#if l.slotSize}
							<span class="text-xs text-muted-foreground">
								{[`Zelt ${group.slot + 1}`, setsText(group.items)].filter(Boolean).join(' · ')}:
							</span>
						{/if}
						{#each group.items as a (a.itemId)}
							<Badge
								variant="outline"
								class="gap-1 font-normal"
								title={[a.code, a.setName ? `Set ${a.setName}` : '', a.locationName ?? '']
									.filter(Boolean)
									.join(' · ')}
							>
								{#if a.pinned}<Pin class="size-3" aria-label="fest zugeteilt" />{/if}
								{a.name}
								{#if a.quantity > 1}<span class="tabular-nums">× {a.quantity}</span>{/if}
							</Badge>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
		{#if l.missing > 0}
			<p class="flex items-center gap-1 text-xs text-warning">
				<TriangleAlert class="size-3.5" aria-hidden="true" />
				{l.missing} noch nicht zugeteilt
			</p>
		{/if}
	{/if}
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title class="flex flex-wrap items-center gap-2">
				{r?.title ?? 'Reservierung'}
				{#if r}
					<Badge variant={STATE_VARIANTS[r.state]}>{RESERVATION_STATE_LABELS[r.state]}</Badge>
					{#if r.returnedAt}
						<Badge variant="secondary">Zurückgenommen</Badge>
					{:else if r.handedOutAt}
						<Badge variant="success">Ausgegeben</Badge>
					{/if}
				{/if}
			</Dialog.Title>
			<Dialog.Description>
				{r ? formatPeriod(r.startsOn, r.endsOn) : 'Materialreservierung'}
			</Dialog.Description>
		</Dialog.Header>

		{#if loading}
			<LoadingState rows={4} />
		{:else if error}
			<ErrorState message={error} onretry={load} compact />
		{:else if r}
			<div class="space-y-5">
				<SummaryList rows={summary} />
				{#if r.notes}
					<div class="space-y-1">
						<h3 class="text-sm font-medium">Notiz</h3>
						<p class="text-sm whitespace-pre-line text-muted-foreground">{r.notes}</p>
					</div>
				{/if}

				<div class="space-y-2">
					<h3 class="text-sm font-medium">
						Material <span class="font-normal text-muted-foreground">({r.lines.length})</span>
					</h3>
					{#if r.notices.length}
						<Alert.Root variant="warning">
							<TriangleAlert aria-hidden="true" />
							<Alert.Title>Hinweis zur Zuteilung</Alert.Title>
							<Alert.Description>
								<ul class="list-disc space-y-0.5 pl-4">
									{#each r.notices as n, i (i)}<li>{n}</li>{/each}
								</ul>
							</Alert.Description>
						</Alert.Root>
					{/if}
					<ul class="divide-y rounded-md border">
						{#each r.lines as l (l.id)}
							<li class="space-y-2 px-3 py-2">
								{@render lineHead(l)}
								{#if l.kind === 'tent'}
									<ul class="space-y-2 border-l-2 pl-3">
										{#each l.parts as p (p.id)}
											<li class="space-y-1">
												{@render lineHead(p, true)}
												{@render assignments(p)}
											</li>
										{/each}
									</ul>
								{:else}
									{@render assignments(l)}
								{/if}
							</li>
						{/each}
					</ul>
				</div>

				{#if r.consumables.length}
					<div class="space-y-2">
						<h3 class="text-sm font-medium">Verbrauchsmaterial</h3>
						<ul class="divide-y rounded-md border text-sm">
							{#each r.consumables as c (c.itemId)}
								<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
									<span class="min-w-0 flex-1 truncate font-medium">{c.name}</span>
									<span class="text-muted-foreground tabular-nums">
										{r.handedOutAt ? 'ausgegeben' : 'reserviert'}
										{formatAmount(c.issued, c.unit)}
									</span>
									{#if c.consumed !== null}
										<span class="font-medium tabular-nums">
											verbraucht {formatAmount(c.consumed, c.unit)}
										</span>
									{/if}
								</li>
							{/each}
						</ul>
						{#if r.handedOutAt && !r.returnedAt}
							<p class="text-xs text-muted-foreground">
								Bleibt belegt, bis es zurückgenommen und der Verbrauch eingetragen ist.
							</p>
						{/if}
					</div>
				{/if}
			</div>

			<Dialog.Footer class="flex-wrap gap-2 sm:justify-between">
				<div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap [&>*]:max-sm:h-10">
					{#if canReturn}
						{#if r.returnedAt}
							<Button variant="outline" size="sm" disabled={!!busy} onclick={undoReturn}>
								<Undo2 />
								{busy === 'return' ? 'Speichert …' : 'Rücknahme aufheben'}
							</Button>
						{:else}
							<Button size="sm" disabled={!!busy} onclick={() => (returnOpen = true)}>
								<PackageOpen />
								Zurücknehmen
							</Button>
						{/if}
					{/if}
					{#if canHandOut && !r.returnedAt}
						{#if r.handedOutAt}
							<Button variant="outline" size="sm" disabled={!!busy} onclick={() => handOut(false)}>
								<Undo2 />
								{busy === 'handout' ? 'Speichert …' : 'Ausgabe zurücknehmen'}
							</Button>
						{:else}
							<Button size="sm" disabled={!!busy} onclick={() => handOut(true)}>
								<PackageCheck />
								{busy === 'handout' ? 'Speichert …' : 'Ausgegeben'}
							</Button>
							<Button variant="outline" size="sm" disabled={!!busy} onclick={reassign}>
								<RefreshCw />
								{busy === 'reassign' ? 'Teilt zu …' : 'Neu zuteilen'}
							</Button>
						{/if}
					{/if}
					<Button variant="outline" size="sm" disabled={!!busy} onclick={() => packingList('pdf')}>
						<FileDown />
						{busy === 'pdf' ? 'Erstellt …' : 'Packliste PDF'}
					</Button>
					<Button variant="outline" size="sm" disabled={!!busy} onclick={() => packingList('csv')}>
						<FileDown />
						{busy === 'csv' ? 'Erstellt …' : 'CSV'}
					</Button>
				</div>
				<div
					class="grid grid-cols-2 gap-2 max-sm:order-first sm:flex sm:flex-wrap [&>*]:max-sm:h-10"
				>
					{#if canDelete}
						<Button
							variant="destructive"
							size="sm"
							disabled={!!busy}
							onclick={() => (deleteOpen = true)}
						>
							{busy === 'delete' ? 'Löscht …' : 'Löschen'}
						</Button>
					{/if}
					{#if canChange}
						<Button
							variant="outline"
							size="sm"
							disabled={!!busy}
							onclick={() => (cancelOpen = true)}
						>
							{busy === 'cancel' ? 'Storniert …' : 'Stornieren'}
						</Button>
						<Button
							size="sm"
							disabled={!!busy}
							onclick={() => {
								open = false;
								onedit(r.id);
							}}
						>
							<Pencil /> Bearbeiten
						</Button>
					{/if}
				</div>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={cancelOpen}
	title="Reservierung stornieren?"
	description={`„${r?.title ?? ''}“ wird storniert, das Material ist im Zeitraum wieder frei.`}
	confirmLabel="Stornieren"
	destructive
	onconfirm={cancel}
/>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Reservierung löschen?"
	description={`„${r?.title ?? ''}“ wird endgültig gelöscht. Das lässt sich nicht rückgängig machen.`}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>

{#if r && canReturn && !r.returnedAt}
	<ReturnDialog
		bind:open={returnOpen}
		reservation={r}
		onsaved={(next) => {
			data = next;
			onchanged();
		}}
	/>
{/if}

{#if assignLine && r}
	{#key assignKey}
		<AssignmentDialog
			bind:open={assignOpen}
			reservationId={r.id}
			line={assignLine}
			onsaved={(next) => (data = next)}
		/>
	{/key}
{/if}
