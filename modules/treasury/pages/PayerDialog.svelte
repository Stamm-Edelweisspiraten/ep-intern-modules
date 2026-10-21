<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, BUSY_SAVE } from '$lib/components/layout';
	import { payerInput, type Payer, type PayerFormInput } from '../schemas';
	import { BASE, fieldErrorsFrom, issuesToErrors } from './helpers';

	let {
		open = $bindable(false),
		payer = null,
		preset = null,
		members,
		onsaved
	}: {
		open?: boolean;
		payer?: Payer | null;
		/** Vorbelegung aus einem Vorschlag */
		preset?: PayerFormInput | null;
		members: { id: string; name: string }[];
		onsaved: () => void | Promise<void>;
	} = $props();

	let name = $state('');
	let email = $state('');
	let note = $state('');
	let memberIds = $state<string[]>([]);
	let accountHolder = $state('');
	let iban = $state('');
	let removeIban = $state(false);
	let bic = $state('');
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	$effect(() => {
		if (!open) return;
		name = payer?.name ?? preset?.name ?? '';
		email = payer?.email ?? preset?.email ?? '';
		note = payer?.note ?? preset?.note ?? '';
		memberIds = payer?.members.map((m) => m.id) ?? preset?.memberIds ?? [];
		accountHolder = payer?.accountHolder ?? '';
		iban = '';
		removeIban = false;
		bic = payer?.bic ?? '';
		error = '';
		errors = {};
	});

	const options = $derived(members.map((m) => ({ value: m.id, label: m.name })));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const parsed = payerInput.safeParse({
			name,
			email,
			note,
			memberIds,
			accountHolder,
			// leer = unverändert (Bearbeiten) bzw. keine IBAN (neu)
			iban: removeIban ? '' : iban.trim() ? iban : payer ? undefined : '',
			bic
		});
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			return;
		}
		busy = true;
		error = '';
		try {
			await apiFetch(payer ? `${BASE}/payers/${payer.id}` : `${BASE}/payers`, {
				method: payer ? 'PUT' : 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success(payer ? 'Zahler gespeichert' : 'Zahler angelegt');
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
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{payer ? 'Zahler bearbeiten' : 'Neuer Zahler'}</Dialog.Title>
			<Dialog.Description>
				Ein Zahler fasst Geschwister zusammen: Offene Posten erscheinen gemeinsam, Sammelzahlungen
				werden automatisch erkannt.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField label="Name *" id="py-name" error={errors.name}>
				<Input
					id="py-name"
					bind:value={name}
					maxlength={120}
					placeholder="z. B. Familie Müller"
					aria-invalid={!!errors.name}
				/>
			</FormField>
			<FormField label="Mitglieder" id="py-members" error={errors.memberIds}>
				<MultiSelect
					id="py-members"
					label="Mitglieder"
					{options}
					bind:value={memberIds}
					placeholder="Kinder auswählen …"
				/>
			</FormField>
			<FormField
				label="Zusätzliche E-Mail"
				id="py-email"
				error={errors.email}
				hint="Bestätigungen gehen immer an die Adressen der Mitglieder – hier optional eine weitere."
			>
				<Input id="py-email" type="email" bind:value={email} aria-invalid={!!errors.email} />
			</FormField>
			<fieldset class="grid gap-4 rounded-md border p-3 sm:grid-cols-2">
				<legend class="px-1 text-sm font-medium"
					>Bankverbindung (für Rückzahlungen und Abgleich)</legend
				>
				<FormField label="Kontoinhaber*in" id="py-holder" error={errors.accountHolder}>
					<Input id="py-holder" bind:value={accountHolder} maxlength={100} />
				</FormField>
				<FormField label="BIC" id="py-bic" error={errors.bic}>
					<Input id="py-bic" bind:value={bic} maxlength={11} />
				</FormField>
				<div class="sm:col-span-2">
					<FormField
						label="IBAN"
						id="py-iban"
						error={errors.iban}
						hint={payer?.ibanMasked
							? `Hinterlegt: ${payer.ibanMasked} – leer lassen für unverändert. Zahlungen von dieser IBAN werden der Familie automatisch vorgeschlagen.`
							: 'Zahlungen von dieser IBAN werden der Familie beim Import automatisch vorgeschlagen.'}
					>
						<Input
							id="py-iban"
							bind:value={iban}
							autocomplete="off"
							disabled={removeIban}
							aria-invalid={!!errors.iban}
						/>
					</FormField>
					{#if payer?.ibanMasked}
						<div class="mt-2 flex items-center gap-2 text-sm">
							<Checkbox id="py-remove-iban" bind:checked={removeIban} />
							<Label for="py-remove-iban">IBAN entfernen</Label>
						</div>
					{/if}
				</div>
			</fieldset>
			<FormField label="Notiz" id="py-note">
				<Textarea id="py-note" bind:value={note} rows={2} maxlength={500} />
			</FormField>
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
