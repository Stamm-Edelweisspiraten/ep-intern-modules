<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import { ConfirmDialog, DataTable } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { lineDescription } from '../stock';
	import type { Order, OrderList } from '../schemas';
	import OrderStatusBadge from './OrderStatusBadge.svelte';
	import PaymentBadge from './PaymentBadge.svelte';
	import { BASE, errorText, formatDate } from './helpers';

	const LIMIT = 50;
	let status = $state<string | null>(null);
	let offset = $state(0);
	let data = $state<OrderList | null>(null);
	let loading = $state(true);
	let error = $state('');

	const statusOptions = [
		{ value: 'active', label: 'Offen/teilweise' },
		{ value: 'delivered', label: 'Ausgegeben' },
		{ value: 'cancelled', label: 'Storniert' }
	];

	async function load() {
		loading = !data;
		error = '';
		try {
			const p = new URLSearchParams({
				scope: 'mine',
				status: status ?? 'all',
				limit: String(LIMIT),
				offset: String(offset)
			});
			data = await apiFetch<OrderList>(`${BASE}/orders?${p}`);
		} catch (e) {
			error = errorText(e, 'Bestellungen konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	onMount(() => void load());

	function itemsText(o: Order): string {
		return o.items
			.filter((i) => i.quantity - i.cancelledQty > 0 || o.status === 'cancelled')
			.map((i) =>
				lineDescription(
					i.articleTitle,
					i.variantLabel,
					o.status === 'cancelled' ? i.quantity : i.quantity - i.cancelledQty
				)
			)
			.join(', ');
	}

	// --- Stornieren --------------------------------------------------------------
	let cancelTarget = $state<Order | null>(null);
	let cancelOpen = $state(false);
	let busyId = $state<string | null>(null);

	function askCancel(o: Order) {
		cancelTarget = o;
		cancelOpen = true;
	}

	async function cancel() {
		const o = cancelTarget;
		if (!o) return;
		busyId = o.id;
		try {
			await apiFetch(`${BASE}/orders/${o.id}/cancel`, {
				method: 'POST',
				body: JSON.stringify({})
			});
			toast.success(`Bestellung ${o.number} storniert`);
			await load();
		} catch (e) {
			toast.error(errorText(e, 'Stornieren fehlgeschlagen'));
		} finally {
			busyId = null;
		}
	}

	const pages = $derived(data ? Math.max(1, Math.ceil(data.total / LIMIT)) : 1);
	const current = $derived(Math.floor(offset / LIMIT) + 1);
</script>

<DataTable
	mobile="cards"
	caption="Meine Bestellungen"
	{loading}
	{error}
	empty={!!data && !data.items.length}
	emptyTitle="Keine Bestellungen"
	emptyDescription={status
		? 'Keine Bestellung passt zum Filter.'
		: 'Du hast noch nichts bestellt. Im Tab „Bestellen“ findest du alle Artikel.'}
>
	{#snippet toolbar()}
		<SelectField
			class="w-full sm:w-48"
			size="sm"
			label="Status"
			options={statusOptions}
			bind:value={status}
			emptyLabel="Alle Bestellungen"
			placeholder="Alle Bestellungen"
			onchange={() => {
				offset = 0;
				void load();
			}}
		/>
		{#if error}
			<Button variant="outline" size="sm" onclick={load}>Erneut versuchen</Button>
		{/if}
	{/snippet}
	{#snippet head()}
		<Table.Row>
			<Table.Head>Nummer</Table.Head>
			<Table.Head>Datum</Table.Head>
			<Table.Head>Mitglied</Table.Head>
			<Table.Head>Positionen</Table.Head>
			<Table.Head class="text-right">Summe</Table.Head>
			<Table.Head>Status</Table.Head>
			<Table.Head>Zahlung</Table.Head>
			<Table.Head><span class="sr-only">Aktionen</span></Table.Head>
		</Table.Row>
	{/snippet}
	{#each data?.items ?? [] as o (o.id)}
		<Table.Row>
			<Table.Cell class="font-medium whitespace-nowrap">{o.number}</Table.Cell>
			<Table.Cell class="whitespace-nowrap tabular-nums">{formatDate(o.createdAt)}</Table.Cell>
			<Table.Cell>{o.member.name}</Table.Cell>
			<Table.Cell class="max-w-80">
				<div class="line-clamp-2" title={itemsText(o)}>{itemsText(o)}</div>
				{#if o.note}
					<div class="truncate text-xs text-muted-foreground" title={o.note}>
						Notiz: {o.note}
					</div>
				{/if}
			</Table.Cell>
			<Table.Cell class="text-right whitespace-nowrap tabular-nums">
				{formatEuro(o.totalCents)}
			</Table.Cell>
			<Table.Cell><OrderStatusBadge status={o.status} /></Table.Cell>
			<Table.Cell>
				<PaymentBadge
					payment={o.payment}
					pending={!o.payment && o.status !== 'cancelled' && o.totalCents > 0}
				/>
			</Table.Cell>
			<Table.Cell class="text-right">
				{#if o.canCancel}
					<Button
						variant="outline"
						size="sm"
						disabled={busyId === o.id}
						onclick={() => askCancel(o)}
					>
						{busyId === o.id ? 'Storniert …' : 'Stornieren'}
					</Button>
				{/if}
			</Table.Cell>
		</Table.Row>
	{/each}
	{#snippet footer()}
		{#if data && data.total > LIMIT}
			<div class="flex items-center justify-between gap-2 text-sm">
				<span class="text-muted-foreground tabular-nums">
					Seite {current} von {pages} · {data.total} Bestellungen
				</span>
				<div class="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={offset === 0}
						onclick={() => {
							offset = Math.max(0, offset - LIMIT);
							void load();
						}}>Zurück</Button
					>
					<Button
						variant="outline"
						size="sm"
						disabled={current >= pages}
						onclick={() => {
							offset += LIMIT;
							void load();
						}}>Weiter</Button
					>
				</div>
			</div>
		{/if}
	{/snippet}
</DataTable>

<ConfirmDialog
	bind:open={cancelOpen}
	title={`Bestellung ${cancelTarget?.number ?? ''} stornieren?`}
	description="Alle noch offenen Positionen werden storniert, die Rechnung wird entsprechend angepasst. Das lässt sich nicht rückgängig machen."
	confirmLabel="Stornieren"
	destructive
	onconfirm={cancel}
/>
