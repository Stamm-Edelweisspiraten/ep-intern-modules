<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Check from '@lucide/svelte/icons/check';
	import FileText from '@lucide/svelte/icons/file-text';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { ConfirmDialog } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		MAX_RECEIPT_BYTES,
		RECEIPT_CONTENT_TYPES,
		type AccountingEntry,
		type AccountingState
	} from '../schemas';
	import { fmtDate } from './format';
	import type { AutoIncome } from './auto-types';
	import AccountingSummaryCards from './AccountingSummaryCards.svelte';
	import EntriesTable, { type EntryFilter } from './EntriesTable.svelte';
	import RefundCard from './RefundCard.svelte';
	import AccountingEntryDialog from './AccountingEntryDialog.svelte';
	import PayoutsSection from './PayoutsSection.svelte';

	let {
		actionId,
		canEdit,
		isPast = false
	}: { actionId: string; canEdit: boolean; isPast?: boolean } = $props();

	const base = $derived(`/modules/actions/actions/${actionId}/accounting`);

	let acc = $state<AccountingState | null>(null);
	let loading = $state(true);
	let error = $state('');
	let filter = $state<EntryFilter>('all');
	let reloadKey = $state(0);

	let entryOpen = $state(false);
	let editEntry = $state<AccountingEntry | null>(null);
	let deleteOpen = $state(false);
	let deleteEntry = $state<AccountingEntry | null>(null);
	let closeOpen = $state(false);
	let forceOpen = $state(false);
	let reopenOpen = $state(false);
	let busy = $state(false);

	const closed = $derived(!!acc?.closed);
	const editable = $derived(canEdit && !closed);
	const canViewPayouts = $derived(acc?.canViewPayouts ?? false);
	const summary = $derived(acc?.summary);
	const autoIncome = $derived(
		(acc as { autoIncome?: AutoIncome | null } | null)?.autoIncome ?? null
	);

	const payeeChoices = $derived.by(() => {
		if (acc?.payees) return acc.payees.map((p) => ({ id: p.id, name: p.name }));
		const m = new Map<string, string>();
		for (const e of acc?.entries ?? []) if (e.payee) m.set(e.payee.id, e.payee.name);
		return [...m].map(([id, name]) => ({ id, name }));
	});

	function errMsg(e: unknown, fallback: string) {
		return e instanceof ApiClientError ? e.message : fallback;
	}

	async function load() {
		try {
			acc = await apiFetch<AccountingState>(base);
			error = '';
		} catch (e) {
			error = errMsg(e, 'Abrechnung konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void actionId;
		loading = true;
		void load();
	});

	function openAdd() {
		editEntry = null;
		entryOpen = true;
	}
	function openEdit(e: AccountingEntry) {
		editEntry = e;
		entryOpen = true;
	}

	async function confirmDelete() {
		if (!deleteEntry) return;
		try {
			await apiFetch(`${base}/entries/${deleteEntry.id}`, { method: 'DELETE' });
			toast.success('Buchung gelöscht');
			await load();
		} catch (e) {
			toast.error(errMsg(e, 'Löschen fehlgeschlagen'));
		}
	}

	async function uploadReceipt(entry: AccountingEntry, input: HTMLInputElement) {
		const f = input.files?.[0];
		input.value = '';
		if (!f) return;
		if (!(RECEIPT_CONTENT_TYPES as readonly string[]).includes(f.type)) {
			toast.error('Dateityp nicht erlaubt (PDF oder Bild)');
			return;
		}
		if (f.size > MAX_RECEIPT_BYTES) {
			toast.error('Datei ist zu groß (maximal 10 MB)');
			return;
		}
		try {
			const fd = new FormData();
			fd.append('file', f);
			await apiFetch(`${base}/entries/${entry.id}/receipt`, { method: 'POST', body: fd });
			toast.success('Beleg gespeichert');
			await load();
		} catch (e) {
			toast.error(errMsg(e, 'Beleg konnte nicht gespeichert werden'));
		}
	}

	async function close(acceptMissingReceipts: boolean) {
		busy = true;
		try {
			await apiFetch(`${base}/close`, {
				method: 'POST',
				body: JSON.stringify({ acceptMissingReceipts })
			});
			toast.success('Abrechnung abgeschlossen');
			await load();
		} catch (e) {
			if (e instanceof ApiClientError && e.status === 409 && !acceptMissingReceipts) {
				toast.error(e.message);
				forceOpen = true;
			} else {
				toast.error(errMsg(e, 'Abschließen fehlgeschlagen'));
			}
		} finally {
			busy = false;
		}
	}

	function startClose() {
		if ((summary?.missingReceipts ?? 0) > 0) forceOpen = true;
		else void close(false);
	}

	async function reopen() {
		busy = true;
		try {
			await apiFetch(`${base}/reopen`, { method: 'POST' });
			toast.success('Abrechnung wieder geöffnet');
			await load();
		} catch (e) {
			if (e instanceof ApiClientError && e.status === 403) {
				toast.error('Du hast keine Berechtigung, die Abrechnung wieder zu öffnen.');
			} else {
				toast.error(errMsg(e, 'Wieder öffnen fehlgeschlagen'));
			}
		} finally {
			busy = false;
		}
	}

	function fmtClosed(iso: string) {
		return fmtDate(iso);
	}
</script>

{#if loading && !acc}
	<div class="space-y-4" aria-busy="true" aria-label="Lade Abrechnung">
		<div class="grid gap-4 sm:grid-cols-3">
			<Skeleton class="h-20 w-full" />
			<Skeleton class="h-20 w-full" />
			<Skeleton class="h-20 w-full" />
		</div>
		<Skeleton class="h-64 w-full" />
	</div>
{:else if error && !acc}
	<div class="space-y-3">
		<p class="text-sm text-destructive" role="alert">{error}</p>
		<Button variant="outline" onclick={load}>Erneut versuchen</Button>
	</div>
{:else if acc && summary}
	<div class="space-y-6">
		{#if acc.closed}
			<div
				class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-green-600/30 bg-green-600/10 px-4 py-3"
				role="status"
			>
				<div class="flex items-center gap-2 text-sm font-medium">
					<Check class="size-4" aria-hidden="true" />
					Abgeschlossen am {fmtClosed(acc.closed.at)}{acc.closed.by
						? ` von ${acc.closed.by.name}`
						: ''}
				</div>
				<div class="flex flex-wrap gap-2">
					<Button
						variant="outline"
						href={`/api/v1${base}/report.pdf`}
						target="_blank"
						rel="noopener"
					>
						<FileText /> PDF-Bericht
					</Button>
					{#if canEdit}
						<Button variant="outline" disabled={busy} onclick={() => (reopenOpen = true)}>
							Wieder öffnen
						</Button>
					{/if}
				</div>
			</div>
		{:else}
			<div class="flex flex-wrap items-center justify-between gap-3">
				<Badge variant="secondary">Offen</Badge>
				<div class="flex flex-wrap gap-2">
					<Button
						variant="outline"
						href={`/api/v1${base}/report.pdf`}
						target="_blank"
						rel="noopener"
					>
						<FileText /> PDF-Bericht
					</Button>
					{#if canEdit}
						<Button disabled={busy} onclick={() => (closeOpen = true)}>
							<Check /> Abrechnung abschließen
						</Button>
					{/if}
				</div>
			</div>
		{/if}

		<AccountingSummaryCards {summary} onshowmissing={() => (filter = 'missing')} />

		<EntriesTable
			entries={acc.entries}
			{autoIncome}
			bind:filter
			{base}
			{editable}
			onadd={openAdd}
			onedit={openEdit}
			ondelete={(e) => {
				deleteEntry = e;
				deleteOpen = true;
			}}
			onupload={uploadReceipt}
		/>

		<RefundCard {actionId} {editable} {reloadKey} onchanged={load} />

		{#if canViewPayouts}
			<PayoutsSection
				{actionId}
				payees={acc.payees}
				{canViewPayouts}
				{editable}
				viaTreasury={!!acc.payoutsViaTreasury}
				onchanged={load}
			/>
		{/if}
	</div>

	<AccountingEntryDialog
		bind:open={entryOpen}
		{actionId}
		entry={editEntry}
		{isPast}
		payees={payeeChoices}
		{canViewPayouts}
		viaTreasury={!!acc?.payoutsViaTreasury}
		onsaved={load}
	/>
	<ConfirmDialog
		bind:open={deleteOpen}
		title="Buchung löschen?"
		description={deleteEntry
			? `„${deleteEntry.description}“ (${formatEuro(deleteEntry.amountCents)}) wird unwiderruflich gelöscht.`
			: undefined}
		confirmLabel="Löschen"
		destructive
		onconfirm={confirmDelete}
	/>
	<ConfirmDialog
		bind:open={closeOpen}
		title="Abrechnung abschließen?"
		description={`Danach können Buchungen nicht mehr geändert werden. Saldo: ${formatEuro(summary.balanceCents)}.${
			summary.missingReceipts > 0
				? ` Achtung: ${summary.missingReceipts} Ausgaben haben keinen Beleg.`
				: ''
		}${
			summary.openClubPayments.count > 0
				? ` ${summary.openClubPayments.count === 1 ? 'Eine Überweisung' : `${summary.openClubPayments.count} Überweisungen`} (${formatEuro(summary.openClubPayments.cents)}) ${summary.openClubPayments.count === 1 ? 'ist' : 'sind'} noch offen${acc?.payoutsViaTreasury ? ' – die Kasse überweist weiterhin' : ''}.`
				: ''
		}${
			acc?.payoutsViaTreasury && summary.openReimbursementCents > 0
				? ` Offene Auslagen (${formatEuro(summary.openReimbursementCents)}) gehen mit dem Abschluss an die Kasse.`
				: ''
		}`}
		confirmLabel="Abschließen"
		onconfirm={startClose}
	/>
	<ConfirmDialog
		bind:open={forceOpen}
		title="Trotz fehlender Belege abschließen?"
		description={`${summary.missingReceipts} Ausgaben haben keinen Beleg. Ohne Belege ist die Abrechnung unvollständig, z. B. gegenüber Zuschussgebern.`}
		confirmLabel="Trotzdem abschließen"
		destructive
		onconfirm={() => close(true)}
	/>
	<ConfirmDialog
		bind:open={reopenOpen}
		title="Abrechnung wieder öffnen?"
		description="Buchungen können danach wieder geändert werden."
		confirmLabel="Wieder öffnen"
		onconfirm={reopen}
	/>
{/if}
