<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Download from '@lucide/svelte/icons/download';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Plus from '@lucide/svelte/icons/plus';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import { DataTable, FormField, MoneyInput } from '$lib/components/layout';
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
	import PayableDialog from './PayableDialog.svelte';

	let {
		accounts,
		actions,
		payers,
		perm,
		version,
		onchanged
	}: SharedData & { onchanged: () => void | Promise<void> } = $props();

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

	// Überweisung buchen
	let payOpen = $state(false);
	let payItem = $state<Payable | null>(null);
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
			toast.success(cancelled ? 'Auszahlung storniert' : 'Wieder aufgenommen');
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

	const statuses = [
		{ value: 'open', label: 'Offen' },
		{ value: 'paid', label: 'Bezahlt' },
		{ value: 'cancelled', label: 'Storniert' },
		{ value: 'all', label: 'Alle' }
	] as const;
	const sourceOptions = PAYABLE_SOURCES.map((s) => ({
		value: s as string,
		label: PAYABLE_SOURCE_LABELS[s]
	}));
	const accountOptions = $derived(
		accounts.filter((a) => !a.archived).map((a) => ({ value: a.id, label: a.name }))
	);
</script>

<DataTable
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
		<div class="flex flex-wrap gap-1" role="group" aria-label="Status">
			{#each statuses as s (s.value)}
				<Button
					size="sm"
					variant={status === s.value ? 'default' : 'outline'}
					aria-pressed={status === s.value}
					onclick={() => (status = s.value)}
				>
					{s.label}
				</Button>
			{/each}
		</div>
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
			<Button size="sm" variant="outline" onclick={exportCsv}><Download /> Überweisungsliste</Button
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
	{/snippet}
	{#snippet head()}
		<Table.Row>
			<Table.Head>Empfänger*in</Table.Head>
			<Table.Head>Grund</Table.Head>
			<Table.Head>Fällig</Table.Head>
			<Table.Head>IBAN</Table.Head>
			<Table.Head class="text-right">Betrag</Table.Head>
			<Table.Head class="text-right">Offen</Table.Head>
			<Table.Head class="text-right"><span class="sr-only">Aktionen</span></Table.Head>
		</Table.Row>
	{/snippet}
	{#each data?.items ?? [] as p (p.id)}
		<Table.Row class={p.cancelledAt ? 'text-muted-foreground' : ''}>
			<Table.Cell class="max-w-56">
				<div class="truncate font-medium">{p.recipientName}</div>
				{#if p.payer}<div class="truncate text-xs text-muted-foreground">{p.payer.name}</div>{/if}
			</Table.Cell>
			<Table.Cell class="max-w-72">
				<div class="truncate">{p.description}</div>
				<div class="mt-1 flex flex-wrap gap-1">
					<Badge variant="outline">{PAYABLE_SOURCE_LABELS[p.source]}</Badge>
					{#if p.action}<Badge variant="secondary">{p.action.name}</Badge>{/if}
					{#if p.cancelledAt}<Badge variant="outline">storniert</Badge>{/if}
					{#if p.openCents === 0 && !p.cancelledAt}<Badge variant="secondary">bezahlt</Badge>{/if}
				</div>
			</Table.Cell>
			<Table.Cell class="whitespace-nowrap tabular-nums {p.overdue ? 'text-destructive' : ''}">
				{fmtDate(p.dueOn)}
			</Table.Cell>
			<Table.Cell class="whitespace-nowrap">
				{#if p.ibanMasked}
					<span class="font-mono text-xs">{p.ibanMasked}</span>
				{:else}
					<span class="text-xs text-amber-700 dark:text-amber-400">fehlt</span>
				{/if}
			</Table.Cell>
			<Table.Cell class="text-right tabular-nums">{formatEuro(p.amountCents)}</Table.Cell>
			<Table.Cell class="text-right font-medium tabular-nums">{formatEuro(p.openCents)}</Table.Cell>
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
						{#if perm.bank && p.hasIban}
							<DropdownMenu.Item onclick={() => showIban(p)}
								>IBAN anzeigen und kopieren</DropdownMenu.Item
							>
						{/if}
						{#if p.receipt || p.source === 'reimbursement'}
							<DropdownMenu.Item onclick={() => showReceipts(p)}>Belege ansehen</DropdownMenu.Item>
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
			<div class="grid grid-cols-2 gap-4">
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
