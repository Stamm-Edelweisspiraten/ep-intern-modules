<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField, MoneyInput } from '$lib/components/layout';
	import { transferInput, type Account } from '../schemas';
	import { BASE, defaultAccountId, fieldErrorsFrom, issuesToErrors, todayIso } from './helpers';

	let {
		open = $bindable(false),
		accounts,
		onsaved
	}: {
		open?: boolean;
		accounts: Account[];
		onsaved: () => void | Promise<void>;
	} = $props();

	let fromAccountId = $state<string | null>(null);
	let toAccountId = $state<string | null>(null);
	let bookedOn = $state(todayIso());
	let amountCents = $state(0);
	let purpose = $state('');
	let busy = $state(false);
	let formEl = $state<HTMLFormElement | null>(null);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	const active = $derived(accounts.filter((a) => !a.archived));
	const options = $derived(active.map((a) => ({ value: a.id, label: a.name })));

	$effect(() => {
		if (!open) return;
		// Standard: von einem anderen Konto (z. B. Barkasse) auf das Standardkonto
		toAccountId = defaultAccountId(accounts);
		fromAccountId =
			active.find((a) => a.id !== toAccountId && a.kind === 'cash')?.id ??
			active.find((a) => a.id !== toAccountId)?.id ??
			null;
		bookedOn = todayIso();
		amountCents = 0;
		purpose = '';
		error = '';
		errors = {};
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		errors = {};
		error = '';
		const parsed = transferInput.safeParse({
			fromAccountId: fromAccountId ?? undefined,
			toAccountId: toAccountId ?? undefined,
			bookedOn,
			amountCents,
			purpose
		});
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			error = 'Bitte die markierten Felder prüfen.';
			return;
		}
		busy = true;
		try {
			await apiFetch(`${BASE}/transfers`, { method: 'POST', body: JSON.stringify(parsed.data) });
			toast.success('Umbuchung angelegt');
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
	<Dialog.Content
		class="sm:max-w-md"
		onkeydown={(e) => {
			// Strg/Cmd+Enter speichert ebenfalls (Enter allein über das Formular)
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				formEl?.requestSubmit();
			}
		}}
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			document.getElementById('tr-amount')?.focus();
		}}
	>
		<Dialog.Header>
			<Dialog.Title>Umbuchung</Dialog.Title>
			<Dialog.Description>
				z. B. Bargeld aus der Barkasse auf das Girokonto einzahlen. Zählt nicht als Einnahme oder
				Ausgabe.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} bind:this={formEl} novalidate>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<FormField label="Von *" id="tr-from" error={errors.fromAccountId}>
					<SelectField id="tr-from" label="Von Konto" {options} bind:value={fromAccountId} />
				</FormField>
				<FormField label="Nach *" id="tr-to" error={errors.toAccountId}>
					<SelectField
						id="tr-to"
						label="Nach Konto"
						{options}
						bind:value={toAccountId}
						invalid={!!errors.toAccountId}
					/>
				</FormField>
				<FormField label="Betrag *" id="tr-amount" error={errors.amountCents}>
					<MoneyInput
						id="tr-amount"
						label="Betrag"
						bind:cents={amountCents}
						invalid={!!errors.amountCents}
					/>
				</FormField>
				<FormField label="Datum *" id="tr-date" error={errors.bookedOn}>
					<Input id="tr-date" type="date" bind:value={bookedOn} />
				</FormField>
			</div>
			<FormField label="Verwendungszweck" id="tr-purpose">
				<Input id="tr-purpose" bind:value={purpose} maxlength={300} />
			</FormField>
			{#if active.length < 2}
				<p class="text-sm text-muted-foreground">
					Für Umbuchungen braucht es mindestens zwei Konten.
				</p>
			{/if}
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer class="items-center gap-2">
				<span class="mr-auto hidden text-xs text-muted-foreground sm:inline">Enter speichert</span>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy || active.length < 2}>
					{busy ? 'Speichert …' : 'Umbuchen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
