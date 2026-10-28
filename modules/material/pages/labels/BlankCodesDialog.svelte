<script lang="ts">
	// Dialog „Leere Codes drucken“: Codes vergeben (`POST /codes/reserve`) → Druck mit Ziel `blank`.
	// Die Codes werden später beim Anlegen eines Artikels als „eigener Code“ eingegeben bzw. gescannt.
	import Printer from '@lucide/svelte/icons/printer';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { FormField, NumberStepper } from '$lib/components/layout';
	import { MAX_RESERVE_CODES, type LabelTemplate } from '../../schemas';
	import { API, errorText } from '../helpers';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';

	let {
		open = $bindable(false),
		templates,
		canReserve,
		oncreate
	}: {
		open?: boolean;
		templates: LabelTemplate[];
		/** Codes vergeben (`material.inventory.manage` oder `material.labels.manage`) */
		canReserve: boolean;
		/** „Neues Etikett“ öffnen, wenn es noch kein Etikett für leere Codes gibt */
		oncreate?: () => void;
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
			open = false;
			printOpen = true;
		} catch (e) {
			toast.error(errorText(e, 'Codes konnten nicht vergeben werden'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Leere Codes drucken</Dialog.Title>
			<Dialog.Description>
				Vergibt neue Codes und druckt sie. Beim Erfassen eines Artikels scannst du später einfach
				ein solches Etikett als Code ein.
			</Dialog.Description>
		</Dialog.Header>

		{#if !canReserve}
			<p class="text-sm text-muted-foreground">
				Codes vergeben darf nur, wer den Bestand pflegt oder Etiketten gestaltet.
			</p>
		{:else if !blankTemplates.length}
			<Alert.Root variant="info">
				<Alert.Title>Noch kein Etikett für leere Codes</Alert.Title>
				<Alert.Description>
					Lege zuerst ein Etikett mit dem Ziel „Leere Codes“ an (Startpunkt „Leer-Code“).
				</Alert.Description>
			</Alert.Root>
		{:else}
			<FormField label="Anzahl Codes" id="blank-count" hint={`Höchstens ${MAX_RESERVE_CODES}`}>
				<NumberStepper
					id="blank-count"
					label="Anzahl Codes"
					bind:value={count}
					min={1}
					max={MAX_RESERVE_CODES}
				/>
			</FormField>
			{#if codes.length}
				<p class="text-xs text-muted-foreground">
					Zuletzt vergeben: <span class="tabular-nums">{codes[0]}</span>
					{#if codes.length > 1}bis <span class="tabular-nums">{codes[codes.length - 1]}</span>{/if}
					·
					<button
						type="button"
						class="text-link underline-offset-4 hover:underline"
						onclick={() => {
							open = false;
							printOpen = true;
						}}>erneut drucken</button
					>
				</p>
			{/if}
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			{#if canReserve && !blankTemplates.length && oncreate}
				<Button
					onclick={() => {
						open = false;
						oncreate();
					}}>Neues Etikett</Button
				>
			{:else if canReserve && blankTemplates.length}
				<Button onclick={reserve} disabled={busy}>
					<Printer aria-hidden="true" />
					{busy ? 'Vergibt …' : 'Codes vergeben und drucken'}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<PrintLabelsDialog bind:open={printOpen} target="blank" {codes} />
