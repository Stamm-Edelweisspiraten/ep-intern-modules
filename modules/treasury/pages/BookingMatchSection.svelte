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
		notify = $bindable(true),
		onpending
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
		/** Vorschläge werden gerade geladen bzw. stehen kurz bevor (Debounce) */
		onpending?: (pending: boolean) => void;
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
				onpending?.(false);
				preview = null;
				if (!touched) {
					amounts = {};
					payableId = null;
				}
			});
			return;
		}
		untrack(() => onpending?.(true));
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
			if (mine === seq) {
				loading = false;
				onpending?.(false);
			}
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
					!q ||
					normalizeName(`${l.invoiceNumber} ${l.recipientName} ${l.description}`).includes(q)
			)
			.sort(
				(a, b) =>
					Number(b.lineId in amounts) - Number(a.lineId in amounts) ||
					Number(suggestedIds.has(b.lineId)) - Number(suggestedIds.has(a.lineId)) ||
					a.recipientName.localeCompare(b.recipientName, 'de')
			)
			.slice(0, 200);
	});

	const visiblePayables = $derived.by(() => {
		const q = normalizeName(search);
		return payables
			.filter(
				(p) =>
					p.id === payableId ||
					!q ||
					normalizeName(`${p.recipientName} ${p.description} ${p.action?.name ?? ''}`).includes(q)
			)
			.sort(
				(a, b) =>
					Number(b.id === payableId) - Number(a.id === payableId) ||
					Number(suggestedIds.has(b.id)) - Number(suggestedIds.has(a.id)) ||
					a.recipientName.localeCompare(b.recipientName, 'de')
			)
			.slice(0, 200);
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

<section
	class="flex min-h-[22rem] flex-col gap-3 rounded-lg border bg-muted/30 p-4 lg:max-h-[calc(94vh-11rem)]"
	aria-labelledby="bm-title"
>
	<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
		<h3 id="bm-title" class="font-semibold">
			{direction === 'income' ? 'Offenen Rechnungen zuordnen' : 'Offener Auszahlung zuordnen'}
		</h3>
		{#if preview && total}
			<span class="text-xs text-muted-foreground">
				{total}
				{direction === 'income' ? 'offene Posten' : 'offene Auszahlungen'}
				{#if selectedCount}· {selectedCount} ausgewählt{/if}
			</span>
		{/if}
	</div>

	{#if !amountCents}
		<div
			class="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-background/60 p-6 text-center text-sm text-muted-foreground"
		>
			<Sparkles class="size-5 text-primary" aria-hidden="true" />
			<p>
				Gib einen Betrag ein – die Kasse schlägt dann passende {direction === 'income'
					? 'Rechnungen'
					: 'Auszahlungen'} vor.
			</p>
			<p class="text-xs">Name, Verwendungszweck und IBAN machen den Vorschlag genauer.</p>
		</div>
	{:else if loading}
		<div class="space-y-2">
			<Skeleton class="h-12 w-full" />
			<Skeleton class="h-12 w-full" />
			<Skeleton class="h-12 w-full" />
		</div>
	{:else if error}
		<p class="text-sm text-destructive" role="alert">{error}</p>
	{:else if preview}
		{#if suggestionText}
			<div
				class="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"
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
			<div
				class="flex flex-1 items-center justify-center rounded-md border border-dashed bg-background/60 p-6 text-center text-sm text-muted-foreground"
			>
				{direction === 'income'
					? 'Es gibt keine offenen Rechnungen – die Einnahme wird ohne Zuordnung gespeichert.'
					: 'Es gibt keine offenen Auszahlungen.'}
			</div>
		{:else}
			<div class="flex flex-wrap items-center gap-2">
				<Input
					class="min-w-0 flex-1 basis-full bg-background sm:basis-0"
					placeholder={direction === 'income'
						? 'Rechnung, Name oder Posten suchen …'
						: 'Empfänger*in, Grund oder Aktion suchen …'}
					aria-label="Offene Posten durchsuchen"
					bind:value={search}
					onkeydown={(e) => {
						// Enter in der Suche speichert nicht die Buchung
						if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) e.preventDefault();
					}}
				/>
				{#if direction === 'income' && selectedCount > 1}
					<Button variant="outline" size="sm" onclick={spread}>Betrag verteilen</Button>
				{/if}
				{#if selectedCount}
					<Button variant="ghost" size="sm" onclick={clear}>Auswahl leeren</Button>
				{/if}
			</div>

			{#if direction === 'income'}
				{#if visibleLines.length}
					<ul
						class="max-h-96 min-h-0 flex-1 divide-y overflow-y-auto rounded-md border bg-background lg:max-h-none"
						aria-label="Offene Rechnungsposten"
					>
						{#each visibleLines as l (l.lineId)}
							{@const checked = l.lineId in amounts}
							<li
								class={[
									'flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5',
									checked && 'bg-primary/5'
								]}
							>
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
											<Badge variant="outline" class="shrink-0 border-primary/40 text-primary"
												>Vorschlag</Badge
											>
										{/if}
									</span>
									<span class="block text-xs text-muted-foreground">
										{l.invoiceNumber} · {l.recipientName} · fällig {fmtDate(l.dueOn)}
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
								{:else}
									<span class="w-28 text-right text-sm text-muted-foreground tabular-nums">
										{formatEuro(l.openCents)}
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="py-6 text-center text-sm text-muted-foreground">Keine Treffer.</p>
				{/if}
				<div class="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
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
			{:else}
				{#if visiblePayables.length}
					<ul
						class="max-h-96 min-h-0 flex-1 divide-y overflow-y-auto rounded-md border bg-background lg:max-h-none"
						aria-label="Offene Auszahlungen"
					>
						{#each visiblePayables as p (p.id)}
							<li
								class={[
									'flex items-center gap-3 px-3 py-2.5',
									p.id === payableId && 'bg-primary/5'
								]}
							>
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
											<Badge variant="outline" class="shrink-0 border-primary/40 text-primary"
												>Vorschlag</Badge
											>
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
				{:else}
					<p class="py-6 text-center text-sm text-muted-foreground">Keine Treffer.</p>
				{/if}
				{#if payableId}
					{@const p = payables.find((x) => x.id === payableId)}
					{#if p && p.openCents !== amountCents}
						<p class="text-xs text-amber-600 dark:text-amber-400">
							Offen sind {formatEuro(p.openCents)} – der Betrag weicht ab, angerechnet wird höchstens
							der offene Betrag.
						</p>
					{/if}
				{/if}
			{/if}
		{/if}
	{/if}
</section>
