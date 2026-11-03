<script lang="ts">
	// Lebensmittel ansehen: Chargen mit MHD, Einlagern, Entnehmen/Entsorgen (zuerst ablaufende zuerst oder aus
	// einer Charge), Charge berichtigen, Verlauf; Bearbeiten, Archivieren, Löschen.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Archive from '@lucide/svelte/icons/archive';
	import ArchiveRestore from '@lucide/svelte/icons/archive-restore';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import {
		BUSY_SAVE,
		ConfirmDialog,
		ErrorState,
		FormField,
		LoadingState,
		NumberStepper
	} from '$lib/components/layout';
	import { EXPIRY_LABELS } from '../../pantry';
	import {
		MAX_QUANTITY,
		MOVEMENT_LABELS,
		type FoodBatch,
		type FoodProduct,
		type Location,
		type ProductDetail
	} from '../../schemas';
	import {
		API,
		EXPIRY_VARIANTS,
		apiFieldErrors,
		errorText,
		formatAmount,
		formatDate
	} from '../helpers';
	import { locationOptions } from '../inventory/options';

	let {
		open = $bindable(false),
		productId,
		canManage,
		locations,
		onedit,
		onchanged
	}: {
		open?: boolean;
		productId: string | null;
		canManage: boolean;
		locations: Location[];
		onedit: (product: FoodProduct) => void;
		/** Bestand oder Angaben geändert, gelöscht */
		onchanged: () => void;
	} = $props();

	let data = $state<ProductDetail | null>(null);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		if (!productId) return;
		loading = !data;
		error = '';
		try {
			data = await apiFetch<ProductDetail>(`${API}/pantry/products/${productId}`);
		} catch (e) {
			error = errorText(e, 'Produkt konnte nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open && productId)
			untrack(() => {
				data = null;
				action = null;
				void load();
			});
	});

	const p = $derived(data);
	const amount = (n: number) => formatAmount(n, p?.unit ?? '');

	// --- Buchen ------------------------------------------------------------------------
	type Action =
		| { kind: 'in' }
		| { kind: 'out'; batch: FoodBatch | null }
		| { kind: 'discard'; batch: FoodBatch | null }
		| { kind: 'correct'; batch: FoodBatch };
	let action = $state<Action | null>(null);
	let quantity = $state(1);
	let bestBefore = $state('');
	let locationId = $state<string | null>(null);
	let note = $state('');
	let errors = $state<Record<string, string>>({});
	let busy = $state<'save' | 'archive' | 'delete' | null>(null);
	let deleteOpen = $state(false);

	function start(a: Action) {
		action = a;
		errors = {};
		note = '';
		if (a.kind === 'correct') {
			quantity = a.batch.quantity;
			bestBefore = a.batch.bestBefore ?? '';
		} else {
			quantity = 1;
			bestBefore = '';
			locationId = p?.locationId ?? null;
		}
	}

	const maxOut = $derived(
		action && (action.kind === 'out' || action.kind === 'discard')
			? (action.batch?.quantity ?? p?.quantity ?? 1)
			: MAX_QUANTITY
	);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!p || !action) return;
		busy = 'save';
		errors = {};
		const base = `${API}/pantry/products/${p.id}`;
		try {
			if (action.kind === 'in') {
				await apiFetch<FoodProduct>(`${base}/check-in`, {
					method: 'POST',
					body: JSON.stringify({ quantity, bestBefore: bestBefore || null, locationId, note })
				});
			} else if (action.kind === 'correct') {
				await apiFetch<FoodProduct>(`${base}/batches/${action.batch.id}`, {
					method: 'PATCH',
					body: JSON.stringify({ quantity, bestBefore: bestBefore || null, note })
				});
			} else {
				await apiFetch<FoodProduct>(`${base}/check-out`, {
					method: 'POST',
					body: JSON.stringify({
						quantity,
						kind: action.kind,
						batchId: action.batch?.id ?? null,
						note
					})
				});
			}
			toast.success(
				action.kind === 'in'
					? `${amount(quantity)} eingelagert`
					: action.kind === 'correct'
						? 'Charge berichtigt'
						: `${amount(quantity)} ${action.kind === 'discard' ? 'entsorgt' : 'entnommen'}`
			);
			action = null;
			onchanged();
			await load();
		} catch (err) {
			errors = apiFieldErrors(err);
			if (!Object.keys(errors).length) toast.error(errorText(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = null;
		}
	}

	async function setArchived(archived: boolean) {
		if (!p) return;
		busy = 'archive';
		try {
			await apiFetch<FoodProduct>(`${API}/pantry/products/${p.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ archived })
			});
			toast.success(archived ? 'Archiviert' : 'Wiederhergestellt');
			onchanged();
			await load();
		} catch (e) {
			toast.error(errorText(e, 'Das hat nicht geklappt'));
		} finally {
			busy = null;
		}
	}

	async function remove() {
		if (!p) return;
		busy = 'delete';
		try {
			await apiFetch(`${API}/pantry/products/${p.id}`, { method: 'DELETE' });
			toast.success('Produkt gelöscht');
			open = false;
			onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		} finally {
			busy = null;
		}
	}

	const actionTitle = $derived.by(() => {
		if (!action) return '';
		const from = (b: FoodBatch | null) =>
			b ? ` (Charge ${b.bestBefore ? `MHD ${formatDate(b.bestBefore)}` : 'ohne MHD'})` : '';
		if (action.kind === 'in') return 'Einlagern';
		if (action.kind === 'correct') return `Charge berichtigen${from(action.batch)}`;
		return `${action.kind === 'discard' ? 'Entsorgen' : 'Entnehmen'}${from(action.batch)}`;
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title class="flex flex-wrap items-center gap-2">
				{p?.name ?? 'Lebensmittel'}
				{#if p && p.quantity > 0}
					<Badge variant={EXPIRY_VARIANTS[p.state]}>{EXPIRY_LABELS[p.state]}</Badge>
				{/if}
				{#if p?.archived}<Badge variant="outline">Archiviert</Badge>{/if}
			</Dialog.Title>
			<Dialog.Description>
				{#if p}
					{[p.brand, p.packageSize, p.locationName ?? 'Ohne Lagerort'].filter(Boolean).join(' · ')}
				{:else}
					Vorrat
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if loading}
			<LoadingState rows={4} />
		{:else if error}
			<ErrorState message={error} onretry={load} compact />
		{:else if p}
			<div class="grid gap-5">
				<dl class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
					<div>
						<dt class="text-xs text-muted-foreground">Bestand</dt>
						<dd class="text-lg font-semibold tabular-nums">{amount(p.quantity)}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Nächstes MHD</dt>
						<dd class="font-medium">{p.nextBestBefore ? formatDate(p.nextBestBefore) : '–'}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Strichcode</dt>
						<dd class="font-mono">{p.barcode ?? '–'}</dd>
					</div>
				</dl>
				{#if p.notes}<p class="text-sm whitespace-pre-line">{p.notes}</p>{/if}

				{#if canManage && !p.archived && !action}
					<div class="grid grid-cols-3 gap-2">
						<Button onclick={() => start({ kind: 'in' })}>Einlagern</Button>
						<Button
							variant="outline"
							disabled={!p.quantity}
							onclick={() => start({ kind: 'out', batch: null })}>Entnehmen</Button
						>
						<Button
							variant="outline"
							disabled={!p.quantity}
							onclick={() => start({ kind: 'discard', batch: null })}>Entsorgen</Button
						>
					</div>
				{/if}

				{#if action}
					<form class="grid gap-3 rounded-lg border p-3" onsubmit={submit}>
						<h3 class="text-sm font-medium">{actionTitle}</h3>
						<div class="grid gap-3 sm:grid-cols-2">
							<FormField
								label={p.unit ? `Menge (${p.unit})` : 'Menge'}
								id="pantry-action-qty"
								error={errors.quantity}
							>
								<NumberStepper
									id="pantry-action-qty"
									label="Menge"
									min={action.kind === 'correct' ? 0 : 1}
									max={action.kind === 'correct' ? MAX_QUANTITY : Math.max(1, maxOut)}
									bind:value={quantity}
								/>
							</FormField>
							{#if action.kind === 'in' || action.kind === 'correct'}
								<FormField
									label="Mindestens haltbar bis"
									id="pantry-action-mhd"
									hint={action.kind === 'in' ? 'Leer = kein MHD' : undefined}
									error={errors.bestBefore}
								>
									<Input id="pantry-action-mhd" type="date" bind:value={bestBefore} />
								</FormField>
							{/if}
							{#if action.kind === 'in'}
								<FormField label="Lagerort" id="pantry-action-location" error={errors.locationId}>
									<SelectField
										id="pantry-action-location"
										label="Lagerort"
										options={locationOptions(locations)}
										emptyLabel="Ohne Lagerort"
										bind:value={locationId}
									/>
								</FormField>
							{/if}
							<FormField label="Notiz" id="pantry-action-note" error={errors.note}>
								<Input
									id="pantry-action-note"
									bind:value={note}
									maxlength={1000}
									placeholder={action.kind === 'out'
										? 'z. B. Gruppenstunde Füchse'
										: action.kind === 'discard'
											? 'z. B. Packung offen'
											: ''}
								/>
							</FormField>
						</div>
						{#if action.kind === 'out' || action.kind === 'discard'}
							{#if !action.batch}
								<p class="text-xs text-muted-foreground">
									Zuerst ablaufende Chargen werden zuerst genommen.
								</p>
							{/if}
						{/if}
						<div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
							<Button type="button" variant="outline" onclick={() => (action = null)}
								>Abbrechen</Button
							>
							<Button type="submit" disabled={!!busy}
								>{busy === 'save' ? BUSY_SAVE : 'Speichern'}</Button
							>
						</div>
					</form>
				{/if}

				<section class="grid gap-2" aria-labelledby="pantry-batches-heading">
					<h3 id="pantry-batches-heading" class="text-sm font-medium">Chargen</h3>
					{#if p.batches.length}
						<ul class="divide-y rounded-lg border text-sm">
							{#each p.batches as b (b.id)}
								<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
									<span class="min-w-0 flex-1">
										<span class="font-medium tabular-nums">{amount(b.quantity)}</span>
										<span class="text-muted-foreground">
											· {b.bestBefore ? `MHD ${formatDate(b.bestBefore)}` : 'ohne MHD'}
											{#if b.locationName}· {b.locationName}{/if}
										</span>
									</span>
									<Badge variant={EXPIRY_VARIANTS[b.state]}>{EXPIRY_LABELS[b.state]}</Badge>
									{#if canManage && !p.archived}
										<span class="flex gap-1">
											<Button
												size="sm"
												variant="ghost"
												onclick={() => start({ kind: 'out', batch: b })}>Entnehmen</Button
											>
											<Button
												size="sm"
												variant="ghost"
												onclick={() => start({ kind: 'discard', batch: b })}>Entsorgen</Button
											>
											<Button
												size="sm"
												variant="ghost"
												aria-label="Charge berichtigen"
												onclick={() => start({ kind: 'correct', batch: b })}><Pencil /></Button
											>
										</span>
									{/if}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-sm text-muted-foreground">Nichts auf Lager.</p>
					{/if}
				</section>

				<section class="grid gap-2" aria-labelledby="pantry-moves-heading">
					<h3 id="pantry-moves-heading" class="text-sm font-medium">Verlauf</h3>
					{#if p.movements.length}
						<ul class="max-h-56 divide-y overflow-y-auto rounded-lg border text-sm">
							{#each p.movements as m (m.id)}
								<li class="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
									<span class="font-medium">{MOVEMENT_LABELS[m.kind]}</span>
									<span class="tabular-nums">
										{m.kind === 'in' ? '+' : m.kind === 'correct' ? '' : '−'}{amount(m.quantity)}
									</span>
									{#if m.note}<span class="min-w-0 flex-1 truncate text-muted-foreground"
											>{m.note}</span
										>{/if}
									<span class="ml-auto text-xs text-muted-foreground">
										{formatDate(m.createdAt)}{m.createdByName ? ` · ${m.createdByName}` : ''}
									</span>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-sm text-muted-foreground">Noch keine Buchungen.</p>
					{/if}
				</section>
			</div>

			{#if canManage}
				<Dialog.Footer class="gap-2 sm:justify-between">
					<div class="flex gap-2">
						{#if p.quantity === 0}
							<Button
								variant="destructive"
								size="sm"
								disabled={!!busy}
								onclick={() => (deleteOpen = true)}
							>
								<Trash2 /> Löschen
							</Button>
						{/if}
						<Button
							variant="outline"
							size="sm"
							disabled={!!busy}
							onclick={() => setArchived(!p.archived)}
						>
							{#if p.archived}<ArchiveRestore /> Wiederherstellen{:else}<Archive /> Archivieren{/if}
						</Button>
					</div>
					<Button
						size="sm"
						onclick={() => {
							open = false;
							onedit(p);
						}}
					>
						<Pencil /> Bearbeiten
					</Button>
				</Dialog.Footer>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Produkt löschen?"
	description={`„${p?.name ?? ''}“ und sein Verlauf werden endgültig gelöscht.`}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
