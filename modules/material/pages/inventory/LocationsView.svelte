<script lang="ts">
	// Lagerorte als Baum: Anzahl je Ort (inkl. Unterorte), Klick zeigt die Stücke dort.
	// Mit Verwaltungsrecht: anlegen, bearbeiten/verschieben, löschen, Etiketten.
	import { toast } from 'svelte-sonner';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Printer from '@lucide/svelte/icons/printer';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { ConfirmDialog, EmptyState } from '$lib/components/layout';
	import type { Location } from '../../schemas';
	import { API, errorText } from '../helpers';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';
	import LocationDialog from './LocationDialog.svelte';
	import { locationRows } from './inventory';

	let {
		locations,
		canManage,
		canLabels,
		onchanged,
		onshow
	}: {
		locations: Location[];
		canManage: boolean;
		canLabels: boolean;
		onchanged: () => void | Promise<void>;
		/** Stücke an diesem Ort (inkl. Unterorte) zeigen */
		onshow: (locationId: string) => void;
	} = $props();

	const rows = $derived(locationRows(locations));

	let dialogOpen = $state(false);
	let dialogKey = $state(0);
	let editing = $state<Location | null>(null);
	let newParent = $state<string | null>(null);

	let deleteTarget = $state<Location | null>(null);
	let deleteOpen = $state(false);

	let printOpen = $state(false);
	let printIds = $state<string[]>([]);

	function create(parentId: string | null) {
		editing = null;
		newParent = parentId;
		dialogKey++;
		dialogOpen = true;
	}

	function edit(l: Location) {
		editing = l;
		newParent = null;
		dialogKey++;
		dialogOpen = true;
	}

	function print(ids: string[]) {
		printIds = ids;
		printOpen = true;
	}

	async function remove() {
		const l = deleteTarget;
		if (!l) return;
		try {
			await apiFetch(`${API}/locations/${l.id}`, { method: 'DELETE' });
			toast.success('Lagerort gelöscht');
			await onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Lagerort konnte nicht gelöscht werden'));
		}
	}
</script>

<Card.Root>
	<Card.Content class="space-y-4 pt-6">
		{#if canManage || canLabels}
			<div class="flex flex-wrap gap-2">
				{#if canManage}
					<Button onclick={() => create(null)}><Plus /> Lagerort</Button>
				{/if}
				{#if canLabels && locations.length}
					<Button variant="outline" onclick={() => print(rows.map((r) => r.loc.id))}>
						<Printer /> Etiketten für alle Orte
					</Button>
				{/if}
			</div>
		{/if}

		{#if !rows.length}
			<EmptyState
				title="Noch keine Lagerorte"
				description="Leg an, wo euer Material liegt – z. B. Materialraum, Regal A, Dachboden."
			/>
		{:else}
			<ul class="divide-y rounded-lg border" aria-label="Lagerorte">
				{#each rows as r (r.loc.id)}
					<li class="flex items-center gap-2 py-1.5 pr-2">
						<button
							type="button"
							class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-sm hover:bg-muted/50"
							style:padding-left={`${0.75 + r.depth * 1.25}rem`}
							onclick={() => onshow(r.loc.id)}
							aria-label={`Stücke in ${r.loc.path} zeigen`}
						>
							{#if r.depth > 0}
								<ChevronRight class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
							{/if}
							<MapPin class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span class="min-w-0 flex-1">
								<span class="block truncate font-medium">{r.loc.name}</span>
								<span class="block truncate text-xs text-muted-foreground">
									{r.loc.code}{r.loc.description ? ` · ${r.loc.description}` : ''}
								</span>
							</span>
							<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
								{r.total === 1
									? '1 Stück'
									: `${r.total} Stücke`}{#if r.hasChildren && r.loc.unitCount !== r.total}
									<span class="sr-only">, davon direkt {r.loc.unitCount}</span>{/if}
							</span>
						</button>
						{#if canManage || canLabels}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon"
											aria-label={`Aktionen für ${r.loc.name}`}
										>
											<EllipsisVertical />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									{#if canManage}
										<DropdownMenu.Item onclick={() => create(r.loc.id)}>
											<Plus /> Unterort anlegen
										</DropdownMenu.Item>
										<DropdownMenu.Item onclick={() => edit(r.loc)}>
											<Pencil /> Bearbeiten / verschieben
										</DropdownMenu.Item>
									{/if}
									{#if canLabels}
										<DropdownMenu.Item onclick={() => print([r.loc.id])}>
											<Printer /> Etikett drucken
										</DropdownMenu.Item>
									{/if}
									{#if canManage}
										<DropdownMenu.Separator />
										<DropdownMenu.Item
											class="text-destructive"
											onclick={() => {
												deleteTarget = r.loc;
												deleteOpen = true;
											}}
										>
											<Trash2 /> Löschen
										</DropdownMenu.Item>
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					</li>
				{/each}
			</ul>
			<p class="text-xs text-muted-foreground">
				Klick auf einen Ort zeigt alle Stücke dort – auch in Unterorten und Kisten.
			</p>
		{/if}
	</Card.Content>
</Card.Root>

{#key dialogKey}
	<LocationDialog
		bind:open={dialogOpen}
		location={editing}
		parentId={newParent}
		{locations}
		onsaved={onchanged}
	/>
{/key}

<ConfirmDialog
	bind:open={deleteOpen}
	title="Lagerort löschen?"
	description={deleteTarget
		? `„${deleteTarget.path}“ wird gelöscht. Das geht nur, wenn dort nichts mehr liegt und es keine Unterorte gibt.`
		: ''}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>

<PrintLabelsDialog bind:open={printOpen} target="location" ids={printIds} />
