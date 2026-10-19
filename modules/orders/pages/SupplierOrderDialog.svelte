<script lang="ts">
	// Bestellung beim Lieferanten anlegen/bearbeiten (Einkauf); vorbelegt aus dem Bestellvorschlag.
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, MoneyInput, NumberStepper } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		MAX_NOTE,
		MAX_QUANTITY,
		MAX_SUPPLIER,
		supplierOrderInput,
		type Article,
		type SupplierOrder,
		type SupplierSuggestion
	} from '../schemas';
	import {
		API,
		errorMessage,
		fieldErrorsFrom,
		issuesToErrors,
		itemName,
		safeUrl,
		todayIso,
		urlHost
	} from './admin-helpers';

	let {
		open = $bindable(false),
		initial = null,
		onsaved
	}: {
		open?: boolean;
		/** Vorschlag (neue Bestellung) oder vorhandene Bestellung (Bearbeiten) */
		initial?: SupplierSuggestion | SupplierOrder | null;
		onsaved?: (order: SupplierOrder) => void | Promise<void>;
	} = $props();

	interface Row {
		key: string;
		variantId: string | null;
		quantity: number;
		costCents: number;
		/** Anzeige, falls die Variante nicht (mehr) in der Artikelliste steht */
		fallbackLabel: string;
		fallbackUrl: string | null;
	}

	const isOrder = (v: SupplierSuggestion | SupplierOrder | null): v is SupplierOrder =>
		!!v && 'id' in v;

	let supplier = $state('');
	let orderedOn = $state('');
	let note = $state('');
	let rows = $state<Row[]>([]);
	let articles = $state<Article[] | null>(null);
	let articlesError = $state('');
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	const editing = $derived(isOrder(initial) ? initial : null);
	/** Positionen nur änderbar, solange nichts eingegangen ist */
	const itemsLocked = $derived(
		!!editing && editing.items.some((i) => i.receivedQty > 0 || i.cancelledQty > 0)
	);

	const newRow = (p: Partial<Row> = {}): Row => ({
		key: crypto.randomUUID(),
		variantId: null,
		quantity: 1,
		costCents: 0,
		fallbackLabel: '',
		fallbackUrl: null,
		...p
	});

	let initKey: string | null = null;
	$effect(() => {
		if (!open) {
			initKey = null;
			return;
		}
		const init = initial;
		const key = isOrder(init) ? init.id : init ? 'suggestion' : 'new';
		if (initKey === key) return;
		initKey = key;
		error = '';
		errors = {};
		if (isOrder(init)) {
			supplier = init.supplier;
			orderedOn = init.orderedOn;
			note = init.note ?? '';
			rows = init.items.map((i) =>
				newRow({
					variantId: i.variantId,
					quantity: i.quantity,
					costCents: i.unitCostCents ?? 0,
					fallbackLabel: itemName(i.articleTitle, i.variantLabel)
				})
			);
		} else {
			supplier = '';
			orderedOn = todayIso();
			note = '';
			rows = init?.items.length
				? init.items.map((i) =>
						newRow({
							variantId: i.variantId,
							quantity: Math.min(Math.max(i.quantity, 1), MAX_QUANTITY),
							fallbackLabel: itemName(i.articleTitle, i.variantLabel),
							fallbackUrl: i.reorderUrl
						})
					)
				: [newRow()];
		}
		if (!articles) void loadArticles();
	});

	async function loadArticles() {
		articlesError = '';
		try {
			articles = await apiFetch<Article[]>(`${API}/articles?scope=all`);
		} catch (e) {
			articlesError = errorMessage(e, 'Artikel konnten nicht geladen werden');
		}
	}

	interface VariantInfo {
		label: string;
		reorderUrl: string | null;
	}
	const variantInfo = $derived.by(() => {
		const map = new Map<string, VariantInfo>();
		for (const a of articles ?? []) {
			for (const v of a.variants) {
				map.set(v.id, {
					label:
						itemName(a.title, v.label) +
						(a.archived || v.archived ? ' (archiviert)' : !a.active ? ' (inaktiv)' : ''),
					reorderUrl: v.reorderUrl ?? a.reorderUrl
				});
			}
		}
		return map;
	});
	const baseOptions = $derived(
		(articles ?? []).flatMap((a) =>
			a.variants
				.filter((v) => !v.archived && !a.archived)
				.map((v) => ({ value: v.id, label: variantInfo.get(v.id)?.label ?? a.title }))
		)
	);
	/** Auswahl je Zeile: ohne die in anderen Zeilen gewählten Varianten, eigene immer enthalten */
	function optionsFor(row: Row) {
		const taken = new Set(rows.filter((r) => r !== row && r.variantId).map((r) => r.variantId));
		const list = baseOptions.filter((o) => !taken.has(o.value));
		if (row.variantId && !list.some((o) => o.value === row.variantId))
			list.unshift({
				value: row.variantId,
				label: variantInfo.get(row.variantId)?.label ?? (row.fallbackLabel || 'Unbekannter Artikel')
			});
		return list;
	}
	const urlFor = (row: Row) =>
		safeUrl((row.variantId ? variantInfo.get(row.variantId)?.reorderUrl : null) ?? row.fallbackUrl);
	const labelFor = (row: Row) =>
		(row.variantId ? variantInfo.get(row.variantId)?.label : null) ?? row.fallbackLabel;

	const total = $derived(rows.reduce((s, r) => s + r.quantity * r.costCents, 0));
	const hasAnyCost = $derived(rows.some((r) => r.costCents > 0));
	const links = $derived.by(() => {
		const seen = new Set<string>();
		const out: { url: string; label: string }[] = [];
		for (const r of rows) {
			const url = urlFor(r);
			if (url && !seen.has(url)) {
				seen.add(url);
				out.push({ url, label: labelFor(r) || urlHost(url) });
			}
		}
		return out;
	});

	function updateRow(key: string, patch: Partial<Row>) {
		rows = rows.map((r) => (r.key === key ? { ...r, ...patch } : r));
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const payload = {
			supplier,
			orderedOn,
			note,
			items: rows.map((r) => ({
				variantId: r.variantId ?? '',
				quantity: r.quantity,
				unitCostCents: r.costCents > 0 ? r.costCents : null
			}))
		};
		const parsed = supplierOrderInput.safeParse(payload);
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			if (!itemsLocked || !Object.keys(errors).every((k) => k.startsWith('items'))) return;
		}
		errors = {};
		busy = true;
		error = '';
		try {
			let saved: SupplierOrder;
			if (editing) {
				const body: Record<string, unknown> = {
					supplier: payload.supplier,
					orderedOn: payload.orderedOn,
					note: payload.note
				};
				if (!itemsLocked) body.items = parsed.data?.items ?? payload.items;
				saved = await apiFetch<SupplierOrder>(`${API}/supplier-orders/${editing.id}`, {
					method: 'PATCH',
					body: JSON.stringify(body)
				});
				toast.success('Bestellung gespeichert');
			} else {
				saved = await apiFetch<SupplierOrder>(`${API}/supplier-orders`, {
					method: 'POST',
					body: JSON.stringify(parsed.data ?? payload)
				});
				toast.success(`Bestellung ${saved.number} angelegt`);
			}
			open = false;
			await onsaved?.(saved);
		} catch (err) {
			if (err instanceof ApiClientError) {
				error = err.message;
				errors = fieldErrorsFrom(err.details);
			} else error = 'Speichern fehlgeschlagen';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>
				{editing ? `Einkauf ${editing.number} bearbeiten` : 'Neue Bestellung beim Lieferanten'}
			</Dialog.Title>
			<Dialog.Description>
				Erfasse, was du beim Lieferanten bestellt hast. Die Mengen zählen im Lager als „unterwegs“,
				bis der Wareneingang gebucht ist.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Lieferant *" id="so-supplier" error={errors.supplier}>
					<Input
						id="so-supplier"
						bind:value={supplier}
						maxlength={MAX_SUPPLIER}
						placeholder="z. B. Rüsthaus"
						aria-invalid={!!errors.supplier}
					/>
				</FormField>
				<FormField label="Bestellt am *" id="so-date" error={errors.orderedOn}>
					<Input
						id="so-date"
						type="date"
						bind:value={orderedOn}
						aria-invalid={!!errors.orderedOn}
					/>
				</FormField>
			</div>

			<fieldset class="space-y-2">
				<legend class="text-sm font-medium">Positionen *</legend>
				{#if itemsLocked}
					<p class="text-xs text-muted-foreground">
						Es ist bereits Ware eingegangen – Positionen lassen sich nicht mehr ändern.
					</p>
				{/if}
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
							errors[`items.${idx}.quantity`] ??
							errors[`items.${idx}.unitCostCents`] ??
							errors[`items.${idx}`]}
						{@const url = urlFor(row)}
						<li class="rounded-md border p-3">
							<div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_9rem_auto] sm:items-end">
								<div class="grid gap-1">
									<span class="text-xs text-muted-foreground">Artikel und Größe</span>
									<SelectField
										label={`Artikel Position ${idx + 1}`}
										options={optionsFor(row)}
										value={row.variantId}
										placeholder={articles ? 'Artikel wählen …' : 'Lädt …'}
										disabled={itemsLocked || busy}
										invalid={!!errors[`items.${idx}.variantId`]}
										onchange={(v) => updateRow(row.key, { variantId: v })}
									/>
								</div>
								<div class="grid gap-1">
									<span class="text-xs text-muted-foreground">Menge</span>
									<NumberStepper
										label={`Menge Position ${idx + 1}`}
										min={1}
										max={MAX_QUANTITY}
										value={row.quantity}
										disabled={itemsLocked || busy}
										onchange={(v) => updateRow(row.key, { quantity: v })}
									/>
								</div>
								<div class="grid gap-1">
									<span class="text-xs text-muted-foreground">Einkaufspreis (optional)</span>
									<MoneyInput
										label={`Einkaufspreis je Stück Position ${idx + 1}`}
										cents={row.costCents}
										disabled={itemsLocked || busy}
										onchange={(c) => updateRow(row.key, { costCents: c })}
									/>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									class="justify-self-end"
									aria-label={`Position ${idx + 1} entfernen`}
									disabled={itemsLocked || busy || rows.length <= 1}
									onclick={() => (rows = rows.filter((r) => r.key !== row.key))}
								>
									<Trash2 />
								</Button>
							</div>
							<div
								class="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
							>
								{#if url}
									<a
										href={url}
										target="_blank"
										rel="noopener noreferrer"
										class="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline"
									>
										<ExternalLink class="size-3" aria-hidden="true" />
										Nachbestellen bei {urlHost(url)}
									</a>
								{:else}
									<span></span>
								{/if}
								{#if row.costCents > 0}
									<span class="tabular-nums">= {formatEuro(row.quantity * row.costCents)}</span>
								{/if}
							</div>
							{#if err}<p class="mt-1 text-xs text-destructive" role="alert">{err}</p>{/if}
						</li>
					{/each}
				</ul>
				{#if errors.items && !Object.keys(errors).some((k) => k.startsWith('items.'))}
					<p class="text-xs text-destructive" role="alert">{errors.items}</p>
				{/if}
				{#if !itemsLocked}
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={busy}
						onclick={() => (rows = [...rows, newRow()])}
					>
						<Plus /> Position hinzufügen
					</Button>
				{/if}
			</fieldset>

			{#if hasAnyCost}
				<p class="flex justify-between rounded-md bg-muted/50 px-3 py-2 text-sm">
					<span>Summe (geschätzt)</span>
					<span class="font-semibold tabular-nums">{formatEuro(total)}</span>
				</p>
			{/if}

			{#if links.length}
				<div class="space-y-1">
					<p class="text-sm font-medium">Shops zum Bestellen</p>
					<ul class="flex flex-wrap gap-2">
						{#each links as l (l.url)}
							<li>
								<a
									href={l.url}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex min-h-9 items-center gap-1 rounded-md border px-3 py-1 text-sm hover:bg-muted"
								>
									<ExternalLink class="size-4" aria-hidden="true" />
									{l.label}
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<FormField label="Notiz" id="so-note" error={errors.note}>
				<Textarea
					id="so-note"
					bind:value={note}
					rows={2}
					maxlength={MAX_NOTE}
					placeholder="z. B. Bestellnummer im Shop"
				/>
			</FormField>
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>
					{busy ? 'Speichert …' : editing ? 'Speichern' : 'Bestellung anlegen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
