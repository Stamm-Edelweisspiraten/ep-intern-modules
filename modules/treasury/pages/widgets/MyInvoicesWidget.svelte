<script lang="ts">
	// Dashboard-Kachel „Meine offenen Rechnungen“: offene Rechnungen der verknüpften Mitglieder
	// mit aufklappbaren Zahlungsdaten (Empfänger, IBAN, Verwendungszweck zum Kopieren).
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Copy from '@lucide/svelte/icons/copy';
	import Receipt from '@lucide/svelte/icons/receipt';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { Button } from '$lib/components/ui/button';
	import { formatIban } from '../../iban';
	import type { MyInvoice, MyInvoices } from '../../schemas';
	import { BASE, errorMessage, fmtDate } from '../helpers';

	let { onstatus }: DashboardWidgetProps = $props();

	const LIMIT = 4;

	let data = $state<MyInvoices | null>(null);
	let loading = $state(true);
	let error = $state('');
	let openId = $state<string | null>(null);

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			data = await apiFetch<MyInvoices>(`${BASE}/my/invoices`);
			onstatus?.(data.invoices.length ? 'ready' : 'empty');
		} catch (e) {
			error = errorMessage(e, 'Rechnungen konnten nicht geladen werden.');
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	const shown = $derived(data?.invoices.slice(0, LIMIT) ?? []);
	const more = $derived(Math.max(0, (data?.invoices.length ?? 0) - shown.length));

	async function copy(value: string, label: string) {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(`${label} kopiert`);
		} catch {
			toast.error('Kopieren nicht möglich');
		}
	}

	const toggle = (inv: MyInvoice) => (openId = openId === inv.id ? null : inv.id);
</script>

<DashboardCard
	title="Meine offenen Rechnungen"
	icon={Receipt}
	{loading}
	{error}
	onretry={load}
	empty={!shown.length}
	emptyText="Keine offenen Rechnungen."
>
	{#if data}
		<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-2">
			<span class="text-2xl font-semibold tabular-nums">{formatEuro(data.totals.openCents)}</span>
			<span class="text-xs text-muted-foreground">offen</span>
			{#if data.totals.overdueCents > 0}
				<span class="text-xs font-medium text-destructive tabular-nums">
					davon {formatEuro(data.totals.overdueCents)} überfällig
				</span>
			{/if}
		</div>
		<ul class="divide-y">
			{#each shown as inv (inv.id)}
				{@const expanded = openId === inv.id}
				<li class="py-2">
					<div class="flex items-start justify-between gap-2">
						<div class="min-w-0">
							<div class="truncate font-medium">
								<span class="tabular-nums">{inv.number}</span>
								{#if inv.members.length}· {inv.members.join(', ')}{/if}
							</div>
							<div
								class="text-xs tabular-nums {inv.overdue
									? 'font-medium text-destructive'
									: 'text-muted-foreground'}"
							>
								{inv.overdue ? 'Überfällig seit' : 'Fällig am'}
								{fmtDate(inv.dueDate)}
							</div>
						</div>
						<div class="shrink-0 text-right">
							<div class="font-medium tabular-nums">{formatEuro(inv.openCents)}</div>
							{#if inv.openCents !== inv.totalCents}
								<div class="text-xs text-muted-foreground tabular-nums">
									von {formatEuro(inv.totalCents)}
								</div>
							{/if}
						</div>
					</div>
					<Button
						variant="link"
						size="sm"
						class="h-auto p-0 text-xs"
						aria-expanded={expanded}
						aria-controls={`pay-${inv.id}`}
						onclick={() => toggle(inv)}
					>
						Zahlungsdaten
						<ChevronDown
							class="transition-transform {expanded ? 'rotate-180' : ''}"
							aria-hidden="true"
						/>
					</Button>
					{#if expanded}
						<dl
							id={`pay-${inv.id}`}
							class="mt-1 grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 rounded-md bg-muted/50 p-2 text-xs"
						>
							{#if data.bank}
								{@const bank = data.bank}
								<dt class="text-muted-foreground">Empfänger</dt>
								<dd class="col-span-2 min-w-0 truncate">{bank.holder}</dd>
								<dt class="text-muted-foreground">IBAN</dt>
								<dd class="min-w-0 truncate font-mono">{formatIban(bank.iban)}</dd>
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label="IBAN kopieren"
									onclick={() => copy(bank.iban.replace(/\s+/g, ''), 'IBAN')}
								>
									<Copy />
								</Button>
								{#if bank.bic}
									<dt class="text-muted-foreground">BIC</dt>
									<dd class="col-span-2 font-mono">{bank.bic}</dd>
								{/if}
							{:else}
								<dd class="col-span-3 text-muted-foreground">
									Die Bankverbindung bitte bei der Kasse erfragen.
								</dd>
							{/if}
							<dt class="text-muted-foreground">Betrag</dt>
							<dd class="col-span-2 tabular-nums">{formatEuro(inv.openCents)}</dd>
							<dt class="text-muted-foreground">Zweck</dt>
							<dd class="min-w-0 break-words">{inv.purpose}</dd>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Verwendungszweck kopieren"
								onclick={() => copy(inv.purpose, 'Verwendungszweck')}
							>
								<Copy />
							</Button>
						</dl>
					{/if}
				</li>
			{/each}
		</ul>
		{#if more}
			<p class="pt-1 text-xs text-muted-foreground">und {more} weitere</p>
		{/if}
	{/if}
</DashboardCard>
