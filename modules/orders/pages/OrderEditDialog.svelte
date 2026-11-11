<script lang="ts">
	// Bestellung nachträglich bearbeiten (Recht `orders.order.edit`): Mengen und Preise ändern, Artikel
	// hinzufügen oder entfernen, Notiz. Die Rechnung in der Kasse wird vom Server angepasst.
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, MoneyInput, NumberStepper } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		MAX_NOTE,
		MAX_ORDER_ITEMS,
		MAX_PRICE_CENTS,
		MAX_QUANTITY,
		orderUpdateInput,
		type Article,
		type Order
	} from '../schemas';
	import { API, errorMessage, fieldErrorsFrom, issuesToErrors, itemName } from './admin-helpers';

	let {
		open = $bindable(false),
		order = null,
		onsaved
	}: {
		open?: boolean;
		order?: Order | null;
		onsaved?: (order: Order) => void | Promise<void>;
	} = $props();

	interface Row {
		key: string;
		/** bestehende Position; `null` = neu */
		itemId: string | null;
		variantId: string | null;
		/** Anzeige bestehender Positionen */
		name: string;
		quantity: number;
		priceCents: number;
		deliveredQty: number;
		cancelledQty: number;
	}

	const newRow = (): Row => ({
		key: crypto.randomUUID(),
		itemId: null,
		variantId: null,
		name: '',
		quantity: 1,
		priceCents: 0,
		deliveredQty: 0,
		cancelledQty: 0
	});

	let rows = $state<Row[]>([]);
	let note = $state('');
	let articles = $state<Article[] | null>(null);
	let articlesError = $state('');
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	let initFor: string | null = null;
	$effect(() => {
		if (!open) {
			initFor = null;
			return;
		}
		const o = order;
		if (!o || initFor === o.id) return;
		initFor = o.id;
		rows = o.items.map((i) => ({
			key: i.id,
			itemId: i.id,
			variantId: i.variantId,
			name: itemName(i.articleTitle, i.variantLabel),
			quantity: i.quantity - i.cancelledQty,
			priceCents: i.unitPriceCents,
			deliveredQty: i.deliveredQty,
			cancelledQty: i.cancelledQty
		}));
		note = o.note ?? '';
		error = '';
		errors = {};
		if (!articles) void loadArticles();
	});

	async function loadArticles() {
		articlesError = '';
		try {
			articles = await apiFetch<Article[]>(`${API}/articles?scope=catalog`);
		} catch (e) {
			articlesError = errorMessage(e, 'Artikel konnten nicht geladen werden');
		}
	}

	const variants = $derived.by(() => {
		const map = new Map<string, { label: string; priceCents: number }>();
		for (const a of articles ?? []) {
			if (!a.active || a.archived) continue;
			for (const v of a.variants) {
				if (!v.archived)
					map.set(v.id, {
						label: `${itemName(a.title, v.label)} · ${formatEuro(v.priceCents)}`,
						priceCents: v.priceCents
					});
			}
		}
		return map;
	});
	const baseOptions = $derived([...variants].map(([value, v]) => ({ value, label: v.label })));
	/** Auswahl einer neuen Zeile: ohne Varianten, die schon in der Bestellung bzw. anderen Zeilen stehen */
	function optionsFor(row: Row) {
		const taken = new Set(rows.filter((r) => r !== row && r.variantId).map((r) => r.variantId));
		return baseOptions.filter((o) => !taken.has(o.value));
	}
	const freeOptions = $derived(
		baseOptions.filter((o) => !rows.some((r) => r.variantId === o.value)).length
	);
	const total = $derived(rows.reduce((s, r) => s + r.quantity * r.priceCents, 0));
	const before = $derived(order?.totalCents ?? 0);

	function updateRow(key: string, patch: Partial<Row>) {
		rows = rows.map((r) => (r.key === key ? { ...r, ...patch } : r));
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!order) return;
		const payload = {
			items: rows.map((r) =>
				r.itemId
					? { itemId: r.itemId, quantity: r.quantity, unitPriceCents: r.priceCents }
					: { variantId: r.variantId, quantity: r.quantity, unitPriceCents: r.priceCents }
			),
			note: note.trim() || null
		};
		const parsed = orderUpdateInput.safeParse(payload);
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			return;
		}
		errors = {};
		busy = true;
		error = '';
		try {
			const saved = await apiFetch<Order>(`${API}/orders/${order.id}`, {
				method: 'PATCH',
				body: JSON.stringify(parsed.data)
			});
			toast.success(`Bestellung ${saved.number} gespeichert`, {
				description:
					saved.totalCents !== before && saved.invoiceNumber
						? `Rechnung ${saved.invoiceNumber} wurde angepasst.`
						: undefined
			});
			open = false;
			await onsaved?.(saved);
		} catch (err) {
			if (err instanceof ApiClientError) {
				error = err.message;
				errors = fieldErrorsFrom(err.details);
			} else error = 'Bestellung konnte nicht gespeichert werden';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Bestellung {order?.number ?? ''} bearbeiten</Dialog.Title>
			<Dialog.Description>
				Für {order?.member.name ?? ''}. Mengen und Preise ändern, Artikel hinzufügen oder entfernen
				– die Rechnung in der Kasse wird angepasst.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<fieldset class="space-y-2">
				<legend class="text-sm font-medium">Artikel *</legend>
				{#if articlesError}
					<p class="text-sm text-destructive" role="alert">
						{articlesError}
						<Button size="sm" variant="link" onclick={loadArticles}>Erneut versuchen</Button>
					</p>
				{/if}
				<ul class="space-y-2">
					{#each rows as row, idx (row.key)}
						{@const err =
							errors[`items.${idx}.variantId`] ??
							errors[`items.${idx}.itemId`] ??
							errors[`items.${idx}.quantity`] ??
							errors[`items.${idx}.unitPriceCents`] ??
							errors[`items.${idx}`]}
						<li class="rounded-md border p-3">
							<div class="flex flex-col gap-2 sm:flex-row sm:items-end">
								<div class="grid min-w-0 flex-1 gap-1">
									<span class="text-xs text-muted-foreground">Artikel und Größe</span>
									{#if row.itemId}
										<span class="flex min-h-9 items-center text-sm font-medium">{row.name}</span>
									{:else}
										<SelectField
											label={`Artikel Position ${idx + 1}`}
											options={optionsFor(row)}
											value={row.variantId}
											placeholder={articles ? 'Artikel wählen …' : 'Lädt …'}
											disabled={busy}
											invalid={!!errors[`items.${idx}.variantId`]}
											onchange={(v) =>
												updateRow(row.key, {
													variantId: v,
													priceCents: v ? (variants.get(v)?.priceCents ?? 0) : 0
												})}
										/>
									{/if}
								</div>
								<div class="flex flex-wrap items-end gap-2">
									<div class="grid gap-1">
										<span class="text-xs text-muted-foreground">Menge</span>
										<NumberStepper
											label={`Menge Position ${idx + 1}`}
											min={row.itemId ? row.deliveredQty : 1}
											max={MAX_QUANTITY}
											value={row.quantity}
											disabled={busy}
											onchange={(v) => updateRow(row.key, { quantity: v })}
										/>
									</div>
									<div class="grid w-28 gap-1">
										<span class="text-xs text-muted-foreground">Einzelpreis</span>
										<MoneyInput
											label={`Einzelpreis Position ${idx + 1}`}
											cents={row.priceCents}
											max={MAX_PRICE_CENTS}
											disabled={busy || (!row.itemId && !row.variantId)}
											invalid={!!errors[`items.${idx}.unitPriceCents`]}
											onchange={(c) => updateRow(row.key, { priceCents: c })}
										/>
									</div>
									<div class="grid flex-1 gap-1 text-right sm:w-20 sm:flex-none">
										<span class="text-xs text-muted-foreground">Betrag</span>
										<span class="flex min-h-9 items-center justify-end text-sm tabular-nums">
											{row.itemId || row.variantId
												? formatEuro(row.quantity * row.priceCents)
												: '–'}
										</span>
									</div>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										aria-label={`Position ${idx + 1} entfernen`}
										title={row.deliveredQty > 0
											? 'Bereits ausgegeben – nur die Menge lässt sich bis zur ausgegebenen Menge senken'
											: undefined}
										disabled={busy || row.deliveredQty > 0 || rows.length <= 1}
										onclick={() => (rows = rows.filter((r) => r.key !== row.key))}
									>
										<Trash2 />
									</Button>
								</div>
							</div>
							{#if row.itemId && (row.deliveredQty > 0 || row.cancelledQty > 0)}
								<p class="mt-1 text-xs text-muted-foreground">
									{#if row.deliveredQty > 0}{row.deliveredQty} ausgegeben{/if}{#if row.deliveredQty > 0 && row.cancelledQty > 0}
										·
									{/if}{#if row.cancelledQty > 0}{row.cancelledQty} storniert – eine neue Menge ersetzt
										das Stornierte{/if}
								</p>
							{/if}
							{#if err}<p class="mt-1 text-xs text-destructive" role="alert">{err}</p>{/if}
						</li>
					{/each}
				</ul>
				{#if errors.items}
					<p class="text-xs text-destructive" role="alert">{errors.items}</p>
				{/if}
				{#if errors['']}
					<p class="text-xs text-destructive" role="alert">{errors['']}</p>
				{/if}
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={busy || !articles || freeOptions === 0 || rows.length >= MAX_ORDER_ITEMS}
					onclick={() => (rows = [...rows, newRow()])}
				>
					<Plus /> Artikel hinzufügen
				</Button>
			</fieldset>

			<p class="flex justify-between rounded-md bg-muted/50 px-3 py-2 text-sm">
				<span>Summe</span>
				<span class="tabular-nums">
					{#if total !== before}
						<span class="mr-2 text-muted-foreground line-through">{formatEuro(before)}</span>
					{/if}
					<span class="font-semibold">{formatEuro(total)}</span>
				</span>
			</p>

			<FormField label="Notiz (optional)" id="oe-note" error={errors.note}>
				<Textarea id="oe-note" bind:value={note} rows={2} maxlength={MAX_NOTE} />
			</FormField>
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? 'Speichert …' : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
