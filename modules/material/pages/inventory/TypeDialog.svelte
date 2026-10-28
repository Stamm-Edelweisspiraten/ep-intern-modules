<script lang="ts">
	// Ansicht eines Typs mit seinen Lagerartikeln (zentrierter Dialog); Aktionen je nach Recht.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Archive from '@lucide/svelte/icons/archive';
	import ArchiveRestore from '@lucide/svelte/icons/archive-restore';
	import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Printer from '@lucide/svelte/icons/printer';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { ConfirmDialog, ErrorState, LoadingState } from '$lib/components/layout';
	import { cn } from '$lib/utils';
	import type { MaterialType, TypeDetail } from '../../schemas';
	import { API, errorText } from '../helpers';
	import CategoryGlyph from '../shared/CategoryGlyph.svelte';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import { inventoryPermissions } from './options';

	let {
		open = $bindable(false),
		typeId,
		onedit,
		onadditem,
		onopenitem,
		onprint,
		onchanged,
		onreserve
	}: {
		open?: boolean;
		typeId: string | null;
		onedit: (type: MaterialType) => void;
		onadditem: (type: MaterialType) => void;
		onopenitem: (itemId: string) => void;
		/** Etiketten für diese Artikel */
		onprint: (itemIds: string[]) => void;
		onchanged: () => void;
		onreserve: () => void;
	} = $props();

	const perm = $derived(inventoryPermissions());

	let type = $state<TypeDetail | null>(null);
	let loading = $state(false);
	let error = $state('');
	let imageIndex = $state(0);
	let busy = $state(false);
	let deleteOpen = $state(false);
	let seq = 0;

	$effect(() => {
		if (!open || !typeId) return;
		const id = typeId;
		untrack(() => {
			imageIndex = 0;
			void load(id);
		});
	});

	async function load(id: string) {
		const mine = ++seq;
		loading = true;
		error = '';
		if (type?.id !== id) type = null;
		try {
			const res = await apiFetch<TypeDetail>(`${API}/types/${id}`);
			if (mine === seq) type = res;
		} catch (e) {
			if (mine === seq) error = errorText(e, 'Typ konnte nicht geladen werden');
		} finally {
			if (mine === seq) loading = false;
		}
	}

	const activeItems = $derived(type?.items.filter((i) => !i.archived) ?? []);
	const archivedCount = $derived((type?.items.length ?? 0) - activeItems.length);

	async function setArchived(archived: boolean) {
		if (!type) return;
		busy = true;
		try {
			await apiFetch<MaterialType>(`${API}/types/${type.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ archived })
			});
			toast.success(archived ? 'Typ archiviert' : 'Typ wiederhergestellt');
			onchanged();
			await load(type.id);
		} catch (err) {
			toast.error(errorText(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!type) return;
		const current = type;
		try {
			await apiFetch(`${API}/types/${current.id}`, { method: 'DELETE' });
			toast.success(`Typ „${current.name}“ gelöscht`);
			open = false;
			onchanged();
		} catch (err) {
			// 409: noch Artikel oder Reservierungen → Server rät zum Archivieren
			toast.error(errorText(err, 'Typ konnte nicht gelöscht werden'));
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		{#if type}
			<Dialog.Header>
				<Dialog.Title class="flex flex-wrap items-center gap-2 break-words">
					<CategoryGlyph category={type.category} size="sm" />
					{type.name}
					{#if type.archived}<Badge variant="outline">Archiviert</Badge>{/if}
				</Dialog.Title>
				<Dialog.Description>
					Typ · {type.category?.name ?? 'Ohne Kategorie'} ·
					<span class="tabular-nums">{type.totalQuantity}</span> insgesamt, davon
					<span class="tabular-nums">{type.usableQuantity}</span> nutzbar
				</Dialog.Description>
			</Dialog.Header>

			<div class="grid gap-5">
				{#if type.images.length}
					<div class="grid gap-2">
						<div class="overflow-hidden rounded-lg border bg-muted">
							<img
								src={type.images[imageIndex]?.webUrl ?? type.images[0]!.webUrl}
								alt={`Bild von ${type.name}`}
								class="mx-auto max-h-64 w-full object-contain"
							/>
						</div>
						{#if type.images.length > 1}
							<div class="flex flex-wrap gap-2" role="group" aria-label="Bilder">
								{#each type.images as img, i (img.id)}
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

				{#if type.description}
					<p class="text-sm whitespace-pre-line">{type.description}</p>
				{/if}
				{#if type.notes}
					<div class="grid gap-1 text-sm">
						<h3 class="text-xs text-muted-foreground">Notizen</h3>
						<p class="whitespace-pre-line">{type.notes}</p>
					</div>
				{/if}

				<section class="grid gap-2" aria-labelledby="type-items-heading">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<h3 id="type-items-heading" class="text-sm font-medium">
							Artikel ({activeItems.length}{archivedCount ? `, ${archivedCount} archiviert` : ''})
						</h3>
						{#if perm.manage && !type.archived}
							<Button size="sm" variant="outline" onclick={() => onadditem(type!)}>
								<Plus /> Artikel hinzufügen
							</Button>
						{/if}
					</div>
					{#if type.items.length}
						<ul class="divide-y rounded-lg border text-sm">
							{#each type.items as i (i.id)}
								<li>
									<button
										type="button"
										class="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-muted/50"
										onclick={() => onopenitem(i.id)}
									>
										<span class="min-w-0 flex-1 truncate font-medium">
											{i.name}
											{#if i.archived}<Badge variant="outline" class="ml-1">Archiviert</Badge>{/if}
										</span>
										<span class="text-muted-foreground">{i.locationName ?? 'Ohne Lagerort'}</span>
										<span class="tabular-nums">{i.quantity} ×</span>
										<ConditionBadge condition={i.condition} hideOk />
										<span class="font-mono text-xs text-muted-foreground">{i.code}</span>
									</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-sm text-muted-foreground">
							Noch keine Artikel. Lege die einzelnen Stücke an, z. B. „{type.name} 1“ bis „{type.name}
							8“.
						</p>
					{/if}
				</section>
			</div>

			<Dialog.Footer class="sm:justify-between">
				<div class="flex flex-col gap-2 sm:flex-row">
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
								{#if type.archived}
									<DropdownMenu.Item onclick={() => setArchived(false)}>
										<ArchiveRestore /> Wiederherstellen
									</DropdownMenu.Item>
								{:else}
									<DropdownMenu.Item onclick={() => setArchived(true)}>
										<Archive /> Archivieren
									</DropdownMenu.Item>
								{/if}
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									variant="destructive"
									disabled={type.items.length > 0}
									onclick={() => (deleteOpen = true)}
								>
									<Trash2 />
									{type.items.length ? 'Löschen (nur ohne Artikel)' : 'Löschen'}
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/if}
					{#if perm.reserve && !type.archived && type.usableQuantity > 0}
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
				<div class="flex flex-col gap-2 sm:flex-row">
					{#if perm.labels && activeItems.length}
						<Button variant="outline" onclick={() => onprint(activeItems.map((i) => i.id))}>
							<Printer /> Etiketten drucken
						</Button>
					{/if}
					{#if perm.manage}
						<Button onclick={() => onedit(type!)}><Pencil /> Bearbeiten</Button>
					{/if}
				</div>
			</Dialog.Footer>
		{:else}
			<Dialog.Header>
				<Dialog.Title>Typ</Dialog.Title>
				<Dialog.Description class="sr-only">Details des Typs</Dialog.Description>
			</Dialog.Header>
			{#if error}
				<ErrorState
					message={error}
					onretry={() => (typeId ? load(typeId) : undefined)}
					busy={loading}
					compact
				/>
			{:else}
				<LoadingState label="Typ" rows={4} />
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Typ löschen?"
	description={type
		? `„${type.name}“ wird endgültig gelöscht, inklusive Bildern. Steht der Typ in Reservierungen, archiviere ihn stattdessen.`
		: ''}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
