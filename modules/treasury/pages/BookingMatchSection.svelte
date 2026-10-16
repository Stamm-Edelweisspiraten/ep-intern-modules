<script lang="ts">
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import { untrack } from 'svelte';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Switch } from '$lib/components/ui/switch';
	import { MoneyInput } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { distribute, normalizeName } from '../logic';
	import type { MatchPreview, OpenLine, Payable } from '../schemas';
	import { BASE, fmtDate } from './helpers';

	/**
	 * Zuordnung einer neuen Buchung: Einnahme → offene Rechnungsposten (auch mehrere),
	 * Ausgabe → eine offene Auszahlung. Lädt Vorschläge, sobald Betrag/Name/Zweck/IBAN feststehen,
	 * und übernimmt sichere Vorschläge automatisch, solange man nichts selbst gewählt hat.
	 */
	let {
		direction,
		amountCents,
		counterparty,
		purpose,
		iban,
		payerId,
		amounts = $bindable({}),
		payableId = $bindable(null),
		notify = $bindable(true)
	}: {
		direction: 'income' | 'expense';
		amountCents: number;
		counterparty: string;
		purpose: string;
		iban: string;
		payerId: string | null;
		amounts?: Record<string, number>;
		payableId?: string | null;
		notify?: boolean;
	} = $props();

	let preview = $state<MatchPreview | null>(null);
	let loading = $state(false);
	let error = $state('');
	let search = $state('');
	/** Hat die Person selbst gewählt? Dann keine automatischen Vorschläge mehr überschreiben. */
	let touched = $state(false);
	let seq = 0;

	const confidenceLabel = { high: 'Sicher', medium: 'Wahrscheinlich', low: 'Unsicher' } as const;

	$effect(() => {
		const input = {
			amountCents: direction === 'expense' ? -amountCents : amountCents,
			counterparty: counterparty.trim() || null,
			purpose: purpose.trim() || null,
			counterpartyIban: iban.trim() || null,
			payerId
		};
		if (!amountCents) {
			untrack(() => {
				preview = null;
				if (!touched) {
					amounts = {};
					payableId = null;
				}
			});
			return;
		}
		const timer = setTimeout(() => void load(input), 400);
		return () => clearTimeout(timer);
	});

	async function load(input: Record<string, unknown>) {
		const mine = ++seq;
		loading = !preview;
		error = '';
		try {
			const p = await apiFetch<MatchPreview>(`${BASE}/match-preview`, {
				method: 'POST',
				body: JSON.stringify(input)
			});
			if (mine !== seq) return;
			preview = p;
			if (!touched) applySuggestion(false);
		} catch (e) {
			if (mine === seq) {
				error = e instanceof ApiClientError ? e.message : 'Vorschläge konnten nicht geladen werden';
			}
		} finally {
			if (mine === seq) loading = false;
		}
	}

	/** Vorschlag übernehmen; automatisch nur, wenn er nicht „unsicher“ ist */
	function applySuggestion(manual: boolean) {
		if (!preview) return;
		if (direction === 'income') {
			const s = preview.suggestion;
			const next: Record<string, number> = {};
			if (s && (manual || s.confidence !== 'low')) {
				for (const a of s.allocations) next[a.lineId] = a.amountCents;
			}
			amounts = next;
		} else {
			const s = preview.payableSuggestion;
			payableId = s && (manual || s.confidence !== 'low') ? s.payableId : null;
		}
		if (manual) touched = true;
	}

	const lines = $derived(preview?.lines ?? []);
	const payables = $derived(preview?.payables ?? []);
	const allocated = $derived(Object.values(amounts).reduce((s, v) => s + (v > 0 ? v : 0), 0));
	const rest = $derived(amountCents - allocated);

	const suggestedIds = $derived(
		new Set(
			direction === 'income'
				? (preview?.suggestion?.allocations.map((a) => a.lineId) ?? [])
				: preview?.payableSuggestion
					? [preview.payableSuggestion.payableId]
					: []
		)
	);

	const visibleLines = $derived.by(() => {
		const q = normalizeName(search);
		return lines
			.filter(
				(l) =>
					l.lineId in amounts ||
					(q
						? normalizeName(`${l.invoiceNumber} ${l.recipientName} ${l.description}`).includes(q)
						: suggestedIds.has(l.lineId))
			)
			.sort(
				(a, b) =>
					Number(b.lineId in amounts) - Number(a.lineId in amounts) ||
					Number(suggestedIds.has(b.lineId)) - Number(suggestedIds.has(a.lineId)) ||
					a.recipientName.localeCompare(b.recipientName, 'de')
			)
			.slice(0, 8);
	});

	const visiblePayables = $derived.by(() => {
		const q = normalizeName(search);
		return payables
			.filter(
				(p) =>
					p.id === payableId ||
					(q
						? normalizeName(`${p.recipientName} ${p.description}`).includes(q)
						: suggestedIds.has(p.id))
			)
			.slice(0, 8);
	});

	function toggleLine(l: OpenLine, checked: boolean) {
		touched = true;
		const next = { ...amounts };
		if (checked) next[l.lineId] = Math.max(0, Math.min(l.openCents, rest));
		else delete next[l.lineId];
		amounts = next;
	}

	function togglePayable(p: Payable, checked: boolean) {
		touched = true;
		payableId = checked ? p.id : null;
	}

	function spread() {
		touched = true;
		const chosen = lines.filter((l) => l.lineId in amounts);
		const d = distribute(amountCents, chosen);
		const next: Record<string, number> = {};
		for (const l of chosen) next[l.lineId] = 0;
		for (const a of d.allocations) next[a.lineId] = a.amountCents;
		amounts = next;
	}

	function clear() {
		touched = true;
		amounts = {};
		payableId = null;
	}

	const suggestionText = $derived.by(() => {
		if (!preview) return null;
		if (direction === 'income' && preview.suggestion) {
			const s = preview.suggestion;
			return {
				confidence: s.confidence,
				text: `${s.reason} – ${s.invoiceNumbers.join(', ')}`
			};
		}
		if (direction === 'expense' && preview.payableSuggestion) {
			const s = preview.payableSuggestion;
			const p = payables.find((x) => x.id === s.payableId);
			return {
				confidence: s.confidence,
				text: `${s.reason}${p ? ` – ${p.recipientName}: ${p.description}` : ''}`
			};
		}
		return null;
	});
	/** Entspricht die aktuelle Auswahl genau dem Vorschlag? */
	const suggestionApplied = $derived.by(() => {
		if (direction === 'expense') {
			return !!preview?.payableSuggestion && payableId === preview.payableSuggestion.payableId;
		}
		const s = preview?.suggestion;
		if (!s) return false;
		const keys = Object.keys(amounts).filter((k) => (amounts[k] ?? 0) > 0);
		return (
			keys.length === s.allocations.length &&
			s.allocations.every((a) => amounts[a.lineId] === a.amountCents)
		);
	});
	const total = $derived(direction === 'income' ? lines.length : payables.length);
	const selectedCount = $derived(
		direction === 'income' ? Object.keys(amounts).length : payableId ? 1 : 0
	);
</script>

<fieldset class="space-y-3 rounded-md border p-3">
	<legend class="px-1 text-sm font-medium">
		{direction === 'income' ? 'Offenen Rechnungen zuordnen' : 'Offener Auszahlung zuordnen'}
	</legend>

	{#if !amountCents}
		<p class="text-xs text-muted-foreground">
			Gib einen Betrag ein – die Kasse schlägt dann passende {direction === 'income'
				? 'Rechnungen'
				: 'Auszahlungen'} vor.
		</p>
	{:else if loading}
		<Skeleton class="h-9 w-full" />
	{:else if error}
		<p class="text-sm text-destructive" role="alert">{error}</p>
	{:else if preview}
		{#if suggestionText}
			<div
				class="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-sm"
				role="note"
			>
				<Sparkles class="size-4 shrink-0 text-primary" aria-hidden="true" />
				<span class="min-w-0 flex-1">
					<span class="font-medium">Vorschlag ({confidenceLabel[suggestionText.confidence]}):</span>
					{suggestionText.text}
				</span>
				{#if suggestionApplied}
					<Badge variant="secondary">Übernommen</Badge>
				{:else}
					<Button size="sm" variant="outline" onclick={() => applySuggestion(true)}>
						Übernehmen
					</Button>
				{/if}
			</div>
		{/if}

		{#if !total}
			<p class="text-xs text-muted-foreground">
				{direction === 'income'
					? 'Es gibt keine offenen Rechnungen – die Einnahme wird ohne Zuordnung gespeichert.'
					: 'Es gibt keine offenen Auszahlungen.'}
			</p>
		{:else}
			<div class="flex flex-wrap items-center gap-2">
				<Input
					class="h-8 min-w-0 flex-1 basis-full sm:basis-0"
					placeholder={direction === 'income'
						? `Rechnung, Name oder Posten suchen (${total} offen) …`
						: `Empfänger*in oder Grund suchen (${total} offen) …`}
					aria-label="Offene Posten durchsuchen"
					bind:value={search}
				/>
				{#if direction === 'income' && selectedCount > 1}
					<Button variant="outline" size="sm" onclick={spread}>Verteilen</Button>
				{/if}
				{#if selectedCount}
					<Button variant="ghost" size="sm" onclick={clear}>Leeren</Button>
				{/if}
			</div>

			{#if direction === 'income'}
				{#if visibleLines.length}
					<ul class="divide-y rounded-md border" aria-label="Offene Rechnungsposten">
						{#each visibleLines as l (l.lineId)}
							{@const checked = l.lineId in amounts}
							<li class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
								<Checkbox
									id={`bm-${l.lineId}`}
									{checked}
									onCheckedChange={(v) => toggleLine(l, v === true)}
									aria-label={`${l.description} auswählen`}
								/>
								<label
									for={`bm-${l.lineId}`}
									class="min-w-0 flex-1 basis-48 cursor-pointer text-sm"
								>
									<span class="flex items-center gap-2">
										<span class="truncate font-medium">{l.description}</span>
										{#if suggestedIds.has(l.lineId)}
											<Badge variant="outline" class="shrink-0">Vorschlag</Badge>
										{/if}
									</span>
									<span class="block text-xs text-muted-foreground">
										{l.invoiceNumber} · {l.recipientName} · fällig {fmtDate(l.dueOn)} · offen
										<span class="tabular-nums">{formatEuro(l.openCents)}</span>
									</span>
								</label>
								{#if checked}
									<MoneyInput
										class="ml-7 w-28 sm:ml-0"
										label={`Betrag für ${l.description}`}
										cents={amounts[l.lineId] ?? 0}
										max={l.openCents}
										onchange={(c) => {
											touched = true;
											amounts = { ...amounts, [l.lineId]: c };
										}}
									/>
								{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-xs text-muted-foreground">
						{search ? 'Keine Treffer.' : 'Kein passender Vorschlag – such oben nach der Rechnung.'}
					</p>
				{/if}
				<div class="flex flex-wrap items-center justify-between gap-2 text-sm">
					<span class="space-x-3">
						<span>Zugeordnet <strong class="tabular-nums">{formatEuro(allocated)}</strong></span>
						<span class={rest < 0 ? 'text-destructive' : 'text-muted-foreground'}>
							Rest <span class="tabular-nums">{formatEuro(rest)}</span>
						</span>
					</span>
					{#if selectedCount}
						<span class="flex items-center gap-2">
							<Switch id="bm-notify" bind:checked={notify} />
							<Label for="bm-notify">Bestätigung per E-Mail</Label>
						</span>
					{/if}
				</div>
			{:else if visiblePayables.length}
				<ul class="divide-y rounded-md border" aria-label="Offene Auszahlungen">
					{#each visiblePayables as p (p.id)}
						<li class="flex items-center gap-3 px-3 py-2">
							<Checkbox
								id={`bm-${p.id}`}
								checked={p.id === payableId}
								onCheckedChange={(v) => togglePayable(p, v === true)}
								aria-label={`${p.recipientName} auswählen`}
							/>
							<label for={`bm-${p.id}`} class="min-w-0 flex-1 cursor-pointer text-sm">
								<span class="flex items-center gap-2">
									<span class="truncate font-medium">{p.recipientName}</span>
									{#if suggestedIds.has(p.id)}
										<Badge variant="outline" class="shrink-0">Vorschlag</Badge>
									{/if}
								</span>
								<span class="block text-xs text-muted-foreground">
									{p.description}{p.action ? ` · ${p.action.name}` : ''}{p.ibanMasked
										? ` · ${p.ibanMasked}`
										: ''}
								</span>
							</label>
							<span class="text-sm tabular-nums">{formatEuro(p.openCents)}</span>
						</li>
					{/each}
				</ul>
				{#if payableId}
					{@const p = payables.find((x) => x.id === payableId)}
					{#if p && p.openCents !== amountCents}
						<p class="text-xs text-amber-600 dark:text-amber-400">
							Offen sind {formatEuro(p.openCents)} – der Betrag weicht ab, angerechnet wird höchstens
							der offene Betrag.
						</p>
					{/if}
				{/if}
			{:else}
				<p class="text-xs text-muted-foreground">
					{search ? 'Keine Treffer.' : 'Kein passender Vorschlag – such oben nach der Auszahlung.'}
				</p>
			{/if}
		{/if}
	{/if}
</fieldset>
