<script lang="ts">
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FileField, FormField, MoneyInput } from '$lib/components/layout';
	import {
		ACCOUNTING_CATEGORY_LABELS,
		CALC_CATEGORIES,
		ENTRY_TYPES,
		ENTRY_TYPE_LABELS,
		INCOME_CATEGORIES,
		MAX_PURPOSE_LENGTH,
		MAX_RECEIPT_BYTES,
		PAID_BY,
		PAID_BY_LABELS,
		RECEIPT_CONTENT_TYPES,
		entryInput,
		type AccountingCategory,
		type AccountingEntry,
		type AccountingPayee
	} from '../schemas';
	import PayeeDialog from './PayeeDialog.svelte';

	let {
		open = $bindable(false),
		actionId,
		entry = null,
		payees,
		canViewPayouts,
		viaTreasury = false,
		onsaved
	}: {
		open?: boolean;
		actionId: string;
		entry?: AccountingEntry | null;
		/** Auswahl der Personen (aus Empfängern bzw. vorhandenen Buchungen) */
		payees: { id: string; name: string }[];
		canViewPayouts: boolean;
		/** Kasse aktiv: offene Stamm-Ausgaben werden dort überwiesen */
		viaTreasury?: boolean;
		onsaved: () => void | Promise<void>;
	} = $props();

	const today = () => new Date().toISOString().slice(0, 10);
	const base = $derived(`/modules/actions/actions/${actionId}/accounting`);

	let type = $state<string | null>('expense');
	let category = $state<string | null>(null);
	let description = $state('');
	let amountCents = $state(0);
	let entryDate = $state(today());
	let paidBy = $state<string | null>('club');
	let payeeId = $state<string | null>(null);
	let clubPaid = $state(false);
	let recipientName = $state('');
	let iban = $state('');
	let bic = $state('');
	let purpose = $state('');
	let file = $state<File | null>(null);
	let removeReceipt = $state(false);
	let busy = $state(false);
	let error = $state('');
	let fieldErrors = $state<Record<string, string>>({});
	let payeeOpen = $state(false);
	let extraPayees = $state<{ id: string; name: string }[]>([]);

	$effect(() => {
		if (!open) return;
		const e = entry;
		type = e?.type ?? 'expense';
		category = e?.category ?? null;
		description = e?.description ?? '';
		amountCents = e?.amountCents ?? 0;
		entryDate = e?.entryDate ?? today();
		paidBy = e?.paidBy ?? 'club';
		payeeId = e?.payee?.id ?? null;
		// Neue Stamm-Ausgaben sind offen, bis sie überwiesen sind
		clubPaid = e ? e.clubPaidAt !== null : false;
		recipientName = e?.recipient?.name ?? '';
		iban = '';
		bic = e?.recipient?.bic ?? '';
		purpose = e?.purpose ?? '';
		file = null;
		removeReceipt = false;
		error = '';
		fieldErrors = {};
		busy = false;
		extraPayees = [];
	});

	const typeOptions = ENTRY_TYPES.map((t) => ({ value: t as string, label: ENTRY_TYPE_LABELS[t] }));
	const paidByOptions = PAID_BY.map((p) => ({ value: p as string, label: PAID_BY_LABELS[p] }));
	const categoryOptions = $derived(
		(type === 'income' ? [...INCOME_CATEGORIES] : [...CALC_CATEGORIES])
			.filter((c) => (c as string) !== 'refund')
			.map((c) => ({
				value: c as string,
				label: ACCOUNTING_CATEGORY_LABELS[c as AccountingCategory]
			}))
	);
	const payeeOptions = $derived(
		[...payees, ...extraPayees.filter((x) => !payees.some((p) => p.id === x.id))].map((p) => ({
			value: p.id,
			label: p.name
		}))
	);
	const isExpense = $derived(type === 'expense');
	const isClubExpense = $derived(isExpense && paidBy === 'club');
	/** Von der Kasse überwiesen: nur Ansicht */
	const locked = $derived(entry?.clubPaidVia === 'treasury');
	const savedIban = $derived(entry?.recipient?.ibanMasked ?? null);

	function onTypeChange() {
		if (category && !categoryOptions.some((o) => o.value === category)) category = null;
		if (type === 'income') {
			paidBy = 'club';
			payeeId = null;
		}
	}

	const ids: Record<string, string> = {
		type: 'acc-type',
		category: 'acc-category',
		description: 'acc-description',
		amountCents: 'acc-amount',
		entryDate: 'acc-date',
		paidBy: 'acc-paidby',
		payeeId: 'acc-payee',
		recipientName: 'acc-recipient',
		iban: 'acc-iban',
		bic: 'acc-bic',
		purpose: 'acc-purpose'
	};

	async function focusFirstError() {
		await tick();
		for (const [k, id] of Object.entries(ids)) {
			if (!fieldErrors[k]) continue;
			document.getElementById(id)?.focus();
			return;
		}
	}

	function applyDetails(details: unknown) {
		const out: Record<string, string> = {};
		const issues = (details as { issues?: { path?: (string | number)[]; message?: string }[] })
			?.issues;
		if (Array.isArray(issues)) {
			for (const i of issues) {
				const key = String(i.path?.[0] ?? '');
				if (key && i.message && !out[key]) out[key] = i.message;
			}
		} else if (details && typeof details === 'object') {
			for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
				const msg = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '';
				if (msg) out[k] = msg;
			}
		}
		fieldErrors = out;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		fieldErrors = {};
		const parsed = entryInput.safeParse({
			type: type ?? undefined,
			category: category ?? undefined,
			description,
			amountCents,
			entryDate,
			paidBy: isExpense ? (paidBy ?? 'club') : 'club',
			payeeId: isExpense && paidBy === 'person' ? payeeId : null,
			clubPaid: isClubExpense ? clubPaid : true,
			recipientName: isClubExpense ? recipientName : null,
			iban: isClubExpense && iban.trim() ? iban : null,
			bic: isClubExpense ? bic : null,
			purpose: isClubExpense ? purpose : null
		});
		if (!parsed.success) {
			const errs: Record<string, string> = {};
			for (const i of parsed.error.issues) {
				const key = String(i.path[0] ?? '');
				if (key && !errs[key]) errs[key] = i.message;
			}
			if (!errs.iban && isClubExpense && !clubPaid && !iban.trim() && !savedIban) {
				errs.iban = 'IBAN fehlt';
			}
			fieldErrors = errs;
			error = 'Bitte die markierten Felder prüfen.';
			void focusFirstError();
			return;
		}
		if (isClubExpense && !clubPaid && !iban.trim() && !savedIban) {
			fieldErrors = { iban: 'IBAN fehlt' };
			error = 'Bitte die markierten Felder prüfen.';
			void focusFirstError();
			return;
		}
		busy = true;
		try {
			const saved = await apiFetch<AccountingEntry>(
				entry ? `${base}/entries/${entry.id}` : `${base}/entries`,
				{ method: entry ? 'PUT' : 'POST', body: JSON.stringify(parsed.data) }
			);
			let receiptFailed = '';
			try {
				if (entry && removeReceipt && !file && entry.receipt) {
					await apiFetch(`${base}/entries/${saved.id}/receipt`, { method: 'DELETE' });
				}
				if (file) {
					const fd = new FormData();
					fd.append('file', file);
					await apiFetch(`${base}/entries/${saved.id}/receipt`, { method: 'POST', body: fd });
				}
			} catch (err) {
				receiptFailed =
					err instanceof ApiClientError ? err.message : 'Beleg konnte nicht gespeichert werden';
			}
			toast.success(entry ? 'Buchung gespeichert' : 'Buchung hinzugefügt');
			if (receiptFailed) toast.error(`Beleg nicht gespeichert: ${receiptFailed}`);
			open = false;
			await onsaved();
		} catch (err) {
			if (err instanceof ApiClientError) {
				error = err.message;
				applyDetails(err.details);
				void focusFirstError();
			} else {
				error = 'Speichern fehlgeschlagen';
			}
		} finally {
			busy = false;
		}
	}

	async function payeeCreated(p: AccountingPayee) {
		extraPayees = [...extraPayees, { id: p.id, name: p.name }];
		payeeId = p.id;
		await onsaved();
	}

	const receiptHref = $derived(
		entry?.receipt ? `/api/v1${base}/entries/${entry.id}/receipt` : null
	);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{entry ? 'Buchung bearbeiten' : 'Buchung hinzufügen'}</Dialog.Title>
			<Dialog.Description>Pflichtfelder sind mit * markiert.</Dialog.Description>
		</Dialog.Header>

		<form class="space-y-4" onsubmit={submit} novalidate>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Typ *" id="acc-type" error={fieldErrors.type}>
					<SelectField
						id="acc-type"
						label="Typ"
						options={typeOptions}
						bind:value={type}
						onchange={onTypeChange}
						invalid={!!fieldErrors.type}
					/>
				</FormField>
				<FormField label="Kategorie *" id="acc-category" error={fieldErrors.category}>
					<SelectField
						id="acc-category"
						label="Kategorie"
						options={categoryOptions}
						bind:value={category}
						invalid={!!fieldErrors.category}
					/>
				</FormField>
			</div>
			{#if type === 'income' && (category === 'contributions' || category === 'subsidy')}
				<p
					class="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
					role="note"
				>
					Eine manuelle Buchung ersetzt die automatische Einnahme aus den Anmeldungen.
				</p>
			{/if}
			<FormField label="Beschreibung *" id="acc-description" error={fieldErrors.description}>
				<Input
					id="acc-description"
					bind:value={description}
					required
					maxlength={200}
					aria-invalid={!!fieldErrors.description}
					aria-describedby={fieldErrors.description ? 'acc-description-error' : undefined}
				/>
			</FormField>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Betrag *" id="acc-amount" error={fieldErrors.amountCents}>
					<MoneyInput
						id="acc-amount"
						label="Betrag"
						bind:cents={amountCents}
						invalid={!!fieldErrors.amountCents}
					/>
				</FormField>
				<FormField label="Datum *" id="acc-date" error={fieldErrors.entryDate}>
					<Input
						id="acc-date"
						type="date"
						bind:value={entryDate}
						aria-invalid={!!fieldErrors.entryDate}
						aria-describedby={fieldErrors.entryDate ? 'acc-date-error' : undefined}
					/>
				</FormField>
			</div>

			{#if isExpense}
				<FormField label="Bezahlt von" id="acc-paidby" error={fieldErrors.paidBy}>
					<SelectField
						id="acc-paidby"
						label="Bezahlt von"
						options={paidByOptions}
						bind:value={paidBy}
						invalid={!!fieldErrors.paidBy}
					/>
				</FormField>
				{#if paidBy === 'person'}
					<FormField
						label="Person *"
						id="acc-payee"
						error={fieldErrors.payeeId}
						hint={!canViewPayouts
							? 'Neue Personen anlegen können nur Personen mit Kassen-Berechtigung.'
							: undefined}
					>
						<div class="flex flex-wrap items-center gap-2">
							<div class="min-w-48 flex-1">
								<SelectField
									id="acc-payee"
									label="Person"
									options={payeeOptions}
									bind:value={payeeId}
									placeholder="Person wählen …"
									invalid={!!fieldErrors.payeeId}
								/>
							</div>
							{#if canViewPayouts}
								<Button type="button" variant="outline" onclick={() => (payeeOpen = true)}>
									<UserPlus /> Neue Person
								</Button>
							{/if}
						</div>
					</FormField>
				{/if}
				{#if isClubExpense}
					<div class="flex items-start gap-2">
						<Checkbox
							id="acc-club-paid"
							checked={clubPaid}
							onCheckedChange={(v) => (clubPaid = v === true)}
							disabled={locked}
							class="mt-0.5"
						/>
						<div class="grid gap-0.5">
							<Label for="acc-club-paid">Bereits bezahlt</Label>
							<p class="text-xs text-muted-foreground">
								{viaTreasury
									? 'Ohne Haken bleibt die Ausgabe offen und erscheint in der Kasse als Überweisung.'
									: 'Ohne Haken bleibt die Ausgabe offen, bis sie als bezahlt markiert wird.'}
							</p>
						</div>
					</div>
					{#if locked}
						<p
							class="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
							role="note"
						>
							Von der Kasse überwiesen{entry?.clubPaidAt
								? ` am ${new Date(entry.clubPaidAt).toLocaleDateString('de-DE')}`
								: ''}. Änderungen sind erst möglich, wenn die Zahlung in der Kasse gelöscht wird.
						</p>
					{/if}
					{#if !clubPaid || recipientName || savedIban}
						<fieldset class="grid gap-4 rounded-md border p-3">
							<legend class="px-1 text-sm font-medium">Überweisung an</legend>
							<FormField
								label={clubPaid ? 'Empfänger' : 'Empfänger *'}
								id="acc-recipient"
								error={fieldErrors.recipientName}
							>
								<Input
									id="acc-recipient"
									bind:value={recipientName}
									maxlength={100}
									disabled={locked}
									placeholder="z. B. Jugendherberge Bremen"
									aria-invalid={!!fieldErrors.recipientName}
									aria-describedby={fieldErrors.recipientName ? 'acc-recipient-error' : undefined}
								/>
							</FormField>
							<div class="grid gap-4 sm:grid-cols-[1fr_10rem]">
								<FormField
									label={clubPaid || savedIban ? 'IBAN' : 'IBAN *'}
									id="acc-iban"
									error={fieldErrors.iban}
									hint={savedIban
										? `Gespeichert: ${savedIban} – leer lassen = unverändert`
										: undefined}
								>
									<Input
										id="acc-iban"
										bind:value={iban}
										maxlength={50}
										disabled={locked}
										autocomplete="off"
										placeholder={savedIban ? 'unverändert' : 'DE00 0000 0000 0000 0000 00'}
										aria-invalid={!!fieldErrors.iban}
										aria-describedby={fieldErrors.iban ? 'acc-iban-error' : undefined}
									/>
								</FormField>
								<FormField label="BIC" id="acc-bic" error={fieldErrors.bic}>
									<Input
										id="acc-bic"
										bind:value={bic}
										maxlength={11}
										disabled={locked}
										autocomplete="off"
										aria-invalid={!!fieldErrors.bic}
										aria-describedby={fieldErrors.bic ? 'acc-bic-error' : undefined}
									/>
								</FormField>
							</div>
							<FormField
								label={clubPaid ? 'Verwendungszweck' : 'Verwendungszweck *'}
								id="acc-purpose"
								error={fieldErrors.purpose}
								hint="Steht so auf der Überweisung, z. B. Rechnungsnummer."
							>
								<Input
									id="acc-purpose"
									bind:value={purpose}
									maxlength={MAX_PURPOSE_LENGTH}
									disabled={locked}
									aria-invalid={!!fieldErrors.purpose}
									aria-describedby={fieldErrors.purpose ? 'acc-purpose-error' : undefined}
								/>
							</FormField>
						</fieldset>
					{/if}
				{/if}
			{/if}

			<div class="grid gap-1.5">
				<span class="text-sm font-medium">Beleg</span>
				<FileField
					id="acc-receipt"
					bind:file
					accept={RECEIPT_CONTENT_TYPES.join(',')}
					maxBytes={MAX_RECEIPT_BYTES}
					existingName={entry?.receipt && !removeReceipt ? entry.receipt.name : null}
					existingHref={receiptHref}
					canRemove
					onremove={() => (removeReceipt = true)}
					disabled={busy}
				/>
				<p class="text-xs text-muted-foreground">PDF oder Bild, maximal 10 MB.</p>
			</div>

			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy || locked}>{busy ? 'Speichere …' : 'Speichern'}</Button
				>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<PayeeDialog bind:open={payeeOpen} {actionId} onsaved={payeeCreated} />
