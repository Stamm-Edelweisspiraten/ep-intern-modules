<script lang="ts">
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { FormField, BUSY_SAVE, BUSY_LOAD } from '$lib/components/layout';
	import { payeeInput, payeeUpdateInput, type AccountingPayee } from '../schemas';

	let {
		open = $bindable(false),
		actionId,
		payee = null,
		onsaved
	}: {
		open?: boolean;
		actionId: string;
		payee?: AccountingPayee | null;
		onsaved: (payee: AccountingPayee) => void | Promise<void>;
	} = $props();

	let name = $state('');
	let iban = $state('');
	let bic = $state('');
	let note = $state('');
	let busy = $state(false);
	let loadingIban = $state(false);
	let error = $state('');
	let fieldErrors = $state<Record<string, string>>({});

	const base = $derived(`/modules/actions/actions/${actionId}/accounting/payees`);

	$effect(() => {
		if (!open) return;
		const p = payee;
		name = p?.name ?? '';
		iban = '';
		bic = p?.bic ?? '';
		note = p?.note ?? '';
		error = '';
		fieldErrors = {};
		busy = false;
		if (p && p.ibanMasked !== null) {
			loadingIban = true;
			apiFetch<{ iban: string }>(`${base}/${p.id}/iban`)
				.then((r) => {
					if (open && payee?.id === p.id) iban = r.iban;
				})
				.catch(() => {
					error = 'IBAN konnte nicht geladen werden. Leer lassen, um sie unverändert zu lassen.';
				})
				.finally(() => (loadingIban = false));
		}
	});

	const ids: Record<string, string> = {
		name: 'payee-name',
		iban: 'payee-iban',
		bic: 'payee-bic',
		note: 'payee-note'
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
		const raw = {
			name,
			iban: iban.trim() === '' && payee ? undefined : iban,
			bic: bic || null,
			note: note || null
		};
		const parsed = (payee ? payeeUpdateInput : payeeInput).safeParse(raw);
		if (!parsed.success) {
			const errs: Record<string, string> = {};
			for (const i of parsed.error.issues) {
				const key = String(i.path[0] ?? '');
				if (key && !errs[key]) errs[key] = i.message;
			}
			fieldErrors = errs;
			error = 'Bitte die markierten Felder prüfen.';
			void focusFirstError();
			return;
		}
		busy = true;
		try {
			const saved = await apiFetch<AccountingPayee>(payee ? `${base}/${payee.id}` : base, {
				method: payee ? 'PUT' : 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success(payee ? 'Bankdaten gespeichert' : 'Person hinzugefügt');
			open = false;
			await onsaved(saved);
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
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{payee ? 'Bankdaten bearbeiten' : 'Neue Person'}</Dialog.Title>
			<Dialog.Description>
				Für die Erstattung von Auslagen. Pflichtfelder sind mit * markiert.
			</Dialog.Description>
		</Dialog.Header>

		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField label="Name *" id="payee-name" error={fieldErrors.name}>
				<Input
					id="payee-name"
					bind:value={name}
					required
					maxlength={100}
					aria-invalid={!!fieldErrors.name}
					aria-describedby={fieldErrors.name ? 'payee-name-error' : undefined}
				/>
			</FormField>
			<FormField
				label={payee ? 'IBAN' : 'IBAN *'}
				id="payee-iban"
				error={fieldErrors.iban}
				hint={loadingIban ? BUSY_LOAD : undefined}
			>
				<Input
					id="payee-iban"
					bind:value={iban}
					autocomplete="off"
					maxlength={50}
					disabled={loadingIban}
					placeholder="DE00 0000 0000 0000 0000 00"
					aria-invalid={!!fieldErrors.iban}
					aria-describedby={fieldErrors.iban ? 'payee-iban-error' : undefined}
				/>
			</FormField>
			<FormField label="BIC" id="payee-bic" error={fieldErrors.bic}>
				<Input
					id="payee-bic"
					bind:value={bic}
					autocomplete="off"
					maxlength={11}
					aria-invalid={!!fieldErrors.bic}
					aria-describedby={fieldErrors.bic ? 'payee-bic-error' : undefined}
				/>
			</FormField>
			<FormField label="Notiz" id="payee-note" error={fieldErrors.note}>
				<Input
					id="payee-note"
					bind:value={note}
					maxlength={300}
					aria-invalid={!!fieldErrors.note}
					aria-describedby={fieldErrors.note ? 'payee-note-error' : undefined}
				/>
			</FormField>

			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer sticky>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy || loadingIban}>
					{busy ? BUSY_SAVE : 'Speichern'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
