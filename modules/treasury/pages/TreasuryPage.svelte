<script lang="ts">
	import { page } from '$app/state';
	import { goto, replaceState } from '$app/navigation';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Plus from '@lucide/svelte/icons/plus';
	import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
	import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
	import ArrowUpFromLine from '@lucide/svelte/icons/arrow-up-from-line';
	import ChartColumn from '@lucide/svelte/icons/chart-column';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import FilePlus from '@lucide/svelte/icons/file-plus';
	import HandCoins from '@lucide/svelte/icons/hand-coins';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import List from '@lucide/svelte/icons/list';
	import ListPlus from '@lucide/svelte/icons/list-plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Send from '@lucide/svelte/icons/send';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Settings from '@lucide/svelte/icons/settings';
	import Upload from '@lucide/svelte/icons/upload';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		BottomSheet,
		MobileTabBar,
		PageHeader,
		SheetAction,
		deviceLayout,
		sheetsSettled,
		type MobileTabItem
	} from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
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
	import PaymentCapture, { type PaymentPreset } from './PaymentCapture.svelte';
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

	async function syncUrl() {
		// ein gerade geschlossenes Blatt nimmt erst seinen Verlaufseintrag weg (sonst springt die URL zurück)
		await sheetsSettled();
		const url = new URL(page.url);
		url.searchParams.set('tab', section);
		if (section === 'income') url.searchParams.set('view', incomeView);
		else if (section === 'outgoing') url.searchParams.set('view', outgoingView);
		else url.searchParams.delete('view');
		url.searchParams.delete('payer');
		replaceState(url, page.state);
	}

	function go(loc: TreasuryLocation) {
		section = loc.section;
		if (loc.section === 'income' && loc.view) incomeView = loc.view as IncomeView;
		if (loc.section === 'outgoing' && loc.view) outgoingView = loc.view as OutgoingView;
		void syncUrl();
	}

	/** Navigation über Bereichs- oder alte Tab-Namen (z. B. `open`, `invoices` aus der Übersicht) */
	function open(tab: string) {
		go(resolveLocation(tab));
	}

	/** Bereich wechseln; die zuletzt gewählte Unteransicht bleibt erhalten */
	function setSection(v: string) {
		section = resolveLocation(v).section;
		void syncUrl();
	}

	// Familienansicht (Seitenpanel), aus allen Bereichen per `onfamily` erreichbar
	let familyOpen = $state(false);
	let familyTarget = $state<FamilyRef | null>(null);
	function openFamily(ref: FamilyRef) {
		familyTarget = ref;
		familyOpen = true;
	}
	// `?payer=<id>` (z. B. aus der globalen Suche) öffnet das Familienkonto direkt
	const payerParam = $derived(page.url.searchParams.get('payer'));
	$effect(() => {
		const id = payerParam;
		if (id) untrack(() => openFamily({ payerId: id }));
	});

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
			const r = await apiFetch<{
				created: number;
				updated: number;
				cancelled: number;
				documents?: { mailsSent: number };
			}>(`${BASE}/sync`, { method: 'POST' });
			toast.success(
				`Abgeglichen: ${r.created} neu, ${r.updated} geändert, ${r.cancelled} storniert` +
					(r.documents?.mailsSent ? `, ${r.documents.mailsSent} Mails verschickt` : '')
			);
			await changed();
		} catch (e) {
			toast.error(errorMessage(e, 'Abgleich fehlgeschlagen'));
		} finally {
			syncing = false;
		}
	}

	/** Handy (Bereichsleiste, Blätter), Tablet (Liste | Details, Popover) oder Desktop */
	const layout = $derived(deviceLayout());

	const shared = $derived({
		layout,
		accounts,
		categories,
		actions,
		members,
		payers,
		perm,
		version,
		onfamily: openFamily
	});

	// --- Handy und Tablet: Menüs „Neu“ und „⋯“, Zahlung erfassen ----------------------
	let plusOpen = $state(false);
	let moreOpen = $state(false);
	let payOpen = $state(false);
	let payPreset = $state<PaymentPreset | null>(null);
	/** Blatt schließen, dann die Aktion starten (Dialoge nie über einem offenen Blatt) */
	function fromSheet(run: () => void) {
		plusOpen = false;
		moreOpen = false;
		run();
	}
	function capturePayment(preset: PaymentPreset | null = null) {
		payPreset = preset;
		payOpen = true;
	}
	const balanceCents = $derived(
		accounts.filter((a) => !a.archived).reduce((s, a) => s + a.balanceCents, 0)
	);
	const activeAccountCount = $derived(accounts.filter((a) => !a.archived).length);
	const TAB_ITEMS: MobileTabItem[] = [
		{ value: 'overview', label: 'Übersicht', icon: LayoutDashboard },
		{ value: 'income', label: 'Eingänge', icon: ArrowDownToLine },
		{ value: 'new', label: 'Neu', icon: Plus, action: true },
		{ value: 'outgoing', label: 'Ausgänge', icon: ArrowUpFromLine },
		{ value: 'transactions', label: 'Buchungen', icon: List }
	];
	// Blatt bzw. Menü „Neu“ nur, wenn es etwas darin gibt (Rechnungen stehen unter ⋯)
	const canCreate = $derived(perm.editTx || perm.payable);
	const tabItems = $derived(TAB_ITEMS.filter((t) => t.value !== 'new' || canCreate));

	// Handy: besuchte Bereiche bleiben geladen (Filter, Unteransicht), Scrollstand je Bereich
	let visited = $state<Section[]>([]);
	const scrollBySection: Partial<Record<Section, number>> = {};
	$effect(() => {
		const s = activeSection;
		untrack(() => {
			if (!visited.includes(s)) visited = [...visited, s];
		});
	});
	function selectTab(v: string) {
		if (v === 'new') {
			plusOpen = true;
			return;
		}
		if (v === activeSection) {
			window.scrollTo({ top: 0, behavior: 'smooth' });
			return;
		}
		scrollBySection[activeSection] = window.scrollY;
		setSection(v);
		const top = scrollBySection[v as Section] ?? 0;
		requestAnimationFrame(() => window.scrollTo({ top }));
	}

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

{#snippet sectionBody(s: Section)}
	{#if s === 'overview'}
		<OverviewTab
			{...shared}
			onopen={open}
			onallocate={allocate}
			onsuggestions={() => (suggestionsOpen = true)}
			oncreate={() => editTransaction(null)}
			onimport={() => (importOpen = true)}
			onchanged={changed}
			onsync={sync}
			{syncing}
		/>
	{:else if s === 'income'}
		<IncomeSection
			{...shared}
			view={incomeView}
			{annualView}
			{annualManage}
			onview={(v) => go({ section: 'income', view: v })}
			onopen={open}
			oncreateinvoice={() => (invoiceOpen = true)}
			onpay={capturePayment}
			onchanged={changed}
		/>
	{:else if s === 'outgoing'}
		<OutgoingSection
			{...shared}
			view={outgoingView}
			onview={(v) => go({ section: 'outgoing', view: v })}
			onchanged={changed}
		/>
	{:else if s === 'transactions'}
		<TransactionsTab
			{...shared}
			onedit={editTransaction}
			onallocate={allocate}
			onsuggestions={() => (suggestionsOpen = true)}
			onchanged={changed}
		/>
	{:else if s === 'reports' && perm.report}
		<ReportsTab {...shared} />
	{/if}
{/snippet}

{#if layout === 'phone'}
	<!-- Handy: kompakter Kopf, Bereichsleiste unten, Menüs als Blätter -->
	<div class="pb-24">
		<div class="-mx-4 -mt-4 mb-4 flex items-center gap-1 border-b py-2 pr-1.5 pl-4">
			<div class="flex min-w-0 flex-1 flex-col">
				<h1 class="truncate text-xl font-bold">
					{activeSection === 'overview' ? 'Kasse' : SECTION_LABELS[activeSection]}
				</h1>
				<p class="truncate text-xs text-muted-foreground">
					Kontostand <span class="tabular-nums">{formatEuro(balanceCents)}</span> ·
					{activeAccountCount}
					{activeAccountCount === 1 ? 'Konto' : 'Konten'}
				</p>
			</div>
			<Button
				variant="ghost"
				size="icon"
				class="size-11"
				aria-label="Weitere Aktionen der Kasse"
				onclick={() => (moreOpen = true)}
			>
				<Ellipsis class="size-5" />
			</Button>
		</div>
		{#each visited as s (s)}
			<div hidden={s !== activeSection}>
				{@render sectionBody(s)}
			</div>
		{/each}
	</div>
	<MobileTabBar
		items={tabItems}
		value={activeSection}
		label="Bereiche der Kasse"
		onselect={selectTab}
	/>
{:else}
	<div class="space-y-6">
		<PageHeader
			title="Kasse"
			description="Konten, Buchungen und offene Beiträge des Stammes an einem Ort."
		>
			{#snippet actions()}
				{#if layout === 'tablet'}
					{#if canCreate}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button {...props}><Plus /> Neu</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end" class="w-80">
								{#if perm.editTx}
									<DropdownMenu.Item class="min-h-11" onclick={() => capturePayment()}>
										<HandCoins /> Zahlung erfassen
									</DropdownMenu.Item>
									<DropdownMenu.Item class="min-h-11" onclick={() => editTransaction(null)}>
										<ListPlus /> Buchung
									</DropdownMenu.Item>
								{/if}
								{#if perm.payable}
									<DropdownMenu.Item
										class="min-h-11"
										onclick={() => go({ section: 'outgoing', view: 'payables' })}
									>
										<Send /> Überweisung als bezahlt
									</DropdownMenu.Item>
								{/if}
								{#if perm.editTx || perm.editInvoice}<DropdownMenu.Separator />{/if}
								{#if perm.editTx}
									<DropdownMenu.Item class="min-h-11" onclick={() => (transferOpen = true)}>
										<ArrowLeftRight /> Umbuchung
									</DropdownMenu.Item>
									<DropdownMenu.Item class="min-h-11" onclick={() => (importOpen = true)}>
										<Upload /> Kontoauszug importieren
									</DropdownMenu.Item>
								{/if}
								{#if perm.editInvoice}
									<DropdownMenu.Item class="min-h-11" onclick={() => (invoiceOpen = true)}>
										<FilePlus /> Rechnung
									</DropdownMenu.Item>
								{/if}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/if}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button {...props} variant="outline" size="icon" aria-label="Weitere Aktionen">
									<Ellipsis />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" class="w-72">
							{#if perm.editTx}
								<DropdownMenu.Item class="min-h-11" onclick={() => (suggestionsOpen = true)}>
									<Sparkles /> Zuordnungsvorschläge prüfen
								</DropdownMenu.Item>
							{/if}
							{#if perm.editInvoice && !canCreate}
								<DropdownMenu.Item class="min-h-11" onclick={() => (invoiceOpen = true)}>
									<FilePlus /> Neue Rechnung
								</DropdownMenu.Item>
							{/if}
							{#if perm.editInvoice}
								<DropdownMenu.Item class="min-h-11" onclick={sync} disabled={syncing}>
									<RefreshCw />
									{syncing ? 'Gleicht ab …' : 'Jetzt abgleichen'}
								</DropdownMenu.Item>
							{/if}
							{#if perm.settings || perm.accounts}
								<DropdownMenu.Item
									class="min-h-11"
									onclick={() => goto('/modules/treasury/settings')}
								>
									<Settings /> Einstellungen
								</DropdownMenu.Item>
							{/if}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				{:else}
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
								class="ml-0.5 hidden rounded border border-current/30 px-1 font-mono text-xs leading-4 opacity-70 sm:inline"
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
										{syncing ? 'Gleicht ab …' : 'Jetzt abgleichen'}
									</DropdownMenu.Item>
								{/if}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/if}
				{/if}
			{/snippet}
		</PageHeader>

		<Tabs.Root value={activeSection} onValueChange={(v) => setSection(v)}>
			<Tabs.List variant="line" class="mb-4 w-full justify-start">
				{#each visibleSections as s (s)}
					<Tabs.Trigger value={s} class="flex-none px-2 sm:px-3">{SECTION_LABELS[s]}</Tabs.Trigger>
				{/each}
			</Tabs.List>
			<Tabs.Content value={activeSection}>
				{@render sectionBody(activeSection)}
			</Tabs.Content>
		</Tabs.Root>
	</div>
{/if}

<!-- Handy: Blatt „Neu erfassen“ -->
<BottomSheet bind:open={plusOpen} title="Neu erfassen">
	{#if perm.editTx}
		<SheetAction
			icon={HandCoins}
			variant="primary"
			title="Zahlung erfassen"
			description="Bar oder Überweisung zu offenen Rechnungen"
			onclick={() => fromSheet(() => capturePayment())}
		/>
		<SheetAction
			icon={ListPlus}
			title="Buchung"
			description="Einnahme oder Ausgabe aufs Konto, mit Beleg"
			onclick={() => fromSheet(() => editTransaction(null))}
		/>
	{/if}
	{#if perm.payable}
		<SheetAction
			icon={Send}
			title="Überweisung als bezahlt"
			description="Auslage, Rückzahlung oder Eingangsrechnung"
			onclick={() => fromSheet(() => go({ section: 'outgoing', view: 'payables' }))}
		/>
	{/if}
	{#if perm.editTx}
		<div class="mx-5 my-1.5 h-px bg-border"></div>
		<SheetAction
			icon={Upload}
			title="Kontoauszug importieren"
			description="CSV der Bank, mit Zuordnungsvorschlägen"
			onclick={() => fromSheet(() => (importOpen = true))}
		/>
		<SheetAction
			icon={ArrowLeftRight}
			title="Umbuchung"
			description="z. B. Bargeld aufs Girokonto einzahlen"
			onclick={() => fromSheet(() => (transferOpen = true))}
		/>
	{/if}
</BottomSheet>

<!-- Handy: Blatt „⋯“ mit Seltenem -->
<BottomSheet bind:open={moreOpen} title="Kasse">
	{#if perm.editTx}
		<SheetAction
			icon={Sparkles}
			title="Zuordnungsvorschläge prüfen"
			description="Einnahmen den offenen Rechnungen zuordnen"
			onclick={() => fromSheet(() => (suggestionsOpen = true))}
		/>
	{/if}
	{#if perm.editInvoice}
		<SheetAction
			icon={FilePlus}
			title="Neue Rechnung"
			description="Manuelle Rechnung mit Posten"
			onclick={() => fromSheet(() => (invoiceOpen = true))}
		/>
		<SheetAction
			icon={RefreshCw}
			title={syncing ? 'Gleicht ab …' : 'Jetzt abgleichen'}
			description="Rechnungen aus Aktionen aktualisieren"
			disabled={syncing}
			onclick={() => fromSheet(() => void sync())}
		/>
	{/if}
	{#if perm.report || perm.settings || perm.accounts}
		<div class="mx-5 my-1.5 h-px bg-border"></div>
	{/if}
	{#if perm.report}
		<SheetAction
			icon={ChartColumn}
			title="Berichte"
			description="Zeitraum, PDF und CSV"
			onclick={() => fromSheet(() => selectTab('reports'))}
		/>
	{/if}
	{#if perm.settings || perm.accounts}
		<SheetAction
			icon={Settings}
			title="Einstellungen"
			description="Konten, Kategorien, Mails, Bankdaten"
			onclick={() =>
				fromSheet(() => void sheetsSettled().then(() => goto('/modules/treasury/settings')))}
		/>
	{/if}
</BottomSheet>

{#if layout !== 'desktop'}
	<PaymentCapture
		bind:open={payOpen}
		variant={layout === 'phone' ? 'sheet' : 'dialog'}
		preset={payPreset}
		{accounts}
		onsaved={changed}
	/>
{/if}

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
