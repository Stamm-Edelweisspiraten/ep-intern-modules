<script lang="ts">
	// Offene Mengen einer Mitgliedsbestellung stornieren (ganz oder teilweise, mit Grund).
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, NumberStepper } from '$lib/components/layout';
	import { MAX_NOTE, orderCancelInput, type Order } from '../schemas';
	import { API, fieldErrorsFrom, issuesToErrors, itemName } from './admin-helpers';

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
	let reason = $state('');
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	const openItems = $derived((order?.items ?? []).filter((i) => i.openQty > 0));
	const total = $derived(openItems.reduce((s, i) => s + (qty[i.id] ?? 0), 0));
	const openTotal = $derived(openItems.reduce((s, i) => s + i.openQty, 0));

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
		reason = '';
		error = '';
		errors = {};
	});

	function setAll(full: boolean) {
		const next: Record<string, number> = {};
		for (const i of openItems) next[i.id] = full ? i.openQty : 0;
		qty = next;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!order || total <= 0) return;
		const parsed = orderCancelInput.safeParse({
			items: openItems.map((i) => ({ itemId: i.id, quantity: qty[i.id] ?? 0 })),
			reason
		});
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			return;
		}
		busy = true;
		error = '';
		errors = {};
		try {
			await apiFetch(`${API}/orders/${order.id}/cancel`, {
				method: 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success(
				total === openTotal ? 'Offene Positionen storniert' : `${total} Stück storniert`
			);
			open = false;
			await onsaved?.();
		} catch (err) {
			if (err instanceof ApiClientError) {
				error = err.message;
				errors = fieldErrorsFrom(err.details);
			} else error = 'Stornieren fehlgeschlagen';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Stornieren{order ? ` – ${order.number}` : ''}</Dialog.Title>
			<Dialog.Description>
				Wähle, wie viele noch offene Stück je Position storniert werden. Bereits ausgegebene Artikel
				bleiben unberührt.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			{#if !openItems.length}
				<p class="text-sm text-muted-foreground">Diese Bestellung hat keine offenen Positionen.</p>
			{:else}
				<div class="flex flex-wrap gap-2">
					<Button type="button" size="sm" variant="outline" onclick={() => setAll(true)}>
						Alles Offene
					</Button>
					<Button type="button" size="sm" variant="outline" onclick={() => setAll(false)}>
						Nichts
					</Button>
				</div>
				<ul class="divide-y rounded-md border">
					{#each openItems as item, idx (item.id)}
						{@const err = errors[`items.${idx}.quantity`] ?? errors[`items.${idx}`]}
						<li class="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
							<div class="min-w-0">
								<div class="font-medium">{itemName(item.articleTitle, item.variantLabel)}</div>
								<div class="text-xs text-muted-foreground tabular-nums">
									bestellt {item.quantity} · ausgegeben {item.deliveredQty} · offen {item.openQty}
								</div>
								{#if err}<p class="mt-1 text-xs text-destructive" role="alert">{err}</p>{/if}
							</div>
							<NumberStepper
								label={`Stornieren: ${itemName(item.articleTitle, item.variantLabel)}`}
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
			{/if}
			<FormField label="Grund" id="oc-reason" error={errors.reason}>
				<Textarea
					id="oc-reason"
					bind:value={reason}
					rows={2}
					maxlength={MAX_NOTE}
					placeholder="z. B. Größe nicht mehr lieferbar"
				/>
			</FormField>
			<p class="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
				Die Rechnung wird automatisch angepasst.
			</p>
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" variant="destructive" disabled={busy || total <= 0}>
					{busy ? 'Speichert …' : total > 0 ? `${total} Stück stornieren` : 'Stornieren'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
