<script lang="ts">
	import { goto } from '$app/navigation';
	import Plus from '@lucide/svelte/icons/plus';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import { DataTable } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { INVOICE_SOURCE_LABELS, type InvoiceList } from '../schemas';
	import {
		BASE,
		errorMessage,
		fmtDate,
		statusText,
		statusVariant,
		type SharedData
	} from './helpers';

	let {
		actions,
		perm,
		version,
		oncreate
	}: SharedData & { oncreate: () => void; onchanged: () => void | Promise<void> } = $props();

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

	const statuses = [
		{ value: 'unpaid', label: 'Offen' },
		{ value: 'overdue', label: 'Überfällig' },
		{ value: 'paid', label: 'Bezahlt' },
		{ value: 'cancelled', label: 'Storniert' },
		{ value: 'all', label: 'Alle' }
	];
	const sources = [
		{ value: 'action', label: 'Aus Aktionen' },
		{ value: 'annual', label: INVOICE_SOURCE_LABELS.annual },
		{ value: 'manual', label: INVOICE_SOURCE_LABELS.manual }
	];
	const actionOptions = $derived(actions.map((a) => ({ value: a.id, label: a.name })));
	const open = (id: string) => goto(`/modules/treasury/invoices/${id}`);
</script>

<DataTable
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
		<div class="flex flex-wrap gap-1" role="group" aria-label="Status">
			{#each statuses as s (s.value)}
				<Button
					size="sm"
					variant={status === s.value ? 'default' : 'outline'}
					aria-pressed={status === s.value}
					onclick={() => {
						status = s.value;
						offset = 0;
					}}
				>
					{s.label}
				</Button>
			{/each}
		</div>
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
	{/snippet}
	{#snippet head()}
		<Table.Row>
			<Table.Head>Nummer</Table.Head>
			<Table.Head>Empfänger*in</Table.Head>
			<Table.Head>Fällig</Table.Head>
			<Table.Head>Status</Table.Head>
			<Table.Head class="text-right">Betrag</Table.Head>
			<Table.Head class="text-right">Offen</Table.Head>
		</Table.Row>
	{/snippet}
	{#each data?.items ?? [] as i (i.id)}
		<Table.Row class="cursor-pointer" onclick={() => open(i.id)}>
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
				<div class="truncate text-xs text-muted-foreground">
					{[i.payer?.name, i.action?.name].filter(Boolean).join(' · ')}
				</div>
			</Table.Cell>
			<Table.Cell class="whitespace-nowrap tabular-nums">{fmtDate(i.dueOn)}</Table.Cell>
			<Table.Cell><Badge variant={statusVariant(i)}>{statusText(i)}</Badge></Table.Cell>
			<Table.Cell class="text-right tabular-nums">{formatEuro(i.totalCents)}</Table.Cell>
			<Table.Cell class="text-right font-medium tabular-nums">{formatEuro(i.openCents)}</Table.Cell>
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
