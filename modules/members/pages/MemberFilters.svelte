<script lang="ts" module>
	/** Filterzustand der Mitgliederliste (spiegelt die URL-Parameter) */
	export interface MemberFilterState {
		status: 'active' | 'left' | 'all';
		stages: string[];
		/** Gruppen-IDs; `UNGROUPED` steht für „Ohne Gruppe“ */
		groups: string[];
		groupMode: 'any' | 'all';
		ageMin: string;
		ageMax: string;
		consentWebsite: string;
		consentSocialMedia: string;
		consentPrint: string;
		secondary: string;
		hasEmail: string;
		entryFrom: string;
		entryTo: string;
	}

	/** Pseudo-Gruppe im Gruppenfilter */
	export const UNGROUPED = '__none__';

	/** Anzahl aktiver Filter im Bereich „Erweitert“ (für das Badge am Knopf) */
	export function advancedCount(f: MemberFilterState): number {
		return [
			f.ageMin || f.ageMax,
			f.consentWebsite,
			f.consentSocialMedia,
			f.consentPrint,
			f.secondary,
			f.hasEmail,
			f.entryFrom || f.entryTo
		].filter(Boolean).length;
	}
</script>

<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import FilterX from '@lucide/svelte/icons/filter-x';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField } from '$lib/components/layout';

	let {
		filter,
		stageOptions,
		groupOptions,
		showGroupMode = true,
		onchange,
		onreset,
		resettable
	}: {
		filter: MemberFilterState;
		stageOptions: { value: string; label: string }[];
		groupOptions: { value: string; label: string }[];
		/** Ohne eigene Gruppen (Gruppenleitung ohne Auswahl) entfällt der Gruppenmodus nicht – nur versteckt */
		showGroupMode?: boolean;
		/** Ändert Filter (Schlüssel = URL-Parameter, leerer Wert = entfernen) */
		onchange: (patch: Record<string, string>) => void;
		onreset: () => void;
		/** Gibt es etwas zurückzusetzen? */
		resettable: boolean;
	} = $props();

	const statusOptions = [
		{ value: 'active', label: 'Aktiv' },
		{ value: 'left', label: 'Ausgetreten' },
		{ value: 'all', label: 'Alle' }
	];
	const yesNoOptions = [
		{ value: 'yes', label: 'Ja' },
		{ value: 'no', label: 'Nein' }
	];
	const groupModeOptions = [
		{ value: 'any', label: 'mindestens eine' },
		{ value: 'all', label: 'alle gewählten' }
	];
	const groupChoices = $derived([{ value: UNGROUPED, label: 'Ohne Gruppe' }, ...groupOptions]);

	const advCount = $derived(advancedCount(filter));
	// Der Bereich bleibt offen, solange darin etwas gesetzt ist
	let advancedOpen = $state(false);
	const showAdvanced = $derived(advancedOpen || advCount > 0);

	/** Ganze Zahl 0–120 oder leer */
	function ageValue(raw: string): string {
		const n = Math.trunc(Number(raw));
		if (!raw.trim() || !Number.isFinite(n)) return '';
		return String(Math.min(120, Math.max(0, n)));
	}
</script>

<div class="flex w-full flex-wrap items-center gap-2">
	<SelectField
		label="Nach Mitgliedschaft filtern"
		class="w-auto"
		options={statusOptions}
		value={filter.status}
		onchange={(v) => onchange({ status: v && v !== 'active' ? v : '' })}
	/>
	<MultiSelect
		label="Nach Ständen filtern"
		class="w-auto min-w-44"
		placeholder="Alle Stände"
		searchPlaceholder="Stand suchen …"
		options={stageOptions}
		value={filter.stages}
		onchange={(v) => onchange({ stages: v.join(','), stage: '' })}
	/>
	<MultiSelect
		label="Nach Gruppen filtern"
		class="w-auto min-w-44"
		placeholder="Alle Gruppen"
		searchPlaceholder="Gruppe suchen …"
		options={groupChoices}
		value={filter.groups}
		onchange={(v) =>
			onchange({
				groupIds: v.filter((g) => g !== UNGROUPED).join(','),
				groupId: '',
				ungrouped: v.includes(UNGROUPED) ? 'yes' : ''
			})}
	/>
	{#if showGroupMode && filter.groups.filter((g) => g !== UNGROUPED).length > 1}
		<SelectField
			label="Gruppen verknüpfen"
			class="w-auto"
			options={groupModeOptions}
			value={filter.groupMode}
			onchange={(v) => onchange({ groupMode: v && v !== 'any' ? v : '' })}
		/>
	{/if}
	<Button
		variant="outline"
		aria-expanded={showAdvanced}
		aria-controls="member-advanced-filters"
		onclick={() => (advancedOpen = !showAdvanced)}
	>
		<SlidersHorizontal /> Erweitert
		{#if advCount}<Badge variant="secondary">{advCount}</Badge>{/if}
		<ChevronDown
			class={showAdvanced ? 'rotate-180 transition-transform' : 'transition-transform'}
		/>
	</Button>
	{#if resettable}
		<Button variant="ghost" onclick={onreset}><FilterX /> Filter zurücksetzen</Button>
	{/if}
</div>

{#if showAdvanced}
	<div
		id="member-advanced-filters"
		class="grid w-full grid-cols-1 gap-3 rounded-md border bg-muted/30 p-3 sm:grid-cols-2 lg:grid-cols-4"
	>
		<FormField label="Alter von (Jahre)" id="mf-age-min">
			<Input
				id="mf-age-min"
				type="number"
				inputmode="numeric"
				min="0"
				max="120"
				value={filter.ageMin}
				onchange={(e) => onchange({ ageMin: ageValue(e.currentTarget.value) })}
			/>
		</FormField>
		<FormField label="Alter bis (Jahre)" id="mf-age-max">
			<Input
				id="mf-age-max"
				type="number"
				inputmode="numeric"
				min="0"
				max="120"
				value={filter.ageMax}
				onchange={(e) => onchange({ ageMax: ageValue(e.currentTarget.value) })}
			/>
		</FormField>
		<FormField label="Eintritt ab" id="mf-entry-from">
			<Input
				id="mf-entry-from"
				type="date"
				value={filter.entryFrom}
				onchange={(e) => onchange({ entryFrom: e.currentTarget.value })}
			/>
		</FormField>
		<FormField label="Eintritt bis" id="mf-entry-to">
			<Input
				id="mf-entry-to"
				type="date"
				value={filter.entryTo}
				onchange={(e) => onchange({ entryTo: e.currentTarget.value })}
			/>
		</FormField>
		<FormField label="Darf auf der Website gezeigt werden" id="mf-consent-website">
			<SelectField
				id="mf-consent-website"
				label="Einwilligung Stammeswebsite"
				emptyLabel="Egal"
				options={yesNoOptions}
				value={filter.consentWebsite || null}
				onchange={(v) => onchange({ consentWebsite: v ?? '' })}
			/>
		</FormField>
		<FormField label="Darf in Social Media gezeigt werden" id="mf-consent-social">
			<SelectField
				id="mf-consent-social"
				label="Einwilligung Socialmedia"
				emptyLabel="Egal"
				options={yesNoOptions}
				value={filter.consentSocialMedia || null}
				onchange={(v) => onchange({ consentSocialMedia: v ?? '' })}
			/>
		</FormField>
		<FormField label="Darf in Print gezeigt werden" id="mf-consent-print">
			<SelectField
				id="mf-consent-print"
				label="Einwilligung Print"
				emptyLabel="Egal"
				options={yesNoOptions}
				value={filter.consentPrint || null}
				onchange={(v) => onchange({ consentPrint: v ?? '' })}
			/>
		</FormField>
		<FormField label="Zweitmitglied" id="mf-secondary">
			<SelectField
				id="mf-secondary"
				label="Zweitmitglied"
				emptyLabel="Egal"
				options={yesNoOptions}
				value={filter.secondary || null}
				onchange={(v) => onchange({ secondary: v ?? '' })}
			/>
		</FormField>
		<FormField label="Hat E-Mail-Adresse" id="mf-has-email">
			<SelectField
				id="mf-has-email"
				label="Hat E-Mail-Adresse"
				emptyLabel="Egal"
				options={yesNoOptions}
				value={filter.hasEmail || null}
				onchange={(v) => onchange({ hasEmail: v ?? '' })}
			/>
		</FormField>
	</div>
{/if}
