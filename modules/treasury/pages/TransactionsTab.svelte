<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import History from '@lucide/svelte/icons/history';
	import Link from '@lucide/svelte/icons/link';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Users from '@lucide/svelte/icons/users';
	import { addDays, todayBerlin } from '$lib/sdk/dates';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		BottomSheet,
		ChoiceChips,
		ConfirmDialog,
		DataTable,
		EmptyState,
		ErrorState,
		FormField,
		ListRow,
		LoadingState,
		ScrollPills,
		SheetAction,
		TouchList,
		toastWithUndo,
		BUSY_SAVE
	} from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type {
		AllocationResult,
		MatchSuggestion,
		Payable,
		PayableList,
		Transaction,
		TransactionList
	} from '../schemas';
	import {
		BASE,
		errorMessage,
		fmtDate,
		openApiFile,
		signedEuro,
		transactionTitle,
		type SharedData
	} from './helpers';
	import CompactFilter from './CompactFilter.svelte';
	import FilterChips from './FilterChips.svelte';
	import HistorySheet from './HistorySheet.svelte';
	import type { FamilyRef } from './navigation';

	let {
		accounts,
		categories,
		perm,
		version,
		layout,
		onedit,
		onallocate,
		onsuggestions,
		onchanged,
		onfamily
	}: SharedData & {
		onedit: (t: Transaction) => void;
		onallocate: (t: Transaction) => void;
		onsuggestions: () => void;
		onchanged: () => void | Promise<void>;
		/** Familie (Zahler) öffnen */
		onfamily?: (ref: FamilyRef) => void;
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
	/** Anzahl „Ohne Zuordnung“ bei sonst gleichen Filtern (null = unbekannt) */
	let unassignedCount = $state<number | null>(null);
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
			const params = new URLSearchParams(q);
			const isUnassigned = params.get('filter') === 'unassigned';
			params.set('filter', 'unassigned');
			params.set('limit', '1');
			params.set('offset', '0');
			const [list, count] = await Promise.all([
				apiFetch<TransactionList>(`${BASE}/transactions?${q}`),
				isUnassigned
					? null
					: apiFetch<TransactionList>(`${BASE}/transactions?${params}`).catch(() => null)
			]);
			data = list;
			unassignedCount = isUnassigned ? list.total : (count?.total ?? null);
		} catch (e) {
			error = errorMessage(e, 'Buchungen konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	const reset = () => (offset = 0);
	type Filter = typeof filter;
	const filterOptions = $derived<{ value: Filter; label: string; count?: number | null }[]>([
		{ value: 'all', label: 'Alle' },
		{ value: 'income', label: 'Einnahmen' },
		{ value: 'expense', label: 'Ausgaben' },
		{ value: 'unassigned', label: 'Ohne Zuordnung', count: unassignedCount }
	]);

	// --- Zuordnungsvorschlag direkt in der Zeile -------------------------------------
	// Lazy: erst wenn die Zeile sichtbar ist; je Buchung höchstens eine Anfrage (Cache bis
	// zur nächsten Änderung), höchstens zwei Anfragen gleichzeitig.
	type SuggestionState = MatchSuggestion | null | 'loading';
	let suggestions = $state<Record<string, SuggestionState>>({});
	let acceptingId = $state<string | null>(null);
	const queue: Transaction[] = [];
	let running = 0;
	const MAX_PARALLEL = 2;

	const suggestionKey = (t: Transaction) => `${t.id}:${t.unallocatedCents}`;
	const canInline = (t: Transaction) =>
		perm.editTx && t.needsAllocation && t.amountCents > 0 && !t.transferId;

	// Nach jeder Änderung (Version) können sich offene Posten verschoben haben → neu fragen
	$effect(() => {
		void version;
		suggestions = {};
		queue.length = 0;
	});

	function requestSuggestion(t: Transaction) {
		const key = suggestionKey(t);
		if (key in suggestions) return;
		suggestions[key] = 'loading';
		queue.push(t);
		pump();
	}

	function pump() {
		while (running < MAX_PARALLEL && queue.length) {
			const t = queue.shift()!;
			const key = suggestionKey(t);
			running++;
			apiFetch<MatchSuggestion | null>(`${BASE}/transactions/${t.id}/suggestion`)
				.then((s) => {
					if (suggestions[key] === 'loading') suggestions[key] = s;
				})
				.catch(() => {
					if (suggestions[key] === 'loading') suggestions[key] = null;
				})
				.finally(() => {
					running--;
					pump();
				});
		}
	}

	/** Svelte-Action: Vorschlag laden, sobald die Zeile in den sichtbaren Bereich kommt */
	function lazySuggestion(node: HTMLElement, t: Transaction) {
		let current = t;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) requestSuggestion(current);
			},
			{ rootMargin: '200px' }
		);
		observer.observe(node);
		return {
			update(next: Transaction) {
				current = next;
				// neu beobachten, damit eine sichtbare Zeile nach einer Änderung erneut fragt
				observer.disconnect();
				observer.observe(node);
			},
			destroy: () => observer.disconnect()
		};
	}

	/** Nur sichere/wahrscheinliche Vorschläge per Klick übernehmen – unsichere über den Dialog */
	function usableSuggestion(t: Transaction): MatchSuggestion | null {
		const s = suggestions[suggestionKey(t)];
		return s && s !== 'loading' && s.confidence !== 'low' ? s : null;
	}

	const confidenceLabel = { high: 'sicher', medium: 'wahrscheinlich', low: 'unsicher' } as const;

	async function acceptSuggestion(t: Transaction, s: MatchSuggestion) {
		acceptingId = t.id;
		const previous = t.allocations.map((a) => ({ lineId: a.lineId, amountCents: a.amountCents }));
		try {
			const r = await apiFetch<AllocationResult>(`${BASE}/transactions/${t.id}/allocations`, {
				method: 'PUT',
				body: JSON.stringify({ allocations: [...previous, ...s.allocations], notify: true })
			});
			const parts = [`${formatEuro(r.allocatedCents)} zugeordnet (${s.invoiceNumbers.join(', ')})`];
			if (r.paidInvoices) parts.push(`${r.paidInvoices} Rechnung(en) vollständig bezahlt`);
			if (r.mailsSent) parts.push(`${r.mailsSent} Bestätigung(en) gesendet`);
			if (r.mailsSent) {
				// Bestätigung ist schon verschickt – Rückgängig wäre irreführend (wie im Zuordnen-Dialog)
				toast.success(parts.join(' · '));
			} else {
				toastWithUndo({
					message: parts.join(' · '),
					undo: () =>
						apiFetch(`${BASE}/transactions/${t.id}/allocations`, {
							method: 'PUT',
							body: JSON.stringify({ allocations: previous, notify: false })
						}),
					undone: 'Zuordnung aufgehoben',
					onundone: onchanged
				});
			}
			if (r.mailErrors) toast.error(`${r.mailErrors} Mail(s) konnten nicht gesendet werden`);
			await onchanged();
		} catch (e) {
			toast.error(errorMessage(e, 'Zuordnung fehlgeschlagen'));
		} finally {
			acceptingId = null;
		}
	}
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

	// --- Handy/Tablet: Liste nach Tagen statt Tabelle ------------------------------------
	const compact = $derived(!!layout && layout !== 'desktop');
	const activeFilters = $derived(Number(!!accountId) + Number(!!categoryId));
	function resetFilters() {
		accountId = null;
		categoryId = null;
		reset();
	}
	const accountChips = $derived([
		{ value: 'all', label: 'Alle Konten' },
		...accounts.filter((a) => !a.archived).map((a) => ({ value: a.id, label: a.name }))
	]);
	const categoryChips = $derived([
		{ value: 'all', label: 'Alle Kategorien' },
		...categories.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.name }))
	]);
	const today = todayBerlin();
	const yesterday = addDays(today, -1);
	const dayLabel = (d: string) =>
		d === today ? 'Heute' : d === yesterday ? 'Gestern' : fmtDate(d);
	const days = $derived.by(() => {
		const out: { day: string; items: Transaction[] }[] = [];
		for (const t of data?.items ?? []) {
			const last = out[out.length - 1];
			if (last && last.day === t.bookedOn) last.items.push(t);
			else out.push({ day: t.bookedOn, items: [t] });
		}
		return out;
	});
	let activeTxId = $state<string | null>(null);
	let rowSheetOpen = $state(false);
	const activeTx = $derived((data?.items ?? []).find((t) => t.id === activeTxId) ?? null);
	const paneTx = $derived(activeTx ?? data?.items[0] ?? null);

	function txSubtitle(t: Transaction): string {
		const parts: string[] = [t.accountName];
		if (t.needsAllocation) parts.push(`${formatEuro(t.unallocatedCents)} nicht zugeordnet`);
		else if (t.allocations.length)
			parts.push([...new Set(t.allocations.map((a) => a.invoiceNumber))].join(', '));
		else if (t.category) parts.push(t.category.name);
		if (t.purpose && !t.allocations.length) parts.push(t.purpose);
		return parts.join(' · ');
	}
	function tapTx(t: Transaction) {
		activeTxId = t.id;
		if (layout === 'phone') rowSheetOpen = true;
	}
	function fromRow(run: () => void) {
		rowSheetOpen = false;
		run();
	}
	const hasTxActions = (t: Transaction) =>
		(perm.editTx && !t.transferId) || !!t.receipt || canHistory || perm.deleteTx;
</script>

{#snippet suggestionBox(t: Transaction, big: boolean)}
	{#if canInline(t)}
		{@const s = usableSuggestion(t)}
		<div use:lazySuggestion={t} class={big ? '' : 'px-3.5 pb-2.5'}>
			{#if s}
				<div class="flex items-center gap-2.5 rounded-lg bg-link/10 px-2.5 py-2 text-sm">
					<Sparkles class="size-4 shrink-0 text-link" aria-hidden="true" />
					<span class="min-w-0 flex-1" title={s.reason}>
						Vorschlag: <strong>{s.invoiceNumbers.join(', ')}</strong>
						<span class="text-muted-foreground">· {confidenceLabel[s.confidence]}</span>
						{#if big}<span class="block truncate text-muted-foreground">{s.reason}</span>{/if}
					</span>
					<Button
						size="sm"
						class="h-9"
						disabled={!!acceptingId}
						onclick={() => acceptSuggestion(t, s)}
					>
						{acceptingId === t.id ? BUSY_SAVE : 'Übernehmen'}
					</Button>
				</div>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet txSheetActions(t: Transaction)}
	{#if perm.editTx && t.amountCents > 0 && !t.transferId}
		<SheetAction
			icon={Link}
			variant={t.needsAllocation ? 'primary' : 'default'}
			title="Rechnungen zuordnen"
			description={t.needsAllocation
				? `${formatEuro(t.unallocatedCents)} sind noch offen`
				: 'Zuordnung ansehen oder ändern'}
			onclick={() => fromRow(() => onallocate(t))}
		/>
	{/if}
	{#if perm.payable && t.amountCents < 0 && !t.transferId}
		<SheetAction
			icon={Link}
			title={t.payable ? 'Auszahlung ändern' : 'Auszahlung zuordnen'}
			description={t.payable?.recipientName}
			onclick={() => fromRow(() => void openLink(t))}
		/>
	{/if}
	{#if perm.editTx && !t.transferId}
		<SheetAction icon={Pencil} title="Bearbeiten" onclick={() => fromRow(() => onedit(t))} />
	{/if}
	{#if t.receipt}
		<SheetAction
			icon={Paperclip}
			title="Beleg öffnen"
			description={t.receipt.name}
			onclick={() => fromRow(() => void receipt(t))}
		/>
	{/if}
	{#if t.payer && onfamily}
		{@const payer = t.payer}
		<SheetAction
			icon={Users}
			title="Familienkonto"
			description={payer.name}
			onclick={() => fromRow(() => onfamily({ payerId: payer.id }))}
		/>
	{/if}
	{#if canHistory}
		<SheetAction
			icon={History}
			title="Verlauf"
			description="Wer hat was geändert"
			onclick={() =>
				fromRow(() => {
					historyTx = t;
					historyOpen = true;
				})}
		/>
	{/if}
	{#if perm.deleteTx}
		<div class="mx-5 my-1.5 h-px bg-border"></div>
		<SheetAction
			icon={Trash2}
			variant="danger"
			title="Löschen"
			description={t.allocations.length ? 'hebt die Zuordnung auf' : 'mit Rückfrage'}
			onclick={() =>
				fromRow(() => {
					toDelete = t;
					deleteOpen = true;
				})}
		/>
	{/if}
{/snippet}

{#snippet txDetail(t: Transaction)}
	<div class="flex flex-col gap-4">
		<div class="flex min-w-0 flex-col">
			<h3 class="truncate text-section">{transactionTitle(t)}</h3>
			<p class="truncate text-sm text-muted-foreground">
				{fmtDate(t.bookedOn)} · {t.accountName}{t.purpose ? ` · ${t.purpose}` : ''}
			</p>
		</div>
		<div
			class="text-4xl font-bold tracking-tight tabular-nums {t.amountCents > 0
				? 'text-success'
				: ''}"
		>
			{signedEuro(t.amountCents)}
		</div>
		{@render suggestionBox(t, true)}
		<div class="flex flex-wrap gap-2">
			{#if perm.editTx && t.amountCents > 0 && !t.transferId}
				<Button
					class="h-11"
					variant={t.needsAllocation ? 'default' : 'outline'}
					onclick={() => onallocate(t)}><Link /> Zuordnen</Button
				>
			{/if}
			{#if perm.payable && t.amountCents < 0 && !t.transferId}
				<Button class="h-11" variant="outline" onclick={() => openLink(t)}
					><Link /> {t.payable ? 'Auszahlung ändern' : 'Auszahlung zuordnen'}</Button
				>
			{/if}
			{#if perm.editTx && !t.transferId}
				<Button class="h-11" variant="outline" onclick={() => onedit(t)}
					><Pencil /> Bearbeiten</Button
				>
			{/if}
			{#if t.receipt}
				<Button class="h-11" variant="outline" onclick={() => receipt(t)}
					><Paperclip /> Beleg</Button
				>
			{/if}
			{#if canHistory || perm.deleteTx}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="outline"
								size="icon"
								class="size-11"
								aria-label="Weitere Aktionen zur Buchung"
							>
								<Ellipsis />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end">
						{#if canHistory}
							<DropdownMenu.Item
								class="min-h-11"
								onclick={() => {
									historyTx = t;
									historyOpen = true;
								}}>Verlauf anzeigen</DropdownMenu.Item
							>
						{/if}
						{#if perm.deleteTx}
							<DropdownMenu.Item
								class="min-h-11 text-destructive"
								onclick={() => {
									toDelete = t;
									deleteOpen = true;
								}}>Löschen</DropdownMenu.Item
							>
						{/if}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		</div>
		<dl class="divide-y rounded-xl border px-3.5 text-sm">
			<div class="flex justify-between gap-3 py-2">
				<dt class="text-muted-foreground">Konto</dt>
				<dd class="truncate font-medium">{t.accountName}</dd>
			</div>
			<div class="flex justify-between gap-3 py-2">
				<dt class="text-muted-foreground">Kategorie</dt>
				<dd class="truncate">{t.category?.name ?? '–'}</dd>
			</div>
			{#if t.action}
				<div class="flex justify-between gap-3 py-2">
					<dt class="text-muted-foreground">Aktion</dt>
					<dd class="truncate">{t.action.name}</dd>
				</div>
			{/if}
			{#if t.payer}
				<div class="flex justify-between gap-3 py-2">
					<dt class="text-muted-foreground">Familie</dt>
					<dd class="truncate">{t.payer.name}</dd>
				</div>
			{/if}
			<div class="flex justify-between gap-3 py-2">
				<dt class="text-muted-foreground">Status</dt>
				<dd>
					{t.transferId
						? 'Umbuchung'
						: t.needsAllocation
							? `${formatEuro(t.unallocatedCents)} nicht zugeordnet`
							: t.amountCents > 0 && t.allocations.length
								? 'zugeordnet'
								: t.payable
									? `Auszahlung ${t.payable.recipientName}`
									: 'gebucht'}
				</dd>
			</div>
		</dl>
		{#if t.allocations.length}
			<TouchList heading="Zugeordnet">
				{#each t.allocations as a (a.id)}
					<ListRow
						title={`${a.invoiceNumber} · ${a.description}`}
						amount={formatEuro(a.amountCents)}
						onclick={() => goto(`/modules/treasury/invoices/${a.invoiceId}`)}
					/>
				{/each}
			</TouchList>
		{/if}
	</div>
{/snippet}

{#snippet compactView()}
	<div class="flex flex-col gap-3">
		<ScrollPills
			label="Buchungen filtern"
			options={filterOptions}
			value={filter}
			onchange={(v) => {
				filter = v;
				reset();
			}}
		/>
		<CompactFilter
			bind:search
			searchLabel="Buchungen durchsuchen"
			placeholder="Zweck, Gegenpartei, Betrag"
			layout={layout ?? 'phone'}
			activeCount={activeFilters}
			resultLabel={data ? `${data.total} Buchungen anzeigen` : 'Anzeigen'}
			onreset={resetFilters}
			oninput={reset}
		>
			{#snippet chips()}
				<ChoiceChips
					legend="Konto"
					options={accountChips}
					value={accountId ?? 'all'}
					onchange={(v) => {
						accountId = v === 'all' ? null : v;
						reset();
					}}
				/>
				<ChoiceChips
					legend="Kategorie"
					options={categoryChips}
					value={categoryId ?? 'all'}
					onchange={(v) => {
						categoryId = v === 'all' ? null : v;
						reset();
					}}
				/>
			{/snippet}
		</CompactFilter>

		{#if loading}
			<LoadingState rows={5} rowClass="h-16" />
		{:else if error}
			<ErrorState message={error} onretry={() => load()} />
		{:else if data}
			<div class="flex items-baseline justify-between gap-3 text-sm text-muted-foreground">
				<span>{data.total} {data.total === 1 ? 'Buchung' : 'Buchungen'}</span>
				<strong class="text-base text-foreground tabular-nums">{signedEuro(data.sumCents)}</strong>
			</div>
			{#if filter === 'unassigned' && data.total > 0 && perm.editTx}
				<Button variant="outline" class="h-11" onclick={onsuggestions}>
					<Sparkles /> Alle Vorschläge prüfen
				</Button>
			{/if}
			{#if !data.items.length}
				<EmptyState
					title={filter !== 'all' || search || accountId ? 'Keine Treffer' : 'Noch keine Buchungen'}
					description={filter !== 'all' || search || accountId
						? 'Kein Eintrag passt zum Filter.'
						: 'Erfasse Buchungen über „Neu“ oder importiere einen Kontoauszug.'}
				/>
			{:else}
				<div
					class={layout === 'tablet'
						? 'grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-start gap-4'
						: ''}
				>
					<div class="flex flex-col gap-4">
						{#each days as d (d.day)}
							<TouchList heading={dayLabel(d.day)}>
								{#each d.items as t (t.id)}
									<ListRow
										title={transactionTitle(t)}
										subtitle={txSubtitle(t)}
										amount={signedEuro(t.amountCents)}
										amountClass={t.amountCents > 0 ? 'text-success' : ''}
										active={layout === 'tablet' && paneTx?.id === t.id}
										disabled={layout === 'phone' && !hasTxActions(t)}
										onclick={() => tapTx(t)}
									>
										{#snippet trailing()}
											{#if t.needsAllocation}
												<Badge variant="warning">offen</Badge>
											{:else if t.receipt}
												<Paperclip class="size-4 text-muted-foreground" aria-label="Mit Beleg" />
											{/if}
										{/snippet}
										{#snippet below()}
											{#if layout === 'phone'}{@render suggestionBox(t, false)}{/if}
										{/snippet}
									</ListRow>
								{/each}
							</TouchList>
						{/each}
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
					</div>
					{#if layout === 'tablet' && paneTx}
						<div class="sticky top-4 rounded-xl border bg-card p-5">
							{@render txDetail(paneTx)}
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	</div>

	{#if layout === 'phone'}
		<BottomSheet
			bind:open={rowSheetOpen}
			title={activeTx ? transactionTitle(activeTx) : 'Buchung'}
			description={activeTx
				? `${signedEuro(activeTx.amountCents)} · ${fmtDate(activeTx.bookedOn)} · ${activeTx.accountName}`
				: undefined}
		>
			{#if activeTx}{@render txSheetActions(activeTx)}{/if}
		</BottomSheet>
	{/if}
{/snippet}

{#if compact}
	{@render compactView()}
{:else}
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
			<FilterChips
				options={filterOptions}
				bind:value={filter}
				label="Buchungen filtern"
				onchange={reset}
			/>
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
					{#if t.payer}
						{@const payer = t.payer}
						<div class="truncate text-xs text-muted-foreground">
							Familie:
							{#if onfamily}
								<button
									type="button"
									class="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
									onclick={(e) => {
										e.stopPropagation();
										onfamily({ payerId: payer.id });
									}}
								>
									{payer.name}
								</button>
							{:else}
								<span class="font-medium text-foreground">{payer.name}</span>
							{/if}
						</div>
					{/if}
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
						<div class="mt-1 text-xs text-warning">
							{formatEuro(t.unallocatedCents)} nicht zugeordnet
						</div>
						{#if canInline(t)}
							{@const s = usableSuggestion(t)}
							<div class="mt-1.5" use:lazySuggestion={t}>
								{#if s}
									<div
										class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-xs"
									>
										<Sparkles class="size-3.5 shrink-0 text-link" aria-hidden="true" />
										<span class="min-w-0 flex-1" title={s.reason}>
											<span class="font-medium">→ {s.invoiceNumbers.join(', ')}</span>
											<span class="text-muted-foreground">
												· {formatEuro(s.allocations.reduce((sum, a) => sum + a.amountCents, 0))}
												· {confidenceLabel[s.confidence]}
											</span>
											<span class="block truncate text-muted-foreground">{s.reason}</span>
										</span>
										<div class="flex gap-1">
											<Button
												size="xs"
												disabled={!!acceptingId}
												onclick={(e) => {
													e.stopPropagation();
													void acceptSuggestion(t, s);
												}}
											>
												{acceptingId === t.id ? BUSY_SAVE : 'Übernehmen'}
											</Button>
											<Button
												size="xs"
												variant="ghost"
												onclick={(e) => {
													e.stopPropagation();
													onallocate(t);
												}}
											>
												Anpassen
											</Button>
										</div>
									</div>
								{:else}
									<Button
										size="xs"
										variant="outline"
										onclick={(e) => {
											e.stopPropagation();
											onallocate(t);
										}}
									>
										Zuordnen
									</Button>
								{/if}
							</div>
						{/if}
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
{/if}

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
			<Button onclick={saveLink} disabled={linkBusy}>{linkBusy ? BUSY_SAVE : 'Speichern'}</Button>
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
