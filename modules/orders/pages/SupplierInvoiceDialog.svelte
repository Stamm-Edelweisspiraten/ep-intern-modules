<script lang="ts">
	// Lieferantenrechnung an die Kasse übergeben (legt dort eine Auszahlung an bzw. aktualisiert sie).
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { ConfirmDialog, FileField, FormField, MoneyInput } from '$lib/components/layout';
	import {
		MAX_NOTE,
		MAX_PRICE_CENTS,
		MAX_RECEIPT_BYTES,
		RECEIPT_ACCEPT,
		supplierInvoiceInput,
		type SupplierOrder
	} from '../schemas';
	import { API, fieldErrorsFrom, issuesToErrors } from './admin-helpers';
	import PaymentBadge from './PaymentBadge.svelte';

	let {
		open = $bindable(false),
		order = null,
		treasuryActive = true,
		onsaved
	}: {
		open?: boolean;
		order?: SupplierOrder | null;
		/** Kasse aktiv? Sonst Hinweis (Server antwortet dann mit Fehler) */
		treasuryActive?: boolean;
		onsaved?: () => void | Promise<void>;
	} = $props();

	let amountCents = $state(0);
	let recipientName = $state('');
	let iban = $state('');
	let bic = $state('');
	let dueOn = $state('');
	let note = $state('');
	let file = $state<File | null>(null);
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});
	let confirmRemove = $state(false);

	const invoice = $derived(order?.invoice ?? null);
	const paid = $derived(
		!!invoice?.payment && (invoice.payment.status === 'paid' || invoice.payment.paidCents > 0)
	);

	let initFor: string | null = null;
	$effect(() => {
		if (!open) {
			initFor = null;
			return;
		}
		const o = order;
		if (!o || initFor === o.id) return;
		initFor = o.id;
		amountCents = o.invoice?.amountCents ?? o.estimatedCents;
		recipientName = o.invoice?.recipientName ?? o.supplier;
		iban = '';
		bic = '';
		dueOn = '';
		note = '';
		file = null;
		error = '';
		errors = {};
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!order) return;
		const parsed = supplierInvoiceInput.safeParse({
			amountCents,
			recipientName,
			// leer = unverändert (bzw. bei neuer Rechnung keine IBAN)
			iban: iban.trim() ? iban.replace(/\s+/g, '') : undefined,
			bic,
			dueOn: dueOn || null,
			note
		});
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			return;
		}
		const d = parsed.data;
		const fd = new FormData();
		fd.append('amountCents', String(d.amountCents));
		fd.append('recipientName', d.recipientName);
		if (d.iban !== undefined) fd.append('iban', d.iban);
		if (d.bic) fd.append('bic', d.bic);
		if (d.dueOn) fd.append('dueOn', d.dueOn);
		if (d.note) fd.append('note', d.note);
		if (file) fd.append('file', file);
		busy = true;
		error = '';
		errors = {};
		try {
			await apiFetch(`${API}/supplier-orders/${order.id}/invoice`, { method: 'PUT', body: fd });
			toast.success(invoice ? 'Rechnung aktualisiert' : 'Rechnung an die Kasse übergeben');
			open = false;
			await onsaved?.();
		} catch (err) {
			if (err instanceof ApiClientError) {
				error = err.message;
				errors = fieldErrorsFrom(err.details);
			} else error = 'Speichern fehlgeschlagen';
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!order) return;
		busy = true;
		error = '';
		try {
			await apiFetch(`${API}/supplier-orders/${order.id}/invoice`, { method: 'DELETE' });
			toast.success('Rechnung entfernt');
			open = false;
			await onsaved?.();
		} catch (err) {
			if (err instanceof ApiClientError && err.status === 409)
				error = `${err.message || 'Die Rechnung ist bereits (teilweise) bezahlt.'} Entfernen ist nicht mehr möglich – wende dich an die Kasse.`;
			else error = err instanceof ApiClientError ? err.message : 'Entfernen fehlgeschlagen';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>
				{invoice ? 'Lieferantenrechnung bearbeiten' : 'Rechnung an die Kasse'}{order
					? ` – ${order.number}`
					: ''}
			</Dialog.Title>
			<Dialog.Description>
				Die Kasse überweist den Betrag; der Bezahlstatus erscheint hier.
			</Dialog.Description>
		</Dialog.Header>
		{#if !treasuryActive}
			<p
				class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
			>
				Das Modul Kasse ist nicht aktiv – die Rechnung kann erst übergeben werden, wenn die Kasse
				aktiviert ist.
			</p>
		{/if}
		{#if invoice}
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<span class="text-muted-foreground">Status in der Kasse:</span>
				{#if invoice.inTreasury}
					<PaymentBadge payment={invoice.payment} pending={!invoice.payment} />
				{:else}
					<span class="text-muted-foreground">noch nicht an die Kasse übergeben</span>
				{/if}
			</div>
		{/if}
		<form class="space-y-4" onsubmit={submit} novalidate>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Betrag *" id="si-amount" error={errors.amountCents}>
					<MoneyInput
						id="si-amount"
						label="Rechnungsbetrag"
						max={MAX_PRICE_CENTS}
						bind:cents={amountCents}
						invalid={!!errors.amountCents}
						disabled={busy}
					/>
				</FormField>
				<FormField label="Empfänger*in *" id="si-name" error={errors.recipientName}>
					<Input
						id="si-name"
						bind:value={recipientName}
						maxlength={150}
						aria-invalid={!!errors.recipientName}
						disabled={busy}
					/>
				</FormField>
				<FormField
					label="IBAN"
					id="si-iban"
					error={errors.iban}
					hint={invoice ? 'Leer lassen für unverändert' : undefined}
				>
					<Input
						id="si-iban"
						bind:value={iban}
						autocomplete="off"
						maxlength={42}
						aria-invalid={!!errors.iban}
						disabled={busy}
					/>
				</FormField>
				<FormField label="BIC" id="si-bic" error={errors.bic}>
					<Input
						id="si-bic"
						bind:value={bic}
						maxlength={11}
						autocomplete="off"
						aria-invalid={!!errors.bic}
						disabled={busy}
					/>
				</FormField>
				<FormField label="Fällig am" id="si-due" error={errors.dueOn}>
					<Input
						id="si-due"
						type="date"
						bind:value={dueOn}
						aria-invalid={!!errors.dueOn}
						disabled={busy}
					/>
				</FormField>
			</div>
			<FormField label="Notiz" id="si-note" error={errors.note}>
				<Textarea
					id="si-note"
					bind:value={note}
					rows={2}
					maxlength={MAX_NOTE}
					placeholder="z. B. Rechnungsnummer des Lieferanten"
					disabled={busy}
				/>
			</FormField>
			<div class="grid gap-1.5">
				<span class="text-sm font-medium">Rechnung / Beleg</span>
				<FileField
					id="si-file"
					bind:file
					accept={RECEIPT_ACCEPT}
					maxBytes={MAX_RECEIPT_BYTES}
					disabled={busy}
					error={errors.file ?? null}
				/>
				<p class="text-xs text-muted-foreground">PDF oder Bild, höchstens 10 MB.</p>
			</div>
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer class="gap-2 sm:justify-between">
				{#if invoice}
					<Button
						type="button"
						variant="destructive"
						disabled={busy || paid}
						title={paid ? 'Bereits (teilweise) bezahlt' : undefined}
						onclick={() => (confirmRemove = true)}
					>
						<Trash2 /> Rechnung entfernen
					</Button>
				{:else}
					<span></span>
				{/if}
				<div class="flex flex-col-reverse gap-2 sm:flex-row">
					<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
					<Button type="submit" disabled={busy}>
						{busy ? 'Speichert …' : invoice ? 'Speichern' : 'An die Kasse übergeben'}
					</Button>
				</div>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmRemove}
	title="Rechnung entfernen?"
	description="Die Auszahlung wird aus der Kasse entfernt. Bereits bezahlte Rechnungen lassen sich nicht entfernen."
	confirmLabel="Entfernen"
	destructive
	onconfirm={remove}
/>
