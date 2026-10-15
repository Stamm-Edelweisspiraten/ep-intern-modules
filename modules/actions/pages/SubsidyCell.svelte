<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { SelectField } from '$lib/components/ui/select-field';
	import type { Participant } from '../schemas';
	import type { SubsidyFields } from './auto-types';

	let {
		participant,
		actionId,
		canEdit,
		onchanged
	}: {
		participant: Participant & SubsidyFields;
		actionId: string;
		canEdit: boolean;
		onchanged: () => void | Promise<void>;
	} = $props();

	const toValue = (v: boolean | null | undefined) =>
		v === true ? 'yes' : v === false ? 'no' : 'auto';

	/** Optimistischer Wert, bis der Server geantwortet hat */
	let pending = $state<string | null>(null);
	let busy = $state(false);

	const current = $derived(pending ?? toValue(participant.subsidyEligible));
	const effective = $derived(
		pending === 'yes'
			? true
			: pending === 'no'
				? false
				: (participant.subsidyEffective ?? participant.subsidyEligible === true)
	);

	const options = $derived([
		{ value: 'auto', label: `Automatisch (${effective ? 'ja' : 'nein'})` },
		{ value: 'yes', label: 'Ja' },
		{ value: 'no', label: 'Nein' }
	]);

	async function change(v: string | null) {
		const next = v ?? 'auto';
		if (busy || next === toValue(participant.subsidyEligible)) return;
		pending = next;
		busy = true;
		try {
			await apiFetch(`/modules/actions/actions/${actionId}/participants/${participant.id}`, {
				method: 'PUT',
				body: JSON.stringify({
					name: participant.name,
					groupLabel: participant.groupLabel,
					birthDate: participant.birthDate,
					bremenResident: participant.bremenResident,
					role: participant.role,
					juleica: participant.juleica,
					diet: participant.diet,
					allergies: participant.allergies,
					notes: participant.notes,
					subsidyEligible: next === 'yes' ? true : next === 'no' ? false : null
				})
			});
			await onchanged();
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Speichern fehlgeschlagen');
		} finally {
			pending = null;
			busy = false;
		}
	}
</script>

{#if canEdit}
	<SelectField
		size="sm"
		class="min-w-40"
		label={`Zuschuss für ${participant.name}`}
		{options}
		value={current}
		onchange={change}
		disabled={busy}
	/>
{:else}
	<Badge variant={effective ? 'secondary' : 'outline'}>
		{effective ? 'berechtigt' : 'nicht berechtigt'}
	</Badge>
{/if}
