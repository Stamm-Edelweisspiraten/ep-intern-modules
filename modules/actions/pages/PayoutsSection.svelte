<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Download from '@lucide/svelte/icons/download';
	import Landmark from '@lucide/svelte/icons/landmark';
	import Pencil from '@lucide/svelte/icons/pencil';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { ConfirmDialog, EmptyState } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { AccountingPayee } from '../schemas';
	import PayeeDialog from './PayeeDialog.svelte';

	let {
		actionId,
		payees,
		canViewPayouts,
		editable,
		viaTreasury = false,
		onchanged
	}: {
		actionId: string;
		payees: AccountingPayee[] | null;
		canViewPayouts: boolean;
		/** Bearbeiten erlaubt (Rechte und Abrechnung offen) */
		editable: boolean;
		/** Kasse aktiv: Auszahlung erfolgt dort (Hinweis) */
		viaTreasury?: boolean;
		onchanged: () => void | Promise<void>;
	} = $props();

	const base = $derived(`/modules/actions/actions/${actionId}/accounting`);

	let dialogOpen = $state(false);
	let editPayee = $state<AccountingPayee | null>(null);
	let payoutOpen = $state(false);
	let payoutPayee = $state<AccountingPayee | null>(null);
	let undoOpen = $state(false);
	let undoPayee = $state<AccountingPayee | null>(null);

	function openNew() {
		editPayee = null;
		dialogOpen = true;
	}
	function openEdit(p: AccountingPayee) {
		editPayee = p;
		dialogOpen = true;
	}

	function errMsg(e: unknown, fallback: string) {
		return e instanceof ApiClientError ? e.message : fallback;
	}

	async function reimburse(p: AccountingPayee) {
		try {
			const r = await apiFetch<{ count: number; amountCents: number }>(
				`${base}/payees/${p.id}/reimburse`,
				{ method: 'POST' }
			);
			toast.success(`${formatEuro(r.amountCents)} an ${p.name} als ausgezahlt markiert`);
			await onchanged();
		} catch (e) {
			toast.error(errMsg(e, 'Markieren fehlgeschlagen'));
		}
	}

	async function undo(p: AccountingPayee) {
		try {
			await apiFetch(`${base}/payees/${p.id}/reimburse`, { method: 'DELETE' });
			toast.success(`Auszahlung an ${p.name} zurückgenommen`);
			await onchanged();
		} catch (e) {
			toast.error(errMsg(e, 'Zurücknehmen fehlgeschlagen'));
		}
	}
</script>

<section aria-labelledby="payouts-title" class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div>
			<h3 id="payouts-title" class="font-semibold">Auslagen &amp; Auszahlung</h3>
			<p class="text-xs text-muted-foreground">Erstattung von Auslagen an Personen.</p>
		</div>
		{#if canViewPayouts}
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-xs text-muted-foreground">Format vorläufig</span>
				<Button variant="outline" href={`/api/v1${base}/payouts.csv`} download>
					<Download /> Auszahlungsliste (CSV)
				</Button>
				{#if editable}
					<Button variant="outline" onclick={openNew}><UserPlus /> Neue Person</Button>
				{/if}
			</div>
		{/if}
	</div>

	{#if viaTreasury}
		<p class="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground" role="note">
			Offene Auslagen erscheinen automatisch in der Kasse unter „Auszahlungen“. Sobald die Kasse die
			Überweisung bucht, wird die Person hier als ausgezahlt markiert.
		</p>
	{/if}
	{#if !canViewPayouts || payees === null}
		<p class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
			Bankdaten sehen nur Personen mit Kassen-Berechtigung.
		</p>
	{:else if payees.length === 0}
		<EmptyState
			title="Noch keine Personen mit Auslagen"
			description="Sobald eine Ausgabe von einer Person bezahlt wurde, erscheint sie hier."
		/>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
			{#each payees as p (p.id)}
				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2">
							<Landmark class="size-4 text-muted-foreground" aria-hidden="true" />
							<span class="min-w-0 truncate">{p.name}</span>
						</Card.Title>
						<Card.Description class="tabular-nums">
							{p.ibanMasked ?? 'Keine IBAN hinterlegt'}{p.bic ? ` · ${p.bic}` : ''}
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-3">
						<div>
							<div class="text-xs text-muted-foreground">Offen</div>
							<div class="text-2xl font-semibold tabular-nums">{formatEuro(p.openCents)}</div>
							<div class="text-xs text-muted-foreground">
								{p.openEntries === 1 ? '1 offener Beleg' : `${p.openEntries} offene Belege`}
							</div>
						</div>
						{#if p.reimbursedCents > 0}
							<Badge variant="secondary" class="tabular-nums">
								Ausgezahlt: {formatEuro(p.reimbursedCents)}
							</Badge>
						{/if}
						{#if p.note}<p class="text-xs text-muted-foreground">{p.note}</p>{/if}
						{#if editable}
							<div class="flex flex-wrap gap-2 pt-1">
								<Button variant="outline" size="sm" onclick={() => openEdit(p)}>
									<Pencil /> Bankdaten bearbeiten
								</Button>
								{#if p.openCents > 0}
									<Button
										size="sm"
										onclick={() => {
											payoutPayee = p;
											payoutOpen = true;
										}}
									>
										Als ausgezahlt markieren
									</Button>
								{/if}
								{#if p.reimbursedCents > 0}
									<Button
										variant="ghost"
										size="sm"
										onclick={() => {
											undoPayee = p;
											undoOpen = true;
										}}
									>
										Auszahlung zurücknehmen
									</Button>
								{/if}
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}
</section>

<PayeeDialog bind:open={dialogOpen} {actionId} payee={editPayee} onsaved={() => onchanged()} />
<ConfirmDialog
	bind:open={payoutOpen}
	title="Als ausgezahlt markieren?"
	description={payoutPayee
		? `${formatEuro(payoutPayee.openCents)} an ${payoutPayee.name} (${payoutPayee.openEntries} Belege) werden als ausgezahlt markiert.`
		: undefined}
	confirmLabel="Als ausgezahlt markieren"
	onconfirm={async () => {
		if (payoutPayee) await reimburse(payoutPayee);
	}}
/>
<ConfirmDialog
	bind:open={undoOpen}
	title="Auszahlung zurücknehmen?"
	description={undoPayee
		? `Die ausgezahlten Auslagen von ${undoPayee.name} gelten wieder als offen.`
		: undefined}
	confirmLabel="Zurücknehmen"
	onconfirm={async () => {
		if (undoPayee) await undo(undoPayee);
	}}
/>
