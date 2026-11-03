<script lang="ts" module>
	export type PantryMode = 'in' | 'out';
</script>

<script lang="ts">
	// Nach einem Scan im Vorrat: Menge (und beim Einlagern das MHD) eintragen und speichern – danach auf
	// Wunsch direkt weiter scannen.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { BUSY_SAVE, FormField, NumberStepper } from '$lib/components/layout';
	import { EXPIRY_LABELS } from '../../pantry';
	import { MAX_QUANTITY, type FoodProduct } from '../../schemas';
	import {
		API,
		EXPIRY_VARIANTS,
		apiFieldErrors,
		errorText,
		formatAmount,
		formatDate
	} from '../helpers';

	let {
		open = $bindable(false),
		product,
		mode = $bindable('in'),
		onsaved,
		onnext,
		ondetails
	}: {
		open?: boolean;
		product: FoodProduct;
		mode?: PantryMode;
		onsaved: (product: FoodProduct) => void;
		/** Nach dem Speichern weiter scannen */
		onnext: () => void;
		ondetails: (id: string) => void;
	} = $props();

	let quantity = $state(1);
	let bestBefore = $state('');
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			quantity = 1;
			bestBefore = '';
			errors = {};
		});
	});

	const first = $derived(product.batches[0] ?? null);
	const canTake = $derived(product.quantity > 0);

	async function save(next: boolean) {
		busy = true;
		errors = {};
		try {
			const saved = await apiFetch<FoodProduct>(
				`${API}/pantry/products/${product.id}/${mode === 'in' ? 'check-in' : 'check-out'}`,
				{
					method: 'POST',
					body: JSON.stringify(
						mode === 'in' ? { quantity, bestBefore: bestBefore || null } : { quantity, kind: 'out' }
					)
				}
			);
			toast.success(
				`${product.name}: ${formatAmount(quantity, product.unit)} ${mode === 'in' ? 'eingelagert' : 'entnommen'}`
			);
			onsaved(saved);
			open = false;
			if (next) onnext();
		} catch (err) {
			errors = apiFieldErrors(err);
			if (!Object.keys(errors).length) toast.error(errorText(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{product.name}</Dialog.Title>
			<Dialog.Description>
				{[product.brand, product.packageSize].filter(Boolean).join(' · ') || 'Lebensmittel'} · Bestand
				{formatAmount(product.quantity, product.unit)}
			</Dialog.Description>
		</Dialog.Header>

		<div class="grid grid-cols-2 gap-2" role="group" aria-label="Was möchtest du tun?">
			<Button variant={mode === 'in' ? 'default' : 'outline'} onclick={() => (mode = 'in')}>
				Einlagern
			</Button>
			<Button
				variant={mode === 'out' ? 'default' : 'outline'}
				disabled={!canTake}
				onclick={() => (mode = 'out')}
			>
				Entnehmen
			</Button>
		</div>

		<form
			id="pantry-scan-form"
			class="grid gap-4"
			onsubmit={(e) => {
				e.preventDefault();
				void save(true);
			}}
		>
			<FormField
				label={product.unit ? `Menge (${product.unit})` : 'Menge'}
				id="pantry-scan-qty"
				error={errors.quantity}
			>
				<NumberStepper
					id="pantry-scan-qty"
					label="Menge"
					min={1}
					max={mode === 'out' ? Math.max(1, product.quantity) : MAX_QUANTITY}
					bind:value={quantity}
				/>
			</FormField>
			{#if mode === 'in'}
				<FormField
					label="Mindestens haltbar bis"
					id="pantry-scan-mhd"
					hint="Leer lassen, wenn kein MHD aufgedruckt ist"
					error={errors.bestBefore}
				>
					<Input id="pantry-scan-mhd" type="date" bind:value={bestBefore} />
				</FormField>
			{:else if first}
				<p class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
					Zuerst aus der Charge
					{first.bestBefore ? `mit MHD ${formatDate(first.bestBefore)}` : 'ohne MHD'}
					<Badge variant={EXPIRY_VARIANTS[first.state]}>{EXPIRY_LABELS[first.state]}</Badge>
				</p>
			{/if}
		</form>

		<Dialog.Footer class="gap-2 sm:justify-between">
			<Button variant="ghost" onclick={() => ondetails(product.id)}>Details</Button>
			<div class="grid grid-cols-2 gap-2 sm:flex">
				<Button
					variant="outline"
					disabled={busy || (mode === 'out' && !canTake)}
					onclick={() => save(false)}
				>
					{busy ? BUSY_SAVE : 'Speichern'}
				</Button>
				<Button
					type="submit"
					form="pantry-scan-form"
					disabled={busy || (mode === 'out' && !canTake)}
				>
					Speichern & weiter
				</Button>
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
