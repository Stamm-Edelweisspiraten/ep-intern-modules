<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Switch } from '$lib/components/ui/switch';
	import { MoneyInput } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { distribute, normalizeName } from '../logic';
	import type { AllocationResult, MatchSuggestion, OpenLine, Transaction } from '../schemas';
	import { BASE, fmtDate } from './helpers';

	let {
		open = $bindable(false),
		transaction,
		onsaved
	}: {
		open?: boolean;
		transaction: Transaction | null;
		onsaved: () => void | Promise<void>;
	} = $props();

	let lines = $state<OpenLine[]>([]);
	let suggestion = $state<MatchSuggestion | null>(null);
	let amounts = $state<Record<string, number>>({});
	let search = $state('');
	let notify = $state(true);
	let loading = $state(false);
	let busy = $state(false);
	let error = $state('');

	const amount = $derived(transaction?.amountCents ?? 0);
	const allocated = $derived(Object.values(amounts).reduce((s, v) => s + (v > 0 ? v : 0), 0));
	const rest = $derived(amount - allocated);

	$effect(() => {
		if (!open || !transaction) return;
		void load(transaction);
	});

	async function load(t: Transaction) {
		loading = true;
		error = '';
		search = '';
		notify = true;
		try {
			const [open, sug] = await Promise.all([
				apiFetch<OpenLine[]>(`${BASE}/open-lines?transactionId=${t.id}`),
				apiFetch<MatchSuggestion | null>(`${BASE}/transactions/${t.id}/suggestion`)
			]);
			lines = open;
			suggestion = sug;
			const initial: Record<string, number> = {};
			for (const a of t.allocations) initial[a.lineId] = a.amountCents;
			if (!t.allocations.length && sug && sug.confidence !== 'low') {
				for (const a of sug.allocations) initial[a.lineId] = a.amountCents;
			}
			amounts = initial;
		} catch (e) {
			error =
				e instanceof ApiClientError ? e.message : 'Offene Posten konnten nicht geladen werden';
		} finally {
			loading = false;
		}
	}

	const visible = $derived.by(() => {
		const q = normalizeName(search);
		const suggested = new Set(suggestion?.allocations.map((a) => a.lineId) ?? []);
		return lines
			.filter(
				(l) =>
					!q ||
					amounts[l.lineId] ||
					normalizeName(`${l.invoiceNumber} ${l.recipientName} ${l.description}`).includes(q)
			)
			.sort(
				(a, b) =>
					Number(!!amounts[b.lineId]) - Number(!!amounts[a.lineId]) ||
					Number(suggested.has(b.lineId)) - Number(suggested.has(a.lineId)) ||
					a.recipientName.localeCompare(b.recipientName, 'de') ||
					a.dueOn.localeCompare(b.dueOn)
			)
			.slice(0, 60);
	});

	function toggle(l: OpenLine, checked: boolean) {
		const next = { ...amounts };
		if (checked) next[l.lineId] = Math.max(0, Math.min(l.openCents, rest));
		else delete next[l.lineId];
		amounts = next;
	}

	function applySuggestion() {
		if (!suggestion) return;
		const next: Record<string, number> = {};
		for (const a of suggestion.allocations) next[a.lineId] = a.amountCents;
		amounts = next;
	}

	function spread() {
		const chosen = lines.filter((l) => l.lineId in amounts);
		const d = distribute(amount, chosen);
		const next: Record<string, number> = {};
		for (const l of chosen) next[l.lineId] = 0;
		for (const a of d.allocations) next[a.lineId] = a.amountCents;
		amounts = next;
	}

	async function save() {
		if (!transaction) return;
		error = '';
		const allocations = Object.entries(amounts)
			.filter(([, v]) => v > 0)
			.map(([lineId, amountCents]) => ({ lineId, amountCents }));
		const over = lines.find((l) => (amounts[l.lineId] ?? 0) > l.openCents);
		if (over) {
			error = `Für ${over.invoiceNumber} sind nur ${formatEuro(over.openCents)} offen.`;
			return;
		}
		if (rest < 0) {
			error = 'Es ist mehr zugeordnet als der Buchungsbetrag.';
			return;
		}
		busy = true;
		try {
			const r = await apiFetch<AllocationResult>(
				`${BASE}/transactions/${transaction.id}/allocations`,
				{ method: 'PUT', body: JSON.stringify({ allocations, notify }) }
			);
			const parts = [`${formatEuro(r.allocatedCents)} zugeordnet`];
			if (r.paidInvoices) parts.push(`${r.paidInvoices} Rechnung(en) vollständig bezahlt`);
			if (r.mailsSent) parts.push(`${r.mailsSent} Bestätigung(en) gesendet`);
			if (r.payer) {
				parts.push(
					r.payer.created ? `Zahler „${r.payer.name}“ angelegt` : `Zahler „${r.payer.name}“ ergänzt`
				);
			}
			toast.success(parts.join(' · '));
			if (r.mailErrors) toast.error(`${r.mailErrors} Mail(s) konnten nicht gesendet werden`);
			open = false;
			await onsaved();
		} catch (e) {
			error = e instanceof ApiClientError ? e.message : 'Speichern fehlgeschlagen';
		} finally {
			busy = false;
		}
	}

	const confidenceLabel = { high: 'Sicher', medium: 'Wahrscheinlich', low: 'Unsicher' } as const;
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Zahlung zuordnen</Dialog.Title>
			<Dialog.Description>
				Verteile den Betrag auf offene Posten – auch auf mehrere Kinder oder Aktionen.
			</Dialog.Description>
		</Dialog.Header>
		{#if transaction}
			<div class="rounded-md border bg-muted/40 p-3 text-sm">
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<span class="font-medium">{transaction.counterparty ?? 'Ohne Gegenpartei'}</span>
					<span class="font-semibold tabular-nums">{formatEuro(transaction.amountCents)}</span>
				</div>
				<div class="text-xs text-muted-foreground">
					{fmtDate(transaction.bookedOn)} · {transaction.accountName}
					{#if transaction.purpose}· {transaction.purpose}{/if}
				</div>
			</div>

			{#if loading}
				<div class="space-y-2">
					<Skeleton class="h-10 w-full" />
					<Skeleton class="h-10 w-full" />
					<Skeleton class="h-10 w-full" />
				</div>
			{:else}
				{#if suggestion}
					<div
						class="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"
						role="note"
					>
						<Sparkles class="size-4 text-primary" aria-hidden="true" />
						<span class="min-w-0 flex-1">
							<span class="font-medium">Vorschlag ({confidenceLabel[suggestion.confidence]}):</span>
							{suggestion.reason} – {suggestion.invoiceNumbers.join(', ')}
						</span>
						<Button size="sm" variant="outline" onclick={applySuggestion}>Übernehmen</Button>
					</div>
				{/if}

				<div class="flex flex-wrap items-center gap-2">
					<Input
						class="min-w-48 flex-1"
						placeholder="Name, Rechnungsnummer oder Posten suchen …"
						aria-label="Offene Posten durchsuchen"
						bind:value={search}
					/>
					<Button
						variant="outline"
						size="sm"
						onclick={spread}
						disabled={!Object.keys(amounts).length}
					>
						Auf Auswahl verteilen
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onclick={() => (amounts = {})}
						disabled={!Object.keys(amounts).length}
					>
						Leeren
					</Button>
				</div>

				{#if !lines.length}
					<p class="py-6 text-center text-sm text-muted-foreground">
						Es gibt keine offenen Posten. Die Zahlung bleibt als nicht zugeordnete Einnahme stehen.
					</p>
				{:else}
					<ul
						class="max-h-[45vh] divide-y overflow-y-auto rounded-md border"
						aria-label="Offene Posten"
					>
						{#each visible as l (l.lineId)}
							{@const checked = l.lineId in amounts}
							<li class="flex flex-wrap items-center gap-3 px-3 py-2">
								<Checkbox
									id={`al-${l.lineId}`}
									{checked}
									onCheckedChange={(v) => toggle(l, v === true)}
									aria-label={`${l.description} auswählen`}
								/>
								<label for={`al-${l.lineId}`} class="min-w-0 flex-1 cursor-pointer text-sm">
									<span class="block truncate font-medium">{l.description}</span>
									<span class="block text-xs text-muted-foreground">
										{l.invoiceNumber} · {l.recipientName} · fällig {fmtDate(l.dueOn)} · offen
										<span class="tabular-nums">{formatEuro(l.openCents)}</span>
									</span>
								</label>
								{#if checked}
									<MoneyInput
										class="w-32"
										label={`Betrag für ${l.description}`}
										cents={amounts[l.lineId] ?? 0}
										max={l.openCents}
										onchange={(c) => (amounts = { ...amounts, [l.lineId]: c })}
									/>
								{/if}
							</li>
						{/each}
					</ul>
					{#if lines.length > visible.length}
						<p class="text-xs text-muted-foreground">
							Weitere Posten über die Suche finden ({lines.length} offen).
						</p>
					{/if}
				{/if}

				<div class="flex flex-wrap items-center justify-between gap-3 text-sm">
					<div class="space-x-3">
						<span>Zugeordnet <strong class="tabular-nums">{formatEuro(allocated)}</strong></span>
						<span class={rest < 0 ? 'text-destructive' : 'text-muted-foreground'}>
							Rest <span class="tabular-nums">{formatEuro(rest)}</span>
						</span>
						{#if rest > 0 && allocated > 0}
							<Badge variant="outline">Rest bleibt als Guthaben/Einnahme</Badge>
						{/if}
					</div>
					<div class="flex items-center gap-2">
						<Switch id="al-notify" bind:checked={notify} />
						<Label for="al-notify">Bestätigung per E-Mail</Label>
					</div>
				</div>
			{/if}
		{/if}
		{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button onclick={save} disabled={busy || loading}>{busy ? 'Speichert …' : 'Speichern'}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
