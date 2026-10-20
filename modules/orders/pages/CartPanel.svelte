<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ImageOff from '@lucide/svelte/icons/image-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { ConfirmDialog, NumberStepper } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		MAX_NOTE,
		MAX_QUANTITY,
		orderCreateInput,
		type MemberOption,
		type OrderCreated
	} from '../schemas';
	import {
		BASE,
		cartCount,
		cartTotal,
		errorText,
		itemLabel,
		setCartQuantity,
		type CartItem
	} from './helpers';

	let {
		cart = $bindable([]),
		memberId = $bindable(null),
		note = $bindable(''),
		canCreate,
		canManage,
		oncartchange,
		onordered,
		onmanage
	}: {
		cart?: CartItem[];
		memberId?: string | null;
		note?: string;
		/** Für verknüpfte Mitglieder bestellen */
		canCreate: boolean;
		/** Kämmerer*in: Hinweis auf „Bestellung anlegen“ im Tab Bestellungen */
		canManage: boolean;
		/** Warenkorb geändert (zum Speichern) */
		oncartchange: (cart: CartItem[]) => void;
		onordered: (created: OrderCreated) => void;
		/** Zum Tab „Bestellungen“ wechseln (für andere Mitglieder bestellen) */
		onmanage?: () => void;
	} = $props();

	const canOrder = $derived(canCreate);

	let myMembers = $state<MemberOption[]>([]);
	let membersLoading = $state(true);
	let membersError = $state('');

	const memberOptions = $derived(myMembers.map((m) => ({ value: m.id, label: m.name })));
	const memberName = $derived(memberOptions.find((o) => o.value === memberId)?.label ?? '');

	async function loadMembers() {
		membersLoading = true;
		membersError = '';
		try {
			myMembers = await apiFetch<MemberOption[]>(`${BASE}/my/members`);
			if (memberId && !memberOptions.some((o) => o.value === memberId)) memberId = null;
			if (!memberId && myMembers.length === 1) memberId = myMembers[0]!.id;
		} catch (e) {
			membersError = errorText(e, 'Mitglieder konnten nicht geladen werden');
		} finally {
			membersLoading = false;
		}
	}

	onMount(() => {
		if (canOrder) void loadMembers();
		else membersLoading = false;
	});

	// --- Positionen ---------------------------------------------------------------
	const total = $derived(cartTotal(cart));
	const count = $derived(cartCount(cart));

	function update(next: CartItem[]) {
		cart = next;
		oncartchange(next);
	}

	// --- Bestellen ----------------------------------------------------------------
	let memberError = $state('');
	let confirmOpen = $state(false);
	let busy = $state(false);

	function requestOrder() {
		memberError = '';
		if (!memberId) {
			memberError = 'Bitte wähle das Mitglied, für das du bestellst.';
			document.getElementById('cart-member')?.focus();
			return;
		}
		const parsed = orderCreateInput.safeParse(payload());
		if (!parsed.success) {
			toast.error(parsed.error.issues[0]?.message ?? 'Bestellung ist unvollständig');
			return;
		}
		confirmOpen = true;
	}

	function payload() {
		return {
			memberId: memberId ?? '',
			items: cart.map((c) => ({ variantId: c.variantId, quantity: c.quantity })),
			note: note.trim() || null
		};
	}

	async function submit() {
		busy = true;
		try {
			const created = await apiFetch<OrderCreated>(`${BASE}/orders`, {
				method: 'POST',
				body: JSON.stringify(payload())
			});
			const nr = created.order.number;
			const inv = created.order.invoiceNumber;
			if (inv && created.mailed)
				toast.success(`Bestellung ${nr} aufgegeben, Rechnung ${inv} per E-Mail verschickt`);
			else if (inv)
				toast.success(`Bestellung ${nr} aufgegeben, Rechnung ${inv} erstellt`, {
					description: 'Die E-Mail konnte nicht verschickt werden. Die Kasse meldet sich.'
				});
			else toast.success(`Bestellung ${nr} aufgegeben, Rechnung folgt`);
			note = '';
			update([]);
			onordered(created);
		} catch (e) {
			toast.error(errorText(e, 'Bestellung konnte nicht aufgegeben werden'));
		} finally {
			busy = false;
		}
	}
</script>

{#snippet manageHint()}
	<p class="text-xs text-muted-foreground">
		Für andere Mitglieder bestellst du im Tab
		{#if onmanage}<button
				type="button"
				class="font-medium text-foreground underline underline-offset-2"
				onclick={onmanage}>Bestellungen</button
			>{:else}„Bestellungen“{/if} über „Bestellung anlegen“.
	</p>
{/snippet}

<section class="space-y-4" aria-labelledby="cart-title">
	<h2 id="cart-title" class="flex items-center gap-2 font-semibold">
		<ShoppingCart class="size-4" aria-hidden="true" /> Warenkorb
		{#if count}<span class="text-sm font-normal text-muted-foreground">({count})</span>{/if}
	</h2>

	{#if !cart.length}
		<p class="text-sm text-muted-foreground">
			Noch leer. Wähle einen Artikel aus, um ihn in den Warenkorb zu legen.
		</p>
	{:else}
		<ul class="divide-y">
			{#each cart as item (item.variantId)}
				<li class="flex gap-3 py-3 first:pt-0">
					<div class="size-12 shrink-0 overflow-hidden rounded-md bg-muted">
						{#if item.thumbUrl}
							<img src={item.thumbUrl} alt="" loading="lazy" class="size-full object-cover" />
						{:else}
							<span class="flex size-full items-center justify-center text-muted-foreground">
								<ImageOff class="size-4" aria-hidden="true" />
							</span>
						{/if}
					</div>
					<div class="min-w-0 flex-1 space-y-1.5">
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<p class="truncate text-sm font-medium" title={item.articleTitle}>
									{item.articleTitle}
								</p>
								<p class="text-xs text-muted-foreground tabular-nums">
									{#if item.variantLabel}Gr. {item.variantLabel} ·
									{/if}{formatEuro(item.unitPriceCents)} je Stück
								</p>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								class="shrink-0"
								aria-label={`${itemLabel(item.articleTitle, item.variantLabel)} entfernen`}
								onclick={() => update(cart.filter((c) => c.variantId !== item.variantId))}
							>
								<Trash2 />
							</Button>
						</div>
						<div class="flex items-center justify-between gap-2">
							<NumberStepper
								label={`Menge ${itemLabel(item.articleTitle, item.variantLabel)}`}
								value={item.quantity}
								min={1}
								max={MAX_QUANTITY}
								onchange={(v) => update(setCartQuantity(cart, item.variantId, v))}
							/>
							<span class="text-sm font-medium tabular-nums">
								{formatEuro(item.unitPriceCents * item.quantity)}
							</span>
						</div>
					</div>
				</li>
			{/each}
		</ul>
		<div class="flex items-center justify-between border-t pt-3">
			<span class="text-sm font-medium">Summe</span>
			<span class="text-base font-semibold tabular-nums">{formatEuro(total)}</span>
		</div>
	{/if}

	{#if !canOrder}
		{#if canManage}
			{@render manageHint()}
		{:else}
			<p class="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
				Du darfst den Katalog ansehen, aber nicht bestellen.
			</p>
		{/if}
	{:else}
		<div class="space-y-2">
			<Label for="cart-member">Für Mitglied *</Label>
			{#if membersLoading}
				<p class="flex items-center gap-2 text-xs text-muted-foreground">
					<LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" /> Lädt Mitglieder …
				</p>
			{:else if membersError}
				<p class="text-xs text-destructive" role="alert">
					{membersError}
					<button type="button" class="underline underline-offset-2" onclick={loadMembers}>
						Erneut versuchen
					</button>
				</p>
			{:else if !memberOptions.length}
				<p class="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
					Mit deinem Konto ist kein Mitglied verknüpft. Bitte wende dich an die Stammesführung,
					damit sie dir einen Verknüpfungsbrief schickt – danach kannst du hier bestellen.
				</p>
			{/if}
			{#if memberOptions.length}
				<SelectField
					id="cart-member"
					label="Mitglied"
					options={memberOptions}
					bind:value={memberId}
					placeholder="Mitglied wählen …"
					invalid={!!memberError}
					onchange={() => (memberError = '')}
				/>
			{/if}
			{#if memberError}
				<p class="text-xs text-destructive" role="alert">{memberError}</p>
			{/if}
			{#if canManage}
				{@render manageHint()}
			{/if}
		</div>

		<div class="space-y-2">
			<Label for="cart-note">Notiz (optional)</Label>
			<Textarea
				id="cart-note"
				rows={2}
				maxlength={MAX_NOTE}
				placeholder="z. B. Abholung bei der nächsten Gruppenstunde"
				bind:value={note}
			/>
		</div>

		<p class="text-xs text-muted-foreground">
			Die Rechnung kommt sofort per E-Mail; bezahlt wird per Überweisung an die Kasse.
		</p>

		<Button class="w-full" disabled={!cart.length || busy} onclick={requestOrder}>
			{busy ? 'Bestellt …' : 'Verbindlich bestellen'}
		</Button>
	{/if}
</section>

<ConfirmDialog
	bind:open={confirmOpen}
	title="Verbindlich bestellen?"
	description={`${count} Artikel für ${memberName || 'das gewählte Mitglied'}, zusammen ${formatEuro(total)}. Die Rechnung geht sofort per E-Mail raus.`}
	confirmLabel="Verbindlich bestellen"
	onconfirm={submit}
/>
