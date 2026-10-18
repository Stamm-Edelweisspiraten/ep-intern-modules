<script lang="ts">
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ConfirmDialog, DataTable, FormField } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { Payable, PayableList, Transaction, TransactionList } from '../schemas';
	import {
		BASE,
		errorMessage,
		fmtDate,
		openApiFile,
		signedEuro,
		transactionTitle,
		type SharedData
	} from './helpers';
	import HistorySheet from './HistorySheet.svelte';

	let {
		accounts,
		categories,
		perm,
		version,
		onedit,
		onallocate,
		onsuggestions,
		onchanged
	}: SharedData & {
		onedit: (t: Transaction) => void;
		onallocate: (t: Transaction) => void;
		onsuggestions: () => void;
		onchanged: () => void | Promise<void>;
	} = $props();

	const LIMIT = 50;
	// wie `history.endpoints.ts`: Berichts- UND Kassenrecht
	const canHistory = $derived(
		can((page.data.permissions ?? []) as string[], 'treasury.report.view') &&
			can((page.data.permissions ?? []) as string[], 'treasury.cash.view')
	);
	let historyOpen = $state(false);
	let historyTx = $state<Transaction | null>(null);
	let accountId = $state<string | null>(null);
	let categoryId = $state<string | null>(null);
	let filter = $state<'all' | 'income' | 'expense' | 'unassigned'>('all');
	let search = $state('');
	let offset = $state(0);
	let data = $state<TransactionList | null>(null);
	let loading = $state(true);
	let error = $state('');

	const query = $derived.by(() => {
		const p = new URLSearchParams({ filter, limit: String(LIMIT), offset: String(offset) });
		if (accountId) p.set('accountId', accountId);
		if (categoryId) p.set('categoryId', categoryId);
		if (search.trim()) p.set('search', search.trim());
		return p.toString();
	});

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
			data = await apiFetch<TransactionList>(`${BASE}/transactions?${q}`);
		} catch (e) {
			error = errorMessage(e, 'Buchungen konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	const reset = () => (offset = 0);
	const filters = [
		{ value: 'all', label: 'Alle' },
		{ value: 'income', label: 'Einnahmen' },
		{ value: 'expense', label: 'Ausgaben' },
		{ value: 'unassigned', label: 'Nicht zugeordnet' }
	] as const;
	const accountOptions = $derived(accounts.map((a) => ({ value: a.id, label: a.name })));
	const categoryOptions = $derived(categories.map((c) => ({ value: c.id, label: c.name })));

	let deleteOpen = $state(false);
	let toDelete = $state<Transaction | null>(null);

	async function remove() {
		if (!toDelete) return;
		try {
			await apiFetch(`${BASE}/transactions/${toDelete.id}`, { method: 'DELETE' });
			toast.success(toDelete.transferId ? 'Umbuchung gelöscht' : 'Buchung gelöscht');
			await onchanged();
		} catch (e) {
			toast.error(errorMessage(e, 'Löschen fehlgeschlagen'));
		}
	}

	// Ausgabe einer ausstehenden Überweisung zuordnen
	let linkOpen = $state(false);
	let linkTx = $state<Transaction | null>(null);
	let linkPayables = $state<Payable[]>([]);
	let linkId = $state<string | null>(null);
	let linkBusy = $state(false);

	async function openLink(t: Transaction) {
		linkTx = t;
		linkId = t.payable?.id ?? null;
		linkOpen = true;
		try {
			const list = await apiFetch<PayableList>(`${BASE}/payables?status=open`);
			const amount = Math.abs(t.amountCents);
			linkPayables = [...list.items].sort(
				(a, b) => Math.abs(a.openCents - amount) - Math.abs(b.openCents - amount)
			);
		} catch (e) {
			toast.error(errorMessage(e, 'Auszahlungen konnten nicht geladen werden'));
		}
	}

	async function saveLink() {
		if (!linkTx) return;
		linkBusy = true;
		try {
			await apiFetch(`${BASE}/transactions/${linkTx.id}/payable`, {
				method: 'PUT',
				body: JSON.stringify({ payableId: linkId })
			});
			toast.success(linkId ? 'Auszahlung zugeordnet' : 'Zuordnung entfernt');
			linkOpen = false;
			await onchanged();
		} catch (e) {
			toast.error(errorMessage(e, 'Zuordnung fehlgeschlagen'));
		} finally {
			linkBusy = false;
		}
	}

	const linkOptions = $derived(
		linkPayables.map((p) => ({
			value: p.id,
			label: `${p.recipientName} – ${p.description} (offen ${formatEuro(p.openCents)})`
		}))
	);

	async function receipt(t: Transaction) {
		try {
			await openApiFile(`${BASE}/transactions/${t.id}/receipt`);
		} catch (e) {
			toast.error(errorMessage(e, 'Beleg konnte nicht geöffnet werden'));
		}
	}
</script>

<DataTable
	mobile="cards"
	caption="Buchungen"
	{loading}
	{error}
	empty={!!data && !data.items.length}
	emptyTitle={filter !== 'all' || search || accountId ? 'Keine Treffer' : 'Noch keine Buchungen'}
	emptyDescription={filter !== 'all' || search || accountId
		? 'Kein Eintrag passt zum Filter.'
		: 'Erfasse Buchungen von Hand oder importiere einen Kontoauszug als CSV.'}
>
	{#snippet toolbar()}
		<div class="flex flex-wrap gap-1" role="group" aria-label="Buchungen filtern">
			{#each filters as f (f.value)}
				<Button
					size="sm"
					variant={filter === f.value ? 'default' : 'outline'}
					aria-pressed={filter === f.value}
					onclick={() => {
						filter = f.value;
						reset();
					}}
				>
					{f.label}
				</Button>
			{/each}
		</div>
		<SelectField
			class="w-44"
			size="sm"
			label="Konto"
			options={accountOptions}
			bind:value={accountId}
			emptyLabel="Alle Konten"
			placeholder="Alle Konten"
			onchange={reset}
		/>
		<SelectField
			class="w-44"
			size="sm"
			label="Kategorie"
			options={categoryOptions}
			bind:value={categoryId}
			emptyLabel="Alle Kategorien"
			placeholder="Alle Kategorien"
			onchange={reset}
		/>
		<Input
			class="h-8 min-w-40 flex-1 sm:max-w-60"
			placeholder="Suchen …"
			aria-label="Buchungen durchsuchen"
			bind:value={search}
			oninput={reset}
		/>
		{#if filter === 'unassigned' && perm.editTx && data?.items.length}
			<Button size="sm" variant="outline" onclick={onsuggestions}>Vorschläge prüfen</Button>
		{/if}
	{/snippet}
	{#snippet head()}
		<Table.Row>
			<Table.Head>Datum</Table.Head>
			<Table.Head>Gegenpartei / Zweck</Table.Head>
			<Table.Head>Zuordnung</Table.Head>
			<Table.Head class="text-right">Betrag</Table.Head>
			<Table.Head class="text-right"><span class="sr-only">Aktionen</span></Table.Head>
		</Table.Row>
	{/snippet}
	{#each data?.items ?? [] as t (t.id)}
		<Table.Row>
			<Table.Cell class="align-top whitespace-nowrap tabular-nums">
				{fmtDate(t.bookedOn)}
				<div class="text-xs text-muted-foreground">{t.accountName}</div>
			</Table.Cell>
			<Table.Cell class="max-w-80 align-top">
				<div class="flex items-center gap-1 truncate font-medium">
					{transactionTitle(t)}
					{#if t.receipt}<Paperclip
							class="size-3.5 shrink-0 text-muted-foreground"
							aria-label="Mit Beleg"
						/>{/if}
				</div>
				{#if t.purpose}<div class="truncate text-xs text-muted-foreground">{t.purpose}</div>{/if}
				<div class="mt-1 flex flex-wrap gap-1">
					{#if t.category}<Badge variant="outline">{t.category.name}</Badge>{/if}
					{#if t.action}<Badge variant="outline">{t.action.name}</Badge>{/if}
					{#if t.transferId}<Badge variant="secondary">Umbuchung</Badge>{/if}
					{#if t.imported}<Badge variant="secondary">Import</Badge>{/if}
					{#if t.payable}<Badge variant="secondary">Auszahlung {t.payable.recipientName}</Badge
						>{/if}
				</div>
			</Table.Cell>
			<Table.Cell class="max-w-56 align-top">
				{#if t.allocations.length}
					<div class="flex flex-wrap gap-1">
						{#each [...new Map(t.allocations.map( (a) => [a.invoiceId, a] )).values()] as a (a.invoiceId)}
							<a href={`/modules/treasury/invoices/${a.invoiceId}`}>
								<Badge variant="secondary">{a.invoiceNumber}</Badge>
							</a>
						{/each}
					</div>
				{/if}
				{#if t.needsAllocation}
					<div class="mt-1 text-xs text-amber-700 dark:text-amber-400">
						{formatEuro(t.unallocatedCents)} nicht zugeordnet
					</div>
				{:else if t.unallocatedCents > 0 && t.allocations.length}
					<div class="mt-1 text-xs text-muted-foreground">
						Rest {formatEuro(t.unallocatedCents)}
					</div>
				{/if}
			</Table.Cell>
			<Table.Cell
				class="text-right align-top font-medium whitespace-nowrap tabular-nums {t.amountCents < 0
					? 'text-destructive'
					: ''}"
			>
				{signedEuro(t.amountCents)}
			</Table.Cell>
			<Table.Cell class="text-right align-top">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="ghost" size="icon" aria-label="Aktionen zur Buchung">
								<Ellipsis />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end">
						{#if perm.editTx && t.amountCents > 0 && !t.transferId}
							<DropdownMenu.Item onclick={() => onallocate(t)}
								>Rechnungen zuordnen</DropdownMenu.Item
							>
						{/if}
						{#if perm.payable && t.amountCents < 0 && !t.transferId}
							<DropdownMenu.Item onclick={() => openLink(t)}>
								{t.payable ? 'Auszahlung ändern' : 'Auszahlung zuordnen'}
							</DropdownMenu.Item>
						{/if}
						{#if perm.editTx && !t.transferId}
							<DropdownMenu.Item onclick={() => onedit(t)}>Bearbeiten</DropdownMenu.Item>
						{/if}
						{#if t.receipt}
							<DropdownMenu.Item onclick={() => receipt(t)}>Beleg öffnen</DropdownMenu.Item>
						{/if}
						{#if canHistory}
							<DropdownMenu.Item
								onclick={() => {
									historyTx = t;
									historyOpen = true;
								}}
							>
								Verlauf anzeigen
							</DropdownMenu.Item>
						{/if}
						{#if perm.deleteTx}
							<DropdownMenu.Separator />
							<DropdownMenu.Item
								class="text-destructive"
								onclick={() => {
									toDelete = t;
									deleteOpen = true;
								}}
							>
								Löschen
							</DropdownMenu.Item>
						{/if}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</Table.Cell>
		</Table.Row>
	{/each}
	{#snippet footer()}
		{#if data && data.total > 0}
			<div class="flex w-full flex-wrap items-center justify-between gap-2 text-sm">
				<span class="text-muted-foreground">
					{data.total} Buchungen · Summe
					<span class="tabular-nums">{signedEuro(data.sumCents)}</span>
				</span>
				{#if data.total > LIMIT}
					<div class="flex items-center gap-2">
						<Button
							size="sm"
							variant="outline"
							disabled={offset === 0}
							onclick={() => (offset = Math.max(0, offset - LIMIT))}
						>
							Zurück
						</Button>
						<span class="tabular-nums">
							{offset + 1}–{Math.min(offset + LIMIT, data.total)} von {data.total}
						</span>
						<Button
							size="sm"
							variant="outline"
							disabled={offset + LIMIT >= data.total}
							onclick={() => (offset += LIMIT)}
						>
							Weiter
						</Button>
					</div>
				{/if}
			</div>
		{/if}
	{/snippet}
</DataTable>

<Dialog.Root bind:open={linkOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Auszahlung zuordnen</Dialog.Title>
			<Dialog.Description>
				{#if linkTx}
					{fmtDate(linkTx.bookedOn)} · {linkTx.counterparty ?? 'Ausgabe'} · {formatEuro(
						linkTx.amountCents
					)}
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<FormField
			label="Ausstehende Überweisung"
			id="tx-link-payable"
			hint="Passende Beträge stehen oben. Bei Auslagen wird die Abrechnung der Aktion automatisch auf „ausgezahlt“ gesetzt."
		>
			<SelectField
				id="tx-link-payable"
				label="Auszahlung"
				options={linkOptions}
				bind:value={linkId}
				emptyLabel="Keine Zuordnung"
				placeholder="Auszahlung wählen …"
			/>
		</FormField>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (linkOpen = false)}>Abbrechen</Button>
			<Button onclick={saveLink} disabled={linkBusy}
				>{linkBusy ? 'Speichert …' : 'Speichern'}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<HistorySheet
	bind:open={historyOpen}
	kind="transaction"
	id={historyTx?.id ?? null}
	title={historyTx ? transactionTitle(historyTx) : ''}
/>

<ConfirmDialog
	bind:open={deleteOpen}
	title={toDelete?.transferId ? 'Umbuchung löschen?' : 'Buchung löschen?'}
	description={toDelete?.allocations.length
		? 'Die Zuordnung zu Rechnungen wird aufgehoben – die Rechnungen gelten dann wieder als offen.'
		: toDelete?.transferId
			? 'Beide Seiten der Umbuchung werden gelöscht.'
			: 'Die Buchung wird dauerhaft gelöscht.'}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
