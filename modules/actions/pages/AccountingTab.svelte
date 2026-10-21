<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Check from '@lucide/svelte/icons/check';
	import FileText from '@lucide/svelte/icons/file-text';
	import Camera from '@lucide/svelte/icons/camera';
	import Inbox from '@lucide/svelte/icons/inbox';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Tabs from '$lib/components/ui/tabs';
	import { ConfirmDialog, EmptyState } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		MAX_RECEIPT_BYTES,
		RECEIPT_CONTENT_TYPES,
		type AccountingEntry,
		type AccountingState,
		type ExpenseLinkConfig
	} from '../schemas';
	import { fmtDate } from './format';
	import type { AutoIncome } from './auto-types';
	import AccountingSummaryCards from './AccountingSummaryCards.svelte';
	import EntriesTable, { type EntryFilter } from './EntriesTable.svelte';
	import RefundCard from './RefundCard.svelte';
	import AccountingEntryDialog from './AccountingEntryDialog.svelte';
	import PayoutsSection from './PayoutsSection.svelte';
	import InterimDialog from './InterimDialog.svelte';
	import InterimsCard from './InterimsCard.svelte';
	import ExpenseLinkSection from './ExpenseLinkSection.svelte';
	import CloseAccountingDialog from './CloseAccountingDialog.svelte';

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
	let reopenOpen = $state(false);
	let interimOpen = $state(false);
	let busy = $state(false);

	/** Unterbereich des Tabs (immer nur einer sichtbar) */
	type Section = 'entries' | 'payouts' | 'submissions' | 'interims' | 'refund';
	let section = $state<Section>('entries');
	/** Offene Einreichungen über den Kosten-Link (Zähler an der Umschaltleiste) */
	let pendingSubmissions = $state(0);

	const closed = $derived(!!acc?.closed);
	const editable = $derived(canEdit && !closed);
	const canViewPayouts = $derived(acc?.canViewPayouts ?? false);
	const interims = $derived(acc?.interims ?? []);
	const entryCount = $derived(acc?.entries.length ?? 0);
	const nextInterimNumber = $derived(interims.reduce((max, i) => Math.max(max, i.number), 0) + 1);
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

	async function loadPending() {
		try {
			const link = await apiFetch<ExpenseLinkConfig>(
				`/modules/actions/actions/${actionId}/expense-link`
			);
			pendingSubmissions = link.pendingCount;
		} catch {
			pendingSubmissions = 0;
		}
	}

	async function load() {
		try {
			acc = await apiFetch<AccountingState>(base);
			error = '';
			void loadPending();
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
	<div class="space-y-4" aria-busy="true" aria-label="Abrechnung wird geladen">
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
				class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success-border bg-success-muted px-4 py-3"
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
					{#if editable && entryCount > 0}
						<Button variant="outline" disabled={busy} onclick={() => (interimOpen = true)}>
							<Camera /> Zwischenabrechnung
						</Button>
					{/if}
					{#if canEdit}
						<Button disabled={busy} onclick={() => (closeOpen = true)}>
							<Check /> Abrechnung abschließen
						</Button>
					{/if}
				</div>
			</div>
		{/if}

		<AccountingSummaryCards
			{summary}
			onshowmissing={() => {
				filter = 'missing';
				section = 'entries';
			}}
		/>

		{#if editable && pendingSubmissions > 0}
			<div
				class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
				role="status"
			>
				<span class="flex items-center gap-2">
					<Inbox class="size-4 shrink-0" aria-hidden="true" />
					{pendingSubmissions === 1
						? '1 eingereichte Auslage wartet auf Prüfung'
						: `${pendingSubmissions} eingereichte Auslagen warten auf Prüfung`}
				</span>
				<Button variant="ghost" size="sm" onclick={() => (section = 'submissions')}>Prüfen</Button>
			</div>
		{/if}

		<Tabs.Root bind:value={section}>
			<Tabs.List variant="line" class="justify-start" aria-label="Bereiche der Abrechnung">
				<Tabs.Trigger value="entries">
					Buchungen
					{#if entryCount > 0}
						<Badge variant="secondary" class="ml-1">{entryCount}</Badge>
					{/if}
				</Tabs.Trigger>
				{#if canViewPayouts}
					<Tabs.Trigger value="payouts">
						Auslagen & Auszahlung
						{#if summary.openReimbursementCents > 0}
							<Badge variant="outline" class="ml-1 border-warning-border text-warning">
								{formatEuro(summary.openReimbursementCents)}
							</Badge>
						{/if}
					</Tabs.Trigger>
				{/if}
				<Tabs.Trigger value="submissions">
					Kosten-Link
					{#if pendingSubmissions > 0}
						<Badge class="ml-1">{pendingSubmissions}</Badge>
					{/if}
				</Tabs.Trigger>
				<Tabs.Trigger value="interims">
					Zwischenabrechnungen
					{#if interims.length > 0}
						<Badge variant="secondary" class="ml-1">{interims.length}</Badge>
					{/if}
				</Tabs.Trigger>
				<Tabs.Trigger value="refund">Rückzahlung</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="entries" class="pt-4">
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
			</Tabs.Content>

			{#if canViewPayouts}
				<Tabs.Content value="payouts" class="pt-4">
					<PayoutsSection
						{actionId}
						payees={acc.payees}
						{canViewPayouts}
						{editable}
						viaTreasury={!!acc.payoutsViaTreasury}
						onchanged={load}
					/>
				</Tabs.Content>
			{/if}

			<Tabs.Content value="submissions" class="pt-4">
				<ExpenseLinkSection {actionId} {editable} {closed} onchanged={load} />
			</Tabs.Content>

			<Tabs.Content value="interims" class="pt-4">
				{#if interims.length > 0}
					<InterimsCard {actionId} {interims} onchanged={load} />
				{:else}
					<EmptyState
						title="Noch keine Zwischenabrechnung"
						description="Eine Zwischenabrechnung hält den aktuellen Stand der Abrechnung fest – zum Beispiel, um Auslagen schon vor dem Abschluss auszuzahlen."
					>
						{#if editable && entryCount > 0}
							<Button variant="outline" onclick={() => (interimOpen = true)}>
								<Camera /> Zwischenabrechnung erstellen
							</Button>
						{/if}
					</EmptyState>
				{/if}
			</Tabs.Content>

			<Tabs.Content value="refund" class="pt-4">
				<RefundCard {actionId} {editable} {reloadKey} onchanged={load} />
			</Tabs.Content>
		</Tabs.Root>
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
	<InterimDialog
		bind:open={interimOpen}
		{actionId}
		entries={acc.entries}
		nextNumber={nextInterimNumber}
		viaTreasury={!!acc.payoutsViaTreasury}
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
	<CloseAccountingDialog
		bind:open={closeOpen}
		{base}
		{summary}
		viaTreasury={!!acc.payoutsViaTreasury}
		{pendingSubmissions}
		onclosed={load}
		onreview={() => (section = 'submissions')}
	/>
	<ConfirmDialog
		bind:open={reopenOpen}
		title="Abrechnung wieder öffnen?"
		description="Buchungen können danach wieder geändert werden."
		confirmLabel="Wieder öffnen"
		onconfirm={reopen}
	/>
{/if}
