<script lang="ts">
	// Verwaltung der Mitgliedsbestellungen (Kämmerer*in): Kopfzahlen, Filter, Ausgabe und Storno.
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import PackageCheck from '@lucide/svelte/icons/package-check';
	import Plus from '@lucide/svelte/icons/plus';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Table from '$lib/components/ui/table';
	import { DataTable } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { PERMISSIONS, type Order, type OrderList, type OrdersOverview } from '../schemas';
	import {
		API,
		ORDER_FILTERS,
		errorMessage,
		fmtDate,
		fmtRatio,
		itemName,
		type OrderFilter
	} from './admin-helpers';
	import CancelItemsDialog from './CancelItemsDialog.svelte';
	import HandoutDialog from './HandoutDialog.svelte';
	import OrderCreateDialog from './OrderCreateDialog.svelte';
	import OrderStatusBadge from './OrderStatusBadge.svelte';
	import PaymentBadge from './PaymentBadge.svelte';

	let {
		onnavigate
	}: {
		/** Optional: zu einem anderen Tab wechseln (Kopfzahlen „Fehlmengen“/„Einkäufe“) */
		onnavigate?: (tab: 'stock' | 'supplier') => void;
	} = $props();

	const permissions = $derived((page.data.permissions as string[] | undefined) ?? []);
	const canManage = $derived(can(permissions, PERMISSIONS.manage));

	const LIMIT = 50;
	let status = $state<OrderFilter>('active');
	let search = $state('');
	let offset = $state(0);
	let data = $state<OrderList | null>(null);
	let loading = $state(true);
	let error = $state('');
	let overview = $state<OrdersOverview | null>(null);
	let overviewError = $state('');
	let expanded = $state<string[]>([]);

	let handoutOrder = $state<Order | null>(null);
	let handoutOpen = $state(false);
	let cancelOrder = $state<Order | null>(null);
	let cancelOpen = $state(false);
	let createOpen = $state(false);

	const query = $derived.by(() => {
		const p = new URLSearchParams({
			scope: 'all',
			status,
			limit: String(LIMIT),
			offset: String(offset)
		});
		if (search.trim()) p.set('search', search.trim());
		return p.toString();
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const q = query;
		clearTimeout(timer);
		timer = setTimeout(() => void load(q), search ? 250 : 0);
		return () => clearTimeout(timer);
	});

	onMount(() => {
		void loadOverview();
	});

	async function load(q = query) {
		loading = !data;
		error = '';
		try {
			data = await apiFetch<OrderList>(`${API}/orders?${q}`);
		} catch (e) {
			error = errorMessage(e, 'Bestellungen konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	async function loadOverview() {
		overviewError = '';
		try {
			overview = await apiFetch<OrdersOverview>(`${API}/overview`);
		} catch (e) {
			overviewError = errorMessage(e, 'Übersicht konnte nicht geladen werden');
		}
	}

	async function reload() {
		await Promise.all([load(), loadOverview()]);
	}

	function toggle(id: string) {
		expanded = expanded.includes(id) ? expanded.filter((x) => x !== id) : [...expanded, id];
	}

	const openQtyOf = (o: Order) => o.items.reduce((s, i) => s + i.openQty, 0);
	const qtyOf = (o: Order) => o.items.reduce((s, i) => s + i.quantity - i.cancelledQty, 0);
	const deliveredOf = (o: Order) => o.items.reduce((s, i) => s + i.deliveredQty, 0);
	/** Mindestens eine offene Position mit Lagerbestand → Ausgabe möglich */
	const canHandout = (o: Order) => o.items.some((i) => i.openQty > 0 && (i.stock ?? 0) > 0);
	const missingOf = (o: Order) =>
		o.items.reduce((s, i) => s + Math.max(0, i.openQty - (i.stock ?? 0)), 0);

	function startHandout(o: Order) {
		handoutOrder = o;
		handoutOpen = true;
	}
	function startCancel(o: Order) {
		cancelOrder = o;
		cancelOpen = true;
	}

	const stats = $derived(
		overview
			? [
					{ label: 'Offene Bestellungen', value: overview.openOrders },
					{ label: 'Offene Stück', value: overview.openItems },
					{
						label: 'Fehlmengen',
						value: overview.deficitVariants,
						warn: overview.deficitVariants > 0,
						hint: 'Artikel/Größen nachbestellen',
						tab: 'stock' as const
					},
					{
						label: 'Offene Einkäufe',
						value: overview.openSupplierOrders,
						tab: 'supplier' as const
					},
					{
						label: 'Unbezahlte Lieferantenrechnungen',
						value: overview.unpaidSupplierInvoices,
						tab: 'supplier' as const
					}
				]
			: []
	);
</script>

{#snippet stat(label: string, value: number, warn: boolean)}
	<span class="text-xs text-muted-foreground">{label}</span>
	<span class={['text-2xl font-semibold tabular-nums', warn ? 'text-destructive' : ''].join(' ')}>
		{value}
	</span>
{/snippet}

<div class="space-y-4">
	<section aria-label="Kennzahlen" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
		{#if !overview && !overviewError}
			{#each [1, 2, 3, 4, 5] as n (n)}
				<Skeleton class="h-20 rounded-lg" />
			{/each}
		{:else}
			{#each stats as s (s.label)}
				{@const cls = [
					'flex min-h-20 flex-col justify-between rounded-lg border bg-card p-3 text-left',
					s.warn ? 'border-destructive/40 bg-destructive/5' : ''
				].join(' ')}
				{@const tab = s.tab}
				{#if tab && onnavigate}
					<button
						type="button"
						class="{cls} transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						onclick={() => onnavigate?.(tab)}
					>
						{@render stat(s.label, s.value, !!s.warn)}
					</button>
				{:else}
					<div class={cls}>{@render stat(s.label, s.value, !!s.warn)}</div>
				{/if}
			{/each}
		{/if}
	</section>
	{#if overviewError}
		<p class="text-sm text-destructive" role="alert">
			{overviewError}
			<Button size="sm" variant="link" onclick={loadOverview}>Erneut versuchen</Button>
		</p>
	{/if}
	{#if overview && !overview.treasuryActive}
		<p
			class="flex items-start gap-2 rounded-md border border-warning-border bg-warning-muted p-3 text-sm text-warning"
		>
			<TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			Das Modul Kasse ist nicht aktiv. Rechnungen an Mitglieder und Lieferantenrechnungen werden erst
			angelegt, wenn die Kasse aktiviert ist.
		</p>
	{/if}

	<DataTable
		mobile="cards"
		caption="Bestellungen der Mitglieder"
		{loading}
		{error}
		empty={!!data && !data.items.length}
		emptyTitle="Keine Bestellungen"
		emptyDescription={status === 'active' && !search
			? 'Es gibt keine offenen Bestellungen.'
			: 'Keine Bestellung passt zum Filter.'}
	>
		{#snippet toolbar()}
			<div class="flex flex-wrap gap-1" role="group" aria-label="Bestellungen nach Status filtern">
				{#each ORDER_FILTERS as f (f.value)}
					<Button
						size="sm"
						variant={status === f.value ? 'default' : 'outline'}
						aria-pressed={status === f.value}
						onclick={() => {
							status = f.value;
							offset = 0;
						}}
					>
						{f.label}
					</Button>
				{/each}
			</div>
			<Input
				class="h-8 min-w-40 flex-1 sm:max-w-60"
				placeholder="Nummer oder Name …"
				aria-label="Bestellungen durchsuchen"
				bind:value={search}
				oninput={() => (offset = 0)}
			/>
			{#if canManage}
				<Button size="sm" class="sm:ml-auto" onclick={() => (createOpen = true)}>
					<Plus /> Bestellung anlegen
				</Button>
			{/if}
		{/snippet}
		{#snippet head()}
			<Table.Row>
				<Table.Head>Bestellung</Table.Head>
				<Table.Head>Mitglied</Table.Head>
				<Table.Head>Status</Table.Head>
				<Table.Head class="text-right">Ausgegeben</Table.Head>
				<Table.Head class="text-right">Betrag</Table.Head>
				<Table.Head>Zahlung</Table.Head>
				<Table.Head><span class="sr-only">Aktionen</span></Table.Head>
			</Table.Row>
		{/snippet}
		{#each data?.items ?? [] as o (o.id)}
			{@const isOpen = expanded.includes(o.id)}
			{@const open = openQtyOf(o)}
			{@const missing = missingOf(o)}
			<Table.Row class="cursor-pointer" onclick={() => toggle(o.id)}>
				<Table.Cell class="whitespace-nowrap">
					<button
						type="button"
						class="inline-flex min-h-9 items-center gap-1 font-medium underline-offset-4 hover:underline"
						aria-expanded={isOpen}
						aria-controls={`order-items-${o.id}`}
						onclick={(e) => {
							e.stopPropagation();
							toggle(o.id);
						}}
					>
						{#if isOpen}<ChevronDown class="size-4" aria-hidden="true" />{:else}<ChevronRight
								class="size-4"
								aria-hidden="true"
							/>{/if}
						{o.number}
					</button>
					<div class="text-xs text-muted-foreground">{fmtDate(o.createdAt)}</div>
				</Table.Cell>
				<Table.Cell class="max-w-60">
					<div class="truncate">{o.member.name}</div>
					{#if o.orderedBy && o.orderedBy.name !== o.member.name}
						<div class="truncate text-xs text-muted-foreground">von {o.orderedBy.name}</div>
					{/if}
				</Table.Cell>
				<Table.Cell>
					<div class="flex flex-wrap items-center gap-1">
						<OrderStatusBadge status={o.status} />
						{#if missing > 0 && o.status !== 'cancelled'}
							<Badge variant="destructive" title="Nicht genug auf Lager"
								>{missing} {missing === 1 ? 'fehlt' : 'fehlen'}</Badge
							>
						{/if}
					</div>
				</Table.Cell>
				<Table.Cell class="text-right tabular-nums">
					{fmtRatio(deliveredOf(o), qtyOf(o))}
					{#if open > 0}
						<div class="text-xs text-muted-foreground">{open} offen</div>
					{/if}
				</Table.Cell>
				<Table.Cell class="text-right tabular-nums">{formatEuro(o.totalCents)}</Table.Cell>
				<Table.Cell>
					<PaymentBadge payment={o.payment} pending={!o.payment && o.totalCents > 0} />
				</Table.Cell>
				<Table.Cell
					class="text-right whitespace-nowrap"
					onclick={(e: MouseEvent) => e.stopPropagation()}
				>
					{#if canManage && open > 0}
						<div class="flex flex-wrap justify-end gap-1">
							<Button
								size="sm"
								variant="outline"
								disabled={!canHandout(o)}
								title={canHandout(o) ? undefined : 'Nichts davon auf Lager'}
								onclick={() => startHandout(o)}
							>
								<PackageCheck /> Ausgeben
							</Button>
							<Button size="sm" variant="ghost" onclick={() => startCancel(o)}>
								<X /> Stornieren
							</Button>
						</div>
					{/if}
				</Table.Cell>
			</Table.Row>
			{#if isOpen}
				<Table.Row class="bg-muted/30 hover:bg-muted/30">
					<Table.Cell colspan={7} data-label-manual id={`order-items-${o.id}`}>
						<div class="space-y-2 py-1">
							<div class="overflow-x-auto">
								<table class="w-full min-w-[26rem] text-sm">
									<caption class="sr-only">Positionen der Bestellung {o.number}</caption>
									<thead class="text-xs text-muted-foreground">
										<tr>
											<th class="py-1 pr-2 text-left font-medium">Artikel</th>
											<th class="px-2 py-1 text-right font-medium">Bestellt</th>
											<th class="px-2 py-1 text-right font-medium">Ausgegeben</th>
											<th class="px-2 py-1 text-right font-medium">Storniert</th>
											<th class="px-2 py-1 text-right font-medium">Offen</th>
											<th class="py-1 pl-2 text-right font-medium">Lager</th>
										</tr>
									</thead>
									<tbody>
										{#each o.items as it (it.id)}
											{@const short = it.openQty > 0 && (it.stock ?? 0) < it.openQty}
											<tr class="border-t border-border/60">
												<td class="py-1 pr-2">
													{itemName(it.articleTitle, it.variantLabel)}
													<span class="text-xs text-muted-foreground tabular-nums">
														· {formatEuro(it.unitPriceCents)}
													</span>
												</td>
												<td class="px-2 py-1 text-right tabular-nums">{it.quantity}</td>
												<td class="px-2 py-1 text-right tabular-nums">{it.deliveredQty}</td>
												<td class="px-2 py-1 text-right tabular-nums">{it.cancelledQty}</td>
												<td class="px-2 py-1 text-right font-medium tabular-nums">{it.openQty}</td>
												<td
													class={[
														'py-1 pl-2 text-right tabular-nums',
														short ? 'font-medium text-destructive' : ''
													].join(' ')}
												>
													{it.stock ?? '–'}
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
							{#if o.note}
								<p class="text-xs text-muted-foreground">
									<span class="font-medium text-foreground">Notiz:</span>
									{o.note}
								</p>
							{/if}
							{#if o.payment}
								<p class="text-xs text-muted-foreground tabular-nums">
									Rechnung {o.payment.invoiceNumber}: {formatEuro(o.payment.paidCents)} von
									{formatEuro(o.payment.dueCents)} bezahlt{o.payment.dueOn
										? ` · fällig ${fmtDate(o.payment.dueOn)}`
										: ''}
								</p>
							{/if}
						</div>
					</Table.Cell>
				</Table.Row>
			{/if}
		{/each}
		{#snippet footer()}
			{#if data && data.total > 0}
				<div class="flex w-full flex-wrap items-center justify-between gap-2 text-sm">
					<span class="text-muted-foreground">
						{data.total}
						{data.total === 1 ? 'Bestellung' : 'Bestellungen'}
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

<HandoutDialog bind:open={handoutOpen} order={handoutOrder} onsaved={reload} />
<CancelItemsDialog bind:open={cancelOpen} order={cancelOrder} onsaved={reload} />
<OrderCreateDialog bind:open={createOpen} onsaved={reload} />
