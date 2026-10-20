<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField, MoneyInput } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { InvoiceLine } from '../schemas';
	import { BASE, fieldErrorsFrom } from './helpers';

	let {
		open = $bindable(false),
		invoiceId,
		line,
		members,
		onsaved
	}: {
		open?: boolean;
		invoiceId: string;
		line: InvoiceLine | null;
		members: { id: string; name: string }[];
		onsaved: () => void | Promise<void>;
	} = $props();

	let waivedCents = $state(0);
	let reason = $state('');
	let memberId = $state<string | null>(null);
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	$effect(() => {
		if (!open || !line) return;
		waivedCents = line.waivedCents;
		reason = line.waiveReason ?? '';
		memberId = line.member?.id ?? null;
		error = '';
		errors = {};
	});

	const maxWaive = $derived(line ? line.amountCents - line.paidCents : 0);
	const memberOptions = $derived(members.map((m) => ({ value: m.id, label: m.name })));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!line) return;
		busy = true;
		error = '';
		try {
			await apiFetch(`${BASE}/invoices/${invoiceId}/lines/${line.id}`, {
				method: 'PUT',
				body: JSON.stringify({ waivedCents, reason: reason || null, memberId })
			});
			toast.success('Posten gespeichert');
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
			<Dialog.Title>Posten anpassen</Dialog.Title>
			<Dialog.Description>
				{#if line}{line.description} · {formatEuro(line.amountCents)}{/if}
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField
				label="Ermäßigung / Erlass"
				id="ln-waived"
				error={errors.waivedCents}
				hint={`Höchstens ${formatEuro(Math.max(0, maxWaive))} (Betrag abzüglich bereits bezahlt).`}
			>
				<MoneyInput
					id="ln-waived"
					label="Ermäßigung"
					bind:cents={waivedCents}
					max={Math.max(0, maxWaive)}
					invalid={!!errors.waivedCents}
				/>
			</FormField>
			<FormField label="Grund" id="ln-reason" error={errors.reason}>
				<Input
					id="ln-reason"
					bind:value={reason}
					maxlength={200}
					placeholder="z. B. Geschwisterrabatt, Härtefall"
				/>
			</FormField>
			<FormField
				label="Mitglied"
				id="ln-member"
				hint="Bestätigungen und Erinnerungen gehen an alle E-Mail-Adressen des Mitglieds."
			>
				<SelectField
					id="ln-member"
					label="Mitglied"
					options={memberOptions}
					bind:value={memberId}
					emptyLabel="Kein Mitglied"
				/>
			</FormField>
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? 'Speichert …' : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
