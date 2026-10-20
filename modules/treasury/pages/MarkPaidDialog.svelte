<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { page } from '$app/state';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField, MoneyInput, toastWithUndo } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		markPaidInput,
		type Account,
		type AllocationResult,
		type InvoiceSummary,
		type Payer
	} from '../schemas';
	import PayerCombobox from './PayerCombobox.svelte';
	import { BASE, defaultAccountId, fieldErrorsFrom, issuesToErrors, todayIso } from './helpers';

	let {
		open = $bindable(false),
		invoice,
		accounts,
		onsaved
	}: {
		open?: boolean;
		invoice: InvoiceSummary | null;
		accounts: Account[];
		onsaved: () => void | Promise<void>;
	} = $props();

	let accountId = $state<string | null>(null);
	let bookedOn = $state(todayIso());
	let amountCents = $state(0);
	let counterparty = $state('');
	let counterpartyIban = $state('');
	let payerId = $state<string | null>(null);
	let payers = $state<Payer[]>([]);
	let notify = $state(true);
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	$effect(() => {
		if (!open || !invoice) return;
		accountId = defaultAccountId(accounts);
		bookedOn = todayIso();
		amountCents = invoice.openCents;
		counterparty = invoice.recipientName;
		counterpartyIban = '';
		payerId = invoice.payer?.id ?? null;
		notify = true;
		void loadPayers();
		error = '';
		errors = {};
	});

	const accountOptions = $derived(
		accounts.filter((a) => !a.archived).map((a) => ({ value: a.id, label: a.name }))
	);

	async function loadPayers() {
		try {
			payers = await apiFetch<Payer[]>(`${BASE}/payers`);
		} catch {
			payers = [];
		}
	}

	const selectedPayer = $derived(payers.find((p) => p.id === payerId) ?? null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!invoice) return;
		const parsed = markPaidInput.safeParse({
			accountId: accountId ?? undefined,
			bookedOn,
			amountCents,
			counterparty,
			counterpartyIban: counterpartyIban.trim() ? counterpartyIban : undefined,
			payerId,
			notify
		});
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			return;
		}
		busy = true;
		error = '';
		try {
			const r = await apiFetch<AllocationResult>(`${BASE}/invoices/${invoice.id}/mark-paid`, {
				method: 'POST',
				body: JSON.stringify(parsed.data)
			});
			const parts = ['Zahlung erfasst'];
			if (r.mailsSent) parts.push(`${r.mailsSent} Bestätigung(en) gesendet`);
			if (r.payer) {
				parts.push(
					r.payer.created ? `Zahler „${r.payer.name}“ angelegt` : `Zahler „${r.payer.name}“ ergänzt`
				);
			}
			// Rückgängig = Buchung löschen: nur anbieten, wenn das Recht dafür da ist
			const canUndo = can((page.data.permissions ?? []) as string[], 'treasury.transaction.delete');
			if (r.mailsSent || !canUndo) toast.success(parts.join(' · '));
			else {
				toastWithUndo({
					message: parts.join(' · '),
					undo: () => apiFetch(`${BASE}/transactions/${r.transactionId}`, { method: 'DELETE' }),
					onundone: onsaved
				});
			}
			open = false;
			await onsaved();
		} catch (err) {
			if (err instanceof ApiClientError) {
				error = err.message;
				errors = fieldErrorsFrom(err.details);
			} else error = 'Speichern fehlgeschlagen';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Zahlung erfassen</Dialog.Title>
			<Dialog.Description>
				{#if invoice}
					{invoice.number} · {invoice.recipientName} · offen {formatEuro(invoice.openCents)}
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField label="Konto *" id="mp-account" error={errors.accountId}>
				<SelectField
					id="mp-account"
					label="Konto"
					options={accountOptions}
					bind:value={accountId}
					invalid={!!errors.accountId}
				/>
			</FormField>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<FormField label="Betrag *" id="mp-amount" error={errors.amountCents}>
					<MoneyInput
						id="mp-amount"
						label="Betrag"
						bind:cents={amountCents}
						max={invoice?.openCents}
						invalid={!!errors.amountCents}
					/>
				</FormField>
				<FormField label="Datum *" id="mp-date" error={errors.bookedOn}>
					<Input id="mp-date" type="date" bind:value={bookedOn} />
				</FormField>
			</div>
			<FormField label="Gezahlt von" id="mp-counterparty" error={errors.counterparty}>
				<PayerCombobox
					id="mp-counterparty"
					bind:value={counterparty}
					bind:payerId
					{payers}
					onpick={() => (counterpartyIban = '')}
				/>
			</FormField>
			<FormField
				label="IBAN der Zahler*in"
				id="mp-iban"
				error={errors.counterpartyIban}
				hint={selectedPayer?.ibanMasked
					? `Beim Zahler „${selectedPayer.name}“ ist ${selectedPayer.ibanMasked} hinterlegt – leer lassen zum Übernehmen.`
					: 'Optional, z. B. bei Überweisung. Die Kasse hinterlegt sie beim Zahler – Rückzahlungen gehen dann auf dieses Konto.'}
			>
				<Input
					id="mp-iban"
					bind:value={counterpartyIban}
					autocomplete="off"
					placeholder="DE00 0000 0000 0000 0000 00"
					aria-invalid={!!errors.counterpartyIban}
				/>
			</FormField>
			<div class="flex items-center gap-2">
				<Switch id="mp-notify" bind:checked={notify} />
				<Label for="mp-notify">Bestätigung per E-Mail, wenn vollständig bezahlt</Label>
			</div>
			{#if !accountOptions.length}
				<p class="text-sm text-muted-foreground">Lege zuerst unter „Einstellungen“ ein Konto an.</p>
			{/if}
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy || !accountOptions.length}>
					{busy ? 'Speichert …' : 'Zahlung buchen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
