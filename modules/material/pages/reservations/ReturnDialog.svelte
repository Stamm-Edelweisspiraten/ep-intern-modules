<script lang="ts">
	// Rücknahme: je ausgegebenem Verbrauchsartikel eintragen, wie viel verbraucht wurde; der Bestand sinkt
	// um diese Menge. Ohne Verbrauchsmaterial nur bestätigen.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { BUSY_SAVE, NumberStepper } from '$lib/components/layout';
	import type { Reservation } from '../../schemas';
	import { API, apiFieldErrors, errorText, formatAmount } from '../helpers';

	let {
		open = $bindable(false),
		reservation,
		onsaved
	}: {
		open?: boolean;
		reservation: Reservation;
		onsaved: (next: Reservation) => void;
	} = $props();

	let consumed = $state<Record<string, number>>({});
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			errors = {};
			consumed = Object.fromEntries(reservation.consumables.map((c) => [c.itemId, 0]));
		});
	});

	const list = $derived(reservation.consumables);

	async function save(e?: SubmitEvent) {
		e?.preventDefault();
		busy = true;
		errors = {};
		const body = {
			consumed: list.map((c) => ({ itemId: c.itemId, quantity: consumed[c.itemId] ?? 0 }))
		};
		try {
			const next = await apiFetch<Reservation>(`${API}/reservations/${reservation.id}/return`, {
				method: 'POST',
				body: JSON.stringify(body)
			});
			toast.success('Zurückgenommen');
			open = false;
			onsaved(next);
		} catch (err) {
			errors = apiFieldErrors(err);
			if (!Object.keys(errors).length) toast.error(errorText(err, 'Rücknahme fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Material zurücknehmen</Dialog.Title>
			<Dialog.Description>
				{list.length
					? 'Trage ein, wie viel vom Verbrauchsmaterial verbraucht wurde. Der Rest ist danach wieder im Lager verfügbar.'
					: 'Diese Reservierung enthält kein Verbrauchsmaterial. Mit der Rücknahme ist sie abgeschlossen.'}
			</Dialog.Description>
		</Dialog.Header>
		<form id="return-form" class="grid gap-3" onsubmit={save}>
			{#each list as c, i (c.itemId)}
				{@const err = errors[`consumed.${i}.quantity`]}
				<div class="grid gap-2 rounded-lg border p-3">
					<div class="flex flex-wrap items-baseline justify-between gap-2">
						<span class="font-medium">{c.name}</span>
						<span class="text-sm text-muted-foreground tabular-nums">
							ausgegeben {formatAmount(c.issued, c.unit)}
						</span>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<label for="consumed-{c.itemId}" class="text-sm">Verbraucht</label>
						<NumberStepper
							id="consumed-{c.itemId}"
							label={`Verbraucht: ${c.name}`}
							min={0}
							max={c.issued}
							bind:value={consumed[c.itemId]!}
						/>
						{#if c.unit}<span class="text-sm text-muted-foreground">{c.unit}</span>{/if}
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onclick={() => (consumed[c.itemId] = c.issued)}
						>
							Alles verbraucht
						</Button>
					</div>
					<p class="text-xs text-muted-foreground tabular-nums">
						Zurück ins Lager: {formatAmount(c.issued - (consumed[c.itemId] ?? 0), c.unit)}
					</p>
					{#if err}<p class="text-xs text-destructive">{err}</p>{/if}
				</div>
			{/each}
		</form>
		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button type="submit" form="return-form" disabled={busy}>
				{busy ? BUSY_SAVE : 'Zurücknehmen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
