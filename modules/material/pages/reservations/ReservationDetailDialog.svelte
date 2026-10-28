<script lang="ts">
	// Reservierung ansehen (zentriert): Positionen mit Bild/Ort/Code, Angaben, Aktionen
	// Bearbeiten, Stornieren, Löschen, Packliste (PDF/CSV).
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Boxes from '@lucide/svelte/icons/boxes';
	import FileDown from '@lucide/svelte/icons/file-down';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Pencil from '@lucide/svelte/icons/pencil';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ConfirmDialog, ErrorState, LoadingState, SummaryList } from '$lib/components/layout';
	import { downloadPdf } from '$lib/components/layout/download';
	import { PURPOSE_LABELS, type Reservation } from '../../schemas';
	import {
		API,
		RESERVATION_STATE_LABELS,
		STATE_VARIANTS,
		errorText,
		formatDate,
		formatPeriod
	} from '../helpers';

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
					{ label: 'Angelegt am', value: formatDate(r.createdAt) }
				]
			: []
	);

	// --- Aktionen ------------------------------------------------------------------
	let busy = $state<'cancel' | 'delete' | 'pdf' | 'csv' | null>(null);
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

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title class="flex flex-wrap items-center gap-2">
				{r?.title ?? 'Reservierung'}
				{#if r}
					<Badge variant={STATE_VARIANTS[r.state]}>{RESERVATION_STATE_LABELS[r.state]}</Badge>
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
					<ul class="divide-y rounded-md border">
						{#each r.lines as l (l.id)}
							<li class="flex items-center gap-3 px-3 py-2">
								<div class="size-10 shrink-0 overflow-hidden rounded-md bg-muted">
									{#if l.thumbUrl}
										<img src={l.thumbUrl} alt="" loading="lazy" class="size-full object-cover" />
									{:else}
										<span class="flex size-full items-center justify-center text-muted-foreground">
											<Boxes class="size-4" aria-hidden="true" />
										</span>
									{/if}
								</div>
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm font-medium">
										{l.name}{#if l.kind === 'type'}
											<span class="font-normal text-muted-foreground"> (beliebige)</span>{/if}
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
								<span class="shrink-0 text-sm font-medium tabular-nums">× {l.quantity}</span>
							</li>
						{/each}
					</ul>
				</div>
			</div>

			<Dialog.Footer class="flex-wrap gap-2 sm:justify-between">
				<div class="flex flex-wrap gap-2">
					<Button variant="outline" size="sm" disabled={!!busy} onclick={() => packingList('pdf')}>
						<FileDown />
						{busy === 'pdf' ? 'Erstellt …' : 'Packliste PDF'}
					</Button>
					<Button variant="outline" size="sm" disabled={!!busy} onclick={() => packingList('csv')}>
						<FileDown />
						{busy === 'csv' ? 'Erstellt …' : 'CSV'}
					</Button>
				</div>
				<div class="flex flex-wrap gap-2">
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
