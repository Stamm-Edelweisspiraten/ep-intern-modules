<script lang="ts">
	// Inhalt einer Reservierung: Aktionen, Befund, Angaben, Positionen mit Fortschritt, ausgegebene
	// Stücke – samt Dialogen (Bearbeiten, Ausgeben, Zurücknehmen, Verlängern, Stornieren, Löschen).
	// Genutzt von der Seite `reservierung/:id` und `ReservationDetailDialog`.
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import FileDown from '@lucide/svelte/icons/file-down';
	import { apiFetch, can, todayBerlin } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { BUSY_DELETE, BUSY_SAVE, ConfirmDialog, FormField } from '$lib/components/layout';
	import { PERMISSIONS, type Reservation } from '../../schemas';
	import { API, errorText, formatDate, unitHref } from '../helpers';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import IssueDialog from './IssueDialog.svelte';
	import ReservationDialog from './ReservationDialog.svelte';
	import ReturnDialog from './ReturnDialog.svelte';
	import { downloadHandoutPdf } from './handout-pdf';
	import {
		bulkOut,
		lineProgress,
		lineText,
		outCount,
		reservationFinding
	} from './reservation-view';

	let {
		reservation,
		onchanged,
		ondeleted,
		showAction = true,
		headingLevel = 2
	}: {
		reservation: Reservation;
		/** Neuer Stand nach jeder Änderung */
		onchanged?: (r: Reservation) => void | Promise<void>;
		/** Reservierung gelöscht */
		ondeleted?: () => void | Promise<void>;
		/** Aktion in den Angaben zeigen (Seite zeigt sie im Kopf) */
		showAction?: boolean;
		/** Überschriften-Ebene der Abschnitte */
		headingLevel?: 2 | 3;
	} = $props();

	const r = $derived(reservation);
	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canDelete = $derived(can(permissions, PERMISSIONS.reservations));
	const today = todayBerlin();

	let editOpen = $state(false);
	let issueOpen = $state(false);
	let returnOpen = $state(false);
	let cancelOpen = $state(false);
	let deleteOpen = $state(false);
	let extendOpen = $state(false);
	let extendTo = $state('');
	let extendError = $state('');
	let busy = $state(false);
	let pdfBusy = $state(false);

	const out = $derived(outCount(r));
	const canIssue = $derived(r.canHandle && (r.status === 'reserved' || r.status === 'issued'));
	const canReturn = $derived(r.canHandle && r.status === 'issued' && (out > 0 || bulkOut(r)));
	const finding = $derived(reservationFinding(r, today));
	/** Primäraktion: zurücknehmen, sobald etwas draußen ist, sonst ausgeben */
	const primary = $derived(canReturn ? 'return' : canIssue ? 'issue' : null);
	const hasDetails = $derived(
		(showAction && !!r.actionId) || !!r.issuedAt || !!r.returnedAt || !!r.notes
	);

	async function changed(next: Reservation) {
		await onchanged?.(next);
	}

	async function cancel() {
		busy = true;
		try {
			const next = await apiFetch<Reservation>(`${API}/reservations/${r.id}/cancel`, {
				method: 'POST'
			});
			toast.success('Reservierung storniert');
			await changed(next);
		} catch (e) {
			toast.error(errorText(e, 'Stornieren fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function remove() {
		busy = true;
		try {
			await apiFetch(`${API}/reservations/${r.id}`, { method: 'DELETE' });
			toast.success('Reservierung gelöscht');
			await ondeleted?.();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	function startExtend() {
		extendTo = r.endsOn;
		extendError = '';
		extendOpen = true;
	}

	async function extend(e: SubmitEvent) {
		e.preventDefault();
		if (!extendTo || extendTo < r.startsOn) {
			extendError = 'Ende liegt vor dem Beginn';
			return;
		}
		busy = true;
		extendError = '';
		try {
			const next = await apiFetch<Reservation>(`${API}/reservations/${r.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ endsOn: extendTo })
			});
			toast.success(`Rückgabe jetzt bis ${formatDate(extendTo)}`);
			extendOpen = false;
			await changed(next);
		} catch (err) {
			extendError = errorText(err, 'Ändern fehlgeschlagen');
		} finally {
			busy = false;
		}
	}

	async function pdf() {
		pdfBusy = true;
		try {
			await downloadHandoutPdf(r.id, r.title);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'PDF konnte nicht erstellt werden');
		} finally {
			pdfBusy = false;
		}
	}

	const h = $derived(`h${headingLevel}`);
	const ids = $derived({ lines: `res-${r.id}-lines`, assigned: `res-${r.id}-assigned` });
</script>

<div class="space-y-6 text-sm">
	<div class="flex flex-wrap items-center gap-2">
		{#if canIssue}
			<Button
				variant={primary === 'issue' ? 'default' : 'outline'}
				onclick={() => (issueOpen = true)}
			>
				{r.status === 'issued' ? 'Weiteres ausgeben' : 'Ausgeben'}
			</Button>
		{/if}
		{#if canReturn}
			<Button onclick={() => (returnOpen = true)}>Zurücknehmen</Button>
		{/if}
		{#if r.canEdit && (r.status === 'reserved' || r.status === 'issued')}
			<Button variant="outline" onclick={() => (editOpen = true)}>Bearbeiten</Button>
		{/if}
		{#if r.canEdit && r.status === 'issued'}
			<Button variant="outline" onclick={startExtend}>Verlängern</Button>
		{/if}
		{#if r.status !== 'cancelled'}
			<Button variant="ghost" disabled={pdfBusy} onclick={pdf}>
				<FileDown aria-hidden="true" />
				{pdfBusy ? 'Erstellt …' : 'Ausgabeliste (PDF)'}
			</Button>
		{/if}
		{#if r.canEdit && r.status === 'reserved'}
			<Button
				variant="ghost"
				class="text-destructive hover:text-destructive sm:ml-auto"
				disabled={busy}
				onclick={() => (cancelOpen = true)}
			>
				Stornieren
			</Button>
		{/if}
		{#if canDelete && r.status === 'cancelled'}
			<Button
				variant="destructive"
				class="sm:ml-auto"
				disabled={busy}
				onclick={() => (deleteOpen = true)}
			>
				{busy ? BUSY_DELETE : 'Löschen'}
			</Button>
		{/if}
	</div>

	<p
		class={[
			'text-base',
			finding.tone === 'destructive'
				? 'font-medium text-destructive'
				: finding.tone === 'warning'
					? 'text-warning'
					: 'text-foreground'
		]}
		role={finding.tone === 'destructive' ? 'alert' : undefined}
	>
		{finding.text}
	</p>

	{#if hasDetails}
		<dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 border-y py-3">
			{#if showAction && r.actionId}
				<dt class="text-muted-foreground">Aktion</dt>
				<dd>
					<a class="text-link hover:underline" href={`/modules/actions/${r.actionId}`}>
						{r.actionName ?? 'Aktion'}
					</a>
				</dd>
			{/if}
			{#if r.issuedAt}
				<dt class="text-muted-foreground">Ausgegeben</dt>
				<dd class="tabular-nums">{formatDate(r.issuedAt)}</dd>
			{/if}
			{#if r.returnedAt}
				<dt class="text-muted-foreground">Zurück</dt>
				<dd class="tabular-nums">{formatDate(r.returnedAt)}</dd>
			{/if}
			{#if r.notes}
				<dt class="text-muted-foreground">Notiz</dt>
				<dd class="whitespace-pre-line">{r.notes}</dd>
			{/if}
		</dl>
	{/if}

	<section class="space-y-2" aria-labelledby={ids.lines}>
		<svelte:element this={h} id={ids.lines} class="text-section">Positionen</svelte:element>
		{#if r.lines.length}
			<div class="overflow-x-auto">
				<table class="w-full border-collapse">
					<thead>
						<tr class="border-b text-left text-muted-foreground">
							<th scope="col" class="py-2 pr-3 font-normal">Material</th>
							<th scope="col" class="py-2 pr-3 text-right font-normal">Menge</th>
							<th scope="col" class="py-2 pr-3 text-right font-normal">Ausgegeben</th>
							<th scope="col" class="py-2 text-right font-normal">Zurück</th>
						</tr>
					</thead>
					<tbody>
						{#each r.lines as l (l.id)}
							{@const p = lineProgress(r, l)}
							{@const done = p.planned > 0 && p.issued >= p.planned}
							<tr class="border-b last:border-b-0">
								<td class="py-2 pr-3 align-top">
									<span class="font-medium">{lineText(l)}</span>
									{#if l.code}
										<span class="ml-1 font-mono text-xs text-muted-foreground">{l.code}</span>
									{/if}
								</td>
								<td class="py-2 pr-3 text-right align-top whitespace-nowrap tabular-nums">
									{p.planned}
									<span class="text-muted-foreground">{p.unit}</span>
								</td>
								<td
									class={[
										'py-2 pr-3 text-right align-top tabular-nums',
										done ? 'text-success' : p.issued ? '' : 'text-muted-foreground'
									]}
								>
									{p.issued}<span class="text-muted-foreground"> / {p.planned}</span>
								</td>
								<td
									class={[
										'py-2 text-right align-top tabular-nums',
										p.issued && p.returned < p.issued && r.overdue
											? 'text-destructive'
											: p.returned
												? ''
												: 'text-muted-foreground'
									]}
								>
									{p.issued ? p.returned : '–'}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<p class="text-muted-foreground">Keine Positionen.</p>
		{/if}
	</section>

	{#if r.assigned.length}
		<section class="space-y-2" aria-labelledby={ids.assigned}>
			<svelte:element this={h} id={ids.assigned} class="text-section">
				Ausgegebene Stücke
				<span class="text-sm font-normal text-muted-foreground tabular-nums">
					{out} draußen · {r.assigned.length - out} zurück
				</span>
			</svelte:element>
			<ul class="divide-y border-y">
				{#each r.assigned as a (a.unit.id)}
					<li class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
						<span class="min-w-0">
							<a class="text-link hover:underline" href={unitHref(a.unit.id)}>{a.unit.name}</a>
							<span class="ml-1 font-mono text-xs text-muted-foreground">{a.unit.code}</span>
							{#if a.returnNote}
								<span class="block text-xs text-muted-foreground">{a.returnNote}</span>
							{/if}
						</span>
						{#if a.returnedAt}
							<span class="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
								zurück {formatDate(a.returnedAt)}
								{#if a.returnCondition}<ConditionBadge condition={a.returnCondition} />{/if}
							</span>
						{:else}
							<span class={['text-xs', r.overdue ? 'text-destructive' : 'text-warning']}>
								noch draußen
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

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
			<FormField label="Neues Ende" id={`extend-to-${r.id}`} required error={extendError}>
				<Input id={`extend-to-${r.id}`} type="date" min={r.startsOn} bind:value={extendTo} />
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
