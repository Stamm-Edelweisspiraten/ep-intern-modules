<script lang="ts">
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FileField, FormField, MoneyInput } from '$lib/components/layout';
	import {
		MAX_RECEIPT_BYTES,
		RECEIPT_CONTENT_TYPES,
		transactionInput,
		type Account,
		type Category,
		type Transaction
	} from '../schemas';
	import { BASE, defaultAccountId, fieldErrorsFrom, issuesToErrors, todayIso } from './helpers';

	let {
		open = $bindable(false),
		transaction = null,
		accounts,
		categories,
		actions,
		canUploadReceipt,
		onsaved
	}: {
		open?: boolean;
		transaction?: Transaction | null;
		accounts: Account[];
		categories: Category[];
		actions: { id: string; name: string }[];
		canUploadReceipt: boolean;
		onsaved: (t: Transaction) => void | Promise<void>;
	} = $props();

	let direction = $state<string | null>('income');
	let accountId = $state<string | null>(null);
	let bookedOn = $state(todayIso());
	let amountCents = $state(0);
	let counterparty = $state('');
	let purpose = $state('');
	let categoryId = $state<string | null>(null);
	let actionId = $state<string | null>(null);
	let note = $state('');
	let file = $state<File | null>(null);
	let removeReceipt = $state(false);
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	$effect(() => {
		if (!open) return;
		const t = transaction;
		direction = t ? (t.amountCents < 0 ? 'expense' : 'income') : 'income';
		accountId = t?.accountId ?? defaultAccountId(accounts);
		bookedOn = t?.bookedOn ?? todayIso();
		amountCents = t ? Math.abs(t.amountCents) : 0;
		counterparty = t?.counterparty ?? '';
		purpose = t?.purpose ?? '';
		categoryId = t?.category?.id ?? null;
		actionId = t?.action?.id ?? null;
		note = t?.note ?? '';
		file = null;
		removeReceipt = false;
		error = '';
		errors = {};
		busy = false;
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
		const parsed = transactionInput.safeParse({
			accountId: accountId ?? undefined,
			bookedOn,
			amountCents: direction === 'expense' ? -amountCents : amountCents,
			counterparty,
			purpose,
			categoryId,
			actionId,
			note
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
			let saved = await apiFetch<Transaction>(
				transaction ? `${BASE}/transactions/${transaction.id}` : `${BASE}/transactions`,
				{ method: transaction ? 'PUT' : 'POST', body: JSON.stringify(parsed.data) }
			);
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
			toast.success(transaction ? 'Buchung gespeichert' : 'Buchung angelegt');
			open = false;
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
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{transaction ? 'Buchung bearbeiten' : 'Neue Buchung'}</Dialog.Title>
			<Dialog.Description>
				{locked
					? 'Umbuchungen lassen sich nicht ändern – bitte löschen und neu anlegen.'
					: 'Pflichtfelder sind mit * markiert.'}
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
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
				<Input id="tx-counterparty" bind:value={counterparty} maxlength={140} disabled={locked} />
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
						existingName={transaction?.receipt && !removeReceipt ? transaction.receipt.name : null}
						existingHref={receiptHref}
						canRemove
						onremove={() => (removeReceipt = true)}
						disabled={busy}
					/>
					<p class="text-xs text-muted-foreground">PDF oder Bild, maximal 10 MB.</p>
				</div>
			{/if}
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? 'Speichert …' : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
