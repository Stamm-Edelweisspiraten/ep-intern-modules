<script lang="ts">
	// Bereich „Eingänge“: Offene Posten · Rechnungen · Familien · Jahresbeitrag
	import type { SharedData } from './helpers';
	import FilterChips from './FilterChips.svelte';
	import AnnualFeeTab from './AnnualFeeTab.svelte';
	import InvoicesTab from './InvoicesTab.svelte';
	import OpenItemsTab from './OpenItemsTab.svelte';
	import PayersTab from './PayersTab.svelte';
	import { INCOME_VIEWS, INCOME_VIEW_LABELS, type FamilyRef, type IncomeView } from './navigation';

	let {
		view,
		annualView,
		annualManage,
		onview,
		onopen,
		oncreateinvoice,
		onchanged,
		onfamily,
		...shared
	}: SharedData & {
		/** aktuelle Unteransicht */
		view: IncomeView;
		/** `treasury.annual-fee.view` */
		annualView: boolean;
		/** `treasury.annual-fee.manage` */
		annualManage: boolean;
		/** Unteransicht wechseln (Seite aktualisiert die URL) */
		onview: (v: IncomeView) => void;
		/** Anderen (alten) Tab der Kasse öffnen, z. B. aus dem Jahresbeitrag */
		onopen: (tab: string) => void;
		oncreateinvoice: () => void;
		onchanged: () => void | Promise<void>;
		/** Familienansicht öffnen */
		onfamily: (ref: FamilyRef) => void;
	} = $props();

	const options = $derived(
		INCOME_VIEWS.filter((v) => v !== 'annual' || annualView).map((v) => ({
			value: v,
			label: INCOME_VIEW_LABELS[v]
		}))
	);
	// ohne Recht auf den Jahresbeitrag zurück auf „Offene Posten“
	const current = $derived<IncomeView>(view === 'annual' && !annualView ? 'open' : view);
	const tabProps = $derived({ ...shared, onfamily });
</script>

<div class="space-y-4">
	<FilterChips label="Ansicht der Eingänge" {options} value={current} onchange={onview} />

	{#if current === 'open'}
		<OpenItemsTab {...tabProps} {onchanged} />
	{:else if current === 'invoices'}
		<InvoicesTab {...tabProps} oncreate={oncreateinvoice} {onchanged} />
	{:else if current === 'families'}
		<PayersTab {...tabProps} {onchanged} />
	{:else if current === 'annual'}
		<AnnualFeeTab {...tabProps} canManage={annualManage} {onopen} {onchanged} />
	{/if}
</div>
