<script lang="ts">
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField, MoneyInput } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		MAX_INVOICE_LINES,
		invoiceInput,
		invoicePatchInput,
		type InvoiceDetail,
		type Payer
	} from '../schemas';
	import { BASE, addDaysIso, fieldErrorsFrom, issuesToErrors, todayIso } from './helpers';

	type Ref = { id: string; name: string };
	type DraftLine = {
		key: string;
		description: string;
		amountCents: number;
		memberId: string | null;
		actionId: string | null;
	};

	let {
		open = $bindable(false),
		invoice = null,
		payers,
		members,
		actions,
		onsaved
	}: {
		open?: boolean;
		/** Bearbeiten; bei Rechnungen aus Aktionen/Jahresbeitrag nur Empfänger/Frist/Notiz */
		invoice?: InvoiceDetail | null;
		payers: Payer[];
		members: Ref[];
		actions: Ref[];
		onsaved: (inv: InvoiceDetail) => void | Promise<void>;
	} = $props();

	let payerId = $state<string | null>(null);
	let recipientName = $state('');
	let recipientEmail = $state('');
	let issuedOn = $state(todayIso());
	let dueOn = $state(addDaysIso(todayIso(), 14));
	let note = $state('');
	let remindersPaused = $state(false);
	let lines = $state<DraftLine[]>([]);
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	/** Aus Aktion oder Jahresbeitrag: nur Empfänger/Frist/Notiz änderbar, Posten fest */
	const fixedLines = $derived(invoice?.source === 'action' || invoice?.source === 'annual');
	const newLine = (): DraftLine => ({
		key: crypto.randomUUID(),
		description: '',
		amountCents: 0,
		memberId: null,
		actionId: null
	});

	$effect(() => {
		if (!open) return;
		const i = invoice;
		payerId = i?.payer?.id ?? null;
		recipientName = i?.recipientName ?? '';
		recipientEmail = i?.recipientEmail ?? '';
		issuedOn = i?.issuedOn ?? todayIso();
		dueOn = i?.dueOn ?? addDaysIso(todayIso(), 14);
		note = i?.note ?? '';
		remindersPaused = i?.remindersPaused ?? false;
		lines = i
			? i.lines.map((l) => ({
					key: l.id,
					description: l.description,
					amountCents: l.amountCents,
					memberId: l.member?.id ?? null,
					actionId: l.action?.id ?? null
				}))
			: [newLine()];
		error = '';
		errors = {};
		busy = false;
	});

	const payerOptions = $derived(payers.map((p) => ({ value: p.id, label: p.name })));
	const memberOptions = $derived(members.map((m) => ({ value: m.id, label: m.name })));
	const actionOptions = $derived(actions.map((a) => ({ value: a.id, label: a.name })));
	const total = $derived(lines.reduce((s, l) => s + l.amountCents, 0));

	function onPayer(id: string | null) {
		const p = payers.find((x) => x.id === id);
		if (!p) return;
		if (!recipientName.trim()) recipientName = p.name;
		if (!recipientEmail.trim() && p.email) recipientEmail = p.email;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		errors = {};
		const base = {
			payerId,
			recipientName,
			recipientEmail,
			dueOn,
			note,
			remindersPaused
		};
		const parsed = fixedLines
			? invoicePatchInput.safeParse(base)
			: invoiceInput.safeParse({
					...base,
					issuedOn,
					lines: lines.map(({ description, amountCents, memberId, actionId }) => ({
						description,
						amountCents,
						memberId,
						actionId
					}))
				});
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			error = 'Bitte die markierten Felder prüfen.';
			await tick();
			document.querySelector<HTMLElement>('[role="dialog"] [aria-invalid="true"]')?.focus();
			return;
		}
		busy = true;
		try {
			const saved = await apiFetch<InvoiceDetail>(
				invoice ? `${BASE}/invoices/${invoice.id}` : `${BASE}/invoices`,
				{ method: invoice ? 'PUT' : 'POST', body: JSON.stringify(parsed.data) }
			);
			toast.success(invoice ? 'Rechnung gespeichert' : `Rechnung ${saved.number} angelegt`);
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
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>
				{invoice ? `Rechnung ${invoice.number} bearbeiten` : 'Neue Rechnung'}
			</Dialog.Title>
			<Dialog.Description>
				{invoice?.source === 'action'
					? 'Diese Rechnung stammt aus einer Aktion. Beträge ändern sich über den Beitrag der Aktion oder eine Ermäßigung je Posten.'
					: invoice?.source === 'annual'
						? 'Diese Rechnung stammt aus dem Jahresbeitrag. Beträge ändern sich nur über eine Ermäßigung je Posten.'
						: 'Für Mitgliedsbeiträge, Material, Zuschüsse o. Ä. Pflichtfelder sind mit * markiert.'}
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Zahler (Familie)" id="inv-payer" error={errors.payerId}>
					<SelectField
						id="inv-payer"
						label="Zahler"
						options={payerOptions}
						bind:value={payerId}
						onchange={onPayer}
						emptyLabel="Kein Zahler"
					/>
				</FormField>
				<FormField label="Empfänger*in *" id="inv-name" error={errors.recipientName}>
					<Input
						id="inv-name"
						bind:value={recipientName}
						maxlength={150}
						aria-invalid={!!errors.recipientName}
					/>
				</FormField>
				<FormField
					label="E-Mail"
					id="inv-email"
					error={errors.recipientEmail}
					hint="Zusätzlich zu den Adressen der Mitglieder auf den Posten."
				>
					<Input
						id="inv-email"
						type="email"
						bind:value={recipientEmail}
						aria-invalid={!!errors.recipientEmail}
					/>
				</FormField>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					{#if !fixedLines}
						<FormField label="Datum *" id="inv-issued" error={errors.issuedOn}>
							<Input id="inv-issued" type="date" bind:value={issuedOn} />
						</FormField>
					{/if}
					<FormField label="Fällig am *" id="inv-due" error={errors.dueOn}>
						<Input id="inv-due" type="date" bind:value={dueOn} aria-invalid={!!errors.dueOn} />
					</FormField>
				</div>
			</div>

			{#if !fixedLines}
				<fieldset class="space-y-3">
					<legend class="mb-1 text-sm font-medium">Posten *</legend>
					{#each lines as l, i (l.key)}
						<div class="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_9rem_auto]">
							<Input
								aria-label={`Bezeichnung Posten ${i + 1}`}
								placeholder="z. B. Jahresbeitrag 2026 – Paul"
								bind:value={l.description}
								maxlength={200}
								aria-invalid={!!errors[`lines.${i}.description`]}
							/>
							<MoneyInput
								label={`Betrag Posten ${i + 1}`}
								bind:cents={l.amountCents}
								invalid={!!errors[`lines.${i}.amountCents`]}
							/>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label={`Posten ${i + 1} entfernen`}
								disabled={lines.length === 1}
								onclick={() => (lines = lines.filter((x) => x.key !== l.key))}
							>
								<Trash2 />
							</Button>
							<div class="grid gap-2 sm:col-span-3 sm:grid-cols-2">
								<SelectField
									label={`Mitglied Posten ${i + 1}`}
									options={memberOptions}
									bind:value={l.memberId}
									emptyLabel="Kein Mitglied"
									placeholder="Mitglied (optional)"
									size="sm"
								/>
								<SelectField
									label={`Aktion Posten ${i + 1}`}
									options={actionOptions}
									bind:value={l.actionId}
									emptyLabel="Keine Aktion"
									placeholder="Aktion (optional)"
									size="sm"
								/>
							</div>
							{#if errors[`lines.${i}.description`] || errors[`lines.${i}.amountCents`]}
								<p class="text-xs text-destructive sm:col-span-3" role="alert">
									{errors[`lines.${i}.description`] ?? errors[`lines.${i}.amountCents`]}
								</p>
							{/if}
						</div>
					{/each}
					<div class="flex flex-wrap items-center justify-between gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onclick={() => (lines = [...lines, newLine()])}
							disabled={lines.length >= MAX_INVOICE_LINES}
						>
							<Plus /> Posten hinzufügen
						</Button>
						<span class="text-sm"
							>Summe <strong class="tabular-nums">{formatEuro(total)}</strong></span
						>
					</div>
					{#if errors.lines}<p class="text-xs text-destructive" role="alert">{errors.lines}</p>{/if}
				</fieldset>
			{/if}

			<FormField label="Notiz (erscheint auf der Rechnung)" id="inv-note" error={errors.note}>
				<Textarea id="inv-note" bind:value={note} rows={2} maxlength={1000} />
			</FormField>
			<div class="flex items-center gap-2">
				<Switch id="inv-paused" bind:checked={remindersPaused} />
				<Label for="inv-paused">Keine automatischen Erinnerungen für diese Rechnung</Label>
			</div>
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? 'Speichert …' : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
