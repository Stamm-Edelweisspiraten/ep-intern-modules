<script lang="ts">
	// Inhalt eines Lagerorts: Unterorte, Stücke und Kisten (aufklappbar mit Inhalt) und Mengen direkt
	// dort. Ohne gewählten Ort („Alle Orte“) die obersten Orte. Mehrfachauswahl → Umlagern/Etiketten.
	import { UNPLACED } from '../helpers';
	import { untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Printer from '@lucide/svelte/icons/printer';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { ConfirmDialog, ErrorState, LoadingState, MobileActionBar } from '$lib/components/layout';
	import { cn } from '$lib/utils';
	import { MAX_BATCH_UNITS, type Location, type StockEntry, type UnitSummary } from '../../schemas';
	import { API, errorText } from '../helpers';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';
	import LocationDialog from '../inventory/LocationDialog.svelte';
	import MoveDialog from '../inventory/MoveDialog.svelte';
	import { locationRows } from '../inventory/inventory';

	let {
		locationId,
		locations,
		canManage,
		canLabels,
		reloadToken = 0,
		onselect,
		onopenunit,
		onopenarticle,
		onchanged
	}: {
		/** `null` = alle Orte */
		locationId: string | null;
		locations: Location[];
		canManage: boolean;
		canLabels: boolean;
		reloadToken?: number;
		onselect: (id: string | null) => void;
		onopenunit: (id: string) => void;
		onopenarticle: (id: string) => void;
		/** Nach Änderungen (Orte/Zähler neu laden) */
		onchanged: () => void | Promise<void>;
	} = $props();

	const location = $derived(locations.find((l) => l.id === locationId) ?? null);
	const rows = $derived(locationRows(locations));
	const children = $derived(
		rows.filter((r) =>
			locationId
				? r.loc.parentId === locationId
				: r.depth === 0 || !locations.some((l) => l.id === r.loc.parentId)
		)
	);
	const parentPath = $derived.by(() => {
		if (!location?.parentId) return '';
		return locations.find((l) => l.id === location.parentId)?.path ?? '';
	});

	// --- Inhalt laden ---
	let units = $state<UnitSummary[]>([]);
	let unitsTotal = $state(0);
	let stock = $state<StockEntry[]>([]);
	let loading = $state(false);
	let error = $state('');
	let seq = 0;

	async function load(id: string | null) {
		const my = ++seq;
		contents.clear();
		openBoxes.clear();
		if (!id) {
			units = [];
			stock = [];
			unitsTotal = 0;
			loading = false;
			error = '';
			return;
		}
		loading = true;
		error = '';
		try {
			const [u, s] = await Promise.all([
				apiFetch<{ items: UnitSummary[]; total: number }>(
					id === UNPLACED
						? `${API}/units?unplaced=1&limit=500`
						: `${API}/units?locationId=${id}&limit=500`
				),
				id === UNPLACED
					? Promise.resolve([] as StockEntry[])
					: apiFetch<StockEntry[]>(`${API}/stock?locationId=${id}`)
			]);
			if (my !== seq) return;
			units = u.items;
			unitsTotal = u.total;
			stock = s;
			const ids = new Set(u.items.map((x) => x.id));
			for (const sid of [...selected]) if (!ids.has(sid)) selected.delete(sid);
		} catch (e) {
			if (my === seq) error = errorText(e, 'Inhalt konnte nicht geladen werden');
		} finally {
			if (my === seq) loading = false;
		}
	}

	$effect(() => {
		const id = locationId;
		void reloadToken;
		untrack(() => void load(id));
	});

	// --- Kisten aufklappen ---
	type BoxContents = {
		loading: boolean;
		error: string;
		units: UnitSummary[];
		stock: StockEntry[];
	};
	const contents = new SvelteMap<string, BoxContents>();
	const openBoxes = new SvelteSet<string>();

	async function loadBox(id: string) {
		contents.set(id, { loading: true, error: '', units: [], stock: [] });
		try {
			const [u, s] = await Promise.all([
				apiFetch<{ items: UnitSummary[]; total: number }>(
					`${API}/units?containerId=${id}&limit=500`
				),
				apiFetch<StockEntry[]>(`${API}/stock?containerId=${id}`)
			]);
			contents.set(id, { loading: false, error: '', units: u.items, stock: s });
		} catch (e) {
			contents.set(id, {
				loading: false,
				error: errorText(e, 'Inhalt konnte nicht geladen werden'),
				units: [],
				stock: []
			});
		}
	}

	function toggleBox(id: string) {
		if (openBoxes.has(id)) openBoxes.delete(id);
		else {
			openBoxes.add(id);
			if (!contents.has(id)) void loadBox(id);
		}
	}

	// --- Auswahl ---
	const canSelect = $derived(canManage || canLabels);
	const selected = new SvelteSet<string>();
	const selectedIds = $derived([...selected]);
	const allSelected = $derived(units.length > 0 && units.every((u) => selected.has(u.id)));
	function toggleAll(on: boolean) {
		if (on) for (const u of units.slice(0, MAX_BATCH_UNITS)) selected.add(u.id);
		else selected.clear();
	}
	function toggleOne(id: string, on: boolean) {
		if (on) {
			if (selected.size < MAX_BATCH_UNITS) selected.add(id);
		} else selected.delete(id);
	}

	// --- Dialoge ---
	let moveOpen = $state(false);
	let moveKey = $state(0);
	let moveIds = $state<string[]>([]);
	let moveTitle = $state('');
	let printOpen = $state(false);
	let printTarget = $state<'unit' | 'location'>('unit');
	let printIds = $state<string[]>([]);

	function move(ids: string[], title: string) {
		moveIds = ids;
		moveTitle = title;
		moveKey++;
		moveOpen = true;
	}
	function print(target: 'unit' | 'location', ids: string[]) {
		printTarget = target;
		printIds = ids;
		printOpen = true;
	}
	async function moved() {
		selected.clear();
		await load(locationId);
		await onchanged();
	}

	let locOpen = $state(false);
	let locKey = $state(0);
	let locEditing = $state<Location | null>(null);
	let locParent = $state<string | null>(null);
	function createLocation(parentId: string | null) {
		locEditing = null;
		locParent = parentId;
		locKey++;
		locOpen = true;
	}
	function editLocation(l: Location) {
		locEditing = l;
		locParent = null;
		locKey++;
		locOpen = true;
	}

	let deleteOpen = $state(false);
	async function removeLocation() {
		const l = location;
		if (!l) return;
		try {
			await apiFetch(`${API}/locations/${l.id}`, { method: 'DELETE' });
			toast.success('Lagerort gelöscht');
			onselect(l.parentId);
			await onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Lagerort konnte nicht gelöscht werden'));
		}
	}

	const containers = $derived(units.filter((u) => u.isContainer).length);
	const summary = $derived.by(() => {
		if (!locationId) {
			const total = rows.filter((r) => r.depth === 0).reduce((s, r) => s + r.total, 0);
			return `${locations.length === 1 ? '1 Ort' : `${locations.length} Orte`} · ${
				total === 1 ? '1 Stück' : `${total.toLocaleString('de-DE')} Stücke`
			}`;
		}
		const parts = [unitsTotal - containers === 1 ? '1 Stück' : `${unitsTotal - containers} Stücke`];
		if (containers) parts.push(containers === 1 ? '1 Kiste' : `${containers} Kisten`);
		if (stock.length)
			parts.push(stock.length === 1 ? '1 Mengenartikel' : `${stock.length} Mengenartikel`);
		if (children.length)
			parts.push(children.length === 1 ? '1 Unterort' : `${children.length} Unterorte`);
		return parts.join(' · ');
	});

	const countText = (n: number) => (n === 1 ? '1 Stück' : `${n.toLocaleString('de-DE')} Stücke`);
</script>

<div class={cn('min-w-0 space-y-4', selectedIds.length > 0 && 'pb-20 sm:pb-0')}>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			{#if parentPath}
				<p class="truncate text-xs text-muted-foreground">{parentPath} ›</p>
			{/if}
			<h2 class="text-section truncate">
				{location?.name ?? (locationId === UNPLACED ? 'Ohne Ort' : 'Alle Orte')}
			</h2>
			<p class="text-sm text-muted-foreground">
				{#if location}<span class="font-mono">{location.code}</span> ·
				{/if}{summary}
			</p>
			{#if location?.description}
				<p class="mt-1 text-sm text-muted-foreground">{location.description}</p>
			{/if}
		</div>
		{#if location && (canManage || canLabels)}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon"
							aria-label={`Aktionen für ${location.name}`}
						>
							<EllipsisVertical />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end">
					{#if canManage}
						<DropdownMenu.Item onclick={() => createLocation(location.id)}>
							<Plus /> Unterort anlegen
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => editLocation(location)}>
							<Pencil /> Bearbeiten / verschieben
						</DropdownMenu.Item>
					{/if}
					{#if canLabels}
						<DropdownMenu.Item onclick={() => print('location', [location.id])}>
							<Printer /> Etikett drucken
						</DropdownMenu.Item>
					{/if}
					{#if canManage}
						<DropdownMenu.Separator />
						<DropdownMenu.Item class="text-destructive" onclick={() => (deleteOpen = true)}>
							<Trash2 /> Löschen
						</DropdownMenu.Item>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{:else if !locationId && (canManage || canLabels)}
			<div class="flex flex-wrap gap-2">
				{#if canLabels && locations.length}
					<Button
						variant="ghost"
						size="sm"
						onclick={() =>
							print(
								'location',
								rows.map((r) => r.loc.id)
							)}
					>
						<Printer /> Etiketten für alle Orte
					</Button>
				{/if}
				{#if canManage}
					<Button variant="outline" size="sm" onclick={() => createLocation(null)}>
						<Plus /> Lagerort
					</Button>
				{/if}
			</div>
		{/if}
	</div>

	{#if canSelect}
		<MobileActionBar
			show={selectedIds.length > 0}
			label="Sammelaktionen"
			class="sm:w-full sm:rounded-md sm:border sm:px-3 sm:py-2"
		>
			<span class="text-sm font-medium" aria-live="polite">{selectedIds.length} ausgewählt</span>
			{#if canManage}
				<Button
					size="sm"
					variant="outline"
					onclick={() =>
						move(
							selectedIds,
							selectedIds.length === 1 ? '1 Stück' : `${selectedIds.length} Stücke`
						)}
				>
					<ArrowRightLeft /> Umlagern
				</Button>
			{/if}
			{#if canLabels}
				<Button size="sm" variant="outline" onclick={() => print('unit', selectedIds)}>
					<Printer /> Etiketten
				</Button>
			{/if}
			<Button size="sm" variant="ghost" onclick={() => selected.clear()}>
				<X /> Auswahl aufheben
			</Button>
		</MobileActionBar>
	{/if}

	{#if loading && !units.length && !stock.length}
		<LoadingState label="Inhalt" rows={5} rowClass="h-12 w-full" />
	{:else if error}
		<ErrorState message={error} onretry={() => load(locationId)} busy={loading} />
	{:else if !children.length && !units.length && !stock.length}
		<div class="border-y py-10 text-center">
			<p class="font-medium">
				{locationId ? 'Hier liegt nichts.' : 'Noch keine Lagerorte'}
			</p>
			<p class="mt-1 text-sm text-muted-foreground">
				{#if location}
					{canManage
						? 'Erfasse Stücke hier oder lagere welche hierher um.'
						: 'An diesem Ort ist kein Material erfasst.'}
				{:else}
					Leg an, wo euer Material liegt – z. B. Materialraum, Regal A, Dachboden.
				{/if}
			</p>
			{#if !locationId && canManage}
				<Button class="mt-4" variant="outline" onclick={() => createLocation(null)}>
					<Plus /> Lagerort anlegen
				</Button>
			{/if}
		</div>
	{:else}
		<table class="w-full border-collapse text-sm">
			<caption class="sr-only">Inhalt von {location?.name ?? 'allen Orten'}</caption>
			<thead class="hidden sm:table-header-group">
				<tr class="border-b text-left text-xs text-muted-foreground">
					{#if canSelect}
						<th scope="col" class="w-10 py-2 pl-1 font-normal">
							{#if units.length}
								<Checkbox
									checked={allSelected}
									onCheckedChange={(v) => toggleAll(v === true)}
									aria-label="Alle Stücke hier auswählen"
								/>
							{/if}
						</th>
					{/if}
					<th scope="col" class="py-2 font-normal">Bezeichnung</th>
					<th scope="col" class="py-2 font-normal">Code</th>
					<th scope="col" class="py-2 font-normal">Status</th>
					<th scope="col" class="py-2 text-right font-normal">Menge</th>
					<th scope="col" class="w-12 py-2"><span class="sr-only">Aktionen</span></th>
				</tr>
			</thead>
			<tbody class="divide-y">
				{#each children as c (c.loc.id)}
					<tr class="cursor-pointer hover:bg-muted/50" onclick={() => onselect(c.loc.id)}>
						{#if canSelect}<td class="hidden sm:table-cell"></td>{/if}
						<td class="py-2" colspan={1}>
							<button
								type="button"
								class="focus-ring flex min-h-10 w-full min-w-0 items-center gap-1 rounded text-left"
								onclick={(e) => {
									e.stopPropagation();
									onselect(c.loc.id);
								}}
							>
								<span class="min-w-0">
									<span class="block truncate font-medium">{c.loc.name}</span>
									<span class="block truncate text-xs text-muted-foreground sm:hidden">
										Ort · {c.loc.code}
									</span>
								</span>
								<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							</button>
						</td>
						<td class="hidden py-2 font-mono text-xs text-muted-foreground sm:table-cell">
							{c.loc.code}
						</td>
						<td class="hidden py-2 text-muted-foreground sm:table-cell">Ort</td>
						<td class="py-2 text-right tabular-nums">
							{c.total.toLocaleString('de-DE')}<span class="sr-only"> {countText(c.total)}</span>
						</td>
						<td></td>
					</tr>
				{/each}
				{#each units as u (u.id)}
					{@render unitRow(u, 0)}
				{/each}
				{#each stock as s (s.id)}
					{@render stockRow(s, 0)}
				{/each}
			</tbody>
		</table>
		{#if unitsTotal > units.length}
			<p class="text-xs text-muted-foreground">
				{units.length} von {unitsTotal} Stücken angezeigt. Nutze die Suche „Wo ist …?“ für den Rest.
			</p>
		{/if}
	{/if}
</div>

{#snippet statusMark(u: UnitSummary)}
	{#if u.issued}
		<Badge variant="warning" title={u.issued.title}>Unterwegs</Badge>
	{:else if u.retired}
		<Badge variant="outline">Ausgemustert</Badge>
	{:else}
		<ConditionBadge condition={u.condition} hideOk />
	{/if}
{/snippet}

{#snippet unitRow(u: UnitSummary, depth: number)}
	{@const isOpen = openBoxes.has(u.id)}
	<tr
		class={cn('cursor-pointer hover:bg-muted/50', selected.has(u.id) && 'bg-muted/40')}
		onclick={() => onopenunit(u.id)}
	>
		{#if canSelect}
			<td class="w-10 py-2 pl-1 align-middle" onclick={(e) => e.stopPropagation()}>
				{#if depth === 0}
					<Checkbox
						checked={selected.has(u.id)}
						onCheckedChange={(v) => toggleOne(u.id, v === true)}
						aria-label={`${u.name} auswählen`}
					/>
				{/if}
			</td>
		{/if}
		<td class="py-2">
			<div
				class="flex min-h-10 min-w-0 items-center gap-1"
				style:padding-left={`${depth * 1.25}rem`}
			>
				{#if u.isContainer}
					<button
						type="button"
						class="focus-ring flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
						aria-expanded={isOpen}
						aria-label={isOpen ? `Inhalt von ${u.name} zuklappen` : `Inhalt von ${u.name} zeigen`}
						onclick={(e) => {
							e.stopPropagation();
							toggleBox(u.id);
						}}
					>
						<ChevronRight class={cn('size-4 transition-transform', isOpen && 'rotate-90')} />
					</button>
				{/if}
				<button
					type="button"
					class="focus-ring min-w-0 rounded text-left"
					onclick={(e) => {
						e.stopPropagation();
						onopenunit(u.id);
					}}
				>
					<span class="block truncate font-medium">
						{u.name}{#if u.isContainer}<span class="font-normal text-muted-foreground">
								· Kiste</span
							>{/if}
					</span>
					<span class="block truncate text-xs text-muted-foreground">
						<span class="font-mono sm:hidden">{u.code} · </span>{u.articleName}{u.setName
							? ` · Set ${u.setName}`
							: ''}{#if u.issued}<span class="text-warning sm:hidden">
								· unterwegs: {u.issued.title}</span
							>{/if}
					</span>
				</button>
			</div>
		</td>
		<td class="hidden py-2 font-mono text-xs sm:table-cell">{u.code}</td>
		<td class="py-2">
			<span class="hidden sm:inline">{@render statusMark(u)}</span>
			<span class="sm:hidden"
				>{#if !u.issued}{@render statusMark(u)}{/if}</span
			>
		</td>
		<td class="hidden py-2 text-right text-muted-foreground tabular-nums sm:table-cell">1</td>
		<td class="w-12 py-2 text-right" onclick={(e) => e.stopPropagation()}>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon" aria-label={`Aktionen für ${u.name}`}>
							<EllipsisVertical />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end">
					<DropdownMenu.Item onclick={() => onopenunit(u.id)}>Details öffnen</DropdownMenu.Item>
					{#if canManage}
						<DropdownMenu.Item onclick={() => move([u.id], `${u.name} (${u.code})`)}>
							<ArrowRightLeft /> Umlagern
						</DropdownMenu.Item>
					{/if}
					{#if canLabels}
						<DropdownMenu.Item onclick={() => print('unit', [u.id])}>
							<Printer /> Etikett drucken
						</DropdownMenu.Item>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</td>
	</tr>
	{#if u.isContainer && isOpen}
		{@const box = contents.get(u.id)}
		{#if !box || box.loading}
			<tr>
				<td
					colspan={canSelect ? 6 : 5}
					class="py-2"
					style:padding-left={`${(depth + 1) * 1.25 + 2.5}rem`}
				>
					<span class="text-xs text-muted-foreground" role="status">Lädt …</span>
				</td>
			</tr>
		{:else if box.error}
			<tr>
				<td
					colspan={canSelect ? 6 : 5}
					class="py-2"
					style:padding-left={`${(depth + 1) * 1.25 + 2.5}rem`}
				>
					<span class="text-xs text-destructive" role="alert">{box.error}</span>
					<Button size="sm" variant="link" onclick={() => loadBox(u.id)}>Erneut versuchen</Button>
				</td>
			</tr>
		{:else if !box.units.length && !box.stock.length}
			<tr>
				<td
					colspan={canSelect ? 6 : 5}
					class="py-2"
					style:padding-left={`${(depth + 1) * 1.25 + 2.5}rem`}
				>
					<span class="text-xs text-muted-foreground">Die Kiste ist leer.</span>
				</td>
			</tr>
		{:else}
			{#each box.units as c (c.id)}
				{@render unitRow(c, depth + 1)}
			{/each}
			{#each box.stock as s (s.id)}
				{@render stockRow(s, depth + 1)}
			{/each}
		{/if}
	{/if}
{/snippet}

{#snippet stockRow(s: StockEntry, depth: number)}
	<tr class="cursor-pointer hover:bg-muted/50" onclick={() => onopenarticle(s.articleId)}>
		{#if canSelect}<td class="w-10"></td>{/if}
		<td class="py-2">
			<div
				class="flex min-h-10 items-center"
				style:padding-left={`${depth * 1.25 + (depth ? 2 : 0)}rem`}
			>
				<button
					type="button"
					class="focus-ring min-w-0 rounded text-left"
					onclick={(e) => {
						e.stopPropagation();
						onopenarticle(s.articleId);
					}}
				>
					<span class="block truncate font-medium">{s.articleName}</span>
					<span class="block truncate text-xs text-muted-foreground">Menge</span>
				</button>
			</div>
		</td>
		<td class="hidden py-2 sm:table-cell"></td>
		<td class="hidden py-2 sm:table-cell"></td>
		<td class="py-2 text-right whitespace-nowrap tabular-nums">
			{s.quantity.toLocaleString('de-DE')}
			<span class="text-muted-foreground">{s.unitLabel}</span>
		</td>
		<td class="w-12 py-2 text-right" onclick={(e) => e.stopPropagation()}>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon"
							aria-label={`Aktionen für ${s.articleName}`}
						>
							<EllipsisVertical />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end">
					<DropdownMenu.Item onclick={() => onopenarticle(s.articleId)}>
						{canManage ? 'Bestand zählen / umlagern' : 'Artikel öffnen'}
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</td>
	</tr>
{/snippet}

{#key moveKey}
	<MoveDialog
		bind:open={moveOpen}
		unitIds={moveIds}
		title={moveTitle}
		{locations}
		onsaved={moved}
	/>
{/key}
<PrintLabelsDialog bind:open={printOpen} target={printTarget} ids={printIds} />

{#if canManage}
	{#key locKey}
		<LocationDialog
			bind:open={locOpen}
			location={locEditing}
			parentId={locParent}
			{locations}
			onsaved={async (l) => {
				await onchanged();
				if (!locEditing) onselect(l.id);
			}}
		/>
	{/key}
	<ConfirmDialog
		bind:open={deleteOpen}
		title="Lagerort löschen?"
		description={location
			? `„${location.path}“ wird gelöscht. Das geht nur, wenn dort nichts mehr liegt und es keine Unterorte gibt.`
			: ''}
		confirmLabel="Löschen"
		destructive
		onconfirm={removeLocation}
	/>
{/if}
