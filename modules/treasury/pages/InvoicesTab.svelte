<script lang="ts">
	import { goto } from '$app/navigation';
	import Bell from '@lucide/svelte/icons/bell';
	import Plus from '@lucide/svelte/icons/plus';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import {
		ChoiceChips,
		ConfirmDialog,
		DataTable,
		EmptyState,
		ErrorState,
		ListRow,
		LoadingState,
		MobileActionBar,
		SelectionBar,
		TouchList
	} from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { INVOICE_SOURCE_LABELS, type InvoiceList, type InvoiceSummary } from '../schemas';
	import { BASE, errorMessage, fmtDate, type SharedData } from './helpers';
	import { remindInvoices } from './BulkActions';
	import CompactFilter from './CompactFilter.svelte';
	import FilterChips from './FilterChips.svelte';
	import type { FamilyRef } from './navigation';
	import StatusBadge from './StatusBadge.svelte';

	let {
		actions,
		perm,
		version,
		layout,
		oncreate,
		onfamily
	}: SharedData & {
		oncreate: () => void;
		onchanged: () => void | Promise<void>;
		/** öffnet das Familienkonto eines Zahlers */
		onfamily?: (ref: FamilyRef) => void;
	} = $props();

	const LIMIT = 50;
	let status = $state<string>('unpaid');
	let source = $state<string | null>(null);
	let actionId = $state<string | null>(null);
	let search = $state('');
	let offset = $state(0);
	let data = $state<InvoiceList | null>(null);
	let loading = $state(true);
	let error = $state('');

	const query = $derived.by(() => {
		const p = new URLSearchParams({ status, limit: String(LIMIT), offset: String(offset) });
		if (source) p.set('source', source);
		if (actionId) p.set('actionId', actionId);
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
			data = await apiFetch<InvoiceList>(`${BASE}/invoices?${q}`);
		} catch (e) {
			error = errorMessage(e, 'Rechnungen konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	const statuses: { value: string; label: string }[] = [
		{ value: 'unpaid', label: 'Offen' },
		{ value: 'overdue', label: 'Überfällig' },
		{ value: 'paid', label: 'Bezahlt' },
		{ value: 'cancelled', label: 'Storniert' },
		{ value: 'all', label: 'Alle' }
	];
	const sources = [
		{ value: 'action', label: 'Aus Aktionen' },
		{ value: 'annual', label: INVOICE_SOURCE_LABELS.annual },
		{ value: 'order', label: INVOICE_SOURCE_LABELS.order },
		{ value: 'manual', label: INVOICE_SOURCE_LABELS.manual }
	];
	// Auswahl für Sammel-Erinnerungen (nur offene Rechnungen, Recht `treasury.invoice.send`)
	const isSelectable = (i: InvoiceSummary) => i.openCents > 0 && i.status !== 'cancelled';
	let selected = $state<string[]>([]);
	const selectable = $derived((data?.items ?? []).filter(isSelectable));
	const selectedInvoices = $derived(selectable.filter((i) => selected.includes(i.id)));
	const allSelected = $derived(
		selectable.length > 0 && selectedInvoices.length === selectable.length
	);
	const someSelected = $derived(selectedInvoices.length > 0 && !allSelected);
	function toggleOne(id: string, on: boolean) {
		selected = on ? [...new Set([...selected, id])] : selected.filter((x) => x !== id);
	}
	let bulkBusy = $state(false);
	/** Handy/Tablet: Auswahlmodus per langem Drücken */
	let selecting = $state(false);
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

	const actionOptions = $derived(actions.map((a) => ({ value: a.id, label: a.name })));
	const open = (id: string) => goto(`/modules/treasury/invoices/${id}`);
</script>

{#snippet compactView()}
	<div class="flex flex-col gap-3">
		<CompactFilter
			bind:search
			searchLabel="Rechnungen durchsuchen"
			placeholder="Nummer, Name, Aktion"
			layout={layout ?? 'phone'}
			activeCount={Number(status !== 'unpaid') + Number(!!source) + Number(!!actionId)}
			resultLabel={data ? `${data.total} Rechnungen anzeigen` : 'Anzeigen'}
			onreset={() => {
				status = 'unpaid';
				source = null;
				actionId = null;
				offset = 0;
			}}
			oninput={() => (offset = 0)}
		>
			{#snippet chips()}
				<ChoiceChips
					legend="Status"
					options={statuses}
					value={status}
					onchange={(v) => {
						status = v;
						offset = 0;
					}}
				/>
				<ChoiceChips
					legend="Herkunft"
					options={[{ value: 'all', label: 'Alle' }, ...sources]}
					value={source ?? 'all'}
					onchange={(v) => {
						source = v === 'all' ? null : v;
						offset = 0;
					}}
				/>
				{#if actionOptions.length}
					<ChoiceChips
						legend="Aktion"
						options={[{ value: 'all', label: 'Alle' }, ...actionOptions]}
						value={actionId ?? 'all'}
						onchange={(v) => {
							actionId = v === 'all' ? null : v;
							offset = 0;
						}}
					/>
				{/if}
			{/snippet}
		</CompactFilter>

		{#if selecting && perm.send}
			<SelectionBar
				count={selectedInvoices.length}
				summary={formatEuro(selectedInvoices.reduce((s, i) => s + i.openCents, 0))}
				{allSelected}
				onall={() => (selected = allSelected ? [] : selectable.map((i) => i.id))}
				onclose={() => {
					selecting = false;
					selected = [];
				}}
				label="Sammelaktionen für Rechnungen"
				fixed={layout === 'phone'}
			>
				{#snippet actions()}
					<Button
						class="max-sm:h-13 max-sm:flex-col max-sm:gap-0.5 max-sm:text-xs"
						disabled={bulkBusy || !selectedInvoices.length}
						onclick={() => (confirmBulkOpen = true)}
					>
						<Bell /> Erinnerung senden
					</Button>
				{/snippet}
			</SelectionBar>
		{/if}

		{#if loading}
			<LoadingState rows={5} rowClass="h-16" />
		{:else if error}
			<ErrorState message={error} onretry={() => load()} />
		{:else if data}
			<div class="flex items-center justify-between gap-3 text-sm text-muted-foreground">
				<span>{data.total} {data.total === 1 ? 'Rechnung' : 'Rechnungen'}</span>
				{#if layout === 'tablet' && !selecting && perm.send && selectable.length}
					<Button variant="outline" size="sm" class="ml-auto" onclick={() => (selecting = true)}
						>Auswählen</Button
					>
				{/if}
				<strong class="text-base text-foreground tabular-nums"
					>{formatEuro(data.totals.openCents)} offen</strong
				>
			</div>
			{#if !data.items.length}
				<EmptyState
					title="Keine Rechnungen"
					description={status === 'unpaid' && !search
						? 'Es gibt keine offenen Rechnungen.'
						: 'Kein Eintrag passt zum Filter.'}
				/>
			{:else}
				<TouchList label="Rechnungen">
					{#each data.items as i (i.id)}
						<ListRow
							title={`${i.number} · ${i.recipientName}`}
							subtitle={[
								i.status === 'paid' ? 'bezahlt' : `fällig ${fmtDate(i.dueOn)}`,
								i.action?.name,
								i.people.filter((n) => n !== i.recipientName).join(', ')
							]
								.filter(Boolean)
								.join(' · ')}
							amount={formatEuro(i.openCents > 0 ? i.openCents : i.totalCents)}
							{selecting}
							selected={selected.includes(i.id)}
							disabled={selecting && !isSelectable(i)}
							onclick={() => {
								if (selecting) {
									if (isSelectable(i)) toggleOne(i.id, !selected.includes(i.id));
									if (!selected.length) selecting = false;
								} else void open(i.id);
							}}
							onlongpress={perm.send && isSelectable(i)
								? () => {
										selecting = true;
										toggleOne(i.id, true);
									}
								: undefined}
						>
							{#snippet trailing()}<StatusBadge invoice={i} />{/snippet}
						</ListRow>
					{/each}
				</TouchList>
				{#if data.total > LIMIT}
					<div class="flex items-center justify-between gap-2 text-sm">
						<Button
							variant="outline"
							class="h-11"
							disabled={offset === 0}
							onclick={() => (offset = Math.max(0, offset - LIMIT))}>Zurück</Button
						>
						<span class="tabular-nums">
							{offset + 1}–{Math.min(offset + LIMIT, data.total)} von {data.total}
						</span>
						<Button
							variant="outline"
							class="h-11"
							disabled={offset + LIMIT >= data.total}
							onclick={() => (offset += LIMIT)}>Weiter</Button
						>
					</div>
				{/if}
			{/if}
		{/if}
		{#if perm.editInvoice}
			<Button variant="outline" class="h-11" onclick={oncreate}><Plus /> Neue Rechnung</Button>
		{/if}
	</div>
{/snippet}

{#if layout && layout !== 'desktop'}
	{@render compactView()}
{:else}
	<div class={perm.send && selectedInvoices.length ? 'max-sm:pb-20' : ''}>
		<DataTable
			mobile="cards"
			caption="Rechnungen"
			{loading}
			{error}
			empty={!!data && !data.items.length}
			emptyTitle="Keine Rechnungen"
			emptyDescription={status === 'unpaid' && !search
				? 'Es gibt keine offenen Rechnungen.'
				: 'Kein Eintrag passt zum Filter.'}
		>
			{#snippet toolbar()}
				<FilterChips
					options={statuses}
					bind:value={status}
					label="Rechnungen nach Status filtern"
					onchange={() => (offset = 0)}
				/>
				<SelectField
					class="w-40"
					size="sm"
					label="Herkunft"
					options={sources}
					bind:value={source}
					emptyLabel="Alle Herkünfte"
					placeholder="Alle Herkünfte"
					onchange={() => (offset = 0)}
				/>
				<SelectField
					class="w-48"
					size="sm"
					label="Aktion"
					options={actionOptions}
					bind:value={actionId}
					emptyLabel="Alle Aktionen"
					placeholder="Alle Aktionen"
					onchange={() => (offset = 0)}
				/>
				<Input
					class="h-8 min-w-40 flex-1 sm:max-w-60"
					placeholder="Name oder Nummer …"
					aria-label="Rechnungen durchsuchen"
					bind:value={search}
					oninput={() => (offset = 0)}
				/>
				{#if perm.editInvoice}
					<Button class="ml-auto" size="sm" onclick={oncreate}><Plus /> Neue Rechnung</Button>
				{/if}
				<MobileActionBar
					show={perm.send && selectedInvoices.length > 0}
					label="Sammelaktionen für Rechnungen"
					class="sm:w-full sm:rounded-md sm:border sm:bg-muted/40 sm:px-3 sm:py-2"
				>
					<span class="text-sm font-medium" aria-live="polite">
						{selectedInvoices.length} ausgewählt
					</span>
					<Button
						size="sm"
						variant="outline"
						disabled={bulkBusy}
						onclick={() => (confirmBulkOpen = true)}
					>
						<Bell /> Erinnerung senden
					</Button>
					<Button size="sm" variant="ghost" class="ml-auto" onclick={() => (selected = [])}>
						<X /> Auswahl aufheben
					</Button>
				</MobileActionBar>
			{/snippet}
			{#snippet head()}
				<Table.Row>
					{#if perm.send}
						<Table.Head class="w-10">
							<Checkbox
								aria-label="Alle offenen Rechnungen dieser Seite auswählen"
								checked={allSelected}
								indeterminate={someSelected}
								disabled={!selectable.length}
								onCheckedChange={(v) => (selected = v === true ? selectable.map((i) => i.id) : [])}
							/>
						</Table.Head>
					{/if}
					<Table.Head>Nummer</Table.Head>
					<Table.Head>Empfänger*in</Table.Head>
					<Table.Head>Fällig</Table.Head>
					<Table.Head>Status</Table.Head>
					<Table.Head class="text-right">Betrag</Table.Head>
					<Table.Head class="text-right">Offen</Table.Head>
				</Table.Row>
			{/snippet}
			{#each data?.items ?? [] as i (i.id)}
				<Table.Row
					class="cursor-pointer"
					data-state={selected.includes(i.id) ? 'selected' : undefined}
					onclick={() => open(i.id)}
				>
					{#if perm.send}
						<Table.Cell onclick={(e: MouseEvent) => e.stopPropagation()}>
							{#if isSelectable(i)}
								<Checkbox
									aria-label={`Rechnung ${i.number} auswählen`}
									checked={selected.includes(i.id)}
									onCheckedChange={(v) => toggleOne(i.id, v === true)}
								/>
							{/if}
						</Table.Cell>
					{/if}
					<Table.Cell class="whitespace-nowrap">
						<a
							class="font-medium underline-offset-4 hover:underline"
							href={`/modules/treasury/invoices/${i.id}`}
							onclick={(e) => e.stopPropagation()}
						>
							{i.number}
						</a>
						<div class="text-xs text-muted-foreground">
							{INVOICE_SOURCE_LABELS[i.source] ?? i.source}
						</div>
					</Table.Cell>
					<Table.Cell class="max-w-72">
						<div class="truncate">{i.recipientName}</div>
						{#if i.payer || i.action}
							<div class="truncate text-xs text-muted-foreground">
								{#if i.payer}
									{@const payer = i.payer}
									{#if onfamily}
										<button
											type="button"
											class="underline-offset-4 hover:text-foreground hover:underline"
											title="Familienkonto öffnen"
											onclick={(e) => {
												e.stopPropagation();
												onfamily({ payerId: payer.id });
											}}
										>
											{payer.name}
										</button>
									{:else}
										{payer.name}
									{/if}
								{/if}
								{#if i.payer && i.action}·{/if}
								{#if i.action}{i.action.name}{/if}
							</div>
						{/if}
					</Table.Cell>
					<Table.Cell class="whitespace-nowrap tabular-nums">{fmtDate(i.dueOn)}</Table.Cell>
					<Table.Cell><StatusBadge invoice={i} /></Table.Cell>
					<Table.Cell class="text-right tabular-nums">{formatEuro(i.totalCents)}</Table.Cell>
					<Table.Cell class="text-right font-medium tabular-nums"
						>{formatEuro(i.openCents)}</Table.Cell
					>
				</Table.Row>
			{/each}
			{#snippet footer()}
				{#if data && data.total > 0}
					<div class="flex w-full flex-wrap items-center justify-between gap-2 text-sm">
						<span class="text-muted-foreground">
							{data.total} Rechnungen · Summe {formatEuro(data.totals.totalCents)} · offen
							{formatEuro(data.totals.openCents)}
						</span>
						{#if data.total > LIMIT}
							<div class="flex items-center gap-2">
								<Button
									size="sm"
									variant="outline"
									disabled={offset === 0}
									onclick={() => (offset -= LIMIT)}
								>
									Zurück
								</Button>
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
	</div>
{/if}

<ConfirmDialog
	bind:open={confirmBulkOpen}
	title="Erinnerungen senden?"
	description={`Für ${selectedInvoices.length} ${selectedInvoices.length === 1 ? 'Rechnung geht' : 'Rechnungen gehen'} sofort eine Zahlungserinnerung (jeweils nächste Stufe) per E-Mail raus. Das kann nicht zurückgeholt werden.`}
	confirmLabel="Erinnerungen senden"
	onconfirm={bulkRemind}
/>
