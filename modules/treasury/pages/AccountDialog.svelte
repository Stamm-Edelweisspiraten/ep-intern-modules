<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField, MoneyInput, BUSY_SAVE } from '$lib/components/layout';
	import {
		ACCOUNT_KINDS,
		ACCOUNT_KIND_LABELS,
		accountInput,
		type Account,
		type AccountKind
	} from '../schemas';
	import { BASE, fieldErrorsFrom, issuesToErrors } from './helpers';

	let {
		open = $bindable(false),
		account = null,
		onsaved
	}: {
		open?: boolean;
		account?: Account | null;
		onsaved: () => void | Promise<void>;
	} = $props();

	let name = $state('');
	let kind = $state<string | null>('giro');
	let iban = $state('');
	let opening = $state(0);
	let negative = $state(false);
	let openingDate = $state(`${new Date().getFullYear()}-01-01`);
	let archived = $state(false);
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	$effect(() => {
		if (!open) return;
		name = account?.name ?? '';
		kind = account?.kind ?? 'giro';
		iban = account?.iban ?? '';
		opening = Math.abs(account?.openingBalanceCents ?? 0);
		negative = (account?.openingBalanceCents ?? 0) < 0;
		openingDate = account?.openingDate ?? `${new Date().getFullYear()}-01-01`;
		archived = account?.archived ?? false;
		error = '';
		errors = {};
	});

	const kindOptions = ACCOUNT_KINDS.map((k) => ({
		value: k as string,
		label: ACCOUNT_KIND_LABELS[k]
	}));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const parsed = accountInput.safeParse({
			name,
			kind: (kind ?? undefined) as AccountKind | undefined,
			iban,
			openingBalanceCents: negative ? -opening : opening,
			openingDate,
			archived
		});
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			return;
		}
		busy = true;
		error = '';
		try {
			await apiFetch(account ? `${BASE}/accounts/${account.id}` : `${BASE}/accounts`, {
				method: account ? 'PUT' : 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success(account ? 'Konto gespeichert' : 'Konto angelegt');
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
			<Dialog.Title>{account ? 'Konto bearbeiten' : 'Neues Konto'}</Dialog.Title>
			<Dialog.Description>Girokonto, Barkasse oder z. B. ein PayPal-Konto.</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField label="Name *" id="ac-name" error={errors.name}>
				<Input id="ac-name" bind:value={name} maxlength={100} aria-invalid={!!errors.name} />
			</FormField>
			<FormField label="Art *" id="ac-kind" error={errors.kind}>
				<SelectField id="ac-kind" label="Kontoart" options={kindOptions} bind:value={kind} />
			</FormField>
			{#if kind !== 'cash'}
				<FormField label="IBAN" id="ac-iban" error={errors.iban}>
					<Input id="ac-iban" bind:value={iban} maxlength={40} autocomplete="off" />
				</FormField>
			{/if}
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<FormField label="Anfangsbestand" id="ac-opening" error={errors.openingBalanceCents}>
					<MoneyInput id="ac-opening" label="Anfangsbestand" bind:cents={opening} />
				</FormField>
				<FormField label="Stichtag *" id="ac-date" error={errors.openingDate}>
					<Input id="ac-date" type="date" bind:value={openingDate} />
				</FormField>
			</div>
			<div class="flex items-center gap-2">
				<Switch id="ac-negative" bind:checked={negative} />
				<Label for="ac-negative">Anfangsbestand ist negativ (Dispo)</Label>
			</div>
			{#if account}
				<div class="flex items-center gap-2">
					<Switch id="ac-archived" bind:checked={archived} />
					<Label for="ac-archived">Archiviert (keine neuen Buchungen)</Label>
				</div>
			{/if}
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
