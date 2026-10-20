<script lang="ts">
	// Bestellung für ein beliebiges Mitglied anlegen (Kämmerer*in): Mitglied suchen, Positionen wählen, bestellen.
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, NumberStepper } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		MAX_NOTE,
		MAX_QUANTITY,
		orderCreateInput,
		type Article,
		type MemberOption,
		type OrderCreated
	} from '../schemas';
	import { API, errorMessage, fieldErrorsFrom, issuesToErrors, itemName } from './admin-helpers';

	let {
		open = $bindable(false),
		onsaved
	}: {
		open?: boolean;
		onsaved?: (created: OrderCreated) => void | Promise<void>;
	} = $props();

	interface Row {
		key: string;
		variantId: string | null;
		quantity: number;
	}

	const newRow = (): Row => ({ key: crypto.randomUUID(), variantId: null, quantity: 1 });

	let member = $state<MemberOption | null>(null);
	let note = $state('');
	let rows = $state<Row[]>([newRow()]);
	let articles = $state<Article[] | null>(null);
	let articlesError = $state('');
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			member = null;
			note = '';
			rows = [newRow()];
			search = '';
			results = [];
			error = '';
			errors = {};
			void loadArticles();
		}
		wasOpen = open;
	});

	async function loadArticles() {
		articlesError = '';
		try {
			articles = await apiFetch<Article[]>(`${API}/articles?scope=catalog`);
		} catch (e) {
			articlesError = errorMessage(e, 'Artikel konnten nicht geladen werden');
		}
	}

	// --- Mitglied suchen -----------------------------------------------------------
	let search = $state('');
	let results = $state<MemberOption[]>([]);
	let searching = $state(false);
	let searchError = $state('');
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchSeq = 0;

	function onsearch() {
		clearTimeout(searchTimer);
		const q = search.trim();
		searchError = '';
		if (q.length < 2) {
			results = [];
			searching = false;
			return;
		}
		searching = true;
		searchTimer = setTimeout(async () => {
			const seq = ++searchSeq;
			try {
				const list = await apiFetch<MemberOption[]>(
					`${API}/members?search=${encodeURIComponent(q)}`
				);
				if (seq === searchSeq) results = list;
			} catch (e) {
				if (seq === searchSeq) searchError = errorMessage(e, 'Suche fehlgeschlagen');
			} finally {
				if (seq === searchSeq) searching = false;
			}
		}, 250);
	}

	function choose(m: MemberOption) {
		member = m;
		search = '';
		results = [];
		errors = Object.fromEntries(Object.entries(errors).filter(([k]) => k !== 'memberId'));
	}

	// --- Positionen ----------------------------------------------------------------
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
	/** Auswahl je Zeile: ohne die in anderen Zeilen gewählten Varianten */
	function optionsFor(row: Row) {
		const taken = new Set(rows.filter((r) => r !== row && r.variantId).map((r) => r.variantId));
		return baseOptions.filter((o) => !taken.has(o.value));
	}
	const priceOf = (row: Row) =>
		row.variantId ? (variants.get(row.variantId)?.priceCents ?? 0) : 0;
	const total = $derived(rows.reduce((s, r) => s + r.quantity * priceOf(r), 0));

	function updateRow(key: string, patch: Partial<Row>) {
		rows = rows.map((r) => (r.key === key ? { ...r, ...patch } : r));
	}

	// --- Bestellen -----------------------------------------------------------------
	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const payload = {
			memberId: member?.id ?? '',
			items: rows.map((r) => ({ variantId: r.variantId ?? '', quantity: r.quantity })),
			note: note.trim() || null
		};
		const parsed = orderCreateInput.safeParse(payload);
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			if (errors.memberId) errors.memberId = 'Bitte wähle das Mitglied, für das du bestellst.';
			for (const [k, v] of Object.entries(errors))
				if (/^items\.\d+\.variantId$/.test(k) && v !== 'Artikel doppelt')
					errors[k] = 'Bitte wähle einen Artikel.';
			return;
		}
		errors = {};
		busy = true;
		error = '';
		try {
			const created = await apiFetch<OrderCreated>(`${API}/orders`, {
				method: 'POST',
				body: JSON.stringify(parsed.data)
			});
			const nr = created.order.number;
			const inv = created.order.invoiceNumber;
			if (inv && created.mailed)
				toast.success(`Bestellung ${nr} angelegt, Rechnung ${inv} per E-Mail verschickt`);
			else if (inv)
				toast.success(`Bestellung ${nr} angelegt, Rechnung ${inv} erstellt`, {
					description: 'Die E-Mail konnte nicht verschickt werden.'
				});
			else toast.success(`Bestellung ${nr} angelegt, Rechnung folgt`);
			open = false;
			await onsaved?.(created);
		} catch (err) {
			if (err instanceof ApiClientError) {
				error = err.message;
				errors = fieldErrorsFrom(err.details);
			} else error = 'Bestellung konnte nicht angelegt werden';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Bestellung anlegen</Dialog.Title>
			<Dialog.Description>
				Für ein beliebiges Mitglied bestellen. Die Rechnung geht sofort per E-Mail raus.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField label="Für Mitglied *" id="oc-member" error={errors.memberId}>
				{#if member}
					<div class="flex min-h-9 items-center justify-between gap-2 rounded-md border px-3 py-1">
						<span class="truncate text-sm font-medium">{member.name}</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={busy}
							onclick={() => {
								member = null;
								queueMicrotask(() => document.getElementById('oc-member')?.focus());
							}}
						>
							Ändern
						</Button>
					</div>
				{:else}
					<div class="space-y-1.5">
						<div class="relative">
							<Search
								class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
								aria-hidden="true"
							/>
							<Input
								id="oc-member"
								class="pl-8"
								placeholder="Name suchen (ab 2 Zeichen) …"
								aria-label="Mitglied suchen"
								autocomplete="off"
								aria-invalid={!!errors.memberId}
								bind:value={search}
								oninput={onsearch}
							/>
							{#if search}
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									class="absolute top-1/2 right-1 -translate-y-1/2"
									aria-label="Suche leeren"
									onclick={() => {
										search = '';
										onsearch();
									}}
								>
									<X />
								</Button>
							{/if}
						</div>
						{#if search.trim().length >= 2}
							<div class="rounded-md border" aria-live="polite">
								{#if searching}
									<p class="p-2 text-xs text-muted-foreground">Sucht …</p>
								{:else if searchError}
									<p class="p-2 text-xs text-destructive">{searchError}</p>
								{:else if !results.length}
									<p class="p-2 text-xs text-muted-foreground">Kein Mitglied gefunden.</p>
								{:else}
									<ul class="max-h-48 overflow-y-auto py-1">
										{#each results as m (m.id)}
											<li>
												<button
													type="button"
													class="w-full px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
													onclick={() => choose(m)}
												>
													{m.name}
												</button>
											</li>
										{/each}
									</ul>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			</FormField>

			<fieldset class="space-y-2">
				<legend class="text-sm font-medium">Artikel *</legend>
				{#if articlesError}
					<p class="text-sm text-destructive" role="alert">
						{articlesError}
						<Button size="sm" variant="link" onclick={loadArticles}>Erneut versuchen</Button>
					</p>
				{:else if articles && !baseOptions.length}
					<p class="text-sm text-muted-foreground">
						Es gibt noch keine bestellbaren Artikel. Lege sie im Tab „Artikel“ an.
					</p>
				{/if}
				<ul class="space-y-2">
					{#each rows as row, idx (row.key)}
						{@const err =
							errors[`items.${idx}.variantId`] ??
							errors[`items.${idx}.quantity`] ??
							errors[`items.${idx}`]}
						<li class="rounded-md border p-3">
							<div class="flex flex-col gap-2 sm:flex-row sm:items-end">
								<div class="grid min-w-0 flex-1 gap-1">
									<span class="text-xs text-muted-foreground">Artikel und Größe</span>
									<SelectField
										label={`Artikel Position ${idx + 1}`}
										options={optionsFor(row)}
										value={row.variantId}
										placeholder={articles ? 'Artikel wählen …' : 'Lädt …'}
										disabled={busy}
										invalid={!!errors[`items.${idx}.variantId`]}
										onchange={(v) => updateRow(row.key, { variantId: v })}
									/>
								</div>
								<div class="flex items-end gap-2">
									<div class="grid gap-1">
										<span class="text-xs text-muted-foreground">Menge</span>
										<NumberStepper
											label={`Menge Position ${idx + 1}`}
											min={1}
											max={MAX_QUANTITY}
											value={row.quantity}
											disabled={busy}
											onchange={(v) => updateRow(row.key, { quantity: v })}
										/>
									</div>
									<div class="grid flex-1 gap-1 text-right sm:w-20 sm:flex-none">
										<span class="text-xs text-muted-foreground">Betrag</span>
										<span class="flex min-h-9 items-center justify-end text-sm tabular-nums">
											{row.variantId ? formatEuro(row.quantity * priceOf(row)) : '–'}
										</span>
									</div>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										aria-label={`Position ${idx + 1} entfernen`}
										disabled={busy || rows.length <= 1}
										onclick={() => (rows = rows.filter((r) => r.key !== row.key))}
									>
										<Trash2 />
									</Button>
								</div>
							</div>
							{#if err}<p class="mt-1 text-xs text-destructive" role="alert">{err}</p>{/if}
						</li>
					{/each}
				</ul>
				{#if errors.items}
					<p class="text-xs text-destructive" role="alert">{errors.items}</p>
				{/if}
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={busy || rows.length >= baseOptions.length}
					onclick={() => (rows = [...rows, newRow()])}
				>
					<Plus /> Artikel hinzufügen
				</Button>
			</fieldset>

			<p class="flex justify-between rounded-md bg-muted/50 px-3 py-2 text-sm">
				<span>Summe</span>
				<span class="font-semibold tabular-nums">{formatEuro(total)}</span>
			</p>

			<FormField label="Notiz (optional)" id="oc-note" error={errors.note}>
				<Textarea
					id="oc-note"
					bind:value={note}
					rows={2}
					maxlength={MAX_NOTE}
					placeholder="z. B. Abholung bei der nächsten Gruppenstunde"
				/>
			</FormField>
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>
					{busy ? 'Bestellt …' : 'Verbindlich bestellen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
