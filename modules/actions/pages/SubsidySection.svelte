<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Calculator from '@lucide/svelte/icons/calculator';
	import Info from '@lucide/svelte/icons/info';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import * as Table from '$lib/components/ui/table';
	import { NumberStepper } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		CHECKLIST_ITEMS,
		FREIZEIT_TYPES,
		FREIZEIT_TYPE_LABELS,
		LODGING_TYPES,
		LODGING_TYPE_LABELS,
		type CalculationInput,
		type CalculationSuggestions,
		type FreizeitType,
		type LodgingType,
		type SubsidyResult
	} from '../schemas';

	let {
		settings = $bindable(),
		subsidy,
		suggestions,
		suggestionsLoading = false,
		suggestionsError = '',
		onLoadSuggestions,
		disabled = false
	}: {
		settings: CalculationInput;
		subsidy: SubsidyResult;
		suggestions: CalculationSuggestions | null;
		suggestionsLoading?: boolean;
		suggestionsError?: string;
		onLoadSuggestions: () => Promise<CalculationSuggestions | null>;
		disabled?: boolean;
	} = $props();

	let checklistOpen = $state(false);
	const doneCount = $derived(CHECKLIST_ITEMS.filter((c) => !!settings.checklist[c.key]).length);

	const MISSING_LABELS = { birthDate: 'Geburtsdatum', bremenResident: 'Wohnort' } as const;

	async function fromList() {
		const s = await onLoadSuggestions();
		if (!s) return;
		settings.bremenChildren = s.children;
		settings.bremenYouth = s.youth;
		settings.teamWithJuleica = s.teamWithJuleica;
		settings.teamWithoutJuleica = s.teamWithoutJuleica;
		settings.teamYouth = s.teamYouth;
	}

	function setChecked(key: string, v: boolean) {
		settings.checklist = { ...settings.checklist, [key]: v };
	}
</script>

<Card.Root>
	<Card.Header>
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div>
				<Card.Title>Zuschuss</Card.Title>
				<Card.Description>
					Voraussichtlich:
					<span class="text-foreground font-medium tabular-nums">
						{formatEuro(subsidy.subsidyCents)}
					</span>
				</Card.Description>
			</div>
			<Button variant="outline" size="sm" {disabled} onclick={fromList}>
				<Calculator />
				{suggestionsLoading ? 'Lädt …' : 'Aus Teilnehmerliste berechnen'}
			</Button>
		</div>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		<div
			class="grid grid-cols-[minmax(0,1fr)] items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
		>
			<div class="flex min-w-0 flex-col gap-1.5">
				<Label for="sub-lodging">Unterkunftsart</Label>
				<SelectField
					id="sub-lodging"
					label="Unterkunftsart"
					value={settings.lodgingType}
					{disabled}
					onchange={(v) => v && (settings.lodgingType = v as LodgingType)}
					options={LODGING_TYPES.map((t) => ({ value: t, label: LODGING_TYPE_LABELS[t] }))}
				/>
			</div>
			<div class="flex min-w-0 flex-col gap-1.5">
				<Label for="sub-type">Art der Freizeit</Label>
				<SelectField
					id="sub-type"
					label="Art der Freizeit"
					value={settings.freizeitType}
					{disabled}
					onchange={(v) => v && (settings.freizeitType = v as FreizeitType)}
					options={FREIZEIT_TYPES.map((t) => ({ value: t, label: FREIZEIT_TYPE_LABELS[t] }))}
				/>
			</div>
			<div class="flex h-8 items-center gap-2">
				<Switch id="sub-konfi" bind:checked={settings.konfi} {disabled} />
				<Label for="sub-konfi">Konfi-Fahrt</Label>
			</div>
		</div>

		<div class="flex flex-col gap-2">
			<h3 class="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
				Personen aus Bremen/Bremerhaven
			</h3>
			<div class="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
				<div class="flex items-center justify-between gap-2">
					<Label for="sub-children">Kinder (0–11 Jahre)</Label>
					<NumberStepper
						id="sub-children"
						bind:value={settings.bremenChildren}
						min={0}
						max={1000}
						step={1}
						label="Kinder 0 bis 11 Jahre"
						{disabled}
					/>
				</div>
				<div class="flex items-center justify-between gap-2">
					<Label for="sub-youth">Jugendliche (12–27 Jahre)</Label>
					<NumberStepper
						id="sub-youth"
						bind:value={settings.bremenYouth}
						min={0}
						max={1000}
						step={1}
						label="Jugendliche 12 bis 27 Jahre"
						{disabled}
					/>
				</div>
				<div class="flex flex-col gap-1 sm:col-span-2">
					<div class="flex items-center justify-between gap-2">
						<Label for="sub-teamyouth" class="leading-snug">
							Teamer*innen 12–27 Jahre aus Bremen/Bremerhaven (zählen als Teilnehmende)
						</Label>
						<NumberStepper
							id="sub-teamyouth"
							bind:value={settings.teamYouth}
							min={0}
							max={1000}
							step={1}
							label="Teamer*innen 12 bis 27 Jahre"
							{disabled}
						/>
					</div>
					<p class="text-muted-foreground text-xs">
						Leiter*innen sind oft selbst Teilnehmende im Sinne der Förderung: Sie zählen beim
						Zuschuss wie Jugendliche (12–27 Jahre) mit und werden hier zusätzlich zu den
						Teilnehmenden angegeben.
					</p>
				</div>
				<div class="flex items-center justify-between gap-2">
					<Label for="sub-juleica">Team mit Juleica</Label>
					<NumberStepper
						id="sub-juleica"
						bind:value={settings.teamWithJuleica}
						min={0}
						max={1000}
						step={1}
						label="Team mit Juleica"
						{disabled}
					/>
				</div>
				<div class="flex items-center justify-between gap-2">
					<Label for="sub-nojuleica">Team ohne Juleica</Label>
					<NumberStepper
						id="sub-nojuleica"
						bind:value={settings.teamWithoutJuleica}
						min={0}
						max={1000}
						step={1}
						label="Team ohne Juleica"
						{disabled}
					/>
				</div>
			</div>
			<div aria-live="polite" class="flex flex-col gap-2">
				{#if suggestionsError}
					<p class="text-destructive text-sm">{suggestionsError}</p>
				{/if}
				{#if suggestions && suggestions.incomplete.length}
					<div class="bg-muted/50 flex gap-2 rounded-lg p-3 text-xs">
						<TriangleAlert class="mt-0.5 size-4 shrink-0" />
						<div>
							<p class="font-medium">
								{suggestions.incomplete.length}
								{suggestions.incomplete.length === 1 ? 'Datensatz' : 'Datensätze'} unvollständig (Geburtsdatum/Wohnort
								fehlt)
							</p>
							<ul class="text-muted-foreground list-disc pl-4">
								{#each suggestions.incomplete as p (p.id)}
									<li>{p.name}: {p.missing.map((m) => MISSING_LABELS[m]).join(', ')} fehlt</li>
								{/each}
							</ul>
						</div>
					</div>
				{/if}
			</div>
		</div>

		<div class="overflow-x-auto">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="h-8">Gruppe</Table.Head>
						<Table.Head class="h-8 text-right">Anzahl</Table.Head>
						<Table.Head class="h-8 text-right">Nächte</Table.Head>
						<Table.Head class="h-8 text-right">Satz</Table.Head>
						<Table.Head class="h-8 text-right">Betrag</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each subsidy.lines as l (l.key)}
						<Table.Row class="tabular-nums">
							<Table.Cell class="py-1.5">{l.label}</Table.Cell>
							<Table.Cell class="py-1.5 text-right">{l.count}</Table.Cell>
							<Table.Cell class="py-1.5 text-right">{l.nights}</Table.Cell>
							<Table.Cell class="py-1.5 text-right">{formatEuro(l.rateCents)}</Table.Cell>
							<Table.Cell class="py-1.5 text-right font-medium">
								{formatEuro(l.totalCents)}
							</Table.Cell>
						</Table.Row>
					{/each}
					<Table.Row class="tabular-nums">
						<Table.Cell colspan={4} class="py-1.5 font-medium">Zuschuss gesamt</Table.Cell>
						<Table.Cell class="py-1.5 text-right font-semibold">
							{formatEuro(subsidy.subsidyCents)}
						</Table.Cell>
					</Table.Row>
				</Table.Body>
			</Table.Root>
			<p class="text-muted-foreground mt-1 text-xs">
				Berücksichtigt werden höchstens {subsidy.cappedNights} Nächte.
			</p>
		</div>

		<div class="bg-muted/50 flex flex-col gap-1 rounded-lg p-3 text-sm">
			<div class="flex justify-between gap-3 font-medium">
				<span>Taschengeld für ehrenamtliche Leitende</span>
				<span class="tabular-nums">{formatEuro(subsidy.allowance.totalCents)}</span>
			</div>
			<p class="text-muted-foreground text-xs">
				Wird getrennt ausgezahlt und senkt den Beitrag nicht. Zuschussfähig sind höchstens
				{subsidy.allowance.limit} Ehrenamtliche (mit Juleica: {subsidy.allowance.withJuleica}, ohne:
				{subsidy.allowance.withoutJuleica}) für {subsidy.allowance.nights} Nächte.
			</p>
		</div>

		{#if subsidy.warnings.length}
			<div class="flex flex-col gap-2" aria-live="polite">
				{#each subsidy.warnings as w (w)}
					<div class="bg-muted/50 flex gap-2 rounded-lg p-3 text-xs">
						<Info class="mt-0.5 size-4 shrink-0" />
						<p>{w}</p>
					</div>
				{/each}
			</div>
		{/if}

		<div class="border-t pt-3">
			<button
				type="button"
				class="flex w-full items-center justify-between gap-3 text-left text-sm font-medium"
				aria-expanded={checklistOpen}
				aria-controls="subsidy-checklist"
				onclick={() => (checklistOpen = !checklistOpen)}
			>
				<span>
					Förder-Checkliste
					<span class="text-muted-foreground font-normal">
						· {doneCount} von {CHECKLIST_ITEMS.length} erledigt
					</span>
				</span>
				<ChevronDown
					class={['size-4 shrink-0 transition-transform', checklistOpen && 'rotate-180']}
				/>
			</button>
			{#if checklistOpen}
				<fieldset id="subsidy-checklist" class="mt-3 flex flex-col gap-2">
					<legend class="sr-only">Förder-Checkliste</legend>
					{#each CHECKLIST_ITEMS as c (c.key)}
						<div class="flex items-start gap-2">
							<Checkbox
								id={`chk-${c.key}`}
								checked={!!settings.checklist[c.key]}
								onCheckedChange={(v) => setChecked(c.key, v === true)}
								{disabled}
								class="mt-0.5"
							/>
							<Label for={`chk-${c.key}`} class="leading-snug font-normal">{c.label}</Label>
						</div>
					{/each}
				</fieldset>
			{/if}
		</div>
	</Card.Content>
</Card.Root>
