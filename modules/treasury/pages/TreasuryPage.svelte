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
	import { apiFetch, can } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
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
	import AllocateDialog from './AllocateDialog.svelte';
	import FamilySheet from './FamilySheet.svelte';
	import ImportDialog from './ImportDialog.svelte';
	import IncomeSection from './IncomeSection.svelte';
	import InvoiceDialog from './InvoiceDialog.svelte';
	import OutgoingSection from './OutgoingSection.svelte';
	import OverviewTab from './OverviewTab.svelte';
	import ReportsTab from './ReportsTab.svelte';
	import SuggestionsDialog from './SuggestionsDialog.svelte';
	import TransactionDialog from './TransactionDialog.svelte';
	import TransactionsTab from './TransactionsTab.svelte';
	import TransferDialog from './TransferDialog.svelte';
	import {
		SECTIONS,
		SECTION_LABELS,
		resolveLocation,
		type FamilyRef,
		type IncomeView,
		type OutgoingView,
		type Section,
		type TreasuryLocation,
		type TreasuryPerm
	} from './navigation';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const perm = $derived<TreasuryPerm>({
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

	// Bereich + Unteransicht aus der URL; alte Links (`?tab=open`, `?tab=payers` …) werden umgeleitet
	const initial = resolveLocation(
		page.url.searchParams.get('tab'),
		page.url.searchParams.get('view')
	);
	let section = $state<Section>(initial.section);
	let incomeView = $state<IncomeView>(
		initial.section === 'income' ? (initial.view as IncomeView) : 'open'
	);
	let outgoingView = $state<OutgoingView>(
		initial.section === 'outgoing' ? (initial.view as OutgoingView) : 'payables'
	);

	const visibleSections = $derived(SECTIONS.filter((s) => s !== 'reports' || perm.report));
	/** ohne Berichtsrecht nie „Berichte“ anzeigen */
	const activeSection = $derived<Section>(
		section === 'reports' && !perm.report ? 'overview' : section
	);

	function syncUrl() {
		const url = new URL(page.url);
		url.searchParams.set('tab', section);
		if (section === 'income') url.searchParams.set('view', incomeView);
		else if (section === 'outgoing') url.searchParams.set('view', outgoingView);
		else url.searchParams.delete('view');
		replaceState(url, {});
	}

	function go(loc: TreasuryLocation) {
		section = loc.section;
		if (loc.section === 'income' && loc.view) incomeView = loc.view as IncomeView;
		if (loc.section === 'outgoing' && loc.view) outgoingView = loc.view as OutgoingView;
		syncUrl();
	}

	/** Navigation über Bereichs- oder alte Tab-Namen (z. B. `open`, `invoices` aus der Übersicht) */
	function open(tab: string) {
		go(resolveLocation(tab));
	}

	/** Bereich wechseln; die zuletzt gewählte Unteransicht bleibt erhalten */
	function setSection(v: string) {
		section = resolveLocation(v).section;
		syncUrl();
	}

	// Familienansicht (Seitenpanel), aus allen Bereichen per `onfamily` erreichbar
	let familyOpen = $state(false);
	let familyTarget = $state<FamilyRef | null>(null);
	function openFamily(ref: FamilyRef) {
		familyTarget = ref;
		familyOpen = true;
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

	const shared = $derived({
		accounts,
		categories,
		actions,
		members,
		payers,
		perm,
		version,
		onfamily: openFamily
	});

	/** Tastenkürzel „n“: neue Buchung (nicht beim Tippen, nicht über offenen Dialogen/Menüs) */
	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'n' && e.key !== 'N') return;
		if (e.ctrlKey || e.altKey || e.metaKey || e.repeat || e.defaultPrevented) return;
		if (!perm.editTx || txOpen) return;
		const el = e.target instanceof HTMLElement ? e.target : null;
		if (el && (el.isContentEditable || el.closest('input, textarea, select, [contenteditable]'))) {
			return;
		}
		if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
		e.preventDefault();
		editTransaction(null);
	}
</script>

<svelte:window onkeydown={onKeydown} />

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
				<Button
					onclick={() => editTransaction(null)}
					title="Neue Buchung (N)"
					aria-keyshortcuts="n"
				>
					<Plus /> Buchung
					<kbd
						class="ml-0.5 hidden rounded border border-current/30 px-1 font-mono text-[10px] leading-4 opacity-70 sm:inline"
						aria-hidden="true">N</kbd
					>
				</Button>
				<Button variant="outline" onclick={() => (importOpen = true)}>
					<Upload /> Import
				</Button>
			{/if}
			{#if perm.editTx || perm.editInvoice}
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
							<DropdownMenu.Label class="text-xs text-muted-foreground"
								>Buchungen</DropdownMenu.Label
							>
							<DropdownMenu.Item onclick={() => (transferOpen = true)}>
								<ArrowLeftRight /> Umbuchung zwischen Konten
							</DropdownMenu.Item>
							<DropdownMenu.Item onclick={() => (suggestionsOpen = true)}>
								<Sparkles /> Zuordnungsvorschläge prüfen
							</DropdownMenu.Item>
						{/if}
						{#if perm.editTx && perm.editInvoice}<DropdownMenu.Separator />{/if}
						{#if perm.editInvoice}
							<DropdownMenu.Label class="text-xs text-muted-foreground"
								>Rechnungen</DropdownMenu.Label
							>
							<DropdownMenu.Item onclick={() => (invoiceOpen = true)}>
								<FilePlus /> Neue Rechnung
							</DropdownMenu.Item>
							<DropdownMenu.Item onclick={sync} disabled={syncing}>
								<RefreshCw />
								{syncing ? 'Gleicht ab …' : 'Mit Aktionen abgleichen'}
							</DropdownMenu.Item>
						{/if}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		{/snippet}
	</PageHeader>

	<Tabs.Root value={activeSection} onValueChange={(v) => setSection(v)}>
		<Tabs.List variant="line" class="mb-4 h-auto w-full flex-wrap justify-start">
			{#each visibleSections as s (s)}
				<Tabs.Trigger value={s} class="flex-none px-2 sm:px-3">{SECTION_LABELS[s]}</Tabs.Trigger>
			{/each}
		</Tabs.List>
		<Tabs.Content value="overview">
			{#if activeSection === 'overview'}
				<OverviewTab
					{...shared}
					onopen={open}
					onallocate={allocate}
					onsuggestions={() => (suggestionsOpen = true)}
					oncreate={() => editTransaction(null)}
					onimport={() => (importOpen = true)}
					onchanged={changed}
				/>
			{/if}
		</Tabs.Content>
		<Tabs.Content value="income">
			{#if activeSection === 'income'}
				<IncomeSection
					{...shared}
					view={incomeView}
					{annualView}
					{annualManage}
					onview={(v) => go({ section: 'income', view: v })}
					onopen={open}
					oncreateinvoice={() => (invoiceOpen = true)}
					onchanged={changed}
				/>
			{/if}
		</Tabs.Content>
		<Tabs.Content value="outgoing">
			{#if activeSection === 'outgoing'}
				<OutgoingSection
					{...shared}
					view={outgoingView}
					onview={(v) => go({ section: 'outgoing', view: v })}
					onchanged={changed}
				/>
			{/if}
		</Tabs.Content>
		<Tabs.Content value="transactions">
			{#if activeSection === 'transactions'}
				<TransactionsTab
					{...shared}
					onedit={editTransaction}
					onallocate={allocate}
					onsuggestions={() => (suggestionsOpen = true)}
					onchanged={changed}
				/>
			{/if}
		</Tabs.Content>
		<Tabs.Content value="reports">
			{#if activeSection === 'reports' && perm.report}<ReportsTab {...shared} />{/if}
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
<FamilySheet
	bind:open={familyOpen}
	target={familyTarget}
	{accounts}
	{payers}
	{members}
	{perm}
	onchanged={changed}
	onfamily={openFamily}
/>
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
