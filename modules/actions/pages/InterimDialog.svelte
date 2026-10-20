<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SummaryList, type SummaryRow } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { AccountingEntry } from '../schemas';
	import { REFUND_CATEGORY } from './refund-types';

	let {
		open = $bindable(false),
		actionId,
		entries,
		nextNumber,
		viaTreasury = false,
		onsaved
	}: {
		open?: boolean;
		actionId: string;
		/** alle Buchungen der Abrechnung – die Zwischenabrechnung hält den gesamten Stand fest */
		entries: AccountingEntry[];
		/** Nummer der neuen Zwischenabrechnung (nur Anzeige) */
		nextNumber: number;
		/** Kasse aktiv: enthaltene Auslagen gehen dort als Auszahlung ein */
		viaTreasury?: boolean;
		onsaved: () => void | Promise<void>;
	} = $props();

	const NOTE_MAX = 300;

	let note = $state('');
	let accept = $state(false);
	let busy = $state(false);
	let error = $state('');

	$effect(() => {
		if (!open) return;
		note = '';
		accept = false;
		error = '';
	});

	const isRefund = (e: AccountingEntry) => (e.category as string) === REFUND_CATEGORY;
	const income = $derived(
		entries.filter((e) => e.type === 'income').reduce((s, e) => s + e.amountCents, 0)
	);
	const expense = $derived(
		entries.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amountCents, 0)
	);
	const missing = $derived(
		entries.filter((e) => e.type === 'expense' && !e.receipt && !isRefund(e))
	);

	/** Noch nicht erstattete Auslagen je Person */
	const reimbursements = $derived.by(() => {
		const m = new Map<string, { name: string; cents: number; count: number }>();
		for (const e of entries) {
			if (e.type !== 'expense' || e.paidBy !== 'person' || !e.payee || e.reimbursedAt) continue;
			const cur = m.get(e.payee.id) ?? { name: e.payee.name, cents: 0, count: 0 };
			cur.cents += e.amountCents;
			cur.count += 1;
			m.set(e.payee.id, cur);
		}
		return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
	});
	const reimbTotal = $derived(reimbursements.reduce((s, r) => s + r.cents, 0));

	const rows = $derived.by((): SummaryRow[] => {
		const out: SummaryRow[] = [
			{ label: 'Buchungen', value: String(entries.length) },
			{ label: 'Einnahmen', value: formatEuro(income) },
			{ label: 'Ausgaben', value: formatEuro(expense), negative: true },
			{
				label: 'Saldo (Einnahmen − Ausgaben)',
				value: formatEuro(income - expense),
				emphasis: 'strong'
			}
		];
		if (reimbursements.length) {
			out.push({
				label: `Offene Auslagen (${reimbursements.length} ${reimbursements.length === 1 ? 'Person' : 'Personen'})`,
				value: formatEuro(reimbTotal),
				details: reimbursements.map((r) => ({
					label: `${r.name} (${r.count} ${r.count === 1 ? 'Beleg' : 'Belege'})`,
					value: formatEuro(r.cents)
				}))
			});
		}
		return out;
	});

	const blocked = $derived(entries.length === 0 || (missing.length > 0 && !accept));

	async function submit(ev: SubmitEvent) {
		ev.preventDefault();
		if (blocked || busy) return;
		busy = true;
		error = '';
		try {
			const trimmed = note.trim();
			await apiFetch(`/modules/actions/actions/${actionId}/accounting/interims`, {
				method: 'POST',
				body: JSON.stringify({
					acceptMissingReceipts: missing.length > 0 && accept,
					note: trimmed ? trimmed : null
				})
			});
			toast.success(`Zwischenabrechnung Nr. ${nextNumber} erstellt`);
			open = false;
			await onsaved();
		} catch (e) {
			error = e instanceof ApiClientError ? e.message : 'Zwischenabrechnung fehlgeschlagen';
			if (e instanceof ApiClientError && e.status === 409) await onsaved();
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="w-full max-w-full overflow-y-auto sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Zwischenabrechnung Nr. {nextNumber}</Dialog.Title>
			<Dialog.Description>
				Hält den aktuellen Stand der Abrechnung fest. Buchungen bleiben änderbar; enthaltene
				Auslagen gehen zur Auszahlung an die Kasse.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit}>
			{#if entries.length === 0}
				<p class="text-sm text-muted-foreground">
					Es gibt noch keine Buchungen, die festgehalten werden können.
				</p>
			{:else}
				<SummaryList {rows} />

				{#if missing.length > 0}
					<div class="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2">
						<p class="text-sm">
							{missing.length === 1
								? 'Eine Ausgabe hat keinen Beleg:'
								: `${missing.length} Ausgaben haben keinen Beleg:`}
						</p>
						<ul class="list-disc pl-5 text-xs text-muted-foreground">
							{#each missing.slice(0, 5) as e (e.id)}
								<li>{e.description} ({formatEuro(e.amountCents)})</li>
							{/each}
							{#if missing.length > 5}<li>… und {missing.length - 5} weitere</li>{/if}
						</ul>
						<div class="flex items-start gap-2">
							<Checkbox
								id="interim-accept"
								checked={accept}
								onCheckedChange={(v) => (accept = v === true)}
								class="mt-0.5"
							/>
							<Label for="interim-accept"
								>Trotzdem festhalten (Belege können später ergänzt werden)</Label
							>
						</div>
					</div>
				{/if}

				<div class="space-y-1.5">
					<Label for="interim-note">Notiz (optional)</Label>
					<Textarea
						id="interim-note"
						bind:value={note}
						maxlength={NOTE_MAX}
						rows={2}
						placeholder="z. B. Vorkasse Unterkunft"
					/>
					<p class="text-xs text-muted-foreground">{note.length}/{NOTE_MAX} Zeichen</p>
				</div>

				<p
					class="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
					role="note"
				>
					Die Zwischenabrechnung steht für sich und baut nicht auf früheren auf.
					{viaTreasury
						? 'Offene Auslagen gehen als Auszahlung an die Kasse – je Person eine Auszahlung, ohne Doppelzahlung.'
						: 'Offene Auslagen können danach ausgezahlt werden.'}
				</p>
			{/if}

			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}

			<Dialog.Footer class="gap-2">
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy || blocked}>
					{busy ? 'Speichert …' : 'Festhalten'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
