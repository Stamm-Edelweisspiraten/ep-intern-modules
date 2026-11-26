<script lang="ts">
	import { ScrollPills } from '$lib/components/layout';
	import AccountingsTab from './AccountingsTab.svelte';
	import FilterChips from './FilterChips.svelte';
	// Bereich „Ausgänge“: Auszahlungen · Abrechnungen (nur mit Berichtsrecht)
	import type { SharedData } from './helpers';
	import {
		type FamilyRef,
		OUTGOING_VIEW_LABELS,
		OUTGOING_VIEWS,
		type OutgoingView
	} from './navigation';
	import PayablesTab from './PayablesTab.svelte';

	let {
		view,
		onview,
		onchanged,
		onfamily,
		...shared
	}: SharedData & {
		/** aktuelle Unteransicht */
		view: OutgoingView;
		/** Unteransicht wechseln (Seite aktualisiert die URL) */
		onview: (v: OutgoingView) => void;
		onchanged: () => void | Promise<void>;
		/** Familienansicht öffnen */
		onfamily: (ref: FamilyRef) => void;
	} = $props();

	const options = $derived(
		OUTGOING_VIEWS.filter((v) => v !== 'accountings' || shared.perm.report).map((v) => ({
			value: v,
			label: OUTGOING_VIEW_LABELS[v]
		}))
	);
	const current = $derived<OutgoingView>(
		view === 'accountings' && !shared.perm.report ? 'payables' : view
	);
	const tabProps = $derived({ ...shared, onfamily });
</script>

<div class="space-y-4">
	{#if options.length > 1 && shared.layout && shared.layout !== 'desktop'}
		<ScrollPills label="Ansicht der Ausgänge" {options} value={current} onchange={onview} />
	{:else if options.length > 1}
		<FilterChips label="Ansicht der Ausgänge" {options} value={current} onchange={onview} />
	{/if}

	{#if current === 'payables'}
		<PayablesTab {...tabProps} {onchanged} />
	{:else if current === 'accountings'}
		<AccountingsTab {...tabProps} />
	{/if}
</div>
