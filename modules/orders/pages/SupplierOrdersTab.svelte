<script lang="ts">
	// Einkauf: Bestellungen beim Lieferanten mit Wareneingang, Rechnung an die Kasse und Abschluss.
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import PackageOpen from '@lucide/svelte/icons/package-open';
	import Plus from '@lucide/svelte/icons/plus';
	import { toast } from 'svelte-sonner';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Table from '$lib/components/ui/table';
	import { ConfirmDialog, DataTable } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { PERMISSIONS, type OrdersOverview, type SupplierOrder } from '../schemas';
	import {
		API,
		SUPPLIER_FILTERS,
		errorMessage,
		fmtDate,
		fmtRatio,
		itemName,
		type SupplierFilter
	} from './admin-helpers';
	import PaymentBadge from './PaymentBadge.svelte';
	import ReceiveDialog from './ReceiveDialog.svelte';
	import SupplierInvoiceDialog from './SupplierInvoiceDialog.svelte';
	import SupplierOrderDialog from './SupplierOrderDialog.svelte';
	import SupplierStatusBadge from './SupplierStatusBadge.svelte';

	const permissions = $derived((page.data.permissions as string[] | undefined) ?? []);
	const canStock = $derived(can(permissions, PERMISSIONS.stock));

	let status = $state<SupplierFilter>('active');
	let list = $state<SupplierOrder[] | null>(null);
	let loading = $state(true);
	let error = $state('');
	let treasuryActive = $state(true);
	let expanded = $state<string[]>([]);
	let busyId = $state<string | null>(null);

	let editOrder = $state<SupplierOrder | null>(null);
	let editOpen = $state(false);
	let receiveOrder = $state<SupplierOrder | null>(null);
	let receiveOpen = $state(false);
	let invoiceOrder = $state<SupplierOrder | null>(null);
	let invoiceOpen = $state(false);
	let cancelRestOrder = $state<SupplierOrder | null>(null);
	let cancelRestOpen = $state(false);

	onMount(() => {
		void load();
		void apiFetch<OrdersOverview>(`${API}/overview`)
			.then((o) => (treasuryActive = o.treasuryActive))
			.catch(() => {});
	});

	async function load() {
		loading = !list;
		error = '';
		try {
			list = await apiFetch<SupplierOrder[]>(`${API}/supplier-orders?status=${status}`);
		} catch (e) {
			error = errorMessage(e, 'Einkäufe konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	function setStatus(s: SupplierFilter) {
		if (status === s) return;
		status = s;
		void load();
	}

	function toggle(id: string) {
		expanded = expanded.includes(id) ? expanded.filter((x) => x !== id) : [...expanded, id];
	}

	const orderedQty = (o: SupplierOrder) =>
		o.items.reduce((s, i) => s + i.quantity - i.cancelledQty, 0);
	const receivedQty = (o: SupplierOrder) => o.items.reduce((s, i) => s + i.receivedQty, 0);
	const openQty = (o: SupplierOrder) => o.items.reduce((s, i) => s + i.openQty, 0);

	function startNew() {
		editOrder = null;
		editOpen = true;
	}
	function startEdit(o: SupplierOrder) {
		editOrder = o;
		editOpen = true;
	}
	function startReceive(o: SupplierOrder) {
		receiveOrder = o;
		receiveOpen = true;
	}
	function startInvoice(o: SupplierOrder) {
		invoiceOrder = o;
		invoiceOpen = true;
	}
	function startCancelRest(o: SupplierOrder) {
		cancelRestOrder = o;
		cancelRestOpen = true;
	}

	async function post(o: SupplierOrder, action: 'cancel-rest' | 'close' | 'reopen', ok: string) {
		busyId = o.id;
		try {
			await apiFetch(`${API}/supplier-orders/${o.id}/${action}`, { method: 'POST' });
			toast.success(ok);
			await load();
		} catch (e) {
			toast.error(errorMessage(e, 'Aktion fehlgeschlagen'));
		} finally {
			busyId = null;
		}
	}
</script>

<DataTable
	mobile="cards"
	caption="Bestellungen beim Lieferanten"
	{loading}
	{error}
	empty={!!list && !list.length}
	emptyTitle="Keine Einkäufe"
	emptyDescription={status === 'active'
		? 'Es gibt keine offenen Bestellungen beim Lieferanten.'
		: 'Kein Einkauf passt zum Filter.'}
>
	{#snippet toolbar()}
		<div class="flex flex-wrap gap-1" role="group" aria-label="Einkäufe nach Status filtern">
			{#each SUPPLIER_FILTERS as f (f.value)}
				<Button
					size="sm"
					variant={status === f.value ? 'default' : 'outline'}
					aria-pressed={status === f.value}
					onclick={() => setStatus(f.value)}
				>
					{f.label}
				</Button>
			{/each}
		</div>
		{#if canStock}
			<Button class="ml-auto" size="sm" onclick={startNew}>
				<Plus /> Neue Bestellung beim Lieferanten
			</Button>
		{/if}
	{/snippet}
	{#snippet head()}
		<Table.Row>
			<Table.Head>Nummer</Table.Head>
			<Table.Head>Lieferant</Table.Head>
			<Table.Head>Bestellt am</Table.Head>
			<Table.Head>Status</Table.Head>
			<Table.Head class="text-right">Geliefert</Table.Head>
			<Table.Head class="text-right">Rechnung</Table.Head>
			<Table.Head>Bezahlt</Table.Head>
			<Table.Head><span class="sr-only">Aktionen</span></Table.Head>
		</Table.Row>
	{/snippet}
	{#each list ?? [] as o (o.id)}
		{@const isOpen = expanded.includes(o.id)}
		{@const rest = openQty(o)}
		{@const closed = o.status === 'closed'}
		<Table.Row class="cursor-pointer" onclick={() => toggle(o.id)}>
			<Table.Cell class="whitespace-nowrap">
				<button
					type="button"
					class="inline-flex min-h-9 items-center gap-1 font-medium underline-offset-4 hover:underline"
					aria-expanded={isOpen}
					aria-controls={`supplier-items-${o.id}`}
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
			</Table.Cell>
			<Table.Cell class="max-w-60"><div class="truncate">{o.supplier}</div></Table.Cell>
			<Table.Cell class="whitespace-nowrap tabular-nums">{fmtDate(o.orderedOn)}</Table.Cell>
			<Table.Cell><SupplierStatusBadge status={o.status} /></Table.Cell>
			<Table.Cell class="text-right tabular-nums">
				{fmtRatio(receivedQty(o), orderedQty(o))}
				{#if rest > 0}<div class="text-xs text-muted-foreground">{rest} offen</div>{/if}
			</Table.Cell>
			<Table.Cell class="text-right tabular-nums">
				{#if o.invoice}
					{formatEuro(o.invoice.amountCents)}
				{:else if o.estimatedCents > 0}
					<span class="text-muted-foreground" title="Geschätzt aus den Einkaufspreisen">
						ca. {formatEuro(o.estimatedCents)}
					</span>
				{:else}
					<span class="text-muted-foreground">–</span>
				{/if}
			</Table.Cell>
			<Table.Cell>
				{#if !o.invoice}
					<span class="text-xs text-muted-foreground">keine Rechnung</span>
				{:else if !o.invoice.inTreasury}
					<span class="text-xs text-muted-foreground">noch nicht an Kasse</span>
				{:else}
					<PaymentBadge payment={o.invoice.payment} pending={!o.invoice.payment} />
				{/if}
			</Table.Cell>
			<Table.Cell
				class="text-right whitespace-nowrap"
				onclick={(e: MouseEvent) => e.stopPropagation()}
			>
				{#if canStock}
					<div class="flex justify-end gap-1">
						{#if rest > 0 && !closed}
							<Button
								size="sm"
								variant="outline"
								disabled={busyId === o.id}
								onclick={() => startReceive(o)}
							>
								<PackageOpen /> Wareneingang
							</Button>
						{/if}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="icon"
										disabled={busyId === o.id}
										aria-label={`Aktionen für ${o.number}`}
									>
										<Ellipsis />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end">
								<DropdownMenu.Item onclick={() => startInvoice(o)}>
									{o.invoice ? 'Rechnung bearbeiten' : 'Rechnung an Kasse'}
								</DropdownMenu.Item>
								<DropdownMenu.Item onclick={() => startEdit(o)}>Bearbeiten</DropdownMenu.Item>
								{#if closed}
									<DropdownMenu.Item
										onclick={() => post(o, 'reopen', `${o.number} wieder geöffnet`)}
									>
										Wieder öffnen
									</DropdownMenu.Item>
								{:else}
									<DropdownMenu.Item onclick={() => post(o, 'close', `${o.number} abgeschlossen`)}>
										Abschließen
									</DropdownMenu.Item>
								{/if}
								{#if rest > 0 && !closed}
									<DropdownMenu.Separator />
									<DropdownMenu.Item class="text-destructive" onclick={() => startCancelRest(o)}>
										Rest stornieren
									</DropdownMenu.Item>
								{/if}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					</div>
				{/if}
			</Table.Cell>
		</Table.Row>
		{#if isOpen}
			<Table.Row class="bg-muted/30 hover:bg-muted/30">
				<Table.Cell colspan={8} data-label-manual id={`supplier-items-${o.id}`}>
					<div class="space-y-2 py-1">
						<div class="overflow-x-auto">
							<table class="w-full min-w-[26rem] text-sm">
								<caption class="sr-only">Positionen von {o.number}</caption>
								<thead class="text-xs text-muted-foreground">
									<tr>
										<th class="py-1 pr-2 text-left font-medium">Artikel</th>
										<th class="px-2 py-1 text-right font-medium">Bestellt</th>
										<th class="px-2 py-1 text-right font-medium">Eingegangen</th>
										<th class="px-2 py-1 text-right font-medium">Storniert</th>
										<th class="px-2 py-1 text-right font-medium">Offen</th>
										<th class="py-1 pl-2 text-right font-medium">Preis</th>
									</tr>
								</thead>
								<tbody>
									{#each o.items as it (it.id)}
										<tr class="border-t border-border/60">
											<td class="py-1 pr-2">{itemName(it.articleTitle, it.variantLabel)}</td>
											<td class="px-2 py-1 text-right tabular-nums">{it.quantity}</td>
											<td class="px-2 py-1 text-right tabular-nums">{it.receivedQty}</td>
											<td class="px-2 py-1 text-right tabular-nums">{it.cancelledQty}</td>
											<td class="px-2 py-1 text-right font-medium tabular-nums">{it.openQty}</td>
											<td class="py-1 pl-2 text-right tabular-nums">
												{it.unitCostCents != null ? formatEuro(it.unitCostCents) : '–'}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
						<p class="text-xs text-muted-foreground">
							{#if o.createdBy}Angelegt von {o.createdBy.name}{/if}
							{#if o.closedAt}· abgeschlossen am {fmtDate(o.closedAt)}{/if}
							{#if o.invoice?.payment}
								· {formatEuro(o.invoice.payment.paidCents)} von {formatEuro(
									o.invoice.payment.amountCents
								)} bezahlt
							{/if}
						</p>
						{#if o.note}
							<p class="text-xs text-muted-foreground">
								<span class="font-medium text-foreground">Notiz:</span>
								{o.note}
							</p>
						{/if}
					</div>
				</Table.Cell>
			</Table.Row>
		{/if}
	{/each}
</DataTable>

<SupplierOrderDialog bind:open={editOpen} initial={editOrder} onsaved={load} />
<ReceiveDialog bind:open={receiveOpen} order={receiveOrder} onsaved={load} />
<SupplierInvoiceDialog
	bind:open={invoiceOpen}
	order={invoiceOrder}
	{treasuryActive}
	onsaved={load}
/>
<ConfirmDialog
	bind:open={cancelRestOpen}
	title="Rest stornieren?"
	description="Die offenen Mengen werden storniert. Fehlmengen erscheinen danach wieder im Lager zum Nachbestellen."
	confirmLabel="Rest stornieren"
	destructive
	onconfirm={() =>
		cancelRestOrder
			? post(
					cancelRestOrder,
					'cancel-rest',
					`Offene Mengen von ${cancelRestOrder.number} storniert`
				)
			: undefined}
/>
