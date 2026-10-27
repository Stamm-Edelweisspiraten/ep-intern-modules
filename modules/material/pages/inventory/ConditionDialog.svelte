<script lang="ts">
	// Zustand eines Stücks melden/ändern (auch mit Reservierungsrecht, z. B. Schaden melden).
	// Der Aufrufer rendert per `{#key}` neu.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import {
		CONDITIONS,
		CONDITION_LABELS,
		MAX_NOTE,
		conditionInput,
		type Condition
	} from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';

	let {
		open = $bindable(false),
		unitId,
		name,
		condition: initialCondition,
		note: initialNote = '',
		onsaved
	}: {
		open?: boolean;
		unitId: string;
		name: string;
		condition: Condition;
		note?: string;
		onsaved: () => void | Promise<void>;
	} = $props();

	let condition = $state<string | null>(untrack(() => initialCondition));
	let note = $state(untrack(() => initialNote));
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	const options = CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }));

	async function save() {
		const data = { condition, note };
		const parsed = conditionInput.safeParse(data);
		if (!parsed.success) {
			errors = fieldErrors(parsed.error.issues);
			return;
		}
		errors = {};
		busy = true;
		try {
			await apiFetch(`${API}/units/${unitId}/condition`, {
				method: 'POST',
				body: JSON.stringify(data)
			});
			toast.success('Zustand gespeichert');
			open = false;
			await onsaved();
		} catch (e) {
			errors = apiFieldErrors(e);
			toast.error(errorText(e, 'Zustand konnte nicht gespeichert werden'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Zustand melden</Dialog.Title>
			<Dialog.Description>{name}</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-4">
			<FormField label="Zustand" id="condition-value" error={errors.condition ?? null} required>
				<SelectField id="condition-value" {options} bind:value={condition} label="Zustand" />
			</FormField>
			<FormField
				label="Was ist los?"
				id="condition-note"
				error={errors.note ?? null}
				hint="z. B. „Riss an der Öse“ – hilft bei der Reparatur."
			>
				<Textarea id="condition-note" bind:value={note} rows={3} maxlength={MAX_NOTE} />
			</FormField>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button onclick={save} disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
