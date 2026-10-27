<script lang="ts">
	// Detailansicht einer Reservierung mit Positionen, ausgegebenen Stücken und Aktionen.
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
	import PackageCheck from '@lucide/svelte/icons/package-check';
	import PackageOpen from '@lucide/svelte/icons/package-open';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import XCircle from '@lucide/svelte/icons/circle-x';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import {
		BUSY_DELETE,
		BUSY_SAVE,
		ConfirmDialog,
		ErrorState,
		FormField,
		LoadingState
	} from '$lib/components/layout';
	import { PERMISSIONS, type Reservation, type ReservationLine } from '../../schemas';
	import { API, errorText, formatDate, formatPeriod, unitHref } from '../helpers';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import StatusBadge from '../shared/StatusBadge.svelte';
	import IssueDialog from './IssueDialog.svelte';
	import ReservationDialog from './ReservationDialog.svelte';
	import ReturnDialog from './ReturnDialog.svelte';

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

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canDelete = $derived(can(permissions, PERMISSIONS.reservations));

	let r = $state<Reservation | null>(null);
	let loading = $state(false);
	let error = $state('');
	let editOpen = $state(false);
	let issueOpen = $state(false);
	let returnOpen = $state(false);
	let cancelOpen = $state(false);
	let deleteOpen = $state(false);
	let extendOpen = $state(false);
	let extendTo = $state('');
	let extendError = $state('');
	let busy = $state(false);

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

	async function cancel() {
		if (!r) return;
		busy = true;
		try {
			r = await apiFetch<Reservation>(`${API}/reservations/${r.id}/cancel`, { method: 'POST' });
			toast.success('Reservierung storniert');
			await onchanged?.();
		} catch (e) {
			toast.error(errorText(e, 'Stornieren fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!r) return;
		busy = true;
		try {
			await apiFetch(`${API}/reservations/${r.id}`, { method: 'DELETE' });
			toast.success('Reservierung gelöscht');
			open = false;
			r = null;
			await onchanged?.();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	function startExtend() {
		if (!r) return;
		extendTo = r.endsOn;
		extendError = '';
		extendOpen = true;
	}

	async function extend(e: SubmitEvent) {
		e.preventDefault();
		if (!r) return;
		if (!extendTo || extendTo < r.startsOn) {
			extendError = 'Ende liegt vor dem Beginn';
			return;
		}
		busy = true;
		extendError = '';
		try {
			r = await apiFetch<Reservation>(`${API}/reservations/${r.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ endsOn: extendTo })
			});
			toast.success(`Rückgabe jetzt bis ${formatDate(extendTo)}`);
			extendOpen = false;
			await onchanged?.();
		} catch (err) {
			extendError = errorText(err, 'Ändern fehlgeschlagen');
		} finally {
			busy = false;
		}
	}

	function lineText(l: ReservationLine): string {
		if (l.kind === 'set') return `Set ${l.name}`;
		if (l.kind === 'article') return `${l.quantity} × ${l.name}`;
		return l.name;
	}
	function lineProgress(l: ReservationLine): string {
		if (l.articleKind === 'bulk') {
			if (!l.issuedQty) return '';
			return `ausgegeben ${l.issuedQty} · zurück ${l.returnedQty} ${l.unitLabel}`;
		}
		return l.assignedCount ? `${l.assignedCount} von ${l.quantity} ausgegeben` : '';
	}

	const outCount = $derived(r ? r.assigned.filter((a) => !a.returnedAt).length : 0);
	const bulkOut = $derived(
		r ? r.lines.some((l) => l.articleKind === 'bulk' && l.issuedQty > l.returnedQty) : false
	);
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
					{formatPeriod(r.startsOn, r.endsOn)} · von {r.createdByName}
				</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-5 text-sm">
				<dl class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr]">
					{#if r.actionId}
						<dt class="text-muted-foreground">Aktion</dt>
						<dd>
							<a class="text-link hover:underline" href={`/modules/actions/${r.actionId}`}>
								{r.actionName ?? 'Aktion'}
							</a>
						</dd>
					{/if}
					{#if r.issuedAt}
						<dt class="text-muted-foreground">Ausgegeben</dt>
						<dd>{formatDate(r.issuedAt)}</dd>
					{/if}
					{#if r.returnedAt}
						<dt class="text-muted-foreground">Zurück</dt>
						<dd>{formatDate(r.returnedAt)}</dd>
					{/if}
					{#if r.notes}
						<dt class="text-muted-foreground">Notiz</dt>
						<dd class="whitespace-pre-line">{r.notes}</dd>
					{/if}
				</dl>

				{#if r.overdue}
					<p
						class="rounded-md border border-destructive-border bg-destructive-muted p-3 text-destructive"
					>
						Die Rückgabe war bis {formatDate(r.endsOn)} fällig.
					</p>
				{/if}

				<section class="space-y-2" aria-labelledby="res-lines">
					<h3 id="res-lines" class="font-medium">Positionen</h3>
					{#if r.lines.length}
						<ul class="divide-y rounded-md border">
							{#each r.lines as l (l.id)}
								{@const p = lineProgress(l)}
								<li class="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
									<span>
										{lineText(l)}
										{#if l.code}<span class="text-xs text-muted-foreground"> · {l.code}</span>{/if}
									</span>
									{#if p}<span class="text-xs text-muted-foreground tabular-nums">{p}</span>{/if}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-muted-foreground">Keine Positionen.</p>
					{/if}
				</section>

				{#if r.assigned.length}
					<section class="space-y-2" aria-labelledby="res-assigned">
						<h3 id="res-assigned" class="font-medium">
							Ausgegebene Stücke
							<span class="text-muted-foreground tabular-nums">
								({outCount} draußen, {r.assigned.length - outCount} zurück)
							</span>
						</h3>
						<ul class="max-h-64 divide-y overflow-y-auto rounded-md border">
							{#each r.assigned as a (a.unit.id)}
								<li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
									<span class="min-w-0">
										<a class="text-link hover:underline" href={unitHref(a.unit.id)}>
											{a.unit.name}
										</a>
										<span class="text-xs text-muted-foreground"> · {a.unit.code}</span>
										{#if a.returnNote}
											<span class="block text-xs text-muted-foreground">{a.returnNote}</span>
										{/if}
									</span>
									{#if a.returnedAt}
										<span class="flex items-center gap-2 text-xs text-muted-foreground">
											zurück {formatDate(a.returnedAt)}
											{#if a.returnCondition}<ConditionBadge condition={a.returnCondition} />{/if}
										</span>
									{:else}
										<span class="text-xs text-warning">noch draußen</span>
									{/if}
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			</div>

			<Dialog.Footer class="flex-wrap gap-2 sm:justify-start">
				{#if r.canHandle && (r.status === 'reserved' || r.status === 'issued')}
					<Button onclick={() => (issueOpen = true)}><PackageOpen /> Ausgeben</Button>
				{/if}
				{#if r.canHandle && r.status === 'issued' && (outCount > 0 || bulkOut)}
					<Button variant="secondary" onclick={() => (returnOpen = true)}>
						<PackageCheck /> Zurücknehmen
					</Button>
				{/if}
				{#if r.canEdit}
					<Button variant="outline" onclick={() => (editOpen = true)}><Pencil /> Bearbeiten</Button>
				{/if}
				{#if r.canEdit && r.status === 'issued'}
					<Button variant="outline" onclick={startExtend}><CalendarPlus /> Verlängern</Button>
				{/if}
				{#if r.canEdit && r.status === 'reserved'}
					<Button variant="outline" disabled={busy} onclick={() => (cancelOpen = true)}>
						<XCircle /> Stornieren
					</Button>
				{/if}
				{#if canDelete && r.status === 'cancelled'}
					<Button variant="destructive" disabled={busy} onclick={() => (deleteOpen = true)}>
						<Trash2 />
						{busy ? BUSY_DELETE : 'Löschen'}
					</Button>
				{/if}
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

{#if r}
	<ReservationDialog bind:open={editOpen} reservation={r} onsaved={changed} />
	{#if issueOpen}
		<IssueDialog bind:open={issueOpen} reservation={r} onchanged={changed} />
	{/if}
	{#if returnOpen}
		<ReturnDialog bind:open={returnOpen} reservation={r} onchanged={changed} />
	{/if}
	<ConfirmDialog
		bind:open={cancelOpen}
		destructive
		title="Reservierung stornieren?"
		description={`„${r.title}“ wird storniert, das Material ist wieder frei.`}
		confirmLabel="Stornieren"
		onconfirm={cancel}
	/>
	<ConfirmDialog
		bind:open={deleteOpen}
		destructive
		title="Reservierung löschen?"
		description={`„${r.title}“ wird endgültig gelöscht.`}
		confirmLabel="Löschen"
		onconfirm={remove}
	/>

	<Dialog.Root bind:open={extendOpen}>
		<Dialog.Content class="sm:max-w-sm">
			<Dialog.Header>
				<Dialog.Title>Rückgabe verschieben</Dialog.Title>
				<Dialog.Description>
					Neues Ende für „{r.title}“. Beim Verlängern wird geprüft, ob das Material frei bleibt.
				</Dialog.Description>
			</Dialog.Header>
			<form class="space-y-4" onsubmit={extend} novalidate>
				<FormField label="Neues Ende" id="extend-to" required error={extendError}>
					<Input id="extend-to" type="date" min={r.startsOn} bind:value={extendTo} />
				</FormField>
				<Dialog.Footer>
					<Button type="button" variant="outline" onclick={() => (extendOpen = false)}>
						Abbrechen
					</Button>
					<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
				</Dialog.Footer>
			</form>
		</Dialog.Content>
	</Dialog.Root>
{/if}
