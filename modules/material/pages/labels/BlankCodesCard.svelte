<script lang="ts">
	// Leer-Etiketten vorab drucken: Codes vergeben (`POST /codes/reserve`) → Druck mit Ziel `blank`.
	// Die Codes werden später beim Anlegen eines Stücks als „eigener Code“ eingegeben bzw. gescannt.
	import Printer from '@lucide/svelte/icons/printer';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { FormField, NumberStepper } from '$lib/components/layout';
	import { MAX_RESERVE_CODES, type LabelTemplate } from '../../schemas';
	import { API, errorText } from '../helpers';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';

	let {
		templates,
		canReserve
	}: {
		templates: LabelTemplate[];
		/** Codes vergeben braucht `material.inventory.manage` */
		canReserve: boolean;
	} = $props();

	let count = $state(24);
	let busy = $state(false);
	let codes = $state<string[]>([]);
	let printOpen = $state(false);

	const blankTemplates = $derived(templates.filter((t) => t.target === 'blank'));

	async function reserve() {
		busy = true;
		try {
			const res = await apiFetch<{ codes: string[] }>(`${API}/codes/reserve`, {
				method: 'POST',
				body: JSON.stringify({ count })
			});
			codes = res.codes;
			toast.success(`${codes.length} Codes vergeben`);
			printOpen = true;
		} catch (e) {
			toast.error(errorText(e, 'Codes konnten nicht vergeben werden'));
		} finally {
			busy = false;
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Leer-Etiketten vorab drucken</Card.Title>
		<Card.Description>
			Vergibt neue Codes und druckt sie. Beim Erfassen eines Stücks scannst du später einfach ein
			solches Etikett als Code ein.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-3">
		{#if !canReserve}
			<p class="text-sm text-muted-foreground">
				Codes vergeben darf nur, wer den Bestand pflegt (Materialwart*in).
			</p>
		{:else if !blankTemplates.length}
			<p class="text-sm text-muted-foreground">
				Lege zuerst ein Layout mit dem Ziel „Leere Codes“ an (Startpunkt „Leer-Code“).
			</p>
		{:else}
			<div class="flex flex-wrap items-end gap-3">
				<FormField label="Anzahl Codes" id="blank-count" hint={`Höchstens ${MAX_RESERVE_CODES}`}>
					<NumberStepper
						id="blank-count"
						label="Anzahl Codes"
						bind:value={count}
						min={1}
						max={MAX_RESERVE_CODES}
					/>
				</FormField>
				<Button onclick={reserve} disabled={busy}>
					<Printer aria-hidden="true" />
					{busy ? 'Vergibt …' : 'Codes vergeben und drucken'}
				</Button>
			</div>
			{#if codes.length}
				<p class="text-xs text-muted-foreground">
					Zuletzt vergeben: <span class="tabular-nums">{codes[0]}</span>
					{#if codes.length > 1}bis <span class="tabular-nums">{codes[codes.length - 1]}</span>{/if}
					·
					<button
						type="button"
						class="text-link underline-offset-4 hover:underline"
						onclick={() => (printOpen = true)}>erneut drucken</button
					>
				</p>
			{/if}
		{/if}
	</Card.Content>
</Card.Root>

<PrintLabelsDialog bind:open={printOpen} target="blank" {codes} />
