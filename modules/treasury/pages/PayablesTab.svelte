<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import Download from '@lucide/svelte/icons/download';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Plus from '@lucide/svelte/icons/plus';
	import Wallet from '@lucide/svelte/icons/wallet';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import {
		DataTable,
		FormField,
		MobileActionBar,
		MoneyInput,
		toastWithUndo
	} from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		PAYABLE_SOURCES,
		PAYABLE_SOURCE_LABELS,
		type Payable,
		type PayableList
	} from '../schemas';
	import {
		BASE,
		defaultAccountId,
		errorMessage,
		fmtDate,
		openApiFile,
		todayIso,
		type SharedData
	} from './helpers';
	import BulkPayDialog from './BulkPayDialog.svelte';
	import FilterChips from './FilterChips.svelte';
	import HistorySheet from './HistorySheet.svelte';
	import type { FamilyRef } from './navigation';
	import StatusBadge from './StatusBadge.svelte';
	import PayableDialog from './PayableDialog.svelte';

	let {
		accounts,
		actions,
		categories,
		payers,
		perm,
		version,
		onchanged,
		onfamily
	}: SharedData & {
		onchanged: () => void | Promise<void>;
		/** öffnet das Familienkonto eines Zahlers */
		onfamily?: (ref: FamilyRef) => void;
	} = $props();

	let status = $state<'open' | 'paid' | 'cancelled' | 'all'>('open');
	let source = $state<string | null>(null);
	let data = $state<PayableList | null>(null);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = !data;
		error = '';
		try {
			const q = new URLSearchParams({ status, source: source ?? 'all' });
			data = await apiFetch<PayableList>(`${BASE}/payables?${q}`);
		} catch (e) {
			error = errorMessage(e, 'Auszahlungen konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void version;
		void status;
		void source;
		untrack(() => void load());
	});

	let dialogOpen = $state(false);
	let edit = $state<Payable | null>(null);

	// Auswahl für Sammelaktionen (nur offene, nicht stornierte; Recht wie der Einzel-Knopf „Bezahlt“)
	const isOpenItem = (p: Payable) => p.openCents > 0 && !p.cancelledAt;
	const canBulk = $derived(perm.payable);
	let selected = $state<string[]>([]);
	const selectable = $derived((data?.items ?? []).filter(isOpenItem));
	const selectedItems = $derived(selectable.filter((p) => selected.includes(p.id)));
	const selectedSum = $derived(selectedItems.reduce((s, p) => s + p.openCents, 0));
	const allSelected = $derived(selectable.length > 0 && selectedItems.length === selectable.length);
	const someSelected = $derived(selectedItems.length > 0 && !allSelected);
	function toggleAll(on: boolean) {
		selected = on ? selectable.map((p) => p.id) : [];
	}
	function toggleOne(id: string, on: boolean) {
		selected = on ? [...new Set([...selected, id])] : selected.filter((x) => x !== id);
	}
	let bulkPayOpen = $state(false);

	// Überweisung buchen
	let payOpen = $state(false);
	let payItem = $state<Payable | null>(null);
	// wie `history.endpoints.ts`: Berichts- UND Kassenrecht
	const canHistory = $derived(
		can((page.data.permissions ?? []) as string[], 'treasury.report.view') &&
			can((page.data.permissions ?? []) as string[], 'treasury.cash.view')
	);
	let historyOpen = $state(false);
	let historyItem = $state<Payable | null>(null);
	let payAccount = $state<string | null>(null);
	let payDate = $state(todayIso());
	let payAmount = $state(0);
	let busy = $state(false);

	function startPay(p: Payable) {
		payItem = p;
		payAccount = defaultAccountId(accounts);
		payDate = todayIso();
		payAmount = p.openCents;
		payOpen = true;
	}

	async function pay() {
		if (!payItem || !payAccount) return;
		busy = true;
		try {
			await apiFetch(`${BASE}/payables/${payItem.id}/pay`, {
				method: 'POST',
				body: JSON.stringify({ accountId: payAccount, bookedOn: payDate, amountCents: payAmount })
			});
			toast.success(
				payItem.source === 'reimbursement'
					? 'Überweisung gebucht – in der Abrechnung als ausgezahlt markiert'
					: payItem.source === 'expense'
						? 'Überweisung gebucht – in der Abrechnung als bezahlt markiert'
						: 'Überweisung gebucht'
			);
			payOpen = false;
			await onchanged();
		} catch (e) {
			toast.error(errorMessage(e, 'Buchen fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	// Belege (Eingangsrechnung bzw. Belege der Auslagen aus der Abrechnung)
	type ReceiptItem = {
		id: string;
		label: string;
		date: string | null;
		amountCents: number | null;
		name: string;
		contentType: string;
	};
	let receiptsOpen = $state(false);
	let receiptsFor = $state<Payable | null>(null);
	let receipts = $state<ReceiptItem[] | null>(null);

	async function showReceipts(p: Payable) {
		receiptsFor = p;
		receipts = null;
		receiptsOpen = true;
		try {
			receipts = await apiFetch<ReceiptItem[]>(`${BASE}/payables/${p.id}/receipts`);
		} catch (e) {
			receipts = [];
			toast.error(errorMessage(e, 'Belege konnten nicht geladen werden'));
		}
	}

	async function openReceipt(r: ReceiptItem) {
		if (!receiptsFor) return;
		try {
			await openApiFile(`${BASE}/payables/${receiptsFor.id}/receipts/${r.id}`);
		} catch (e) {
			toast.error(errorMessage(e, 'Beleg nicht verfügbar'));
		}
	}

	async function showIban(p: Payable) {
		try {
			const r = await apiFetch<{ iban: string }>(`${BASE}/payables/${p.id}/iban`);
			await navigator.clipboard?.writeText(r.iban.replace(/\s/g, '')).catch(() => undefined);
			toast.info(`IBAN ${p.recipientName}: ${r.iban} (kopiert)`, { duration: 10000 });
		} catch (e) {
			toast.error(errorMessage(e, 'IBAN nicht verfügbar'));
		}
	}

	async function setCancelled(p: Payable, cancelled: boolean) {
		try {
			await apiFetch(`${BASE}/payables/${p.id}/cancel`, {
				method: 'POST',
				body: JSON.stringify({ cancelled })
			});
			const revert = async () => {
				await apiFetch(`${BASE}/payables/${p.id}/cancel`, {
					method: 'POST',
					body: JSON.stringify({ cancelled: !cancelled })
				});
			};
			toastWithUndo({
				message: cancelled ? 'Auszahlung storniert' : 'Wieder aufgenommen',
				undo: revert,
				onundone: onchanged
			});
			await onchanged();
		} catch (e) {
			toast.error(errorMessage(e, 'Aktion fehlgeschlagen'));
		}
	}

	async function exportCsv() {
		try {
			await openApiFile(`${BASE}/payables.csv`, true);
		} catch (e) {
			toast.error(errorMessage(e, 'Export fehlgeschlagen'));
		}
	}

	const statuses: { value: typeof status; label: string }[] = [
		{ value: 'open', label: 'Offen' },
		{ value: 'paid', label: 'Bezahlt' },
		{ value: 'cancelled', label: 'Storniert' },
		{ value: 'all', label: 'Alle' }
	];
	const sourceOptions = PAYABLE_SOURCES.map((s) => ({
		value: s as string,
		label: PAYABLE_SOURCE_LABELS[s]
	}));
	const accountOptions = $derived(
		accounts.filter((a) => !a.archived).map((a) => ({ value: a.id, label: a.name }))
	);
</script>

<div class={canBulk && selectedItems.length ? 'max-sm:pb-20' : ''}>
	<DataTable
		mobile="cards"
		caption="Ausstehende Überweisungen"
		{loading}
		{error}
		empty={!!data && !data.items.length}
		emptyTitle={status === 'open' ? 'Nichts auszuzahlen' : 'Keine Einträge'}
		emptyDescription={status === 'open'
			? 'Auslagen aus Abrechnungen, Rückzahlungen und Guthaben erscheinen hier automatisch. Eingangsrechnungen kannst du selbst erfassen.'
			: undefined}
	>
		{#snippet toolbar()}
			<FilterChips
				options={statuses}
				bind:value={status}
				label="Auszahlungen nach Status filtern"
				onchange={() => (selected = [])}
			/>
			<SelectField
				class="w-48"
				size="sm"
				label="Art"
				options={sourceOptions}
				bind:value={source}
				emptyLabel="Alle Arten"
				placeholder="Alle Arten"
			/>
			<div class="ml-auto flex flex-wrap gap-2">
				<Button size="sm" variant="outline" onclick={exportCsv}
					><Download /> Überweisungsliste</Button
				>
				{#if perm.payable}
					<Button
						size="sm"
						onclick={() => {
							edit = null;
							dialogOpen = true;
						}}
					>
						<Plus /> Eingangsrechnung
					</Button>
				{/if}
			</div>
			<MobileActionBar
				show={canBulk && selectedItems.length > 0}
				label="Sammelaktionen für Auszahlungen"
				class="sm:w-full sm:rounded-md sm:border sm:bg-muted/40 sm:px-3 sm:py-2"
			>
				<span class="text-sm font-medium" aria-live="polite">
					{selectedItems.length} ausgewählt ·
					<span class="tabular-nums">{formatEuro(selectedSum)}</span>
				</span>
				<Button size="sm" onclick={() => (bulkPayOpen = true)}>
					<Wallet /> Als bezahlt buchen
				</Button>
				<Button size="sm" variant="ghost" class="ml-auto" onclick={() => (selected = [])}>
					<X /> Auswahl aufheben
				</Button>
			</MobileActionBar>
		{/snippet}
		{#snippet head()}
			<Table.Row>
				{#if canBulk}
					<Table.Head class="w-10">
						<Checkbox
							aria-label="Alle offenen Auszahlungen auswählen"
							checked={allSelected}
							indeterminate={someSelected}
							disabled={!selectable.length}
							onCheckedChange={(v) => toggleAll(v === true)}
						/>
					</Table.Head>
				{/if}
				<Table.Head>Empfänger*in</Table.Head>
				<Table.Head>Grund</Table.Head>
				<Table.Head>Fällig</Table.Head>
				<Table.Head>IBAN</Table.Head>
				<Table.Head>Status</Table.Head>
				<Table.Head class="text-right">Betrag</Table.Head>
				<Table.Head class="text-right">Offen</Table.Head>
				<Table.Head class="text-right"><span class="sr-only">Aktionen</span></Table.Head>
			</Table.Row>
		{/snippet}
		{#each data?.items ?? [] as p (p.id)}
			<Table.Row
				class={p.cancelledAt ? 'text-muted-foreground' : ''}
				data-state={selected.includes(p.id) ? 'selected' : undefined}
			>
				{#if canBulk}
					<Table.Cell onclick={(e: MouseEvent) => e.stopPropagation()}>
						{#if isOpenItem(p)}
							<Checkbox
								aria-label={`Auszahlung an ${p.recipientName} auswählen`}
								checked={selected.includes(p.id)}
								onCheckedChange={(v) => toggleOne(p.id, v === true)}
							/>
						{/if}
					</Table.Cell>
				{/if}
				<Table.Cell class="max-w-56">
					<div class="truncate font-medium">{p.recipientName}</div>
					{#if p.payer}
						{@const payer = p.payer}
						{#if onfamily}
							<button
								type="button"
								class="block max-w-full truncate text-left text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
								title="Familienkonto öffnen"
								onclick={(e) => {
									e.stopPropagation();
									onfamily({ payerId: payer.id });
								}}
							>
								{payer.name}
							</button>
						{:else}
							<div class="truncate text-xs text-muted-foreground">{payer.name}</div>
						{/if}
					{/if}
				</Table.Cell>
				<Table.Cell class="max-w-72">
					<div class="truncate">{p.description}</div>
					<div class="mt-1 flex flex-wrap gap-1">
						<Badge variant="outline">{PAYABLE_SOURCE_LABELS[p.source]}</Badge>
						{#if p.action}<Badge variant="secondary">{p.action.name}</Badge>{/if}
					</div>
				</Table.Cell>
				<Table.Cell class="whitespace-nowrap tabular-nums {p.overdue ? 'text-destructive' : ''}">
					{fmtDate(p.dueOn)}
				</Table.Cell>
				<Table.Cell class="whitespace-nowrap">
					{#if p.ibanMasked}
						<span class="font-mono text-xs">{p.ibanMasked}</span>
					{:else}
						<span class="text-xs text-warning">fehlt</span>
					{/if}
				</Table.Cell>
				<Table.Cell><StatusBadge payable={p} /></Table.Cell>
				<Table.Cell class="text-right tabular-nums">{formatEuro(p.amountCents)}</Table.Cell>
				<Table.Cell class="text-right font-medium tabular-nums"
					>{formatEuro(p.openCents)}</Table.Cell
				>
				<Table.Cell class="text-right whitespace-nowrap">
					{#if perm.payable && p.openCents > 0}
						<Button size="sm" variant="outline" onclick={() => startPay(p)}>Bezahlt</Button>
					{/if}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon"
									aria-label={`Aktionen für ${p.recipientName}`}
								>
									<Ellipsis />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end">
							{#if canHistory}
								<DropdownMenu.Item
									onclick={() => {
										historyItem = p;
										historyOpen = true;
									}}
								>
									Verlauf anzeigen
								</DropdownMenu.Item>
							{/if}
							{#if perm.bank && p.hasIban}
								<DropdownMenu.Item onclick={() => showIban(p)}
									>IBAN anzeigen und kopieren</DropdownMenu.Item
								>
							{/if}
							{#if p.receipt || p.source === 'reimbursement' || p.source === 'expense'}
								<DropdownMenu.Item onclick={() => showReceipts(p)}>Belege ansehen</DropdownMenu.Item
								>
							{/if}
							{#if p.source === 'reimbursement' && p.action && perm.report}
								<DropdownMenu.Item
									onclick={() => p.action && goto(`/modules/treasury/accountings/${p.action.id}`)}
									>Abrechnung ansehen</DropdownMenu.Item
								>
							{/if}
							{#if perm.payable}
								<DropdownMenu.Item
									onclick={() => {
										edit = p;
										dialogOpen = true;
									}}
								>
									Bearbeiten
								</DropdownMenu.Item>
								{#if p.cancelledAt}
									<DropdownMenu.Item onclick={() => setCancelled(p, false)}
										>Wieder aufnehmen</DropdownMenu.Item
									>
								{:else if p.paidCents === 0}
									<DropdownMenu.Item class="text-destructive" onclick={() => setCancelled(p, true)}>
										Stornieren
									</DropdownMenu.Item>
								{/if}
							{/if}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</Table.Cell>
			</Table.Row>
		{/each}
		{#snippet footer()}
			{#if data && data.items.length}
				<span class="text-sm text-muted-foreground">
					{data.totals.count} offen · Summe
					<span class="tabular-nums">{formatEuro(data.totals.openCents)}</span>
				</span>
			{/if}
		{/snippet}
	</DataTable>
</div>

<BulkPayDialog
	bind:open={bulkPayOpen}
	items={selectedItems}
	{accounts}
	{categories}
	onfinished={async () => {
		selected = [];
		await onchanged();
	}}
/>

<HistorySheet
	bind:open={historyOpen}
	kind="payable"
	id={historyItem?.id ?? null}
	title={historyItem?.recipientName ?? ''}
/>

<PayableDialog
	bind:open={dialogOpen}
	payable={edit}
	{actions}
	{payers}
	canUpload={perm.upload}
	onsaved={onchanged}
/>

<Dialog.Root bind:open={receiptsOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Belege</Dialog.Title>
			<Dialog.Description>
				{receiptsFor?.recipientName} · {receiptsFor?.description}
			</Dialog.Description>
		</Dialog.Header>
		{#if receipts === null}
			<p class="text-sm text-muted-foreground">Lädt …</p>
		{:else if !receipts.length}
			<p class="text-sm text-muted-foreground">
				Keine Belege vorhanden. Bei Auslagen werden die Belege in der Abrechnung der Aktion
				hochgeladen.
			</p>
		{:else}
			<ul class="divide-y text-sm">
				{#each receipts as r (r.id)}
					<li class="flex items-center justify-between gap-2 py-2">
						<div class="min-w-0">
							<div class="truncate font-medium">{r.label}</div>
							<div class="text-xs text-muted-foreground">
								{fmtDate(r.date)}{r.amountCents != null ? ` · ${formatEuro(r.amountCents)}` : ''} · {r.name}
							</div>
						</div>
						<Button size="sm" variant="outline" onclick={() => openReceipt(r)}>Öffnen</Button>
					</li>
				{/each}
			</ul>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (receiptsOpen = false)}>Schließen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={payOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Überweisung buchen</Dialog.Title>
			<Dialog.Description>
				{#if payItem}
					{payItem.recipientName} · {payItem.description} · offen {formatEuro(payItem.openCents)}
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-4">
			<FormField label="Von Konto *" id="pp-account">
				<SelectField
					id="pp-account"
					label="Konto"
					options={accountOptions}
					bind:value={payAccount}
				/>
			</FormField>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<FormField label="Betrag *" id="pp-amount">
					<MoneyInput
						id="pp-amount"
						label="Betrag"
						bind:cents={payAmount}
						max={payItem?.openCents}
					/>
				</FormField>
				<FormField label="Datum *" id="pp-date">
					<Input id="pp-date" type="date" bind:value={payDate} />
				</FormField>
			</div>
			<p class="text-xs text-muted-foreground">
				Legt eine Ausgabe auf dem Konto an. Die Überweisung selbst machst du im Online-Banking.
			</p>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (payOpen = false)}>Abbrechen</Button>
			<Button onclick={pay} disabled={busy || !payAccount || payAmount <= 0}>
				{busy ? 'Bucht …' : 'Buchen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
