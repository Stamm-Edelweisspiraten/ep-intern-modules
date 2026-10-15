<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Check from '@lucide/svelte/icons/check';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Table from '$lib/components/ui/table';
	import { ConfirmDialog } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { fmtDate } from './format';
	import type { RefundMode, RefundState } from './refund-types';

	let {
		open = $bindable(false),
		actionId,
		editable,
		onchanged
	}: {
		open?: boolean;
		actionId: string;
		/** Bearbeitungsrecht und Abrechnung offen */
		editable: boolean;
		onchanged: () => void | Promise<void>;
	} = $props();

	const url = $derived(`/modules/actions/actions/${actionId}/accounting/refund`);
	const MAX_NAMES = 300;
	const MAX_NAME_LEN = 80;
	const SEP = /[\r\n,;]+/;

	let data = $state<RefundState | null>(null);
	let loading = $state(false);
	let error = $state('');
	let busy = $state(false);
	let undoOpen = $state(false);
	let mode = $state<RefundMode>('auto');
	let names = $state<string[]>([]);
	let nameInput = $state('');
	let autoNames = $state<string[]>([]);
	let inputHint = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	function errMsg(e: unknown, fallback: string) {
		return e instanceof ApiClientError ? e.message : fallback;
	}

	async function load() {
		const mine = ++seq;
		loading = true;
		try {
			const q = mode === 'manual' ? `?count=${Math.max(names.length, 1)}` : '';
			const res = await apiFetch<RefundState>(url + q);
			if (mine !== seq) return;
			data = res;
			if (mode === 'auto' && !res.booked) autoNames = res.items.map((i) => i.name);
			error = '';
		} catch (e) {
			if (mine !== seq) return;
			error = errMsg(e, 'Rückzahlung konnte nicht geladen werden');
		} finally {
			if (mine === seq) loading = false;
		}
	}

	// Beim Oeffnen frisch laden und Modus zuruecksetzen
	$effect(() => {
		if (!open) return;
		// nur auf `open` reagieren: load() liest mode/count, das darf den Effekt nicht erneut ausloesen
		untrack(() => {
			mode = 'auto';
			names = [];
			nameInput = '';
			autoNames = [];
			inputHint = '';
			data = null;
			error = '';
			void load();
		});
		return () => clearTimeout(timer);
	});

	function setMode(m: RefundMode) {
		if (m === mode) return;
		mode = m;
		clearTimeout(timer);
		if (m === 'manual' && names.length === 0 && autoNames.length) {
			names = autoNames.slice(0, MAX_NAMES);
		}
		void load();
	}

	function schedulePreview() {
		clearTimeout(timer);
		if (names.length < 1) return;
		timer = setTimeout(() => void load(), 300);
	}

	function addNames() {
		inputHint = '';
		const parts = nameInput
			.split(SEP)
			.map((p) => p.trim())
			.filter(Boolean);
		if (!parts.length) {
			nameInput = '';
			return;
		}
		const next = [...names];
		let cut = false;
		for (const p of parts) {
			if (next.length >= MAX_NAMES) {
				cut = true;
				break;
			}
			if (p.length > MAX_NAME_LEN) cut = true;
			next.push(p.slice(0, MAX_NAME_LEN));
		}
		names = next;
		nameInput = '';
		if (cut)
			inputHint = `Höchstens ${MAX_NAMES} Namen mit je ${MAX_NAME_LEN} Zeichen; Überhang wurde gekürzt.`;
		schedulePreview();
	}

	function removeName(i: number) {
		names = names.filter((_, idx) => idx !== i);
		inputHint = '';
		schedulePreview();
	}

	function adoptAuto() {
		names = autoNames.slice(0, MAX_NAMES);
		inputHint = '';
		schedulePreview();
	}

	function onPaste(e: ClipboardEvent) {
		const text = e.clipboardData?.getData('text') ?? '';
		if (!SEP.test(text)) return;
		e.preventDefault();
		nameInput = text;
		addNames();
	}

	function onNameKey(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			addNames();
		}
	}

	async function book() {
		busy = true;
		try {
			await apiFetch(url, {
				method: 'POST',
				body: JSON.stringify(mode === 'manual' ? { names } : {})
			});
			toast.success('Rückzahlung eingetragen');
			open = false;
			await onchanged();
		} catch (e) {
			toast.error(errMsg(e, 'Eintragen fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function undo() {
		busy = true;
		try {
			await apiFetch(url, { method: 'DELETE' });
			toast.success('Rückzahlung zurückgenommen');
			open = false;
			await onchanged();
		} catch (e) {
			toast.error(errMsg(e, 'Zurücknehmen fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	const booked = $derived(data?.booked ?? null);
	const shown = $derived(
		booked
			? {
					surplusCents: booked.surplusCents,
					totalCents: booked.totalCents,
					remainderCents: booked.remainderCents,
					items: booked.items,
					count: booked.count ?? booked.items.length,
					perHeadCents: booked.perHeadCents ?? booked.items[0]?.amountCents ?? 0
				}
			: data
				? {
						surplusCents: data.surplusCents,
						totalCents: data.totalCents,
						remainderCents: data.remainderCents,
						items: data.items,
						count: data.count,
						perHeadCents: data.perHeadCents
					}
				: null
	);
	const showList = $derived(!booked && mode === 'auto');
	const countLabel = (n: number) => (n === 1 ? '1 Person' : `${n} Personen`);
	const minLabel = $derived(formatEuro(data?.minPerHeadCents ?? 500));
</script>

{#snippet stat(label: string, value: string)}
	<div>
		<div class="text-xs text-muted-foreground">{label}</div>
		<div class="font-semibold tabular-nums">{value}</div>
	</div>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[90vh] w-full max-w-full overflow-y-auto sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Rückzahlung des Überschusses</Dialog.Title>
			<Dialog.Description>
				Gleicher Betrag je Person, auf ganze Euro abgerundet; der Rest bleibt in der Stammkasse.
			</Dialog.Description>
		</Dialog.Header>

		{#if loading && !data}
			<div class="space-y-3" aria-busy="true" aria-label="Lade Rückzahlung">
				<Skeleton class="h-10 w-full" />
				<Skeleton class="h-24 w-full" />
			</div>
		{:else if error && !data}
			<div class="space-y-3">
				<p class="text-sm text-destructive" role="alert">{error}</p>
				<Button variant="outline" onclick={load}>Erneut versuchen</Button>
			</div>
		{:else if data && shown}
			<div class="space-y-4">
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div>
						<div class="text-xs text-muted-foreground">Überschuss</div>
						<div class="text-2xl font-semibold tabular-nums">
							{formatEuro(shown.surplusCents)}
						</div>
					</div>
					{#if booked}
						<div
							class="flex items-center gap-2 rounded-lg border border-green-600/30 bg-green-600/10 px-3 py-2 text-sm font-medium"
							role="status"
						>
							<Check class="size-4" aria-hidden="true" />
							Gebucht am {fmtDate(booked.bookedAt)}
						</div>
					{/if}
				</div>

				{#if !booked}
					<fieldset class="space-y-2" disabled={busy}>
						<legend class="sr-only">Berechnungsgrundlage</legend>
						<div
							class="grid grid-cols-1 gap-1 rounded-lg border p-1 sm:grid-cols-2"
							role="radiogroup"
						>
							{#each [{ v: 'auto', t: `Aus Anmeldungen (${data.autoCount} ${data.autoCount === 1 ? 'Person' : 'Personen'})` }, { v: 'manual', t: 'Namen selbst eintragen' }] as opt (opt.v)}
								<button
									type="button"
									role="radio"
									aria-checked={mode === opt.v}
									class="rounded-md px-3 py-2 text-left text-sm transition-colors {mode === opt.v
										? 'bg-primary text-primary-foreground'
										: 'hover:bg-accent'}"
									onclick={() => setMode(opt.v as RefundMode)}
								>
									{opt.t}
								</button>
							{/each}
						</div>
						{#if mode === 'manual'}
							<div class="space-y-2">
								<label class="text-sm" for="refund-name">Name hinzufügen</label>
								<div class="flex gap-2">
									<Input
										id="refund-name"
										bind:value={nameInput}
										placeholder="Name (mehrere mit Komma oder Zeilenumbruch)"
										autocomplete="off"
										onkeydown={onNameKey}
										onpaste={onPaste}
									/>
									<Button type="button" variant="outline" onclick={addNames}>Hinzufügen</Button>
								</div>
								{#if inputHint}<p class="text-xs text-muted-foreground" role="status">
										{inputHint}
									</p>{/if}
								<div class="flex flex-wrap items-center justify-between gap-2">
									<span class="text-sm font-medium">{countLabel(names.length)}</span>
									{#if autoNames.length}
										<Button type="button" variant="ghost" size="sm" onclick={adoptAuto}>
											Aus Anmeldungen übernehmen
										</Button>
									{/if}
								</div>
								{#if names.length}
									<ul class="max-h-48 divide-y overflow-auto rounded-lg border text-sm">
										{#each names as n, i (i)}
											<li class="flex items-center justify-between gap-2 px-3 py-1.5">
												<span class="truncate">{n}</span>
												<Button
													type="button"
													variant="ghost"
													size="sm"
													aria-label={`${n} entfernen`}
													onclick={() => removeName(i)}
												>
													Entfernen
												</Button>
											</li>
										{/each}
									</ul>
								{:else}
									<p class="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
										Mindestens einen Namen eintragen.
									</p>
								{/if}
							</div>
						{/if}
					</fieldset>
				{:else}
					<p class="text-sm text-muted-foreground">
						{booked.mode === 'manual' ? 'Namen selbst eingetragen' : 'Aus Anmeldungen'}:
						{countLabel(shown.count)}
					</p>
				{/if}

				<div
					class="grid grid-cols-2 gap-4 transition-opacity sm:grid-cols-3"
					class:opacity-60={loading}
					aria-live="polite"
				>
					{@render stat('Betrag je Person', formatEuro(shown.perHeadCents))}
					{@render stat('Summe', formatEuro(shown.totalCents))}
					{@render stat('Rest in der Stammkasse', formatEuro(shown.remainderCents))}
				</div>

				{#if showList}
					{#if shown.items.length}
						<div class="max-h-60 overflow-auto rounded-lg border">
							<Table.Root>
								<caption class="sr-only">Rückzahlung je Teilnehmende*r</caption>
								<Table.Header>
									<Table.Row>
										<Table.Head>Teilnehmende*r</Table.Head>
										<Table.Head class="text-right">Rückzahlung</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each shown.items as it (it.participantId)}
										<Table.Row>
											<Table.Cell>{it.name}</Table.Cell>
											<Table.Cell class="text-right tabular-nums">
												{formatEuro(it.amountCents)}
											</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						</div>
					{:else}
						<p class="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
							Es gibt keine zahlenden Teilnehmenden oder keinen auszahlbaren Betrag.
						</p>
					{/if}
				{:else if booked && booked.items.length}
					<div class="max-h-60 overflow-auto rounded-lg border">
						<Table.Root>
							<caption class="sr-only">Rückzahlung je Teilnehmende*r</caption>
							<Table.Body>
								{#each booked.items as it, i (i)}
									<Table.Row>
										<Table.Cell>{it.name}</Table.Cell>
										<Table.Cell class="text-right tabular-nums">
											{formatEuro(it.amountCents)}
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
				{/if}

				{#if !booked && (data.blockers.length || !data.thresholdOk)}
					<div class="space-y-1 text-sm">
						<p class="font-medium">Noch nicht möglich, weil:</p>
						<ul class="list-disc space-y-0.5 pl-5 text-muted-foreground">
							{#each data.blockers as b (b)}<li>{b}</li>{/each}
							{#if !data.thresholdOk && !data.blockers.some((b) => b.includes('5'))}
								<li>
									je Person bleiben höchstens {minLabel} (Mindestbetrag je Person ist nicht erreicht)
								</li>
							{/if}
						</ul>
					</div>
				{/if}
			</div>

			<Dialog.Footer class="gap-2">
				<Button variant="outline" onclick={() => (open = false)}>Schließen</Button>
				{#if editable}
					{#if booked}
						<Button variant="outline" disabled={busy} onclick={() => (undoOpen = true)}>
							<Undo2 /> Rückzahlung zurücknehmen
						</Button>
					{:else if data.canBook}
						<Button
							disabled={busy || loading || (mode === 'manual' && names.length < 1)}
							onclick={book}
						>
							{busy ? 'Trägt ein …' : 'Als Buchung eintragen'}
						</Button>
					{/if}
				{/if}
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={undoOpen}
	title="Rückzahlung zurücknehmen?"
	description="Die Rückzahlungs-Buchung wird gelöscht. Der Überschuss wird danach neu berechnet."
	confirmLabel="Zurücknehmen"
	destructive
	onconfirm={undo}
/>
