<script lang="ts">
	// Ansicht eines Lagerartikels als zentrierter Dialog (auch nach einem Scan): Bilder, Daten, Zustand,
	// kommende Reservierungen; Aktionen je nach Recht.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Archive from '@lucide/svelte/icons/archive';
	import ArchiveRestore from '@lucide/svelte/icons/archive-restore';
	import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Printer from '@lucide/svelte/icons/printer';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import {
		BUSY_SAVE,
		ConfirmDialog,
		ErrorState,
		FormField,
		LoadingState
	} from '$lib/components/layout';
	import { cn } from '$lib/utils';
	import { conditionInput, reservationState, type Item, type ItemDetail } from '../../schemas';
	import {
		API,
		RESERVATION_STATE_LABELS,
		STATE_VARIANTS,
		errorText,
		fieldErrors,
		formatAmount,
		formatDate,
		formatPeriod,
		reservationHref
	} from '../helpers';
	import CategoryGlyph from '../shared/CategoryGlyph.svelte';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import { conditionOptions, inventoryPermissions } from './options';

	let {
		open = $bindable(false),
		itemId,
		onedit,
		onprint,
		onopentype,
		onchanged,
		onreserve
	}: {
		open?: boolean;
		itemId: string | null;
		onedit: (item: Item) => void;
		onprint: (id: string) => void;
		onopentype: (typeId: string) => void;
		/** Artikel geändert, archiviert oder gelöscht */
		onchanged: () => void;
		onreserve: () => void;
	} = $props();

	const perm = $derived(inventoryPermissions());

	let item = $state<ItemDetail | null>(null);
	let loading = $state(false);
	let error = $state('');
	let imageIndex = $state(0);
	let reporting = $state(false);
	let reportCondition = $state<string | null>('ok');
	let reportNote = $state('');
	let reportErrors = $state<Record<string, string>>({});
	let busy = $state(false);
	let deleteOpen = $state(false);
	let seq = 0;

	$effect(() => {
		if (!open || !itemId) return;
		const id = itemId;
		untrack(() => {
			reporting = false;
			imageIndex = 0;
			void load(id);
		});
	});

	async function load(id: string) {
		const mine = ++seq;
		loading = true;
		error = '';
		if (item?.id !== id) item = null;
		try {
			const res = await apiFetch<ItemDetail>(`${API}/items/${id}`);
			if (mine === seq) item = res;
		} catch (e) {
			if (mine === seq) error = errorText(e, 'Artikel konnte nicht geladen werden');
		} finally {
			if (mine === seq) loading = false;
		}
	}

	const today = new Date().toISOString().slice(0, 10);
	const mainImage = $derived(
		item?.images[imageIndex]?.webUrl ?? item?.images[0]?.webUrl ?? item?.thumbUrl ?? null
	);

	function startReport() {
		if (!item) return;
		reportCondition = item.condition;
		reportNote = item.conditionNote;
		reportErrors = {};
		reporting = true;
	}

	async function sendReport(e: SubmitEvent) {
		e.preventDefault();
		if (!item) return;
		const parsed = conditionInput.safeParse({ condition: reportCondition, note: reportNote });
		if (!parsed.success) {
			reportErrors = fieldErrors(parsed.error);
			return;
		}
		busy = true;
		try {
			await apiFetch<Item>(`${API}/items/${item.id}/condition`, {
				method: 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success('Zustand gemeldet');
			reporting = false;
			onchanged();
			await load(item.id);
		} catch (err) {
			toast.error(errorText(err, 'Zustand konnte nicht gemeldet werden'));
		} finally {
			busy = false;
		}
	}

	async function setArchived(archived: boolean) {
		if (!item) return;
		busy = true;
		try {
			await apiFetch<Item>(`${API}/items/${item.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ archived })
			});
			toast.success(archived ? 'Artikel archiviert' : 'Artikel wiederhergestellt');
			onchanged();
			await load(item.id);
		} catch (err) {
			toast.error(errorText(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!item) return;
		const current = item;
		try {
			await apiFetch(`${API}/items/${current.id}`, { method: 'DELETE' });
			toast.success(`„${current.name}“ gelöscht`);
			open = false;
			onchanged();
		} catch (err) {
			// 409: steht in Reservierungen → Hinweis „archivieren“ kommt vom Server
			toast.error(errorText(err, 'Artikel konnte nicht gelöscht werden'));
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		{#if item}
			<Dialog.Header>
				<Dialog.Title class="flex flex-wrap items-center gap-2 break-words">
					{item.name}
					{#if item.archived}<Badge variant="outline">Archiviert</Badge>{/if}
				</Dialog.Title>
				<Dialog.Description>
					<span class="font-mono">{item.code}</span>
					{#if item.typeName}· Typ {item.typeName}{/if}
				</Dialog.Description>
			</Dialog.Header>

			<div class="grid gap-5">
				{#if mainImage}
					<div class="grid gap-2">
						<div class="overflow-hidden rounded-lg border bg-muted">
							<img
								src={mainImage}
								alt={`Bild von ${item.name}`}
								class="mx-auto max-h-72 w-full object-contain"
							/>
						</div>
						{#if item.images.length > 1}
							<div class="flex flex-wrap gap-2" role="group" aria-label="Bilder">
								{#each item.images as img, i (img.id)}
									<button
										type="button"
										class={cn(
											'size-14 overflow-hidden rounded-md border-2',
											i === imageIndex ? 'border-foreground' : 'border-transparent'
										)}
										aria-label={`Bild ${i + 1} zeigen`}
										aria-pressed={i === imageIndex}
										onclick={() => (imageIndex = i)}
									>
										<img src={img.thumbUrl} alt="" class="size-full object-cover" loading="lazy" />
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				<dl class="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
					<div>
						<dt class="text-xs text-muted-foreground">Typ</dt>
						<dd>
							{#if item.typeId}
								<button
									type="button"
									class="text-link hover:underline"
									onclick={() => onopentype(item!.typeId!)}
								>
									{item.typeName}
								</button>
							{:else}
								<span class="text-muted-foreground">Ohne Typ</span>
							{/if}
						</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Kategorie</dt>
						<dd class="flex items-center gap-2">
							<CategoryGlyph category={item.category} size="sm" />
							{item.category?.name ?? 'Ohne Kategorie'}
						</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">
							{item.consumable ? 'Bestand (Verbrauchsmaterial)' : 'Anzahl'}
						</dt>
						<dd class="font-medium tabular-nums">{formatAmount(item.quantity, item.unit)}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Lagerort</dt>
						<dd class="font-medium">
							{item.locationName ?? 'Ohne Lagerort'}
						</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Code</dt>
						<dd class="font-mono">{item.code}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Zustand</dt>
						<dd class="grid gap-1">
							<span><ConditionBadge condition={item.condition} /></span>
							{#if item.conditionNote}<span>{item.conditionNote}</span>{/if}
							{#if item.conditionReportedAt}
								<span class="text-xs text-muted-foreground">
									Gemeldet {item.conditionReportedByName
										? `von ${item.conditionReportedByName} `
										: ''}am {formatDate(item.conditionReportedAt)}
								</span>
							{/if}
						</dd>
					</div>
				</dl>

				{#if item.notes}
					<div class="grid gap-1 text-sm">
						<h3 class="text-xs text-muted-foreground">Notizen</h3>
						<p class="whitespace-pre-line">{item.notes}</p>
					</div>
				{/if}

				{#if reporting}
					<form class="grid gap-3 rounded-lg border p-3" onsubmit={sendReport}>
						<h3 class="text-sm font-medium">Zustand melden</h3>
						<div class="grid gap-3 sm:grid-cols-2">
							<FormField label="Zustand" id="report-condition" error={reportErrors.condition}>
								<SelectField
									id="report-condition"
									label="Zustand"
									options={conditionOptions}
									bind:value={reportCondition}
								/>
							</FormField>
							<FormField label="Notiz" id="report-note" error={reportErrors.note}>
								<Input
									id="report-note"
									bind:value={reportNote}
									maxlength={1000}
									placeholder="Was ist passiert?"
								/>
							</FormField>
						</div>
						{#if reportCondition === 'damaged' || reportCondition === 'defect' || reportCondition === 'lost'}
							<p class="text-xs text-muted-foreground">
								Die Materialwart*innen werden benachrichtigt.
							</p>
						{/if}
						<div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
							<Button type="button" variant="outline" onclick={() => (reporting = false)}>
								Abbrechen
							</Button>
							<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Melden'}</Button>
						</div>
					</form>
				{/if}

				<section class="grid gap-2" aria-labelledby="item-reservations-heading">
					<h3 id="item-reservations-heading" class="text-sm font-medium">
						Laufende und kommende Reservierungen
					</h3>
					{#if item.reservations.length}
						<ul class="divide-y rounded-lg border text-sm">
							{#each item.reservations as r (r.id)}
								{@const state = reservationState(r, today)}
								<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
									<a
										href={reservationHref(r.id, !perm.reservations)}
										class="min-w-0 flex-1 truncate font-medium text-link hover:underline"
									>
										{r.title}
									</a>
									<span class="text-muted-foreground tabular-nums">
										{formatPeriod(r.startsOn, r.endsOn)}
									</span>
									<span class="tabular-nums">
										{r.quantity} ×{r.viaType ? ` ${item.typeName ?? 'Typ'}` : ''}
									</span>
									<Badge variant={STATE_VARIANTS[state]}>{RESERVATION_STATE_LABELS[state]}</Badge>
								</li>
							{/each}
						</ul>
						<p class="text-xs text-muted-foreground">
							„× Typ“ = über den Typ reserviert, welcher Artikel genau mitgeht, entscheidet sich bei
							der Ausgabe.
						</p>
					{:else}
						<p class="text-sm text-muted-foreground">Keine Reservierungen.</p>
					{/if}
				</section>

				{#if item.consumable && item.consumptions.length}
					<section class="grid gap-2" aria-labelledby="item-consumptions-heading">
						<h3 id="item-consumptions-heading" class="text-sm font-medium">Letzte Verbräuche</h3>
						<ul class="divide-y rounded-lg border text-sm">
							{#each item.consumptions as c, i (i)}
								<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
									{#if c.reservationId}
										<a
											href={reservationHref(c.reservationId, !perm.reservations)}
											class="min-w-0 flex-1 truncate font-medium text-link hover:underline"
										>
											{c.reservationTitle}
										</a>
									{:else}
										<span class="min-w-0 flex-1 truncate">{c.reservationTitle}</span>
									{/if}
									<span class="text-muted-foreground tabular-nums">{formatDate(c.recordedAt)}</span>
									<span class="font-medium tabular-nums"
										>−{formatAmount(c.quantity, item.unit)}</span
									>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			</div>

			<Dialog.Footer class="sm:justify-between">
				<div class="grid grid-cols-2 gap-2 sm:flex sm:flex-row">
					{#if perm.manage}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button {...props} variant="outline" disabled={busy}>
										<Ellipsis /> Mehr
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="start">
								{#if item.archived}
									<DropdownMenu.Item onclick={() => setArchived(false)}>
										<ArchiveRestore /> Wiederherstellen
									</DropdownMenu.Item>
								{:else}
									<DropdownMenu.Item onclick={() => setArchived(true)}>
										<Archive /> Archivieren
									</DropdownMenu.Item>
								{/if}
								<DropdownMenu.Separator />
								<DropdownMenu.Item variant="destructive" onclick={() => (deleteOpen = true)}>
									<Trash2 /> Löschen
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/if}
					{#if perm.reserve && !item.archived}
						<Button
							variant="outline"
							onclick={() => {
								open = false;
								onreserve();
							}}
						>
							<CalendarPlus /> Reservieren
						</Button>
					{/if}
				</div>
				<div class="grid grid-cols-2 gap-2 max-sm:order-first sm:flex sm:flex-row">
					{#if perm.report && !reporting}
						<Button variant="outline" onclick={startReport}><ShieldAlert /> Zustand melden</Button>
					{/if}
					{#if perm.labels}
						<Button variant="outline" onclick={() => onprint(item!.id)}>
							<Printer /> Etikett drucken
						</Button>
					{/if}
					{#if perm.manage}
						<Button class="max-sm:col-span-2" onclick={() => onedit(item!)}>
							<Pencil /> Bearbeiten
						</Button>
					{/if}
				</div>
			</Dialog.Footer>
		{:else}
			<Dialog.Header>
				<Dialog.Title>Lagerartikel</Dialog.Title>
				<Dialog.Description class="sr-only">Details des Lagerartikels</Dialog.Description>
			</Dialog.Header>
			{#if error}
				<ErrorState
					message={error}
					onretry={() => (itemId ? load(itemId) : undefined)}
					busy={loading}
					compact
				/>
			{:else}
				<LoadingState label="Artikel" rows={4} />
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Artikel löschen?"
	description={item
		? `„${item.name}“ (${item.code}) wird endgültig gelöscht, inklusive Bildern. Steht der Artikel in Reservierungen, archiviere ihn stattdessen.`
		: ''}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
