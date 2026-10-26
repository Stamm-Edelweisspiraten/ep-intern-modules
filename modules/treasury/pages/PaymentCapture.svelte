<script lang="ts" module>
	/** Vorbelegung: Familie/Person aus „Offene Posten“ bzw. die Rechnung, aus der gestartet wurde */
	export interface PaymentPreset {
		/** `OpenItemsGroup.key` (Gruppierung nach Familie/Person) */
		groupKey?: string;
		invoiceId?: string;
	}
</script>

<script lang="ts">
	// „Zahlung erfassen“ für Handy und Tablet: Bar- oder Überweisungseingang zu offenen Rechnungen.
	// Handy: Blatt in 3 Schritten (Betrag → Wer → Zuordnen). Tablet: ein zweispaltiger Dialog.
	// Gebucht wird über `POST /transactions` mit direkter Zuordnung (eine DB-Transaktion).
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Check from '@lucide/svelte/icons/check';
	import Delete from '@lucide/svelte/icons/delete';
	import Search from '@lucide/svelte/icons/search';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import {
		BottomSheet,
		ChoiceChips,
		ErrorState,
		ListRow,
		LoadingState,
		MoneyInput,
		TouchList,
		toastWithUndo,
		BUSY_SAVE
	} from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { formatDateDe } from '$lib/sdk/dates';
	import type {
		Account,
		OpenItems,
		OpenItemsGroup,
		OpenLine,
		TransactionCreated
	} from '../schemas';
	import { BASE, defaultAccountId, errorMessage, todayIso } from './helpers';
	import {
		distributeOverLines,
		linesOfGroup,
		paymentCandidates,
		pressKey
	} from './payment-capture';

	let {
		open = $bindable(false),
		variant,
		accounts,
		preset = null,
		onsaved
	}: {
		open?: boolean;
		variant: 'sheet' | 'dialog';
		accounts: Account[];
		preset?: PaymentPreset | null;
		onsaved: () => void | Promise<void>;
	} = $props();

	let step = $state<1 | 2 | 3>(1);
	let amountCents = $state(0);
	let accountId = $state<string | null>(null);
	let bookedOn = $state(todayIso());
	let groupKey = $state<string | null>(null);
	let assigned = $state<Record<string, number>>({});
	let notify = $state(true);
	let keep = $state(false);
	let search = $state('');
	let busy = $state(false);

	let groups = $state<OpenItemsGroup[]>([]);
	let lines = $state<OpenLine[]>([]);
	let loading = $state(false);
	let loadError = $state('');

	const activeAccounts = $derived(accounts.filter((a) => !a.archived));
	const accountOptions = $derived(activeAccounts.map((a) => ({ value: a.id, label: a.name })));
	const group = $derived(groups.find((g) => g.key === groupKey) ?? null);

	async function load() {
		loading = true;
		loadError = '';
		try {
			const [items, open] = await Promise.all([
				apiFetch<OpenItems>(`${BASE}/open-items?groupBy=payer&overdue=0`),
				apiFetch<OpenLine[]>(`${BASE}/open-lines`)
			]);
			groups = items.groups.filter((g) => g.openCents > 0);
			lines = open;
		} catch (e) {
			loadError = errorMessage(e, 'Offene Posten konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	/** Gruppe zur Vorbelegung (Gruppe oder Rechnung) */
	function presetGroup(): OpenItemsGroup | null {
		if (!preset) return null;
		if (preset.groupKey) return groups.find((g) => g.key === preset.groupKey) ?? null;
		if (preset.invoiceId) {
			return groups.find((g) => g.invoices.some((i) => i.id === preset.invoiceId)) ?? null;
		}
		return null;
	}

	function reset(keepBasics: boolean) {
		step = 1;
		amountCents = 0;
		groupKey = null;
		assigned = {};
		notify = true;
		search = '';
		if (!keepBasics) {
			accountId = defaultAccountId(accounts);
			bookedOn = todayIso();
			keep = false;
		}
	}

	// Beim Öffnen frisch laden und vorbelegen
	$effect(() => {
		if (!open) return;
		untrack(() => start());
	});
	function start() {
		reset(false);
		void load().then(() => {
			const g = presetGroup();
			if (!g) return;
			groupKey = g.key;
			amountCents = preset?.invoiceId
				? (g.invoices.find((i) => i.id === preset.invoiceId)?.openCents ?? g.openCents)
				: g.openCents;
			autoAssign();
		});
	}

	// --- Betrag (Tastenfeld auf dem Handy) -------------------------------------------
	const press = (key: string) => (amountCents = pressKey(amountCents, key));
	const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'];

	// --- Zahler -------------------------------------------------------------------
	const candidates = $derived(paymentCandidates(groups, search, amountCents));

	function subtitleOf(g: OpenItemsGroup): string {
		const people = [...new Set(g.invoices.flatMap((i) => i.people))].slice(0, 3).join(', ');
		const n = g.invoices.length;
		return [people, `${n} ${n === 1 ? 'Rechnung' : 'Rechnungen'}`].filter(Boolean).join(' · ');
	}

	function pick(g: OpenItemsGroup) {
		groupKey = g.key;
		if (amountCents === 0) amountCents = g.openCents;
		autoAssign();
		if (variant === 'sheet') step = 3;
	}

	// --- Zuordnung ----------------------------------------------------------------
	const groupLines = $derived(linesOfGroup(group, lines, preset?.invoiceId));
	const assignedCents = $derived(groupLines.reduce((s, l) => s + (assigned[l.lineId] ?? 0), 0));
	const restCents = $derived(Math.max(0, amountCents - assignedCents));

	/** Betrag der Reihe nach (älteste Fälligkeit zuerst) auf die Posten verteilen */
	function autoAssign() {
		assigned = distributeOverLines(amountCents, groupLines);
	}

	function toggleLine(l: OpenLine) {
		if (assigned[l.lineId]) {
			const rest = { ...assigned };
			delete rest[l.lineId];
			assigned = rest;
			return;
		}
		const take = Math.min(l.openCents, restCents);
		if (take > 0) assigned = { ...assigned, [l.lineId]: take };
		else toast.info('Der Betrag ist schon vollständig zugeordnet.');
	}

	const canSave = $derived(amountCents > 0 && !!accountId && !!group && assignedCents > 0 && !busy);

	async function save() {
		if (!canSave || !group || !accountId) return;
		busy = true;
		try {
			const allocations = groupLines
				.filter((l) => (assigned[l.lineId] ?? 0) > 0)
				.map((l) => ({ lineId: l.lineId, amountCents: assigned[l.lineId]! }));
			const numbers = [
				...new Set(groupLines.filter((l) => assigned[l.lineId]).map((l) => l.invoiceNumber))
			];
			const created = await apiFetch<TransactionCreated>(`${BASE}/transactions`, {
				method: 'POST',
				body: JSON.stringify({
					accountId,
					bookedOn,
					amountCents,
					counterparty: group.label,
					purpose: numbers.join(', ') || null,
					payerId: group.payerId,
					allocations,
					notify
				})
			});
			const r = created.allocation;
			const parts = [`${formatEuro(amountCents)} von ${group.label} gebucht`];
			if (r?.paidInvoices) parts.push(`${r.paidInvoices} Rechnung(en) bezahlt`);
			if (r?.mailsSent) {
				// Bestätigung ist schon raus – Rückgängig wäre irreführend
				parts.push(`${r.mailsSent} Bestätigung(en) gesendet`);
				toast.success(parts.join(' · '));
			} else {
				toastWithUndo({
					message: parts.join(' · '),
					undo: () => apiFetch(`${BASE}/transactions/${created.id}`, { method: 'DELETE' }),
					undone: 'Buchung gelöscht',
					onundone: onsaved
				});
			}
			if (r?.mailErrors) toast.error(`${r.mailErrors} Mail(s) konnten nicht gesendet werden`);
			await onsaved();
			if (keep) {
				reset(true);
				await load();
			} else {
				open = false;
			}
		} catch (e) {
			toast.error(errorMessage(e, 'Zahlung konnte nicht gebucht werden'));
		} finally {
			busy = false;
		}
	}

	function next() {
		if (step === 1 && group) {
			autoAssign();
			step = 3;
		} else if (step === 1) step = 2;
		else if (step === 2 && group) {
			autoAssign();
			step = 3;
		} else if (step === 3) void save();
	}
	function back() {
		if (step === 3) step = 2;
		else if (step === 2) step = 1;
	}
	const nextLabel = $derived(
		step === 3 ? (busy ? BUSY_SAVE : `Zahlung buchen · ${formatEuro(amountCents)}`) : 'Weiter'
	);
	const nextDisabled = $derived(
		step === 1 ? amountCents <= 0 || !accountId : step === 2 ? !group : !canSave
	);
	const accountName = $derived(activeAccounts.find((a) => a.id === accountId)?.name ?? '');
	const STEPS = ['Betrag', 'Wer', 'Zuordnen'] as const;
</script>

{#snippet accountPicker()}
	{#if accountOptions.length > 1}
		<ChoiceChips
			class="px-0"
			legend="Konto"
			options={accountOptions}
			value={accountId ?? ''}
			onchange={(v) => (accountId = v)}
		/>
	{/if}
{/snippet}

{#snippet payerList()}
	<label
		class="flex h-11 items-center gap-2 rounded-lg border bg-background px-3 text-muted-foreground"
	>
		<Search class="size-4.5 shrink-0" aria-hidden="true" />
		<input
			type="search"
			class="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none"
			placeholder="Name, Familie oder Rechnungsnr."
			aria-label="Zahler*in suchen"
			bind:value={search}
		/>
	</label>
	{#if loading}
		<LoadingState rows={4} />
	{:else if loadError}
		<ErrorState compact message={loadError} onretry={load} />
	{:else if !candidates.length}
		<p class="py-6 text-center text-sm text-muted-foreground">
			{search ? 'Niemand passt zur Suche.' : 'Es gibt keine offenen Rechnungen.'}
		</p>
	{:else}
		<TouchList label="Offene Rechnungen nach Familie/Person">
			{#each candidates as g (g.key)}
				<ListRow
					title={g.label}
					subtitle={subtitleOf(g)}
					amount={formatEuro(g.openCents)}
					selecting
					selected={g.key === groupKey}
					onclick={() => pick(g)}
				>
					{#snippet trailing()}
						{#if amountCents > 0 && g.openCents === amountCents}
							<Badge variant="success">passt</Badge>
						{/if}
					{/snippet}
				</ListRow>
			{/each}
		</TouchList>
	{/if}
{/snippet}

{#snippet allocation()}
	{#if group}
		<TouchList heading="Offene Posten">
			{#each groupLines as l (l.lineId)}
				{@const on = (assigned[l.lineId] ?? 0) > 0}
				<ListRow
					title={`${l.invoiceNumber} · ${l.description}`}
					subtitle={`offen ${formatEuro(l.openCents)} · fällig ${formatDateDe(l.dueOn)}`}
					amount={on ? formatEuro(assigned[l.lineId]!) : '–'}
					amountClass={on ? '' : 'text-muted-foreground font-normal'}
					selecting
					selected={on}
					onclick={() => toggleLine(l)}
				/>
			{/each}
		</TouchList>
		<dl class="divide-y rounded-xl border bg-card px-3.5 text-sm">
			<div class="flex justify-between gap-3 py-2">
				<dt class="text-muted-foreground">Zugeordnet</dt>
				<dd class="font-semibold tabular-nums">{formatEuro(assignedCents)}</dd>
			</div>
			<div class="flex justify-between gap-3 py-2">
				<dt class="text-muted-foreground">Rest (bleibt ohne Zuordnung)</dt>
				<dd class="font-semibold tabular-nums">{formatEuro(restCents)}</dd>
			</div>
		</dl>
		<div class="flex min-h-12 items-center gap-3">
			<Switch id="pc-notify" bind:checked={notify} />
			<Label for="pc-notify">Zahlungsbestätigung per Mail (wenn vollständig bezahlt)</Label>
		</div>
	{/if}
{/snippet}

{#if variant === 'sheet'}
	<BottomSheet
		bind:open
		title="Zahlung erfassen"
		size="tall"
		onback={step > 1 ? back : undefined}
		backLabel="Schritt zurück"
	>
		<ol class="flex gap-1.5 px-5 pb-3" aria-label="Schritte">
			{#each STEPS as label, i (label)}
				{@const n = i + 1}
				<li
					class="flex flex-1 flex-col gap-1.5 text-xs font-medium {n <= step
						? 'font-bold text-link'
						: 'text-muted-foreground'}"
					aria-current={n === step ? 'step' : undefined}
				>
					<span class="h-1 rounded-full {n <= step ? 'bg-primary' : 'bg-border'}"></span>
					{label}
				</li>
			{/each}
		</ol>
		<div class="flex flex-col gap-4 px-5 pb-4">
			{#if step === 1}
				<output
					class="block pt-2 text-center text-5xl font-bold tracking-tight tabular-nums"
					aria-live="polite"
					aria-label="Betrag">{formatEuro(amountCents)}</output
				>
				{#if group && amountCents !== group.openCents}
					<div class="flex justify-center">
						<Button variant="outline" size="sm" onclick={() => (amountCents = group.openCents)}>
							Offener Betrag {formatEuro(group.openCents)}
						</Button>
					</div>
				{/if}
				{@render accountPicker()}
				<div class="flex items-center justify-between gap-3">
					<Label for="pc-date">Datum</Label>
					<Input id="pc-date" type="date" class="w-44" bind:value={bookedOn} />
				</div>
				<div class="grid grid-cols-3 gap-2">
					{#each keys as k (k)}
						<button
							type="button"
							class="flex h-14 items-center justify-center rounded-lg bg-muted text-2xl font-semibold active:brightness-90"
							aria-label={k === 'back' ? 'Letzte Ziffer löschen' : k}
							onclick={() => press(k)}
						>
							{#if k === 'back'}<Delete class="size-6" />{:else}{k}{/if}
						</button>
					{/each}
				</div>
			{:else if step === 2}
				<p class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
					Passt zum Betrag {formatEuro(amountCents)}
				</p>
				{@render payerList()}
			{:else if group}
				<div class="flex items-center justify-between gap-3 rounded-xl border bg-card p-3.5">
					<div class="flex min-w-0 flex-col">
						<strong class="truncate">{group.label}</strong>
						<span class="text-sm text-muted-foreground"
							>{accountName} · {formatDateDe(bookedOn)}</span
						>
					</div>
					<strong class="text-xl tabular-nums">{formatEuro(amountCents)}</strong>
				</div>
				{@render allocation()}
			{/if}
		</div>
		{#snippet footer()}
			<div class="flex flex-col gap-2 pb-1">
				{#if step === 3}
					<div class="flex min-h-10 items-center gap-3">
						<Switch id="pc-keep" bind:checked={keep} />
						<Label for="pc-keep">Danach weitere Zahlung erfassen</Label>
					</div>
				{/if}
				<Button class="h-12 w-full text-base" disabled={nextDisabled} onclick={next}>
					{#if step === 3 && !busy}<Check />{/if}
					{nextLabel}
				</Button>
			</div>
		{/snippet}
	</BottomSheet>
{:else}
	<Dialog.Root bind:open>
		<Dialog.Content class="sm:max-w-3xl">
			<Dialog.Header>
				<Dialog.Title>Zahlung erfassen</Dialog.Title>
				<Dialog.Description>Bar oder Überweisung zu offenen Rechnungen buchen.</Dialog.Description>
			</Dialog.Header>
			<div class="grid gap-6 sm:grid-cols-2">
				<div class="flex min-w-0 flex-col gap-4">
					<div class="flex flex-col gap-1.5">
						<Label for="pc-amount">Betrag</Label>
						<MoneyInput
							id="pc-amount"
							label="Betrag in Euro"
							bind:cents={amountCents}
							onchange={() => autoAssign()}
						/>
					</div>
					{@render accountPicker()}
					<div class="flex flex-col gap-1.5">
						<Label for="pc-date-d">Datum</Label>
						<Input id="pc-date-d" type="date" bind:value={bookedOn} />
					</div>
					<div class="flex flex-col gap-2">
						<span class="text-sm font-medium">Wer hat gezahlt?</span>
						<div class="flex max-h-80 flex-col gap-2 overflow-y-auto">
							{@render payerList()}
						</div>
					</div>
				</div>
				<div class="flex min-w-0 flex-col gap-4">
					<span class="text-sm font-medium">Zuordnen zu offenen Posten</span>
					{#if group}
						{@render allocation()}
					{:else}
						<p class="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
							Links auswählen, wer gezahlt hat – die offenen Posten erscheinen hier und werden
							automatisch vorbelegt.
						</p>
					{/if}
				</div>
			</div>
			<Dialog.Footer class="items-center gap-3 sm:justify-between">
				<div class="flex items-center gap-3">
					<Switch id="pc-keep-d" bind:checked={keep} />
					<Label for="pc-keep-d">Weitere Zahlung erfassen</Label>
				</div>
				<div class="flex gap-2">
					<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
					<Button disabled={!canSave} onclick={save}>
						{busy ? BUSY_SAVE : 'Zahlung buchen'}
					</Button>
				</div>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}
