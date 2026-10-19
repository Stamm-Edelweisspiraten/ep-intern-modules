<script lang="ts">
	// Lagerbestand einer Artikel-Größe korrigieren (Inventur, Schwund, Fund).
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, NumberStepper } from '$lib/components/layout';
	import { MAX_NOTE, stockCorrectionInput, type StockRow } from '../schemas';
	import { API, fieldErrorsFrom, fmtDelta, issuesToErrors, itemName } from './admin-helpers';

	let {
		open = $bindable(false),
		row = null,
		onsaved
	}: {
		open?: boolean;
		row?: StockRow | null;
		onsaved?: () => void | Promise<void>;
	} = $props();

	let stock = $state(0);
	let note = $state('');
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	const delta = $derived(row ? stock - row.stock : 0);

	let initFor: string | null = null;
	$effect(() => {
		if (!open) {
			initFor = null;
			return;
		}
		const r = row;
		if (!r || initFor === r.variantId) return;
		initFor = r.variantId;
		stock = r.stock;
		note = '';
		error = '';
		errors = {};
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!row) return;
		const parsed = stockCorrectionInput.safeParse({ variantId: row.variantId, stock, note });
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			return;
		}
		busy = true;
		error = '';
		errors = {};
		try {
			await apiFetch(`${API}/stock/corrections`, {
				method: 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success(`Bestand auf ${parsed.data.stock} gesetzt`);
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
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Bestand korrigieren</Dialog.Title>
			<Dialog.Description>
				{row ? itemName(row.articleTitle, row.variantLabel) : ''} – zum Beispiel nach einer Inventur.
				Die Änderung erscheint in den Lagerbewegungen.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField
				label="Neuer Bestand *"
				id="sc-stock"
				error={errors.stock}
				hint={row
					? `Bisher ${row.stock}${delta !== 0 ? ` · Änderung ${fmtDelta(delta)}` : ''}`
					: undefined}
			>
				<NumberStepper
					id="sc-stock"
					label="Neuer Bestand"
					unit="Stück"
					min={0}
					max={100000}
					bind:value={stock}
					disabled={busy}
					invalid={!!errors.stock}
				/>
			</FormField>
			<FormField label="Notiz" id="sc-note" error={errors.note}>
				<Textarea
					id="sc-note"
					bind:value={note}
					rows={2}
					maxlength={MAX_NOTE}
					placeholder="z. B. Inventur Oktober"
				/>
			</FormField>
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy || !row || delta === 0}>
					{busy ? 'Speichert …' : 'Speichern'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
