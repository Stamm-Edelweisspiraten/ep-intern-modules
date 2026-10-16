<script lang="ts">
	import { page } from '$app/state';
	import { goto, replaceState } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Plus from '@lucide/svelte/icons/plus';
	import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
	import FilePlus from '@lucide/svelte/icons/file-plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Settings from '@lucide/svelte/icons/settings';
	import Upload from '@lucide/svelte/icons/upload';
	import Users from '@lucide/svelte/icons/users';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as Tabs from '$lib/components/ui/tabs';
	import { PageHeader } from '$lib/components/layout';
	import type {
		Account,
		Category,
		InvoiceDetail,
		ImportResult,
		Payer,
		Transaction
	} from '../schemas';
	import { BASE, errorMessage } from './helpers';
	import AccountingsTab from './AccountingsTab.svelte';
	import AnnualFeeTab from './AnnualFeeTab.svelte';
	import AllocateDialog from './AllocateDialog.svelte';
	import ImportDialog from './ImportDialog.svelte';
	import InvoiceDialog from './InvoiceDialog.svelte';
	import InvoicesTab from './InvoicesTab.svelte';
	import OpenItemsTab from './OpenItemsTab.svelte';
	import OverviewTab from './OverviewTab.svelte';
	import PayablesTab from './PayablesTab.svelte';
	import PayersTab from './PayersTab.svelte';
	import ReportsTab from './ReportsTab.svelte';
	import SuggestionsDialog from './SuggestionsDialog.svelte';
	import TransactionDialog from './TransactionDialog.svelte';
	import TransactionsTab from './TransactionsTab.svelte';
	import TransferDialog from './TransferDialog.svelte';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const perm = $derived({
		editTx: can(permissions, 'treasury.transaction.edit'),
		deleteTx: can(permissions, 'treasury.transaction.delete'),
		editInvoice: can(permissions, 'treasury.invoice.edit'),
		deleteInvoice: can(permissions, 'treasury.invoice.delete'),
		send: can(permissions, 'treasury.invoice.send'),
		report: can(permissions, 'treasury.report.view'),
		accounts: can(permissions, 'treasury.account.manage'),
		settings: can(permissions, 'treasury.settings.manage'),
		upload: can(permissions, 'treasury.storage.write'),
		payable: can(permissions, 'treasury.payable.edit'),
		bank: can(permissions, 'treasury.bank.view')
	});
	const annualView = $derived(can(permissions, 'treasury.annual-fee.view'));
	const annualManage = $derived(can(permissions, 'treasury.annual-fee.manage'));

	const TABS = [
		'overview',
		'open',
		'payables',
		'accountings',
		'transactions',
		'invoices',
		'annual',
		'reports'
	];
	const initialTab = page.url.searchParams.get('tab');
	let tab = $state(initialTab && TABS.includes(initialTab) ? initialTab : 'overview');
	/** Zahler & Familien: im „Mehr“-Menü als Seitenpanel (alte Links mit ?tab=payers öffnen es) */
	let payersOpen = $state(initialTab === 'payers');

	function setTab(v: string) {
		tab = v;
		const url = new URL(page.url);
		url.searchParams.set('tab', v);
		replaceState(url, {});
	}

	let accounts = $state<Account[]>([]);
	let categories = $state<Category[]>([]);
	let actions = $state<{ id: string; name: string }[]>([]);
	let members = $state<{ id: string; name: string; emails: string[] }[]>([]);
	let payers = $state<Payer[]>([]);
	/** Zähler zum Neuladen der Tabs nach Änderungen */
	let version = $state(0);

	async function loadShared() {
		try {
			[accounts, categories, actions, members, payers] = await Promise.all([
				apiFetch<Account[]>(`${BASE}/accounts`),
				apiFetch<Category[]>(`${BASE}/categories`),
				apiFetch<{ id: string; name: string }[]>(`${BASE}/action-refs`),
				apiFetch<{ id: string; name: string; emails: string[] }[]>(`${BASE}/members`),
				apiFetch<Payer[]>(`${BASE}/payers`)
			]);
		} catch (e) {
			toast.error(errorMessage(e, 'Stammdaten der Kasse konnten nicht geladen werden'));
		}
	}

	async function changed() {
		version++;
		await loadShared();
	}

	$effect(() => {
		void loadShared();
	});

	let txOpen = $state(false);
	let txEdit = $state<Transaction | null>(null);
	let transferOpen = $state(false);
	let importOpen = $state(false);
	let suggestionsOpen = $state(false);
	let allocateOpen = $state(false);
	let allocateTx = $state<Transaction | null>(null);
	let invoiceOpen = $state(false);
	let syncing = $state(false);

	function editTransaction(t: Transaction | null) {
		txEdit = t;
		txOpen = true;
	}
	function allocate(t: Transaction) {
		allocateTx = t;
		allocateOpen = true;
	}

	// Zuordnung passiert bereits im Buchungsdialog – kein zweiter Dialog danach
	async function afterTxSaved() {
		await changed();
	}

	async function afterImport(r: ImportResult) {
		await changed();
		if (r.suggestions > 0) suggestionsOpen = true;
	}

	async function sync() {
		syncing = true;
		try {
			const r = await apiFetch<{ created: number; updated: number; cancelled: number }>(
				`${BASE}/sync`,
				{ method: 'POST' }
			);
			toast.success(`Abgleich: ${r.created} neu, ${r.updated} geändert, ${r.cancelled} storniert`);
			await changed();
		} catch (e) {
			toast.error(errorMessage(e, 'Abgleich fehlgeschlagen'));
		} finally {
			syncing = false;
		}
	}

	const shared = $derived({ accounts, categories, actions, members, payers, perm, version });
</script>

<div class="space-y-6">
	<PageHeader
		title="Kasse"
		description="Konten, Buchungen und offene Beiträge des Stammes an einem Ort."
	>
		{#snippet actions()}
			{#if perm.settings || perm.accounts}
				<Button
					variant="ghost"
					href="/modules/treasury/settings"
					aria-label="Einstellungen der Kasse"
				>
					<Settings /> Einstellungen
				</Button>
			{/if}
			{#if perm.editTx}
				<Button onclick={() => editTransaction(null)}><Plus /> Buchung</Button>
				<Button variant="outline" onclick={() => (importOpen = true)}>
					<Upload /> Import
				</Button>
			{/if}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" aria-label="Weitere Aktionen">
							Mehr <ChevronDown />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-72">
					{#if perm.editTx}
						<DropdownMenu.Label class="text-xs text-muted-foreground">Buchungen</DropdownMenu.Label>
						<DropdownMenu.Item onclick={() => (transferOpen = true)}>
							<ArrowLeftRight /> Umbuchung zwischen Konten
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => (suggestionsOpen = true)}>
							<Sparkles /> Zuordnungsvorschläge prüfen
						</DropdownMenu.Item>
					{/if}
					{#if perm.editTx && perm.editInvoice}<DropdownMenu.Separator />{/if}
					{#if perm.editInvoice}
						<DropdownMenu.Label class="text-xs text-muted-foreground">Rechnungen</DropdownMenu.Label
						>
						<DropdownMenu.Item onclick={() => (invoiceOpen = true)}>
							<FilePlus /> Neue Rechnung
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={sync} disabled={syncing}>
							<RefreshCw />
							{syncing ? 'Gleicht ab …' : 'Mit Aktionen abgleichen'}
						</DropdownMenu.Item>
					{/if}
					{#if perm.editTx || perm.editInvoice}<DropdownMenu.Separator />{/if}
					<DropdownMenu.Label class="text-xs text-muted-foreground">Familien</DropdownMenu.Label>
					<DropdownMenu.Item onclick={() => (payersOpen = true)}>
						<Users /> Zahler &amp; Familien
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/snippet}
	</PageHeader>

	<Tabs.Root value={tab} onValueChange={(v) => setTab(v)}>
		<Tabs.List variant="line" class="mb-4 h-auto flex-wrap">
			<Tabs.Trigger value="overview">Übersicht</Tabs.Trigger>
			<Tabs.Trigger value="open">Offene Posten</Tabs.Trigger>
			<Tabs.Trigger value="payables">Auszahlungen</Tabs.Trigger>
			{#if perm.report}<Tabs.Trigger value="accountings">Abrechnungen</Tabs.Trigger>{/if}
			<Tabs.Trigger value="transactions">Buchungen</Tabs.Trigger>
			<Tabs.Trigger value="invoices">Rechnungen</Tabs.Trigger>
			{#if annualView}<Tabs.Trigger value="annual">Jahresbeitrag</Tabs.Trigger>{/if}
			{#if perm.report}<Tabs.Trigger value="reports">Berichte</Tabs.Trigger>{/if}
		</Tabs.List>
		<Tabs.Content value="overview">
			{#if tab === 'overview'}
				<OverviewTab
					{...shared}
					onopen={(t) => setTab(t)}
					onallocate={allocate}
					onsuggestions={() => (suggestionsOpen = true)}
					onchanged={changed}
				/>
			{/if}
		</Tabs.Content>
		<Tabs.Content value="open">
			{#if tab === 'open'}<OpenItemsTab {...shared} onchanged={changed} />{/if}
		</Tabs.Content>
		<Tabs.Content value="transactions">
			{#if tab === 'transactions'}
				<TransactionsTab
					{...shared}
					onedit={editTransaction}
					onallocate={allocate}
					onsuggestions={() => (suggestionsOpen = true)}
					onchanged={changed}
				/>
			{/if}
		</Tabs.Content>
		<Tabs.Content value="invoices">
			{#if tab === 'invoices'}
				<InvoicesTab {...shared} oncreate={() => (invoiceOpen = true)} onchanged={changed} />
			{/if}
		</Tabs.Content>
		<Tabs.Content value="accountings">
			{#if tab === 'accountings' && perm.report}<AccountingsTab {...shared} />{/if}
		</Tabs.Content>
		<Tabs.Content value="annual">
			{#if tab === 'annual' && annualView}
				<AnnualFeeTab
					{...shared}
					canManage={annualManage}
					onopen={(t) => setTab(t)}
					onchanged={changed}
				/>
			{/if}
		</Tabs.Content>
		<Tabs.Content value="reports">
			{#if tab === 'reports' && perm.report}<ReportsTab {...shared} />{/if}
		</Tabs.Content>
		<Tabs.Content value="payables">
			{#if tab === 'payables'}<PayablesTab {...shared} onchanged={changed} />{/if}
		</Tabs.Content>
	</Tabs.Root>
</div>

<TransactionDialog
	bind:open={txOpen}
	transaction={txEdit}
	{accounts}
	{categories}
	{actions}
	{payers}
	canUploadReceipt={perm.upload}
	onsaved={afterTxSaved}
/>
<Sheet.Root bind:open={payersOpen}>
	<Sheet.Content
		side="right"
		class="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
	>
		<Sheet.Header class="border-b">
			<Sheet.Title>Zahler &amp; Familien</Sheet.Title>
			<Sheet.Description>
				Zahler entstehen automatisch, wenn du Zahlungen zuordnest oder erfasst – inklusive IBAN und
				Kindern. Hier kannst du nachsehen, korrigieren und Sammelrechnungen erstellen.
			</Sheet.Description>
		</Sheet.Header>
		<div class="p-4">
			{#if payersOpen}<PayersTab {...shared} onchanged={changed} />{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
<TransferDialog bind:open={transferOpen} {accounts} onsaved={changed} />
<ImportDialog bind:open={importOpen} {accounts} onimported={afterImport} />
<SuggestionsDialog
	bind:open={suggestionsOpen}
	onchanged={changed}
	onmanual={(t) => {
		suggestionsOpen = false;
		allocate(t);
	}}
/>
<AllocateDialog bind:open={allocateOpen} transaction={allocateTx} onsaved={changed} />
<InvoiceDialog
	bind:open={invoiceOpen}
	{payers}
	{members}
	{actions}
	onsaved={(inv: InvoiceDetail) => goto(`/modules/treasury/invoices/${inv.id}`)}
/>
