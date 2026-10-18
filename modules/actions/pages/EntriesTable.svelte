<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Upload from '@lucide/svelte/icons/upload';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Table from '$lib/components/ui/table';
	import { ColorBadge, DataTable } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		ACCOUNTING_CATEGORY_LABELS,
		RECEIPT_CONTENT_TYPES,
		type AccountingEntry
	} from '../schemas';
	import { fmtDate } from './format';
	import type { AutoIncome } from './auto-types';
	import { REFUND_CATEGORY, REFUND_CATEGORY_LABEL } from './refund-types';

	export type EntryFilter = 'all' | 'income' | 'expense' | 'missing';

	let {
		entries,
		autoIncome = null,
		filter = $bindable('all'),
		base,
		editable,
		onadd,
		onedit,
		ondelete,
		onupload
	}: {
		entries: AccountingEntry[];
		/** automatische Einnahmen aus Anmeldungen/Kalkulation */
		autoIncome?: AutoIncome | null;
		filter?: EntryFilter;
		base: string;
		editable: boolean;
		onadd: () => void;
		onedit: (e: AccountingEntry) => void;
		ondelete: (e: AccountingEntry) => void;
		onupload: (e: AccountingEntry, input: HTMLInputElement) => void;
	} = $props();

	const filters = [
		{ value: 'all', label: 'Alle' },
		{ value: 'income', label: 'Einnahmen' },
		{ value: 'expense', label: 'Ausgaben' },
		{ value: 'missing', label: 'Ohne Beleg' }
	] as const;

	const isRefund = (e: AccountingEntry) => (e.category as string) === REFUND_CATEGORY;
	const viewOnly = (e: AccountingEntry) => !!e.reimbursedAt || e.clubPaidVia === 'treasury';
	const label = (e: AccountingEntry) =>
		isRefund(e)
			? REFUND_CATEGORY_LABEL
			: ((ACCOUNTING_CATEGORY_LABELS as Record<string, string>)[e.category] ?? e.category);

	type AutoRow = { key: string; title: string; detail: string; cents: number };
	const fmtOne = (c: number) => formatEuro(c);
	const autoRows = $derived.by<AutoRow[]>(() => {
		if (!autoIncome || (filter !== 'all' && filter !== 'income')) return [];
		const rows: AutoRow[] = [];
		const c = autoIncome.contributions;
		if (c && c.cents > 0 && !autoIncome.overridden.includes('contributions')) {
			const parts = [`${c.payingCount} × ${fmtOne(c.feeCents)}`];
			if (c.teamCount > 0) parts.push(`Team ${c.teamCount} × ${fmtOne(c.teamFeeCents)}`);
			rows.push({
				key: 'contributions',
				title: 'Teilnehmerbeiträge',
				detail: `aus Anmeldungen (${parts.join(', ')})`,
				cents: c.cents
			});
		}
		const s = autoIncome.subsidy;
		if (s && s.cents > 0 && !autoIncome.overridden.includes('subsidy')) {
			rows.push({
				key: 'subsidy',
				title: 'Zuschuss',
				detail: `laut Kalkulation (${s.eligibleCount} ${s.eligibleCount === 1 ? 'berechtigte Person' : 'berechtigte Personen'})`,
				cents: s.cents
			});
		}
		return rows;
	});
	const replacedNote = $derived(
		autoIncome && autoIncome.overridden.length > 0 && (filter === 'all' || filter === 'income')
	);

	const filtered = $derived.by(() => {
		switch (filter) {
			case 'income':
				return entries.filter((e) => e.type === 'income');
			case 'expense':
				return entries.filter((e) => e.type === 'expense');
			case 'missing':
				return entries.filter((e) => e.type === 'expense' && !e.receipt && !isRefund(e));
			default:
				return entries;
		}
	});

	/** Mobil: ein gemeinsames Dateifeld für „Beleg hochladen“ aus dem Zeilenmenü */
	let mobileUploadInput = $state<HTMLInputElement>();
	let mobileUploadEntry = $state<AccountingEntry | null>(null);
	function pickReceipt(e: AccountingEntry) {
		mobileUploadEntry = e;
		mobileUploadInput?.click();
	}
	const canUpload = (e: AccountingEntry) => editable && !e.receipt && !isRefund(e);
</script>

{#snippet amount(cents: number, income: boolean)}
	<span aria-hidden="true">{income ? '+' : '−'}</span><span class="sr-only"
		>{income ? 'plus ' : 'minus '}</span
	>{formatEuro(cents)}
{/snippet}

{#snippet mobileList()}
	<ul class="divide-y sm:hidden" aria-label="Buchungen">
		{#each autoRows as r (r.key)}
			<li class="-mx-2 rounded-md bg-muted/40 px-2 py-3">
				<div class="flex items-start justify-between gap-3">
					<span class="min-w-0 font-medium break-words">{r.title}</span>
					<span class="shrink-0 tabular-nums text-green-700 dark:text-green-400"
						>{@render amount(r.cents, true)}</span
					>
				</div>
				<div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
					<Badge variant="secondary">Automatisch</Badge>
					<span>{r.detail}</span>
				</div>
			</li>
		{/each}
		{#if replacedNote}
			<li class="py-2 text-xs text-muted-foreground">
				{autoIncome?.overridden
					.map((k) => (k === 'contributions' ? 'Teilnehmerbeiträge' : 'Zuschuss'))
					.join(' und ')}: durch manuelle Buchung ersetzt
			</li>
		{/if}
		{#each filtered as e (e.id)}
			<li class="py-3">
				<div class="flex items-start justify-between gap-3">
					<span class="min-w-0 font-medium break-words">{e.description}</span>
					<span
						class={[
							'shrink-0 tabular-nums',
							e.type === 'income' && 'text-green-700 dark:text-green-400'
						]}>{@render amount(e.amountCents, e.type === 'income')}</span
					>
				</div>
				<div class="mt-1 flex items-start justify-between gap-2">
					<div
						class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
					>
						<span class="tabular-nums">{fmtDate(e.entryDate)}</span>
						<span aria-hidden="true">·</span>
						<ColorBadge>{label(e)}</ColorBadge>
						{#if e.receipt}
							<a
								href={`/api/v1${base}/entries/${e.id}/receipt`}
								target="_blank"
								rel="noopener"
								class="underline underline-offset-2"
							>
								Beleg<span class="sr-only"> zu {e.description} ansehen</span>
							</a>
						{:else if e.type === 'expense' && !isRefund(e)}
							<Badge
								variant="outline"
								class="border-amber-500/50 text-amber-700 dark:text-amber-400"
							>
								Beleg fehlt
							</Badge>
						{/if}
						{#if e.paidBy === 'person' && e.payee}<span>bezahlt von {e.payee.name}</span>{/if}
						{#if e.reimbursedAt}
							<Badge variant="secondary"
								><Check class="size-3" aria-hidden="true" /> Ausgezahlt</Badge
							>
						{/if}
						{#if e.type === 'expense' && e.paidBy === 'club' && !isRefund(e)}
							{#if e.recipient}<span>an {e.recipient.name}</span>{/if}
							{#if e.clubPaidAt === null}
								<Badge
									variant="outline"
									class="border-amber-500/50 text-amber-700 dark:text-amber-400"
									title={e.purpose ?? undefined}>Überweisung offen</Badge
								>
							{:else if e.clubPaidVia === 'treasury'}
								<Badge variant="secondary"
									><Check class="size-3" aria-hidden="true" /> Überwiesen {new Date(
										e.clubPaidAt
									).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</Badge
								>
							{/if}
						{/if}
						{#if editable && isRefund(e)}
							<span>über die Rückzahlung verwalten</span>
						{/if}
					</div>
					{#if editable && !isRefund(e)}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										size="icon"
										variant="ghost"
										class="-my-1 shrink-0"
										aria-label={`Aktionen zu ${e.description}`}
									>
										<Ellipsis />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end">
								<DropdownMenu.Item onSelect={() => onedit(e)}>
									<Pencil />
									{viewOnly(e) ? 'Ansehen' : 'Bearbeiten'}
								</DropdownMenu.Item>
								{#if canUpload(e)}
									<DropdownMenu.Item onSelect={() => pickReceipt(e)}>
										<Upload /> Beleg hochladen
									</DropdownMenu.Item>
								{/if}
								{#if !viewOnly(e)}
									<DropdownMenu.Item variant="destructive" onSelect={() => ondelete(e)}>
										<Trash2 /> Löschen
									</DropdownMenu.Item>
								{/if}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
	{#if editable}
		<input
			bind:this={mobileUploadInput}
			type="file"
			class="sr-only"
			tabindex="-1"
			aria-hidden="true"
			accept={RECEIPT_CONTENT_TYPES.join(',')}
			onchange={(ev) => {
				if (mobileUploadEntry) onupload(mobileUploadEntry, ev.currentTarget);
				mobileUploadEntry = null;
			}}
		/>
	{/if}
{/snippet}

<!-- Unter 640 px: Tabelle ausblenden, kompakte Liste (Footer-Snippet) anzeigen -->
<div class="[&_[data-mobile]]:hidden sm:[&_[data-mobile]]:block">
	<DataTable
		caption="Buchungen"
		title="Buchungen"
		empty={!filtered.length && !autoRows.length}
		emptyTitle={entries.length || autoRows.length
			? 'Keine Buchungen in diesem Filter'
			: 'Noch keine Buchungen'}
		emptyDescription={entries.length || autoRows.length
			? undefined
			: 'Erfasse hier Einnahmen und Ausgaben der Aktion, am besten mit Beleg. Daraus entstehen Saldo und Auszahlungen.'}
	>
		{#snippet footer()}
			{#if filtered.length || autoRows.length}{@render mobileList()}{/if}
		{/snippet}
		{#snippet toolbar()}
			<div class="flex flex-wrap gap-1" role="group" aria-label="Buchungen filtern">
				{#each filters as f (f.value)}
					<Button
						size="sm"
						variant={filter === f.value ? 'default' : 'outline'}
						aria-pressed={filter === f.value}
						onclick={() => (filter = f.value)}
					>
						{f.label}
					</Button>
				{/each}
			</div>
			{#if editable}
				<Button class="ml-auto" onclick={onadd}><Plus /> Buchung hinzufügen</Button>
			{/if}
		{/snippet}
		{#snippet head()}
			<Table.Row>
				<Table.Head>Datum</Table.Head>
				<Table.Head>Bezeichnung</Table.Head>
				<Table.Head class="text-right">Betrag</Table.Head>
				<Table.Head>Beleg</Table.Head>
				{#if editable}<Table.Head class="text-right"
						><span class="sr-only">Aktionen</span></Table.Head
					>{/if}
			</Table.Row>
		{/snippet}
		{#each autoRows as r (r.key)}
			<Table.Row class="bg-muted/40">
				<Table.Cell class="align-top text-muted-foreground">–</Table.Cell>
				<Table.Cell class="max-w-72 align-top">
					<div class="font-medium">{r.title}</div>
					<div
						class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
					>
						<Badge variant="secondary">Automatisch</Badge>
						<span>{r.detail}</span>
					</div>
				</Table.Cell>
				<Table.Cell
					class="text-right align-top whitespace-nowrap tabular-nums text-green-700 dark:text-green-400"
				>
					<span aria-hidden="true">+</span><span class="sr-only">plus </span>{formatEuro(r.cents)}
				</Table.Cell>
				<Table.Cell class="align-top"><span class="text-muted-foreground">–</span></Table.Cell>
				{#if editable}
					<Table.Cell class="text-right align-top">
						<span class="text-xs text-muted-foreground">berechnet</span>
					</Table.Cell>
				{/if}
			</Table.Row>
		{/each}
		{#if replacedNote}
			<Table.Row>
				<Table.Cell colspan={editable ? 5 : 4} class="text-xs text-muted-foreground">
					{autoIncome?.overridden
						.map((k) => (k === 'contributions' ? 'Teilnehmerbeiträge' : 'Zuschuss'))
						.join(' und ')}: durch manuelle Buchung ersetzt
				</Table.Cell>
			</Table.Row>
		{/if}
		{#each filtered as e (e.id)}
			<Table.Row>
				<Table.Cell class="align-top whitespace-nowrap tabular-nums"
					>{fmtDate(e.entryDate)}</Table.Cell
				>
				<Table.Cell class="max-w-72 align-top">
					<div class="font-medium">{e.description}</div>
					<div
						class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
					>
						<ColorBadge>{label(e)}</ColorBadge>
						{#if e.paidBy === 'person' && e.payee}<span>bezahlt von {e.payee.name}</span>{/if}
						{#if e.reimbursedAt}
							<Badge variant="secondary"
								><Check class="size-3" aria-hidden="true" /> Ausgezahlt</Badge
							>
						{/if}
						{#if e.type === 'expense' && e.paidBy === 'club' && !isRefund(e)}
							{#if e.recipient}<span>an {e.recipient.name}</span>{/if}
							{#if e.clubPaidAt === null}
								<Badge
									variant="outline"
									class="border-amber-500/50 text-amber-700 dark:text-amber-400"
									title={e.purpose ?? undefined}>Überweisung offen</Badge
								>
							{:else if e.clubPaidVia === 'treasury'}
								<Badge variant="secondary"
									><Check class="size-3" aria-hidden="true" /> Überwiesen {new Date(
										e.clubPaidAt
									).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</Badge
								>
							{/if}
						{/if}
					</div>
				</Table.Cell>
				<Table.Cell
					class={[
						'text-right align-top whitespace-nowrap tabular-nums',
						e.type === 'income' && 'text-green-700 dark:text-green-400'
					]}
				>
					<span aria-hidden="true">{e.type === 'income' ? '+' : '−'}</span><span class="sr-only"
						>{e.type === 'income' ? 'plus ' : 'minus '}</span
					>{formatEuro(e.amountCents)}
				</Table.Cell>
				<Table.Cell class="align-top">
					<div class="flex flex-wrap items-center gap-2">
						{#if e.receipt}
							<a
								href={`/api/v1${base}/entries/${e.id}/receipt`}
								target="_blank"
								rel="noopener"
								class="text-sm underline underline-offset-2"
							>
								Ansehen<span class="sr-only">: Beleg zu {e.description}</span>
							</a>
						{:else if e.type === 'expense' && !isRefund(e)}
							<Badge
								variant="outline"
								class="border-amber-500/50 text-amber-700 dark:text-amber-400"
							>
								fehlt
							</Badge>
						{:else}
							<span class="text-muted-foreground">–</span>
						{/if}
						{#if editable && !e.receipt && !isRefund(e)}
							<label
								class="inline-flex size-8 cursor-pointer items-center justify-center rounded-md border hover:bg-accent focus-within:ring-2 focus-within:ring-ring"
							>
								<Upload class="size-4" aria-hidden="true" />
								<span class="sr-only">Beleg zu {e.description} hochladen</span>
								<input
									type="file"
									class="sr-only"
									accept={RECEIPT_CONTENT_TYPES.join(',')}
									onchange={(ev) => onupload(e, ev.currentTarget)}
								/>
							</label>
						{/if}
					</div>
				</Table.Cell>
				{#if editable}
					<Table.Cell class="text-right align-top">
						{#if isRefund(e)}
							<span class="text-xs text-muted-foreground">über die Rückzahlung verwalten</span>
						{:else}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											size="icon"
											variant="ghost"
											aria-label={`Aktionen zu ${e.description}`}
										>
											<Ellipsis />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									<DropdownMenu.Item onSelect={() => onedit(e)}>
										<Pencil />
										{viewOnly(e) ? 'Ansehen' : 'Bearbeiten'}
									</DropdownMenu.Item>
									{#if !viewOnly(e)}
										<DropdownMenu.Item variant="destructive" onSelect={() => ondelete(e)}>
											<Trash2 /> Löschen
										</DropdownMenu.Item>
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					</Table.Cell>
				{/if}
			</Table.Row>
		{/each}
	</DataTable>
</div>
