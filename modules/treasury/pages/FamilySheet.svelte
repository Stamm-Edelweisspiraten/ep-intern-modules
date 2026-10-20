<script lang="ts">
	// Familienkonto als Seitenpanel: Rechnungen, Zahlungen, Guthaben, Auszahlungen und IBAN einer Familie.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Banknote from '@lucide/svelte/icons/banknote';
	import FileText from '@lucide/svelte/icons/file-text';
	import Pencil from '@lucide/svelte/icons/pencil';
	import UsersRound from '@lucide/svelte/icons/users-round';
	import { apiFetch } from '$lib/sdk/client';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { formatEuro } from '$lib/components/layout/money';
	import type { Account, FamilyAccount, InvoiceSummary, Payer, PayerFormInput } from '../schemas';
	import { BASE, errorMessage, fmtDate, openApiFile } from './helpers';
	import MarkPaidDialog from './MarkPaidDialog.svelte';
	import PayerDialog from './PayerDialog.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import type { FamilyRef, TreasuryPerm } from './navigation';

	let {
		open = $bindable(false),
		target,
		accounts,
		payers,
		members,
		perm,
		onchanged,
		onfamily
	}: {
		open?: boolean;
		target: FamilyRef | null;
		accounts: Account[];
		payers: Payer[];
		members: { id: string; name: string; emails: string[] }[];
		perm: TreasuryPerm;
		onchanged: () => void | Promise<void>;
		/** Wechsel zu einer anderen Familie (z. B. Geschwister-Zahler) */
		onfamily: (ref: FamilyRef) => void;
	} = $props();

	let account = $state<FamilyAccount | null>(null);
	let loading = $state(false);
	let error = $state('');
	let iban = $state<string | null>(null);
	let payerOpen = $state(false);
	let payerPreset = $state<PayerFormInput | null>(null);
	let payOpen = $state(false);
	let payInvoice = $state<InvoiceSummary | null>(null);
	let seq = 0;

	const targetKey = $derived(
		target
			? 'payerId' in target
				? `payerId=${target.payerId}`
				: `memberId=${target.memberId}`
			: ''
	);

	/** Vorläufiger Titel aus den Stammdaten, solange das Konto lädt */
	const fallbackName = $derived.by(() => {
		if (!target) return '';
		if ('payerId' in target) return payers.find((p) => p.id === target.payerId)?.name ?? '';
		return members.find((m) => m.id === target.memberId)?.name ?? '';
	});
	const title = $derived(account?.name ?? fallbackName);

	async function load(key: string) {
		if (!key) return;
		const mine = ++seq;
		loading = true;
		error = '';
		try {
			const data = await apiFetch<FamilyAccount>(`${BASE}/family-account?${key}`);
			if (mine !== seq) return;
			account = data;
		} catch (e) {
			if (mine !== seq) return;
			account = null;
			error = errorMessage(e, 'Familienkonto konnte nicht geladen werden');
		} finally {
			if (mine === seq) loading = false;
		}
	}

	$effect(() => {
		const key = targetKey;
		if (!open || !key) return;
		untrack(() => {
			iban = null;
			if (account && !matches(account, key)) account = null;
			void load(key);
		});
	});

	function matches(a: FamilyAccount, key: string): boolean {
		if (key.startsWith('payerId=')) return a.payer?.id === key.slice(8);
		return a.members.some((m) => m.id === key.slice(9));
	}

	async function changed() {
		await onchanged();
		await load(targetKey);
		// Mitglied wurde gerade als Familie angelegt → zum Zahler wechseln
		if (account?.payer && target && 'memberId' in target) onfamily({ payerId: account.payer.id });
	}

	async function showIban(p: Payer) {
		try {
			const r = await apiFetch<{ iban: string }>(`${BASE}/payers/${p.id}/iban`);
			iban = r.iban;
		} catch (e) {
			toast.error(errorMessage(e, 'IBAN nicht verfügbar'));
		}
	}

	async function copyIban() {
		if (!iban) return;
		try {
			await navigator.clipboard.writeText(iban.replace(/\s/g, ''));
			toast.success('IBAN kopiert');
		} catch {
			toast.error('Kopieren nicht möglich');
		}
	}

	async function statement(p: Payer) {
		try {
			await openApiFile(`${BASE}/payers/${p.id}/statement.pdf`);
		} catch (e) {
			toast.error(errorMessage(e, 'PDF konnte nicht erstellt werden'));
		}
	}

	function editPayer() {
		payerPreset = null;
		payerOpen = true;
	}

	function createFamily() {
		if (!account) return;
		payerPreset = {
			name: account.name,
			email: account.members[0]?.emails[0] ?? null,
			memberIds: account.members.map((m) => m.id)
		};
		payerOpen = true;
	}

	function pay(inv: InvoiceSummary) {
		payInvoice = inv;
		payOpen = true;
	}

	const kpis = $derived(
		account
			? [
					{ label: 'Offen', cents: account.totals.openCents, tone: '' },
					{
						label: 'Überfällig',
						cents: account.totals.overdueCents,
						tone: account.totals.overdueCents ? 'text-destructive' : ''
					},
					{ label: 'Bezahlt', cents: account.totals.paidCents, tone: '' },
					{ label: 'Guthaben', cents: account.totals.creditCents, tone: '' },
					{ label: 'Auszahlungen offen', cents: account.totals.payableOpenCents, tone: '' }
				]
			: []
	);
</script>

<Sheet.Root bind:open>
	<Sheet.Content
		side="right"
		class="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
	>
		<Sheet.Header class="border-b">
			<Sheet.Title class="flex items-center gap-2">
				<UsersRound class="size-4 text-muted-foreground" />
				<span class="truncate">{title || 'Familienkonto'}</span>
			</Sheet.Title>
			<Sheet.Description>
				{#if account && !account.payer}
					Mitglied ohne Familie (Zahler)
				{:else}
					Familienkonto
				{/if}
			</Sheet.Description>
		</Sheet.Header>

		<div class="space-y-6 px-4 pb-6">
			{#if error}
				<div class="space-y-2" role="alert">
					<p class="text-sm text-destructive">{error}</p>
					<Button size="sm" variant="outline" onclick={() => load(targetKey)}>
						Erneut versuchen
					</Button>
				</div>
			{:else if !account}
				<div class="space-y-3" aria-busy="true">
					<Skeleton class="h-6 w-2/3" />
					<Skeleton class="h-16 w-full" />
					<Skeleton class="h-32 w-full" />
				</div>
			{:else}
				<!-- Kopf: Mitglieder, Kontakt, Bankverbindung, Aktionen -->
				<section class="space-y-3" aria-busy={loading}>
					<div class="flex flex-wrap gap-1">
						{#each account.members as m (m.id)}<Badge variant="outline">{m.name}</Badge>{/each}
						{#if !account.members.length}
							<span class="text-xs text-muted-foreground">Keine Mitglieder zugeordnet</span>
						{/if}
					</div>
					{#if account.payer}
						{@const p = account.payer}
						<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
							<dt class="text-muted-foreground">E-Mail</dt>
							<dd class="min-w-0 truncate">{p.email ?? '–'}</dd>
							<dt class="text-muted-foreground">Bankverbindung</dt>
							<dd class="flex min-w-0 flex-wrap items-center gap-2">
								{#if p.ibanMasked}
									{#if p.accountHolder}<span>{p.accountHolder}</span>{/if}
									<span class="font-mono">{iban ?? p.ibanMasked}</span>
									{#if perm.bank && !iban}
										<Button size="sm" variant="ghost" class="h-6 px-2" onclick={() => showIban(p)}>
											anzeigen
										</Button>
									{:else if iban}
										<Button size="sm" variant="ghost" class="h-6 px-2" onclick={copyIban}>
											kopieren
										</Button>
									{/if}
								{:else}
									<span class="text-muted-foreground">keine hinterlegt</span>
								{/if}
							</dd>
							{#if p.note}
								<dt class="text-muted-foreground">Notiz</dt>
								<dd class="min-w-0 whitespace-pre-line">{p.note}</dd>
							{/if}
						</dl>
						<div class="flex flex-wrap gap-2">
							{#if account.totals.openCents > 0}
								<Button size="sm" variant="outline" onclick={() => statement(p)}>
									<FileText /> Sammelrechnung (PDF)
								</Button>
							{/if}
							{#if perm.editInvoice}
								<Button size="sm" variant="outline" onclick={editPayer}>
									<Pencil /> Bearbeiten
								</Button>
							{/if}
						</div>
					{:else}
						<div class="rounded-md border border-dashed p-3 text-sm">
							<p class="text-muted-foreground">
								Dieses Mitglied gehört zu keiner Familie. Als Familie (Zahler) zusammengefasst
								erscheinen Rechnungen von Geschwistern gemeinsam und Sammelüberweisungen werden
								erkannt.
							</p>
							{#if perm.editInvoice}
								<Button size="sm" class="mt-2" onclick={createFamily}>
									<UsersRound /> Als Familie anlegen
								</Button>
							{/if}
						</div>
					{/if}
				</section>

				<!-- Kennzahlen -->
				<section aria-label="Kennzahlen">
					<dl class="grid grid-cols-2 gap-2 sm:grid-cols-5">
						{#each kpis as k (k.label)}
							<div class="rounded-md border p-2">
								<dt class="text-xs text-muted-foreground">{k.label}</dt>
								<dd class="font-semibold tabular-nums {k.tone}">{formatEuro(k.cents)}</dd>
							</div>
						{/each}
					</dl>
				</section>

				<!-- Rechnungen -->
				<section class="space-y-2">
					<h3 class="text-sm font-semibold">Rechnungen ({account.invoices.length})</h3>
					{#if !account.invoices.length}
						<p class="text-sm text-muted-foreground">Keine Rechnungen.</p>
					{:else}
						<ul class="divide-y rounded-md border">
							{#each account.invoices as inv (inv.id)}
								<li class="flex flex-wrap items-center gap-x-3 gap-y-1 p-2 text-sm">
									<div class="min-w-0 flex-1">
										<a
											href={`/modules/treasury/invoices/${inv.id}`}
											class="font-mono font-medium underline-offset-4 hover:underline"
										>
											{inv.number}
										</a>
										<div class="truncate text-xs text-muted-foreground">
											{inv.action?.name ?? inv.recipientName} · fällig {fmtDate(inv.dueOn)}
										</div>
									</div>
									<StatusBadge invoice={inv} />
									<div class="w-24 text-right tabular-nums">
										{#if inv.status === 'cancelled'}
											<span class="text-muted-foreground">–</span>
										{:else if inv.openCents > 0}
											<span class="font-medium">{formatEuro(inv.openCents)}</span>
											<div class="text-xs text-muted-foreground">
												von {formatEuro(inv.totalCents)}
											</div>
										{:else}
											<span class="text-muted-foreground">{formatEuro(inv.totalCents)}</span>
										{/if}
									</div>
									{#if perm.editTx && inv.status !== 'cancelled' && inv.openCents > 0}
										<Button
											size="sm"
											variant="ghost"
											aria-label={`Zahlung für ${inv.number} erfassen`}
											onclick={() => pay(inv)}
										>
											<Banknote /> Zahlung erfassen
										</Button>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>

				<!-- Zahlungen -->
				<section class="space-y-2">
					<h3 class="text-sm font-semibold">Zahlungen ({account.payments.length})</h3>
					{#if !account.payments.length}
						<p class="text-sm text-muted-foreground">Noch keine Zahlungen eingegangen.</p>
					{:else}
						<ul class="divide-y rounded-md border">
							{#each account.payments as t (t.id)}
								<li class="flex items-start gap-3 p-2 text-sm">
									<div class="w-20 shrink-0 tabular-nums text-muted-foreground">
										{fmtDate(t.bookedOn)}
									</div>
									<div class="min-w-0 flex-1">
										<div class="truncate">{t.purpose ?? t.counterparty ?? 'Zahlung'}</div>
										<div class="truncate text-xs text-muted-foreground">
											{t.accountName}{#if t.counterparty && t.purpose}
												· {t.counterparty}{/if}
											{#if t.allocations.length}
												· {[...new Set(t.allocations.map((a) => a.invoiceNumber))].join(', ')}
											{/if}
										</div>
									</div>
									<div class="shrink-0 text-right font-medium tabular-nums">
										{formatEuro(t.amountCents)}
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</section>

				<!-- Auszahlungen -->
				{#if account.payables.length}
					<section class="space-y-2">
						<h3 class="text-sm font-semibold">Auszahlungen ({account.payables.length})</h3>
						<ul class="divide-y rounded-md border">
							{#each account.payables as p (p.id)}
								<li class="flex flex-wrap items-center gap-x-3 gap-y-1 p-2 text-sm">
									<div class="min-w-0 flex-1">
										<div class="truncate">{p.description}</div>
										<div class="truncate text-xs text-muted-foreground">
											an {p.recipientName}{#if p.dueOn}
												· fällig {fmtDate(p.dueOn)}{/if}
										</div>
									</div>
									<StatusBadge payable={p} />
									<div class="w-24 text-right tabular-nums">
										{formatEuro(p.openCents > 0 ? p.openCents : p.amountCents)}
									</div>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>

<PayerDialog
	bind:open={payerOpen}
	payer={payerPreset ? null : (account?.payer ?? null)}
	preset={payerPreset}
	{members}
	onsaved={changed}
/>
<MarkPaidDialog bind:open={payOpen} invoice={payInvoice} {accounts} onsaved={changed} />
