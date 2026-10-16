<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Switch } from '$lib/components/ui/switch';
	import { formatEuro } from '$lib/components/layout/money';
	import type { AllocationResult, MatchSuggestion, Transaction } from '../schemas';
	import { BASE, fmtDate } from './helpers';

	let {
		open = $bindable(false),
		onchanged,
		onmanual
	}: {
		open?: boolean;
		onchanged: () => void | Promise<void>;
		/** Buchung im Zuordnen-Dialog öffnen */
		onmanual: (t: Transaction) => void;
	} = $props();

	type Item = { s: MatchSuggestion; t: Transaction | null; done: boolean };
	let items = $state<Item[]>([]);
	let loading = $state(false);
	let busy = $state<string | null>(null);
	let notify = $state(true);
	let error = $state('');

	$effect(() => {
		if (open) void load();
	});

	async function load() {
		loading = true;
		error = '';
		try {
			const list = await apiFetch<MatchSuggestion[]>(`${BASE}/suggestions`);
			const txs = await Promise.all(
				list.map((s) =>
					apiFetch<Transaction>(`${BASE}/transactions/${s.transactionId}`).catch(() => null)
				)
			);
			items = list.map((s, i) => ({ s, t: txs[i] ?? null, done: false }));
		} catch (e) {
			error = e instanceof ApiClientError ? e.message : 'Vorschläge konnten nicht geladen werden';
		} finally {
			loading = false;
		}
	}

	async function accept(item: Item) {
		busy = item.s.transactionId;
		try {
			const existing =
				item.t?.allocations.map((a) => ({ lineId: a.lineId, amountCents: a.amountCents })) ?? [];
			const r = await apiFetch<AllocationResult>(
				`${BASE}/transactions/${item.s.transactionId}/allocations`,
				{
					method: 'PUT',
					body: JSON.stringify({ allocations: [...existing, ...item.s.allocations], notify })
				}
			);
			item.done = true;
			toast.success(
				`${formatEuro(r.allocatedCents)} zugeordnet${r.mailsSent ? ` · ${r.mailsSent} Bestätigung(en)` : ''}`
			);
			await onchanged();
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Zuordnung fehlgeschlagen');
		} finally {
			busy = null;
		}
	}

	async function acceptAllHigh() {
		for (const it of items.filter((i) => !i.done && i.s.confidence === 'high')) await accept(it);
	}

	const confidence = {
		high: { label: 'Sicher', variant: 'default' },
		medium: { label: 'Wahrscheinlich', variant: 'secondary' },
		low: { label: 'Unsicher', variant: 'outline' }
	} as const;
	const pending = $derived(items.filter((i) => !i.done));
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Zuordnungsvorschläge</Dialog.Title>
			<Dialog.Description>
				Für Einnahmen ohne Zuordnung: Rechnungsnummer, Namen (auch Geschwister) und Betrag werden
				verglichen. Nichts wird ohne deine Bestätigung gebucht.
			</Dialog.Description>
		</Dialog.Header>
		{#if loading}
			<div class="space-y-2">
				<Skeleton class="h-16 w-full" />
				<Skeleton class="h-16 w-full" />
			</div>
		{:else if !items.length}
			<p class="py-6 text-center text-sm text-muted-foreground">
				Keine Vorschläge – alle Einnahmen sind zugeordnet oder passen zu keiner offenen Rechnung.
			</p>
		{:else}
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div class="flex items-center gap-2">
					<Switch id="sg-notify" bind:checked={notify} />
					<Label for="sg-notify">Bestätigungen per E-Mail</Label>
				</div>
				<Button
					size="sm"
					onclick={acceptAllHigh}
					disabled={!!busy || !pending.some((i) => i.s.confidence === 'high')}
				>
					Alle sicheren übernehmen
				</Button>
			</div>
			<ul class="space-y-2">
				{#each items as it (it.s.transactionId)}
					<li class="rounded-md border p-3 text-sm" class:opacity-60={it.done}>
						<div class="flex flex-wrap items-start justify-between gap-2">
							<div class="min-w-0">
								<div class="font-medium">
									{it.t?.counterparty ?? 'Einnahme'} · {fmtDate(it.t?.bookedOn)}
								</div>
								<div class="truncate text-xs text-muted-foreground">{it.t?.purpose ?? ''}</div>
							</div>
							<span class="font-semibold tabular-nums">{formatEuro(it.t?.amountCents ?? 0)}</span>
						</div>
						<div class="mt-2 flex flex-wrap items-center gap-2">
							<Badge variant={confidence[it.s.confidence].variant}>
								{confidence[it.s.confidence].label}
							</Badge>
							<span class="min-w-0 flex-1 text-xs text-muted-foreground">
								{it.s.reason}: {it.s.invoiceNumbers.join(', ')} ({formatEuro(
									it.s.allocations.reduce((a, x) => a + x.amountCents, 0)
								)})
							</span>
							{#if it.done}
								<Badge variant="secondary">Übernommen</Badge>
							{:else}
								<Button
									size="sm"
									variant="ghost"
									onclick={() => it.t && onmanual(it.t)}
									disabled={!it.t}
								>
									Anpassen
								</Button>
								<Button size="sm" onclick={() => accept(it)} disabled={!!busy}>
									{busy === it.s.transactionId ? 'Speichert …' : 'Übernehmen'}
								</Button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
		{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Schließen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
