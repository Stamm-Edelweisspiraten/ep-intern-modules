<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Check from '@lucide/svelte/icons/check';
	import Download from '@lucide/svelte/icons/download';
	import Moon from '@lucide/svelte/icons/moon';
	import Loader from '@lucide/svelte/icons/loader-circle';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { ConfirmDialog } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { fmtDate } from './format';
	import { Label } from '$lib/components/ui/label';
	import * as Popover from '$lib/components/ui/popover';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Slider } from '$lib/components/ui/slider';
	import { Switch } from '$lib/components/ui/switch';
	import { NumberStepper } from '$lib/components/layout';
	import {
		calculationInput,
		type CalculationDto,
		type CalculationInput,
		type AppliedFee,
		type CalculationSuggestions
	} from '../schemas';
	import { calculate, nightsBetween } from '../calculation';
	import { computeSubsidy } from '../subsidy';
	import CalcItemsEditor from './CalcItemsEditor.svelte';
	import CalcSummary from './CalcSummary.svelte';
	import SubsidySection from './SubsidySection.svelte';

	let {
		actionId,
		startsOn,
		endsOn,
		canEdit,
		participantsCount,
		onfeechanged
	}: {
		actionId: string;
		startsOn: string;
		endsOn: string | null;
		canEdit: boolean;
		participantsCount?: number;
		onfeechanged?: () => void;
	} = $props();

	const disabled = $derived(!canEdit);
	const path = $derived(`/modules/actions/actions/${encodeURIComponent(actionId)}/calculation`);

	let settings = $state<CalculationInput | null>(null);
	let loading = $state(true);
	let loadError = $state('');

	type SaveState = 'idle' | 'saving' | 'saved' | 'error';
	let saveState = $state<SaveState>('idle');
	let saveError = $state('');
	let lastSaved = '';
	let saving = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	let suggestions = $state<CalculationSuggestions | null>(null);
	let suggestionsLoading = $state(false);
	let suggestionsError = $state('');
	let applyOpen = $state(false);

	let applied = $state<AppliedFee | null>(null);
	let outdated = $state(false);
	let feeBusy = $state(false);
	let clearOpen = $state(false);

	// --- Laden ---------------------------------------------------------------
	async function load() {
		loading = true;
		loadError = '';
		try {
			const dto = await apiFetch<CalculationDto>(path);
			settings = dto.settings;
			applied = dto.applied;
			outdated = dto.outdated;
			lastSaved = JSON.stringify(dto.settings);
			saveState = 'idle';
		} catch (e) {
			loadError =
				e instanceof ApiClientError ? e.message : 'Kalkulation konnte nicht geladen werden.';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void actionId;
		untrack(() => {
			settings = null;
			suggestions = null;
			void load();
		});
	});

	// --- Berechnung (lokal, sofort) -----------------------------------------
	const subsidy = $derived(
		settings
			? computeSubsidy({
					nights: settings.nights,
					lodgingType: settings.lodgingType,
					konfi: settings.konfi,
					freizeitType: settings.freizeitType,
					children: settings.bremenChildren,
					youth: settings.bremenYouth,
					teamWithJuleica: settings.teamWithJuleica,
					teamWithoutJuleica: settings.teamWithoutJuleica,
					teamYouth: settings.teamYouth
				})
			: null
	);
	const result = $derived(
		settings
			? calculate({
					participants: settings.participants,
					team: settings.team,
					teamPercent: settings.teamPercent,
					nights: settings.nights,
					items: settings.items,
					bufferPercent: settings.bufferPercent,
					subsidyCents: settings.includeSubsidy && subsidy ? subsidy.subsidyCents : 0
				})
			: null
	);

	const validation = $derived(settings ? calculationInput.safeParse(settings) : null);
	const validationMessage = $derived.by(() => {
		if (!validation || validation.success) return '';
		const issue = validation.error.issues[0];
		if (!issue) return 'Ungültige Eingabe';
		const p = issue.path;
		if (p[0] === 'items' && typeof p[1] === 'number') {
			const it = settings?.items[p[1]];
			return `Posten „${it?.label?.trim() || p[1] + 1}“: ${issue.message}`;
		}
		return issue.message;
	});

	const nightsHint = $derived(nightsBetween(startsOn, endsOn));

	// --- Autosave -----------------------------------------------------------
	function snapshot() {
		return settings ? JSON.stringify(settings) : '';
	}

	async function flush(keepalive = false) {
		if (!settings || !canEdit) return;
		while (saving) await new Promise((r) => setTimeout(r, 50));
		const snap = snapshot();
		if (snap === lastSaved) return;
		const parsed = calculationInput.safeParse(settings);
		if (!parsed.success) return;
		saving = true;
		saveState = 'saving';
		saveError = '';
		try {
			const dto = await apiFetch<CalculationDto>(path, {
				method: 'PUT',
				body: JSON.stringify(parsed.data),
				keepalive
			});
			applied = dto.applied;
			outdated = dto.outdated;
			lastSaved = snap;
			saveState = 'saved';
		} catch (e) {
			saveState = 'error';
			saveError = e instanceof ApiClientError ? e.message : 'Speichern fehlgeschlagen.';
		} finally {
			saving = false;
		}
		// Waehrend des Speicherns geaenderte Eingaben direkt nachziehen.
		if (saveState === 'saved' && snapshot() !== lastSaved && !keepalive) void flush();
	}

	$effect(() => {
		if (!settings || !canEdit) return;
		const snap = JSON.stringify(settings);
		const valid = validation?.success ?? false;
		if (snap === untrack(() => lastSaved)) return;
		if (timer) clearTimeout(timer);
		if (!valid) {
			timer = null;
			return;
		}
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, 800);
		return () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		};
	});

	onDestroy(() => {
		if (timer) clearTimeout(timer);
		void flush(true);
	});

	// --- Beitrag uebernehmen ---------------------------------------------------
	async function applyFee() {
		if (!canEdit || feeBusy || !result) return;
		if (!validation?.success) {
			toast.error(validationMessage || 'Ungültige Eingabe');
			return;
		}
		feeBusy = true;
		try {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			await flush();
			if (saveState === 'error') throw new Error(saveError || 'Speichern fehlgeschlagen.');
			const dto = await apiFetch<CalculationDto>(`${path}/apply`, { method: 'POST' });
			applied = dto.applied;
			outdated = dto.outdated;
			toast.success('Beitrag übernommen');
			onfeechanged?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Übernahme fehlgeschlagen.');
		} finally {
			feeBusy = false;
		}
	}

	async function clearFee() {
		if (!canEdit || feeBusy) return;
		feeBusy = true;
		try {
			const dto = await apiFetch<CalculationDto>(`${path}/apply`, { method: 'DELETE' });
			applied = dto.applied;
			outdated = dto.outdated;
			toast.success('Übernahme zurückgenommen');
			onfeechanged?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Zurücknehmen fehlgeschlagen.');
		} finally {
			feeBusy = false;
		}
	}

	const dirty = $derived(!!settings && snapshot() !== lastSaved);

	// --- Vorschlaege --------------------------------------------------------
	async function loadSuggestions(): Promise<CalculationSuggestions | null> {
		suggestionsLoading = true;
		suggestionsError = '';
		try {
			suggestions = await apiFetch<CalculationSuggestions>(`${path}/suggestions`);
			return suggestions;
		} catch (e) {
			suggestionsError =
				e instanceof ApiClientError ? e.message : 'Vorschläge konnten nicht geladen werden.';
			return null;
		} finally {
			suggestionsLoading = false;
		}
	}

	function onApplyOpenChange(o: boolean) {
		applyOpen = o;
		if (o) void loadSuggestions();
	}

	function applySuggestions() {
		if (!settings || !suggestions) return;
		settings.participants = Math.min(1000, suggestions.participants);
		settings.team = Math.min(1000, suggestions.team);
		if (suggestions.nights !== null) settings.nights = Math.min(60, suggestions.nights);
		applyOpen = false;
		toast.success('Werte aus den Anmeldungen übernommen');
	}

	function adoptNights() {
		if (settings && nightsHint !== null) settings.nights = Math.min(60, Math.max(0, nightsHint));
	}

	const nightsDiffer = $derived(
		!!settings && nightsHint !== null && nightsHint !== settings.nights
	);
</script>

<div class="flex flex-col gap-4 pb-36 lg:pb-0">
	{#if loading && !settings}
		<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]" aria-busy="true">
			<div class="flex flex-col gap-4">
				<Skeleton class="h-44 w-full" />
				<Skeleton class="h-56 w-full" />
				<Skeleton class="h-40 w-full" />
			</div>
			<Skeleton class="h-80 w-full" />
		</div>
	{:else if loadError || !settings || !result}
		<Card.Root>
			<Card.Content class="flex flex-col items-start gap-3">
				<p class="text-destructive text-sm" role="alert">
					{loadError || 'Kalkulation konnte nicht geladen werden.'}
				</p>
				<Button variant="outline" onclick={load}>Erneut versuchen</Button>
			</Card.Content>
		</Card.Root>
	{:else}
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="flex items-center gap-2">
				{#if !canEdit}
					<Badge variant="secondary">Nur Ansicht</Badge>
				{/if}
			</div>
			<div class="flex min-h-8 items-center gap-2 text-sm" aria-live="polite">
				{#if !canEdit}
					<span class="text-muted-foreground">Änderungen sind nicht möglich.</span>
				{:else if validationMessage}
					<span class="text-destructive flex items-center gap-1.5">
						<CircleAlert class="size-4" /> Nicht gespeichert: {validationMessage}
					</span>
				{:else if saveState === 'error'}
					<span class="text-destructive flex items-center gap-1.5">
						<CircleAlert class="size-4" />
						{saveError || 'Speichern fehlgeschlagen.'}
					</span>
					<Button size="sm" variant="outline" onclick={() => flush()}>Erneut versuchen</Button>
				{:else if saveState === 'saving'}
					<span class="text-muted-foreground flex items-center gap-1.5">
						<Loader class="size-4 animate-spin" /> Speichert …
					</span>
				{:else if dirty}
					<span class="text-muted-foreground">Ungespeicherte Änderungen …</span>
				{:else}
					<span class="text-muted-foreground flex items-center gap-1.5">
						<Check class="size-4" /> Gespeichert
					</span>
				{/if}
			</div>
		</div>

		{#if applied && !outdated}
			<div
				class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-green-600/30 bg-green-600/10 px-3 py-2 text-sm"
				role="status"
			>
				<span>
					Übernommen: {formatEuro(applied.participantCents)} pro Teilnehmende*r{applied.teamCents >
					0
						? ` · Team ${formatEuro(applied.teamCents)}`
						: ''} · am {fmtDate(applied.appliedAt)}{applied.appliedBy
						? ` von ${applied.appliedBy.name}`
						: ''} – wird für Anmeldung und Abrechnung verwendet
				</span>
				{#if canEdit}
					<Button size="sm" variant="outline" disabled={feeBusy} onclick={() => (clearOpen = true)}>
						Zurücknehmen
					</Button>
				{/if}
			</div>
		{:else if applied && outdated}
			<div
				class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
				role="status"
			>
				<span>
					Die Kalkulation hat sich seit der Übernahme geändert (übernommen: {formatEuro(
						applied.participantCents
					)}, aktuell: {formatEuro(result.recommendedPerPersonCents)}).
				</span>
				{#if canEdit}
					<span class="flex gap-2">
						<Button size="sm" disabled={feeBusy} onclick={applyFee}>Erneut übernehmen</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={feeBusy}
							onclick={() => (clearOpen = true)}
						>
							Zurücknehmen
						</Button>
					</span>
				{/if}
			</div>
		{:else}
			<p class="text-muted-foreground text-xs">Noch nicht übernommen.</p>
		{/if}

		<div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
			<div class="flex min-w-0 flex-col gap-4">
				<Card.Root>
					<Card.Header>
						<div class="flex flex-wrap items-center justify-between gap-2">
							<div>
								<Card.Title>Eckdaten</Card.Title>
								<Card.Description>Wer fährt mit und wie lange?</Card.Description>
							</div>
							{#if canEdit}
								<Popover.Root open={applyOpen} onOpenChange={onApplyOpenChange}>
									<Popover.Trigger>
										{#snippet child({ props })}
											<Button {...props} variant="outline" size="sm">
												<Download /> Aus Anmeldungen übernehmen
											</Button>
										{/snippet}
									</Popover.Trigger>
									<Popover.Content class="w-72" align="end">
										<div class="flex flex-col gap-3" aria-live="polite">
											{#if suggestionsLoading}
												<p class="text-muted-foreground text-sm">Lädt …</p>
											{:else if suggestionsError}
												<p class="text-destructive text-sm">{suggestionsError}</p>
											{:else if suggestions}
												<p class="text-sm">
													<span class="font-medium tabular-nums">
														{suggestions.participants} Teilnehmende, {suggestions.team} Team{suggestions.nights !==
														null
															? `, ${suggestions.nights} ${suggestions.nights === 1 ? 'Nacht' : 'Nächte'}`
															: ''}
													</span>
												</p>
												<p class="text-muted-foreground text-xs">
													Ersetzt die aktuellen Eckdaten
													{#if participantsCount !== undefined}
														({participantsCount} Anmeldungen)
													{/if}.
												</p>
												<Button size="sm" onclick={applySuggestions}>Übernehmen</Button>
											{/if}
										</div>
									</Popover.Content>
								</Popover.Root>
							{/if}
						</div>
					</Card.Header>
					<Card.Content class="flex flex-col gap-4">
						<div class="grid gap-4 sm:grid-cols-3">
							<div class="flex flex-col gap-1.5">
								<Label for="calc-participants">Teilnehmende</Label>
								<NumberStepper
									id="calc-participants"
									bind:value={settings.participants}
									min={0}
									max={1000}
									step={1}
									label="Anzahl Teilnehmende"
									{disabled}
								/>
								<Slider
									value={Math.min(100, settings.participants)}
									min={1}
									max={100}
									step={1}
									label="Anzahl Teilnehmende (Schieberegler)"
									{disabled}
									onchange={(v) => {
										if (settings) settings.participants = v;
									}}
								/>
							</div>
							<div class="flex flex-col gap-1.5">
								<Label for="calc-team">Team (Leitende)</Label>
								<NumberStepper
									id="calc-team"
									bind:value={settings.team}
									min={0}
									max={1000}
									step={1}
									label="Anzahl Team"
									{disabled}
								/>
							</div>
							<div class="flex flex-col gap-1.5">
								<Label for="calc-nights">Nächte</Label>
								<NumberStepper
									id="calc-nights"
									bind:value={settings.nights}
									min={0}
									max={60}
									step={1}
									unit={settings.nights === 1 ? 'Nacht' : 'Nächte'}
									label="Anzahl Nächte"
									{disabled}
								/>
								{#if nightsDiffer && canEdit}
									<Button
										variant="ghost"
										size="xs"
										class="text-muted-foreground -ml-2 self-start"
										onclick={adoptNights}
									>
										<Moon /> Aus Aktionsdaten: {nightsHint}
										{nightsHint === 1 ? 'Nacht' : 'Nächte'} übernehmen
									</Button>
								{/if}
							</div>
						</div>
						{#if settings.team > 0}
							<div class="flex flex-col gap-1">
								<div class="flex flex-wrap items-center justify-between gap-2">
									<Label for="calc-teampercent">Anteil des Teams am Beitrag</Label>
									<NumberStepper
										id="calc-teampercent"
										bind:value={settings.teamPercent}
										min={0}
										max={100}
										step={5}
										unit="%"
										label="Anteil des Beitrags, den das Team zahlt, in Prozent"
										{disabled}
									/>
								</div>
								<p class="text-muted-foreground text-xs">
									Der Rest wird auf die Teilnehmenden umgelegt.
								</p>
							</div>
						{/if}
						<div class="bg-muted/50 flex items-center justify-between gap-3 rounded-lg px-3 py-2">
							<Label for="calc-subsidy" class="flex flex-col items-start gap-0.5">
								<span>Zuschuss einbeziehen</span>
								<span class="text-muted-foreground text-xs font-normal">
									Zuschuss senkt die Nettokosten und den Beitrag
								</span>
							</Label>
							<Switch id="calc-subsidy" bind:checked={settings.includeSubsidy} {disabled} />
						</div>
					</Card.Content>
				</Card.Root>

				<CalcItemsEditor bind:items={settings.items} {result} {disabled} />

				{#if settings.includeSubsidy && subsidy}
					<SubsidySection
						bind:settings
						{subsidy}
						{suggestions}
						{suggestionsLoading}
						{suggestionsError}
						onLoadSuggestions={loadSuggestions}
						{disabled}
					/>
				{/if}
			</div>

			<CalcSummary
				{result}
				{subsidy}
				includeSubsidy={settings.includeSubsidy}
				bind:bufferPercent={settings.bufferPercent}
				teamPercent={settings.teamPercent}
				team={settings.team}
				canApply={canEdit}
				applying={feeBusy}
				onapply={applyFee}
				{disabled}
			/>
		</div>
	{/if}
</div>

<ConfirmDialog
	bind:open={clearOpen}
	title="Übernahme zurücknehmen?"
	description="Der übernommene Beitrag wird aus der Aktion entfernt. Die Kalkulation bleibt erhalten."
	confirmLabel="Zurücknehmen"
	onconfirm={clearFee}
/>
