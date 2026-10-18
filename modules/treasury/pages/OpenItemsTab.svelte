<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Bell from '@lucide/svelte/icons/bell';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Download from '@lucide/svelte/icons/download';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import FileText from '@lucide/svelte/icons/file-text';
	import Users from '@lucide/svelte/icons/users';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import * as Table from '$lib/components/ui/table';
	import { ConfirmDialog, DataTable, MobileActionBar } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { InvoiceSummary, OpenItems, OpenItemsGroup } from '../schemas';
	import { BASE, errorMessage, fmtDate, openApiFile, type SharedData } from './helpers';
	import { openStatements, remindInvoices } from './BulkActions';
	import FilterChips from './FilterChips.svelte';
	import MarkPaidDialog from './MarkPaidDialog.svelte';
	import type { FamilyRef } from './navigation';
	import StatusBadge from './StatusBadge.svelte';

	let {
		accounts,
		perm,
		version,
		onchanged,
		onfamily
	}: SharedData & {
		onchanged: () => void | Promise<void>;
		/** öffnet das Familienkonto eines Zahlers bzw. Mitglieds */
		onfamily?: (ref: FamilyRef) => void;
	} = $props();

	let groupBy = $state<'payer' | 'action'>('payer');
	let overdueOnly = $state(false);
	let search = $state('');
	let sort = $state<string | null>('overdue');
	let data = $state<OpenItems | null>(null);
	let loading = $state(true);
	let error = $state('');
	let busy = $state(false);
	let expanded = $state<Record<string, boolean>>({});

	const query = $derived(
		`groupBy=${groupBy}&overdue=${overdueOnly ? '1' : '0'}${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`
	);

	let timer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		void version;
		const q = query;
		clearTimeout(timer);
		timer = setTimeout(() => void load(q), search ? 250 : 0);
		return () => clearTimeout(timer);
	});

	async function load(q = query) {
		loading = !data;
		error = '';
		try {
			data = await apiFetch<OpenItems>(`${BASE}/open-items?${q}`);
		} catch (e) {
			error = errorMessage(e, 'Offene Posten konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	const earliestDue = (g: OpenItemsGroup) =>
		g.invoices
			.filter((i) => i.openCents > 0)
			.map((i) => i.dueOn)
			.sort()[0] ?? null;

	const groups = $derived.by(() => {
		const list = [...(data?.groups ?? [])];
		const by: Record<string, (a: OpenItemsGroup, b: OpenItemsGroup) => number> = {
			overdue: (a, b) => b.overdueCents - a.overdueCents || b.openCents - a.openCents,
			open: (a, b) => b.openCents - a.openCents,
			name: (a, b) => a.label.localeCompare(b.label, 'de'),
			due: (a, b) => (earliestDue(a) ?? '9999').localeCompare(earliestDue(b) ?? '9999')
		};
		return list.sort(by[sort ?? 'overdue'] ?? by.overdue);
	});

	const allOpen = $derived(groups.length > 0 && groups.every((g) => expanded[g.key]));
	function toggleAll() {
		const next = !allOpen;
		expanded = Object.fromEntries(groups.map((g) => [g.key, next]));
	}
	const toggle = (key: string) => (expanded = { ...expanded, [key]: !expanded[key] });

	/** Verweis aufs Familienkonto der Gruppe (Zahler oder Mitglied ohne Zahler) */
	function familyOf(g: OpenItemsGroup): FamilyRef | null {
		if (g.payerId) return { payerId: g.payerId };
		if (g.kind === 'member' && g.key.startsWith('member:')) return { memberId: g.key.slice(7) };
		return null;
	}

	// Auswahl auf Rechnungsebene (nur Rechnungen mit offenem Betrag)
	const isSelectable = (i: InvoiceSummary) => i.openCents > 0 && i.status !== 'cancelled';
	let selected = $state<string[]>([]);
	const selectable = $derived(groups.flatMap((g) => g.invoices.filter(isSelectable)));
	const selectedInvoices = $derived(selectable.filter((i) => selected.includes(i.id)));
	const selectedSum = $derived(selectedInvoices.reduce((s, i) => s + i.openCents, 0));
	const allSelected = $derived(
		selectable.length > 0 && selectedInvoices.length === selectable.length
	);
	const someSelected = $derived(selectedInvoices.length > 0 && !allSelected);
	function groupState(g: OpenItemsGroup): { all: boolean; some: boolean; count: number } {
		const list = g.invoices.filter(isSelectable);
		const n = list.filter((i) => selected.includes(i.id)).length;
		return {
			all: list.length > 0 && n === list.length,
			some: n > 0 && n < list.length,
			count: list.length
		};
	}
	function setSelected(ids: string[], on: boolean) {
		const set = new Set(selected);
		for (const id of ids) {
			if (on) set.add(id);
			else set.delete(id);
		}
		selected = [...set];
	}
	const toggleGroup = (g: OpenItemsGroup, on: boolean) =>
		setSelected(
			g.invoices.filter(isSelectable).map((i) => i.id),
			on
		);
	function toggleEverything(on: boolean) {
		selected = on ? selectable.map((i) => i.id) : [];
	}
	/** Sammelrechnung nur, wenn alle gewählten Rechnungen zu Zahlern gehören */
	const selectedPayers = $derived.by(() => {
		if (!selectedInvoices.length || selectedInvoices.some((i) => !i.payer)) return null;
		const map = new Map<string, { id: string; name: string }>();
		for (const i of selectedInvoices) if (i.payer) map.set(i.payer.id, i.payer);
		return [...map.values()];
	});
	let bulkBusy = $state(false);
	let confirmBulkOpen = $state(false);

	async function bulkRemind() {
		const list = [...selectedInvoices];
		if (!list.length) return;
		bulkBusy = true;
		try {
			const r = await remindInvoices(list);
			if (r.ok) selected = [];
			await load();
		} finally {
			bulkBusy = false;
		}
	}

	async function bulkStatements() {
		if (!selectedPayers?.length) return;
		bulkBusy = true;
		try {
			await openStatements(selectedPayers);
		} finally {
			bulkBusy = false;
		}
	}

	let payOpen = $state(false);
	let payInvoice = $state<InvoiceSummary | null>(null);

	// Mailversand ist nicht rückholbar → vorher bestätigen
	let confirmRemind = $state<InvoiceSummary | null>(null);
	let confirmRemindOpen = $state(false);
	let confirmAllOpen = $state(false);

	async function remind(i: InvoiceSummary) {
		busy = true;
		try {
			const r = await apiFetch<{ invoices: number; mailsSent: number; withoutAddress: number }>(
				`${BASE}/invoices/${i.id}/remind`,
				{ method: 'POST' }
			);
			if (r.invoices) toast.success(`Erinnerung an ${r.mailsSent} Adresse(n) gesendet`);
			else if (r.withoutAddress) toast.error('Keine E-Mail-Adresse hinterlegt');
			else toast.error('Erinnerung konnte nicht gesendet werden');
			await load();
		} catch (e) {
			toast.error(errorMessage(e, 'Erinnerung fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function runReminders() {
		busy = true;
		try {
			const r = await apiFetch<{ invoices: number; mailsSent: number; mailErrors: number }>(
				`${BASE}/reminders/run`,
				{ method: 'POST' }
			);
			toast.success(
				r.invoices
					? `${r.invoices} Rechnung(en) erinnert, ${r.mailsSent} Mail(s)`
					: 'Heute sind keine Erinnerungen fällig'
			);
			if (r.mailErrors) toast.error(`${r.mailErrors} Mail(s) fehlgeschlagen`);
			await load();
		} catch (e) {
			toast.error(errorMessage(e, 'Versand fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function exportCsv() {
		try {
			await openApiFile(`${BASE}/open-items.csv?${query}`, true);
		} catch (e) {
			toast.error(errorMessage(e, 'Export fehlgeschlagen'));
		}
	}

	async function openPdf(i: InvoiceSummary) {
		try {
			await openApiFile(`${BASE}/invoices/${i.id}/documents/${i.documentCount}/pdf`);
		} catch (e) {
			toast.error(errorMessage(e, 'PDF nicht verfügbar'));
		}
	}

	const kindLabel = {
		payer: 'Zahler',
		member: 'Mitglied',
		person: 'Person',
		action: 'Aktion',
		manual: ''
	} as const;
	const groupOptions: { value: 'payer' | 'action'; label: string }[] = [
		{ value: 'payer', label: 'Familie/Person' },
		{ value: 'action', label: 'Aktion' }
	];
	const sortOptions = [
		{ value: 'overdue', label: 'Überfällig zuerst' },
		{ value: 'open', label: 'Höchster Betrag' },
		{ value: 'due', label: 'Fälligkeit' },
		{ value: 'name', label: 'Name' }
	];
</script>

<div class="space-y-3 {selectedInvoices.length ? 'max-sm:pb-20' : ''}">
	{#if data}
		<div class="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm" aria-live="polite">
			<span>Offen <strong class="tabular-nums">{formatEuro(data.totals.openCents)}</strong></span>
			<span class="text-destructive">
				Überfällig <strong class="tabular-nums">{formatEuro(data.totals.overdueCents)}</strong>
			</span>
			{#if data.totals.creditCents > 0}
				<span
					>Guthaben <strong class="tabular-nums">{formatEuro(data.totals.creditCents)}</strong
					></span
				>
			{/if}
			<span class="text-muted-foreground">
				{groups.length}
				{groupBy === 'payer' ? 'Familien/Personen' : 'Aktionen'} · {data.totals.invoiceCount} Rechnungen
			</span>
		</div>
	{/if}

	<DataTable
		mobile="cards"
		caption="Offene Posten"
		{loading}
		{error}
		empty={!!data && !groups.length}
		emptyTitle={overdueOnly || search ? 'Keine Treffer' : 'Alles bezahlt'}
		emptyDescription={overdueOnly || search
			? 'Kein offener Posten passt zum Filter.'
			: 'Es gibt keine offenen Beträge.'}
	>
		{#snippet toolbar()}
			<FilterChips options={groupOptions} bind:value={groupBy} label="Gruppieren nach" />
			<SelectField
				class="w-44"
				size="sm"
				label="Sortierung"
				options={sortOptions}
				bind:value={sort}
			/>
			<div class="flex items-center gap-2">
				<Switch id="oi-overdue" bind:checked={overdueOnly} />
				<Label for="oi-overdue">Nur überfällige</Label>
			</div>
			<Input
				class="h-8 min-w-40 flex-1 sm:max-w-56"
				placeholder="Name oder Rechnung …"
				aria-label="Offene Posten durchsuchen"
				bind:value={search}
			/>
			<div class="ml-auto flex flex-wrap gap-2">
				<Button size="sm" variant="ghost" onclick={toggleAll} disabled={!groups.length}>
					{allOpen ? 'Alle zuklappen' : 'Alle aufklappen'}
				</Button>
				<Button variant="outline" size="sm" onclick={exportCsv}><Download /> CSV</Button>
				{#if perm.send}
					<Button
						variant="outline"
						size="sm"
						onclick={() => (confirmAllOpen = true)}
						disabled={busy}
					>
						<Bell /> Fällige Erinnerungen senden
					</Button>
				{/if}
			</div>
			<MobileActionBar
				show={selectedInvoices.length > 0}
				label="Sammelaktionen für offene Posten"
				class="sm:w-full sm:rounded-md sm:border sm:bg-muted/40 sm:px-3 sm:py-2"
			>
				<span class="text-sm font-medium" aria-live="polite">
					{selectedInvoices.length}
					{selectedInvoices.length === 1 ? 'Rechnung' : 'Rechnungen'} ·
					<span class="tabular-nums">{formatEuro(selectedSum)}</span>
				</span>
				{#if perm.send}
					<Button
						size="sm"
						variant="outline"
						disabled={bulkBusy}
						onclick={() => (confirmBulkOpen = true)}
					>
						<Bell /> Erinnerung senden
					</Button>
				{/if}
				{#if selectedPayers}
					<Button size="sm" variant="outline" disabled={bulkBusy} onclick={bulkStatements}>
						<FileText /> Sammelrechnung (PDF)
					</Button>
				{/if}
				<Button size="sm" variant="ghost" class="ml-auto" onclick={() => (selected = [])}>
					<X /> Auswahl aufheben
				</Button>
			</MobileActionBar>
		{/snippet}
		{#snippet head()}
			<Table.Row>
				<Table.Head class="w-16">
					<Checkbox
						aria-label="Alle offenen Rechnungen auswählen"
						checked={allSelected}
						indeterminate={someSelected}
						disabled={!selectable.length}
						onCheckedChange={(v) => toggleEverything(v === true)}
					/>
				</Table.Head>
				<Table.Head>{groupBy === 'payer' ? 'Familie / Person' : 'Aktion'}</Table.Head>
				<Table.Head>Rechnung</Table.Head>
				<Table.Head>Fällig</Table.Head>
				<Table.Head>Status</Table.Head>
				<Table.Head class="text-right">Offen</Table.Head>
				<Table.Head class="text-right"><span class="sr-only">Aktionen</span></Table.Head>
			</Table.Row>
		{/snippet}
		{#each groups as g (g.key)}
			{@const isOpen = !!expanded[g.key]}
			{@const gs = groupState(g)}
			{@const family = onfamily ? familyOf(g) : null}
			<Table.Row class="cursor-pointer bg-muted/30 hover:bg-muted/60" onclick={() => toggle(g.key)}>
				<Table.Cell onclick={(e: MouseEvent) => e.stopPropagation()}>
					<div class="flex items-center gap-1">
						{#if gs.count}
							<Checkbox
								aria-label={`Alle Rechnungen von ${g.label} auswählen`}
								checked={gs.all}
								indeterminate={gs.some}
								onCheckedChange={(v) => toggleGroup(g, v === true)}
							/>
						{:else}
							<span class="size-4" aria-hidden="true"></span>
						{/if}
						<button
							type="button"
							class="flex size-6 items-center justify-center rounded hover:bg-accent"
							aria-expanded={isOpen}
							aria-label={`${g.label} ${isOpen ? 'zuklappen' : 'aufklappen'}`}
							onclick={(e) => {
								e.stopPropagation();
								toggle(g.key);
							}}
						>
							<ChevronRight class="size-4 transition-transform {isOpen ? 'rotate-90' : ''}" />
						</button>
					</div>
				</Table.Cell>
				<Table.Cell class="max-w-64">
					<div class="flex items-center gap-2">
						{#if g.kind === 'payer'}
							<Users class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						{/if}
						{#if family && onfamily}
							<button
								type="button"
								class="truncate text-left font-medium underline-offset-4 hover:underline"
								title="Familienkonto öffnen"
								onclick={(e) => {
									e.stopPropagation();
									onfamily(family);
								}}
							>
								{g.label}
							</button>
						{:else}
							<span class="truncate font-medium">{g.label}</span>
						{/if}
						{#if kindLabel[g.kind]}
							<Badge variant="outline" class="shrink-0">{kindLabel[g.kind]}</Badge>
						{/if}
					</div>
					<div class="text-xs text-muted-foreground tabular-nums sm:hidden">
						offen {formatEuro(g.openCents)}{g.overdueCents > 0
							? ` · ${formatEuro(g.overdueCents)} überfällig`
							: ''}
					</div>
				</Table.Cell>
				<Table.Cell class="whitespace-nowrap text-muted-foreground">
					{g.invoices.length}
					{g.invoices.length === 1 ? 'Rechnung' : 'Rechnungen'}
				</Table.Cell>
				<Table.Cell class="whitespace-nowrap tabular-nums">{fmtDate(earliestDue(g))}</Table.Cell>
				<Table.Cell>
					<div class="flex flex-wrap gap-1">
						{#if g.overdueCents > 0}
							<Badge variant="destructive">{formatEuro(g.overdueCents)} überfällig</Badge>
						{/if}
						{#if g.creditCents > 0}
							<Badge variant="secondary">Guthaben {formatEuro(g.creditCents)}</Badge>
						{/if}
					</div>
				</Table.Cell>
				<Table.Cell class="text-right font-semibold whitespace-nowrap tabular-nums">
					{formatEuro(g.openCents)}
				</Table.Cell>
				<Table.Cell></Table.Cell>
			</Table.Row>
			{#if isOpen}
				{#each g.invoices as i (i.id)}
					<Table.Row data-state={selected.includes(i.id) ? 'selected' : undefined}>
						<Table.Cell>
							{#if isSelectable(i)}
								<Checkbox
									aria-label={`Rechnung ${i.number} auswählen`}
									checked={selected.includes(i.id)}
									onCheckedChange={(v) => setSelected([i.id], v === true)}
								/>
							{/if}
						</Table.Cell>
						<Table.Cell class="max-w-64 pl-6">
							<div class="truncate">{i.people.join(', ')}</div>
							{#if i.action && groupBy === 'payer'}
								<div class="truncate text-xs text-muted-foreground">{i.action.name}</div>
							{/if}
						</Table.Cell>
						<Table.Cell class="whitespace-nowrap">
							<a
								class="font-medium underline-offset-4 hover:underline"
								href={`/modules/treasury/invoices/${i.id}`}
							>
								{i.number}
							</a>
							{#if i.documentCount > 0}
								<button
									type="button"
									class="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground"
									aria-label={`PDF der Rechnung ${i.number} öffnen`}
									onclick={() => openPdf(i)}
								>
									<FileText class="size-3.5" />
								</button>
							{/if}
						</Table.Cell>
						<Table.Cell class="whitespace-nowrap tabular-nums">{fmtDate(i.dueOn)}</Table.Cell>
						<Table.Cell>
							<StatusBadge invoice={i} />
							{#if i.reminderLevel > 0}
								<span class="ml-1 text-xs text-muted-foreground">{i.reminderLevel}. Erinnerung</span
								>
							{/if}
							{#if i.status === 'cancelled' && i.creditCents > 0}
								<div class="text-xs text-muted-foreground">
									Bezahlt {formatEuro(i.creditCents)} – siehe „Auszahlungen“
								</div>
							{/if}
						</Table.Cell>
						<Table.Cell class="text-right whitespace-nowrap tabular-nums">
							{formatEuro(i.openCents)}
						</Table.Cell>
						<Table.Cell class="text-right">
							{#if i.openCents > 0 && (perm.editTx || perm.send)}
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button
												{...props}
												variant="ghost"
												size="icon"
												aria-label={`Aktionen für ${i.number}`}
											>
												<Ellipsis />
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end">
										{#if perm.editTx}
											<DropdownMenu.Item
												onclick={() => {
													payInvoice = i;
													payOpen = true;
												}}
											>
												Zahlung erfassen (bar o. Ä.)
											</DropdownMenu.Item>
										{/if}
										{#if perm.send}
											<DropdownMenu.Item
												onclick={() => {
													confirmRemind = i;
													confirmRemindOpen = true;
												}}
												disabled={busy}
											>
												Erinnerung senden
											</DropdownMenu.Item>
										{/if}
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
			{/if}
		{/each}
	</DataTable>
</div>

<ConfirmDialog
	bind:open={confirmBulkOpen}
	title="Erinnerungen senden?"
	description={`Für ${selectedInvoices.length} ${selectedInvoices.length === 1 ? 'Rechnung geht' : 'Rechnungen gehen'} sofort eine Zahlungserinnerung (jeweils nächste Stufe) per E-Mail raus. Das kann nicht zurückgeholt werden.`}
	confirmLabel="Erinnerungen senden"
	onconfirm={bulkRemind}
/>
<MarkPaidDialog bind:open={payOpen} invoice={payInvoice} {accounts} onsaved={onchanged} />
<ConfirmDialog
	bind:open={confirmRemindOpen}
	title="Erinnerung senden?"
	description={confirmRemind
		? `Die Zahlungserinnerung für ${confirmRemind.number} geht sofort per E-Mail raus und kann nicht zurückgeholt werden.`
		: ''}
	confirmLabel="Erinnerung senden"
	onconfirm={() => {
		if (confirmRemind) void remind(confirmRemind);
	}}
/>
<ConfirmDialog
	bind:open={confirmAllOpen}
	title="Fällige Erinnerungen senden?"
	description="Alle heute fälligen Zahlungserinnerungen gehen sofort per E-Mail raus und können nicht zurückgeholt werden."
	confirmLabel="Erinnerungen senden"
	onconfirm={runReminders}
/>
