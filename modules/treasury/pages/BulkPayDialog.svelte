<script lang="ts">
	// Mehrere Auszahlungen auf einmal als bezahlt buchen (je Auszahlung `POST /payables/:id/pay`).
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { Account, Category, Payable } from '../schemas';
	import { BASE, defaultAccountId, todayIso } from './helpers';
	import { runSequential, toastOutcome } from './BulkActions';

	let {
		open = $bindable(false),
		items,
		accounts,
		categories,
		onfinished
	}: {
		open?: boolean;
		/** offene Auszahlungen der Auswahl */
		items: Payable[];
		accounts: Account[];
		categories: Category[];
		/** nach dem Lauf (auch bei Teilfehlern), z. B. Auswahl leeren und neu laden */
		onfinished: () => void | Promise<void>;
	} = $props();

	let accountId = $state<string | null>(null);
	let bookedOn = $state(todayIso());
	let categoryId = $state<string | null>(null);
	let busy = $state(false);
	let done = $state(0);

	// Beim Öffnen vorbelegen
	let wasOpen = false;
	$effect.pre(() => {
		if (open && !wasOpen) {
			accountId = defaultAccountId(accounts);
			bookedOn = todayIso();
			categoryId = null;
			done = 0;
		}
		wasOpen = open;
	});

	const payable = $derived(items.filter((p) => p.openCents > 0 && !p.cancelledAt));
	const total = $derived(payable.reduce((s, p) => s + p.openCents, 0));
	const accountOptions = $derived(
		accounts.filter((a) => !a.archived).map((a) => ({ value: a.id, label: a.name }))
	);
	const categoryOptions = $derived(
		categories
			.filter((c) => !c.archived && (c.kind === 'expense' || c.kind === 'both'))
			.map((c) => ({ value: c.id, label: c.name }))
	);

	async function run() {
		if (!accountId || !bookedOn || !payable.length) return;
		busy = true;
		done = 0;
		const list = [...payable];
		const outcome = await runSequential(
			list,
			(p) => p.recipientName,
			async (p) => {
				await apiFetch(`${BASE}/payables/${p.id}/pay`, {
					method: 'POST',
					body: JSON.stringify({
						accountId,
						bookedOn,
						amountCents: p.openCents,
						categoryId
					})
				});
			},
			(n) => (done = n)
		);
		busy = false;
		toastOutcome(outcome, {
			ok: (n) => `${n} ${n === 1 ? 'Überweisung' : 'Überweisungen'} gebucht`,
			failed: (n) => `${n} ${n === 1 ? 'Überweisung' : 'Überweisungen'} nicht gebucht`
		});
		open = false;
		await onfinished();
	}
</script>

<Dialog.Root
	bind:open={
		() => open,
		(v) => {
			if (!busy) open = v;
		}
	}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Als bezahlt buchen</Dialog.Title>
			<Dialog.Description>
				{payable.length}
				{payable.length === 1 ? 'Auszahlung' : 'Auszahlungen'} · zusammen {formatEuro(total)}. Je
				Auszahlung wird der offene Betrag als Ausgabe gebucht.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-4">
			<FormField label="Von Konto *" id="bp-account">
				<SelectField
					id="bp-account"
					label="Konto"
					options={accountOptions}
					bind:value={accountId}
					disabled={busy}
				/>
			</FormField>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<FormField label="Datum *" id="bp-date">
					<Input id="bp-date" type="date" bind:value={bookedOn} disabled={busy} />
				</FormField>
				<FormField label="Kategorie" id="bp-category">
					<SelectField
						id="bp-category"
						label="Kategorie"
						options={categoryOptions}
						bind:value={categoryId}
						emptyLabel="Automatisch"
						placeholder="Automatisch"
						disabled={busy}
					/>
				</FormField>
			</div>
			<ul class="max-h-48 divide-y overflow-y-auto rounded-md border text-sm">
				{#each payable as p (p.id)}
					<li class="flex items-center justify-between gap-2 px-3 py-1.5">
						<span class="min-w-0 truncate">{p.recipientName}</span>
						<span class="shrink-0 tabular-nums">{formatEuro(p.openCents)}</span>
					</li>
				{/each}
			</ul>
			{#if busy}
				<div class="space-y-1" aria-live="polite">
					<div class="text-xs text-muted-foreground">
						Bucht … {done} von {payable.length}
					</div>
					<div class="h-1.5 overflow-hidden rounded-full bg-muted">
						<div
							class="h-full bg-primary transition-[width]"
							style:width={`${payable.length ? (done / payable.length) * 100 : 0}%`}
						></div>
					</div>
				</div>
			{:else}
				<p class="text-xs text-muted-foreground">
					Legt je Auszahlung eine Ausgabe auf dem Konto an. Die Überweisungen selbst machst du im
					Online-Banking.
				</p>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={busy}>Abbrechen</Button>
			<Button onclick={run} disabled={busy || !accountId || !bookedOn || !payable.length}>
				{busy ? 'Bucht …' : `${payable.length} buchen`}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
