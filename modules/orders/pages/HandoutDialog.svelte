<script lang="ts">
	// Ausgabe einer Mitgliedsbestellung aus dem Lager (Teilmengen erlaubt, Rest wartet auf Nachschub).
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { NumberStepper } from '$lib/components/layout';
	import type { Order, OrderItem } from '../schemas';
	import { API, fieldErrorsFrom, itemName } from './admin-helpers';

	let {
		open = $bindable(false),
		order = null,
		onsaved
	}: {
		open?: boolean;
		order?: Order | null;
		onsaved?: () => void | Promise<void>;
	} = $props();

	let qty = $state<Record<string, number>>({});
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	const openItems = $derived((order?.items ?? []).filter((i) => i.openQty > 0));
	const maxFor = (i: OrderItem) => Math.max(0, Math.min(i.openQty, i.stock ?? 0));
	const total = $derived(openItems.reduce((s, i) => s + (qty[i.id] ?? 0), 0));

	// Beim Öffnen vorbelegen: so viel wie offen und auf Lager
	let initFor: string | null = null;
	$effect(() => {
		if (!open) {
			initFor = null;
			return;
		}
		const o = order;
		if (!o || initFor === o.id) return;
		initFor = o.id;
		const next: Record<string, number> = {};
		for (const i of o.items) if (i.openQty > 0) next[i.id] = maxFor(i);
		qty = next;
		error = '';
		errors = {};
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!order || total <= 0) return;
		busy = true;
		error = '';
		errors = {};
		try {
			await apiFetch(`${API}/orders/${order.id}/handout`, {
				method: 'POST',
				body: JSON.stringify({
					items: openItems.map((i) => ({ itemId: i.id, quantity: qty[i.id] ?? 0 }))
				})
			});
			const rest = openItems.reduce((s, i) => s + i.openQty, 0) - total;
			toast.success(
				rest > 0
					? `${total} Stück ausgegeben – ${rest} Stück warten auf Nachschub`
					: `${total} Stück ausgegeben – Bestellung vollständig`
			);
			open = false;
			await onsaved?.();
		} catch (err) {
			if (err instanceof ApiClientError) {
				error =
					err.status === 409
						? `${err.message} Bitte lade die Liste neu – der Lagerbestand hat sich geändert.`
						: err.message;
				errors = fieldErrorsFrom(err.details);
			} else error = 'Ausgabe fehlgeschlagen';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Ausgeben{order ? ` – ${order.number}` : ''}</Dialog.Title>
			<Dialog.Description>
				{order ? `Für ${order.member.name}. ` : ''}Was nicht auf Lager ist, bleibt offen und wird
				nach dem nächsten Wareneingang ausgegeben.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			{#if !openItems.length}
				<p class="text-sm text-muted-foreground">Diese Bestellung hat keine offenen Positionen.</p>
			{:else}
				<ul class="divide-y rounded-md border">
					{#each openItems as item, idx (item.id)}
						{@const max = maxFor(item)}
						{@const missing = Math.max(0, item.openQty - (item.stock ?? 0))}
						{@const err = errors[`items.${idx}.quantity`] ?? errors[`items.${idx}`]}
						<li class="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
							<div class="min-w-0">
								<div class="font-medium">{itemName(item.articleTitle, item.variantLabel)}</div>
								<div class="text-xs text-muted-foreground tabular-nums">
									offen {item.openQty} · auf Lager {item.stock ?? 0}
								</div>
								{#if missing > 0}
									<p class="mt-1 text-xs text-amber-700 dark:text-amber-400">
										{missing}
										{missing === 1 ? 'fehlt' : 'fehlen'} – {missing === 1 ? 'wird' : 'werden'} nachbestellt
									</p>
								{/if}
								{#if err}<p class="mt-1 text-xs text-destructive" role="alert">{err}</p>{/if}
							</div>
							<NumberStepper
								label={`Ausgeben: ${itemName(item.articleTitle, item.variantLabel)}`}
								min={0}
								{max}
								disabled={busy || max === 0}
								invalid={!!err}
								value={qty[item.id] ?? 0}
								onchange={(v) => (qty = { ...qty, [item.id]: v })}
							/>
						</li>
					{/each}
				</ul>
			{/if}
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy || total <= 0}>
					{busy ? 'Speichert …' : total > 0 ? `${total} Stück ausgeben` : 'Ausgeben'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
