<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FileField, FormField, MoneyInput, BUSY_SAVE } from '$lib/components/layout';
	import {
		MAX_RECEIPT_BYTES,
		RECEIPT_CONTENT_TYPES,
		payableInput,
		type Payable,
		type Payer
	} from '../schemas';
	import { BASE, fieldErrorsFrom, issuesToErrors } from './helpers';

	let {
		open = $bindable(false),
		payable = null,
		actions,
		payers,
		canUpload,
		onsaved
	}: {
		open?: boolean;
		payable?: Payable | null;
		actions: { id: string; name: string }[];
		payers: Payer[];
		canUpload: boolean;
		onsaved: () => void | Promise<void>;
	} = $props();

	let recipientName = $state('');
	let description = $state('');
	let amountCents = $state(0);
	let dueOn = $state('');
	let iban = $state('');
	let bic = $state('');
	let actionId = $state<string | null>(null);
	let payerId = $state<string | null>(null);
	let note = $state('');
	let file = $state<File | null>(null);
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	const automatic = $derived(!!payable?.automatic);

	$effect(() => {
		if (!open) return;
		const p = payable;
		recipientName = p?.recipientName ?? '';
		description = p?.description ?? '';
		amountCents = p?.amountCents ?? 0;
		dueOn = p?.dueOn ?? '';
		iban = '';
		bic = p?.bic ?? '';
		actionId = p?.action?.id ?? null;
		payerId = p?.payer?.id ?? null;
		note = p?.note ?? '';
		file = null;
		error = '';
		errors = {};
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const parsed = payableInput.safeParse({
			recipientName,
			description,
			amountCents,
			dueOn: dueOn || null,
			// leer beim Bearbeiten = unverändert
			iban: iban.trim() ? iban : payable ? undefined : '',
			bic,
			actionId,
			payerId,
			note
		});
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			return;
		}
		busy = true;
		error = '';
		try {
			const saved = await apiFetch<Payable>(
				payable ? `${BASE}/payables/${payable.id}` : `${BASE}/payables`,
				{ method: payable ? 'PUT' : 'POST', body: JSON.stringify(parsed.data) }
			);
			if (file) {
				const fd = new FormData();
				fd.append('file', file);
				try {
					await apiFetch(`${BASE}/payables/${saved.id}/receipt`, { method: 'POST', body: fd });
				} catch (err) {
					toast.error(
						`Beleg nicht gespeichert: ${err instanceof ApiClientError ? err.message : 'Fehler'}`
					);
				}
			}
			toast.success(payable ? 'Auszahlung gespeichert' : 'Auszahlung angelegt');
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

	const actionOptions = $derived(actions.map((a) => ({ value: a.id, label: a.name })));
	const payerOptions = $derived(payers.map((p) => ({ value: p.id, label: p.name })));
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>
				{payable ? 'Auszahlung bearbeiten' : 'Eingangsrechnung / Auszahlung erfassen'}
			</Dialog.Title>
			<Dialog.Description>
				{automatic
					? 'Automatisch erzeugt – hier lassen sich nur Fälligkeit und Notiz ändern.'
					: 'Zum Beispiel Rechnung des Zeltplatzes oder Busunternehmens. Pflichtfelder sind mit * markiert.'}
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Empfänger*in *" id="pa-name" error={errors.recipientName}>
					<Input
						id="pa-name"
						bind:value={recipientName}
						maxlength={150}
						disabled={automatic}
						aria-invalid={!!errors.recipientName}
					/>
				</FormField>
				<FormField label="Betrag *" id="pa-amount" error={errors.amountCents}>
					<MoneyInput
						id="pa-amount"
						label="Betrag"
						bind:cents={amountCents}
						disabled={automatic}
						invalid={!!errors.amountCents}
					/>
				</FormField>
			</div>
			<FormField label="Verwendungszweck / Beschreibung *" id="pa-desc" error={errors.description}>
				<Input
					id="pa-desc"
					bind:value={description}
					maxlength={200}
					disabled={automatic}
					aria-invalid={!!errors.description}
				/>
			</FormField>
			{#if !automatic}
				<div class="grid gap-4 sm:grid-cols-2">
					<FormField
						label="IBAN"
						id="pa-iban"
						error={errors.iban}
						hint={payable?.ibanMasked
							? `Hinterlegt: ${payable.ibanMasked} – leer lassen für unverändert`
							: undefined}
					>
						<Input id="pa-iban" bind:value={iban} autocomplete="off" aria-invalid={!!errors.iban} />
					</FormField>
					<FormField label="BIC" id="pa-bic" error={errors.bic}>
						<Input id="pa-bic" bind:value={bic} maxlength={11} />
					</FormField>
					<FormField label="Aktion" id="pa-action">
						<SelectField
							id="pa-action"
							label="Aktion"
							options={actionOptions}
							bind:value={actionId}
							emptyLabel="Keine Aktion"
						/>
					</FormField>
					<FormField label="Zahler (bei Rückzahlungen)" id="pa-payer">
						<SelectField
							id="pa-payer"
							label="Zahler"
							options={payerOptions}
							bind:value={payerId}
							emptyLabel="Kein Zahler"
						/>
					</FormField>
				</div>
			{/if}
			<FormField label="Fällig am" id="pa-due" error={errors.dueOn}>
				<Input id="pa-due" type="date" bind:value={dueOn} />
			</FormField>
			<FormField label="Notiz" id="pa-note">
				<Textarea id="pa-note" bind:value={note} rows={2} maxlength={1000} />
			</FormField>
			{#if canUpload && !automatic}
				<div class="grid gap-1.5">
					<span class="text-sm font-medium">Rechnung / Beleg</span>
					<FileField
						id="pa-receipt"
						bind:file
						accept={RECEIPT_CONTENT_TYPES.join(',')}
						maxBytes={MAX_RECEIPT_BYTES}
						existingName={payable?.receipt?.name ?? null}
						existingHref={payable?.receipt ? `/api/v1${BASE}/payables/${payable.id}/receipt` : null}
						disabled={busy}
					/>
				</div>
			{/if}
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer sticky>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
