<script lang="ts">
	// Wareneingang einer Lieferantenbestellung buchen (Teillieferung möglich).
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, NumberStepper } from '$lib/components/layout';
	import { MAX_NOTE, supplierReceiveInput, type SupplierOrder } from '../schemas';
	import { API, fieldErrorsFrom, issuesToErrors, itemName } from './admin-helpers';

	let {
		open = $bindable(false),
		order = null,
		onsaved
	}: {
		open?: boolean;
		order?: SupplierOrder | null;
		onsaved?: () => void | Promise<void>;
	} = $props();

	let qty = $state<Record<string, number>>({});
	let note = $state('');
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	const openItems = $derived((order?.items ?? []).filter((i) => i.openQty > 0));
	const total = $derived(openItems.reduce((s, i) => s + (qty[i.id] ?? 0), 0));
	const rest = $derived(openItems.reduce((s, i) => s + i.openQty, 0) - total);

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
		for (const i of o.items) if (i.openQty > 0) next[i.id] = i.openQty;
		qty = next;
		note = '';
		error = '';
		errors = {};
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!order || total <= 0) return;
		const parsed = supplierReceiveInput.safeParse({
			items: openItems.map((i) => ({ itemId: i.id, quantity: qty[i.id] ?? 0 })),
			note
		});
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			return;
		}
		busy = true;
		error = '';
		errors = {};
		try {
			await apiFetch(`${API}/supplier-orders/${order.id}/receive`, {
				method: 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success(
				rest > 0
					? `${total} Stück eingebucht – ${rest} Stück stehen noch aus`
					: `${total} Stück eingebucht – Lieferung vollständig`
			);
			open = false;
			await onsaved?.();
		} catch (err) {
			if (err instanceof ApiClientError) {
				error = err.message;
				errors = fieldErrorsFrom(err.details);
			} else error = 'Wareneingang fehlgeschlagen';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Wareneingang{order ? ` – ${order.number}` : ''}</Dialog.Title>
			<Dialog.Description>
				Trage ein, was angekommen ist. Bei einer Teillieferung bleibt der Rest offen und kann später
				eingebucht oder storniert werden.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			{#if !openItems.length}
				<p class="text-sm text-muted-foreground">Alle Positionen sind bereits eingegangen.</p>
			{:else}
				<ul class="divide-y rounded-md border">
					{#each openItems as item, idx (item.id)}
						{@const err = errors[`items.${idx}.quantity`] ?? errors[`items.${idx}`]}
						<li class="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
							<div class="min-w-0">
								<div class="font-medium">{itemName(item.articleTitle, item.variantLabel)}</div>
								<div class="text-xs text-muted-foreground tabular-nums">
									bestellt {item.quantity} · eingegangen {item.receivedQty} · offen {item.openQty}
								</div>
								{#if err}<p class="mt-1 text-xs text-destructive" role="alert">{err}</p>{/if}
							</div>
							<NumberStepper
								label={`Eingegangen: ${itemName(item.articleTitle, item.variantLabel)}`}
								min={0}
								max={item.openQty}
								disabled={busy}
								invalid={!!err}
								value={qty[item.id] ?? 0}
								onchange={(v) => (qty = { ...qty, [item.id]: v })}
							/>
						</li>
					{/each}
				</ul>
				{#if rest > 0 && total > 0}
					<p class="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground" aria-live="polite">
						Teillieferung: {rest} Stück bleiben offen. Offene Bestellungen der Mitglieder lassen sich
						danach mit dem eingegangenen Bestand ausgeben.
					</p>
				{/if}
			{/if}
			<FormField label="Notiz" id="rc-note" error={errors.note}>
				<Textarea
					id="rc-note"
					bind:value={note}
					rows={2}
					maxlength={MAX_NOTE}
					placeholder="z. B. Lieferschein 4711"
				/>
			</FormField>
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy || total <= 0}>
					{busy ? 'Speichert …' : total > 0 ? `${total} Stück einbuchen` : 'Einbuchen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
