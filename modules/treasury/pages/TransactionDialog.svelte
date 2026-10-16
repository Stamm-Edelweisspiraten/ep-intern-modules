<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FileField, FormField, MoneyInput } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		MAX_RECEIPT_BYTES,
		RECEIPT_CONTENT_TYPES,
		transactionCreateInput,
		transactionInput,
		type Account,
		type Category,
		type Payer,
		type Transaction,
		type TransactionCreated
	} from '../schemas';
	import BookingMatchSection from './BookingMatchSection.svelte';
	import PayerCombobox from './PayerCombobox.svelte';
	import { BASE, defaultAccountId, fieldErrorsFrom, issuesToErrors, todayIso } from './helpers';

	let {
		open = $bindable(false),
		transaction = null,
		accounts,
		categories,
		actions,
		payers = [],
		canUploadReceipt,
		onsaved
	}: {
		open?: boolean;
		transaction?: Transaction | null;
		accounts: Account[];
		categories: Category[];
		actions: { id: string; name: string }[];
		/** Für die Autovervollständigung der Gegenpartei */
		payers?: Payer[];
		canUploadReceipt: boolean;
		onsaved: (t: Transaction) => void | Promise<void>;
	} = $props();

	let direction = $state<string | null>('income');
	let accountId = $state<string | null>(null);
	let bookedOn = $state(todayIso());
	let amountCents = $state(0);
	let counterparty = $state('');
	let counterpartyIban = $state('');
	let payerId = $state<string | null>(null);
	let matchAmounts = $state<Record<string, number>>({});
	let payableId = $state<string | null>(null);
	let notify = $state(true);
	let purpose = $state('');
	let categoryId = $state<string | null>(null);
	let actionId = $state<string | null>(null);
	let note = $state('');
	let file = $state<File | null>(null);
	let removeReceipt = $state(false);
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});
	/** „Weitere Buchung erfassen“: Dialog bleibt nach dem Speichern offen (bleibt für die Sitzung gemerkt) */
	let keepOpen = $state(false);
	let savedCount = $state(0);
	/** neu aufbauen der Zuordnung nach jeder gespeicherten Buchung */
	let formKey = $state(0);

	/** Für die nächste Buchung leeren; Art, Konto, Datum, Kategorie und Aktion bleiben stehen */
	async function resetForNext() {
		amountCents = 0;
		counterparty = '';
		counterpartyIban = '';
		payerId = null;
		matchAmounts = {};
		payableId = null;
		purpose = '';
		note = '';
		file = null;
		error = '';
		errors = {};
		formKey++;
		await tick();
		document.getElementById('tx-amount')?.focus();
	}

	$effect(() => {
		if (!open) return;
		const t = transaction;
		direction = t ? (t.amountCents < 0 ? 'expense' : 'income') : 'income';
		// untrack: Neuladen der Konten nach dem Speichern darf das Formular nicht zurücksetzen
		accountId = t?.accountId ?? untrack(() => defaultAccountId(accounts));
		bookedOn = t?.bookedOn ?? todayIso();
		amountCents = t ? Math.abs(t.amountCents) : 0;
		counterparty = t?.counterparty ?? '';
		counterpartyIban = '';
		payerId = t?.payer?.id ?? null;
		matchAmounts = {};
		payableId = null;
		notify = true;
		purpose = t?.purpose ?? '';
		categoryId = t?.category?.id ?? null;
		actionId = t?.action?.id ?? null;
		note = t?.note ?? '';
		file = null;
		removeReceipt = false;
		error = '';
		errors = {};
		busy = false;
		savedCount = 0;
	});

	// Konten können nach dem Öffnen eintreffen: Standardkonto nachträglich vorbelegen
	$effect(() => {
		if (open && !accountId && accounts.length) {
			accountId = untrack(() => defaultAccountId(accounts));
		}
	});

	const directionOptions = [
		{ value: 'income', label: 'Einnahme' },
		{ value: 'expense', label: 'Ausgabe' }
	];
	const accountOptions = $derived(
		accounts
			.filter((a) => !a.archived || a.id === transaction?.accountId)
			.map((a) => ({ value: a.id, label: a.name }))
	);
	const categoryOptions = $derived(
		categories
			.filter(
				(c) =>
					(!c.archived || c.id === transaction?.category?.id) &&
					(c.kind === 'both' || c.kind === direction)
			)
			.map((c) => ({ value: c.id, label: c.name }))
	);
	const actionOptions = $derived(actions.map((a) => ({ value: a.id, label: a.name })));

	function onDirection() {
		if (categoryId && !categoryOptions.some((o) => o.value === categoryId)) categoryId = null;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		errors = {};
		const base = {
			accountId: accountId ?? undefined,
			bookedOn,
			amountCents: direction === 'expense' ? -amountCents : amountCents,
			counterparty,
			purpose,
			categoryId,
			actionId,
			note,
			// leer = unverändert (bzw. IBAN des gewählten Zahlers)
			counterpartyIban: counterpartyIban.trim() ? counterpartyIban : undefined,
			payerId
		};
		const allocations = Object.entries(matchAmounts)
			.filter(([, v]) => v > 0)
			.map(([lineId, cents]) => ({ lineId, amountCents: cents }));
		if (canMatch && direction === 'income') {
			const sum = allocations.reduce((s, a) => s + a.amountCents, 0);
			if (sum > amountCents) {
				error = 'Es ist mehr zugeordnet als der Buchungsbetrag.';
				return;
			}
		}
		const parsed = transaction
			? transactionInput.safeParse(base)
			: transactionCreateInput.safeParse({
					...base,
					allocations: canMatch && direction === 'income' ? allocations : [],
					payableId: canMatch && direction === 'expense' ? payableId : null,
					notify
				});
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			error = 'Bitte die markierten Felder prüfen.';
			await tick();
			document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
			return;
		}
		busy = true;
		try {
			const response = await apiFetch<Transaction | TransactionCreated>(
				transaction ? `${BASE}/transactions/${transaction.id}` : `${BASE}/transactions`,
				{ method: transaction ? 'PUT' : 'POST', body: JSON.stringify(parsed.data) }
			);
			let saved: Transaction = response;
			const created = 'allocation' in response ? response : null;
			try {
				if (transaction?.receipt && removeReceipt && !file) {
					await apiFetch(`${BASE}/transactions/${saved.id}/receipt`, { method: 'DELETE' });
				}
				if (file) {
					const fd = new FormData();
					fd.append('file', file);
					await apiFetch(`${BASE}/transactions/${saved.id}/receipt`, { method: 'POST', body: fd });
				}
				if (file || removeReceipt) {
					saved = await apiFetch<Transaction>(`${BASE}/transactions/${saved.id}`);
				}
			} catch (err) {
				toast.error(
					`Beleg nicht gespeichert: ${err instanceof ApiClientError ? err.message : 'Fehler'}`
				);
			}
			toast.success(transaction ? 'Buchung gespeichert' : createdMessage(created));
			if (created?.allocation?.mailErrors) {
				toast.error(`${created.allocation.mailErrors} Mail(s) konnten nicht gesendet werden`);
			}
			if (canMatch && keepOpen) {
				savedCount++;
				await resetForNext();
			} else {
				open = false;
			}
			await onsaved(saved);
		} catch (err) {
			if (err instanceof ApiClientError) {
				error = err.message;
				errors = fieldErrorsFrom(err.details);
			} else error = 'Speichern fehlgeschlagen';
		} finally {
			busy = false;
		}
	}

	const receiptHref = $derived(
		transaction?.receipt ? `/api/v1${BASE}/transactions/${transaction.id}/receipt` : null
	);
	const locked = $derived(!!transaction?.transferId);
	/** Direkt zuordnen nur beim Anlegen; bestehende Buchungen über „Zuordnen“ in der Liste */
	const canMatch = $derived(!transaction);

	function createdMessage(c: TransactionCreated | null): string {
		const parts = ['Buchung angelegt'];
		const a = c?.allocation;
		if (a?.allocatedCents) parts.push(`${formatEuro(a.allocatedCents)} zugeordnet`);
		if (a?.paidInvoices) parts.push(`${a.paidInvoices} Rechnung(en) bezahlt`);
		if (a?.mailsSent) parts.push(`${a.mailsSent} Bestätigung(en) gesendet`);
		if (a?.payer) {
			parts.push(
				a.payer.created ? `Zahler „${a.payer.name}“ angelegt` : `Zahler „${a.payer.name}“ ergänzt`
			);
		}
		if (c?.payableLinked) parts.push('Auszahlung als bezahlt verbucht');
		return parts.join(' · ');
	}

	const selectedPayer = $derived(payers.find((p) => p.id === payerId) ?? null);
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class={canMatch
			? 'max-h-[94vh] overflow-y-auto sm:max-w-[min(72rem,calc(100vw-2rem))]'
			: 'max-h-[90vh] overflow-y-auto sm:max-w-xl'}
	>
		<Dialog.Header>
			<Dialog.Title>{transaction ? 'Buchung bearbeiten' : 'Neue Buchung'}</Dialog.Title>
			<Dialog.Description>
				{locked
					? 'Umbuchungen lassen sich nicht ändern – bitte löschen und neu anlegen.'
					: canMatch
						? 'Links die Buchung, rechts die Zuordnung zu offenen Posten. Pflichtfelder sind mit * markiert.'
						: 'Pflichtfelder sind mit * markiert.'}
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<div
				class={canMatch ? 'grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]' : 'grid gap-4'}
			>
				<div class="space-y-4">
					<div class="grid gap-4 sm:grid-cols-2">
						<FormField label="Art *" id="tx-direction">
							<SelectField
								id="tx-direction"
								label="Art"
								options={directionOptions}
								bind:value={direction}
								onchange={onDirection}
								disabled={locked}
							/>
						</FormField>
						<FormField label="Konto *" id="tx-account" error={errors.accountId}>
							<SelectField
								id="tx-account"
								label="Konto"
								options={accountOptions}
								bind:value={accountId}
								invalid={!!errors.accountId}
								disabled={locked}
							/>
						</FormField>
						<FormField label="Betrag *" id="tx-amount" error={errors.amountCents}>
							<MoneyInput
								id="tx-amount"
								label="Betrag"
								bind:cents={amountCents}
								invalid={!!errors.amountCents}
								disabled={locked}
							/>
						</FormField>
						<FormField label="Datum *" id="tx-date" error={errors.bookedOn}>
							<Input
								id="tx-date"
								type="date"
								bind:value={bookedOn}
								aria-invalid={!!errors.bookedOn}
								disabled={locked}
							/>
						</FormField>
					</div>
					<FormField
						label={direction === 'expense' ? 'Empfänger*in' : 'Zahler*in'}
						id="tx-counterparty"
						error={errors.counterparty}
					>
						<PayerCombobox
							id="tx-counterparty"
							bind:value={counterparty}
							bind:payerId
							{payers}
							active={direction === 'income'}
							disabled={locked}
							onpick={() => (counterpartyIban = '')}
						/>
					</FormField>
					<FormField
						label={direction === 'income' ? 'IBAN der Zahler*in' : 'IBAN der Empfänger*in'}
						id="tx-iban"
						error={errors.counterpartyIban}
						hint={direction === 'income' && selectedPayer
							? `Zahler: ${selectedPayer.name}${selectedPayer.ibanMasked ? ` (${selectedPayer.ibanMasked} wird übernommen)` : ''}`
							: transaction?.counterpartyIbanLast4
								? `Hinterlegt: •••• ${transaction.counterpartyIbanLast4} – leer lassen für unverändert`
								: 'Optional – hilft beim Zuordnen und für Rückzahlungen.'}
					>
						<Input
							id="tx-iban"
							bind:value={counterpartyIban}
							autocomplete="off"
							placeholder="DE00 0000 0000 0000 0000 00"
							disabled={locked}
							aria-invalid={!!errors.counterpartyIban}
						/>
					</FormField>
					<FormField label="Verwendungszweck" id="tx-purpose" error={errors.purpose}>
						<Input id="tx-purpose" bind:value={purpose} maxlength={300} disabled={locked} />
					</FormField>
					<div class="grid gap-4 sm:grid-cols-2">
						<FormField label="Kategorie" id="tx-category" error={errors.categoryId}>
							<SelectField
								id="tx-category"
								label="Kategorie"
								options={categoryOptions}
								bind:value={categoryId}
								emptyLabel="Keine Kategorie"
							/>
						</FormField>
						<FormField label="Aktion" id="tx-action" error={errors.actionId}>
							<SelectField
								id="tx-action"
								label="Aktion"
								options={actionOptions}
								bind:value={actionId}
								emptyLabel="Keine Aktion"
							/>
						</FormField>
					</div>
					<FormField label="Notiz" id="tx-note" error={errors.note}>
						<Textarea id="tx-note" bind:value={note} maxlength={1000} rows={2} />
					</FormField>
					{#if canUploadReceipt}
						<div class="grid gap-1.5">
							<span class="text-sm font-medium">Beleg</span>
							<FileField
								id="tx-receipt"
								bind:file
								accept={RECEIPT_CONTENT_TYPES.join(',')}
								maxBytes={MAX_RECEIPT_BYTES}
								existingName={transaction?.receipt && !removeReceipt
									? transaction.receipt.name
									: null}
								existingHref={receiptHref}
								canRemove
								onremove={() => (removeReceipt = true)}
								disabled={busy}
							/>
							<p class="text-xs text-muted-foreground">PDF oder Bild, maximal 10 MB.</p>
						</div>
					{/if}
				</div>
				{#if canMatch}
					{#key `${direction}-${formKey}`}
						<BookingMatchSection
							direction={direction === 'expense' ? 'expense' : 'income'}
							{amountCents}
							{counterparty}
							{purpose}
							iban={counterpartyIban}
							{payerId}
							bind:amounts={matchAmounts}
							bind:payableId
							bind:notify
						/>
					{/key}
				{/if}
			</div>
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer class="items-center gap-3 sm:justify-between">
				{#if canMatch}
					<div class="flex items-center gap-2">
						<Checkbox
							id="tx-keep-open"
							checked={keepOpen}
							onCheckedChange={(v) => (keepOpen = v === true)}
						/>
						<Label for="tx-keep-open" class="font-normal">Weitere Buchung erfassen</Label>
					</div>
				{:else}
					<span></span>
				{/if}
				<div class="flex gap-2">
					<Button type="button" variant="outline" onclick={() => (open = false)}>
						{keepOpen && savedCount ? 'Fertig' : 'Abbrechen'}
					</Button>
					<Button type="submit" disabled={busy}>
						{busy ? 'Speichert …' : canMatch && keepOpen ? 'Speichern & weiter' : 'Speichern'}
					</Button>
				</div>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
