<script lang="ts">
	// Dateiliste des Moduls `files`: Raster- oder Listenansicht mit Auswahl, Menü je Eintrag,
	// Tastaturbedienung und Drag & Drop zum Verschieben auf Ordner.
	import { onMount, type Snippet } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import Download from '@lucide/svelte/icons/download';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Info from '@lucide/svelte/icons/info';
	import Link from '@lucide/svelte/icons/link';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Users from '@lucide/svelte/icons/users';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Table from '$lib/components/ui/table';
	import { DataTable, EmptyState } from '$lib/components/layout';
	import type { FileNode } from '../schemas';
	import {
		DRAG_MIME,
		formatBytes,
		formatDateTime,
		iconFor,
		thumbUrl,
		type NodeAction
	} from './helpers';

	let {
		items,
		view = 'grid',
		selected = $bindable([]),
		loading = false,
		canEdit = false,
		canLink = true,
		emptyTitle = 'Dieser Ordner ist leer',
		emptyDescription = 'Ziehe Dateien hierher oder nutze „Hochladen“.',
		emptyAction,
		onopen,
		onaction,
		onmove
	}: {
		items: FileNode[];
		view?: 'grid' | 'list';
		/** IDs der markierten Einträge */
		selected?: string[];
		loading?: boolean;
		/** Bearbeiten im aktuellen Ordner erlaubt (Drag-&-Drop-Verschieben) */
		canEdit?: boolean;
		/** Menüpunkt „Öffentlicher Link“ anbieten (zusätzlich nur bei `access === 'edit'`) */
		canLink?: boolean;
		emptyTitle?: string;
		emptyDescription?: string;
		emptyAction?: Snippet;
		/** Doppelklick/Enter: Ordner öffnen bzw. Datei in der Vorschau */
		onopen: (node: FileNode) => void;
		/** Menü-/Tastatur-Aktion auf einem oder mehreren Einträgen */
		onaction: (action: NodeAction, nodes: FileNode[]) => void;
		/** Einträge per Drag & Drop auf einen Ordner gezogen (`targetId` = Ordner-ID) */
		onmove: (ids: string[], targetId: string) => void;
	} = $props();

	// ---------- Umgebung (Touch / schmale Ansicht) ----------

	let isCoarse = $state(false);
	let isNarrow = $state(false);

	onMount(() => {
		const coarse = window.matchMedia('(pointer: coarse)');
		const narrow = window.matchMedia('(max-width: 639px)');
		const update = () => {
			isCoarse = coarse.matches;
			isNarrow = narrow.matches;
		};
		update();
		coarse.addEventListener('change', update);
		narrow.addEventListener('change', update);
		return () => {
			coarse.removeEventListener('change', update);
			narrow.removeEventListener('change', update);
		};
	});

	// ---------- Auswahl ----------

	const selectedSet = $derived(new Set(selected));
	const selectedNodes = $derived(items.filter((n) => selectedSet.has(n.id)));
	const allSelected = $derived(items.length > 0 && selectedNodes.length === items.length);
	const someSelected = $derived(selectedNodes.length > 0 && !allSelected);

	/** Ausgangspunkt für Shift-Bereiche */
	let anchorId = $state<string | null>(null);
	/** Eintrag mit Tastaturfokus (Roving-Tabindex) */
	let focusId = $state<string | null>(null);
	const activeId = $derived(
		focusId && items.some((n) => n.id === focusId) ? focusId : (items[0]?.id ?? null)
	);

	function setSelected(id: string, on: boolean) {
		if (on) {
			if (!selectedSet.has(id)) selected = [...selected, id];
		} else if (selectedSet.has(id)) {
			selected = selected.filter((s) => s !== id);
		}
		anchorId = id;
	}

	function toggleAll(on: boolean) {
		selected = on ? items.map((n) => n.id) : [];
	}

	function rangeIds(fromId: string, toId: string): string[] {
		const a = items.findIndex((n) => n.id === fromId);
		const b = items.findIndex((n) => n.id === toId);
		if (a < 0 || b < 0) return [toId];
		const [lo, hi] = a <= b ? [a, b] : [b, a];
		return items.slice(lo, hi + 1).map((n) => n.id);
	}

	/** Auswahl per Klick/Tastatur: einfach, additiv (Strg/⌘) oder Bereich (Shift) */
	function selectWith(node: FileNode, mods: { additive: boolean; range: boolean }) {
		if (mods.range && anchorId) {
			const range = rangeIds(anchorId, node.id);
			selected = mods.additive ? [...new Set([...selected, ...range])] : range;
			return; // Anker bleibt
		}
		if (mods.additive) {
			setSelected(node.id, !selectedSet.has(node.id));
			return;
		}
		selected = [node.id];
		anchorId = node.id;
	}

	function onItemClick(e: MouseEvent, node: FileNode) {
		focusId = node.id;
		if (isCoarse) {
			onopen(node);
			return;
		}
		selectWith(node, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey });
	}

	function onItemDblClick(node: FileNode) {
		if (isCoarse) return; // Tap öffnet bereits
		onopen(node);
	}

	/** Klick auf freie Fläche hebt die Auswahl auf */
	function onBackgroundClick(e: MouseEvent) {
		if (e.target === e.currentTarget && !e.ctrlKey && !e.metaKey && !e.shiftKey) selected = [];
	}

	// ---------- Menü ----------

	let menuOpenId = $state<string | null>(null);

	function run(action: NodeAction, nodes: FileNode[]) {
		menuOpenId = null;
		if (nodes.length) onaction(action, nodes);
	}

	function onContextMenu(e: MouseEvent, node: FileNode) {
		e.preventDefault();
		if (!selectedSet.has(node.id)) {
			selected = [node.id];
			anchorId = node.id;
		}
		focusId = node.id;
		menuOpenId = node.id;
	}

	// ---------- Tastatur ----------

	let container = $state<HTMLElement | null>(null);

	function itemElements(): HTMLElement[] {
		return container ? [...container.querySelectorAll<HTMLElement>('[data-node-item]')] : [];
	}

	/** Spaltenzahl im Raster (Einträge in der ersten Zeile) */
	function gridColumns(els: HTMLElement[]): number {
		if (view !== 'grid' || els.length === 0) return 1;
		const top = els[0]!.offsetTop;
		let cols = 0;
		for (const el of els) {
			if (el.offsetTop !== top) break;
			cols++;
		}
		return Math.max(1, cols);
	}

	function focusIndex(index: number) {
		const els = itemElements();
		const el = els[index];
		const node = items[index];
		if (!el || !node) return;
		focusId = node.id;
		el.focus();
		el.scrollIntoView({ block: 'nearest' });
	}

	function onItemKeydown(e: KeyboardEvent, node: FileNode) {
		const self = e.target === e.currentTarget;
		const index = items.findIndex((n) => n.id === node.id);

		if (e.key === 'F2') {
			if (node.access === 'edit') {
				e.preventDefault();
				run('rename', [node]);
			}
			return;
		}
		if (e.key === 'Delete') {
			const base = selectedSet.has(node.id) ? selectedNodes : [node];
			const editable = base.filter((n) => n.access === 'edit');
			if (editable.length) {
				e.preventDefault();
				run('trash', editable);
			}
			return;
		}
		if (!self) return; // Checkbox/Menü-Knopf behalten ihr eigenes Verhalten

		if (e.key === 'Enter') {
			e.preventDefault();
			onopen(node);
		} else if (e.key === ' ') {
			e.preventDefault();
			if (e.shiftKey && anchorId)
				selectWith(node, { additive: e.ctrlKey || e.metaKey, range: true });
			else setSelected(node.id, !selectedSet.has(node.id));
		} else if (e.key === 'Escape') {
			if (selected.length) {
				e.preventDefault();
				selected = [];
			}
		} else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			toggleAll(true);
		} else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
			e.preventDefault();
			menuOpenId = node.id;
		} else if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
			const els = itemElements();
			const cols = gridColumns(els);
			let next: number;
			if (e.key === 'Home') next = 0;
			else if (e.key === 'End') next = items.length - 1;
			else if (view === 'grid' && e.key === 'ArrowRight') next = index + 1;
			else if (view === 'grid' && e.key === 'ArrowLeft') next = index - 1;
			else if (e.key === 'ArrowDown') next = index + cols;
			else if (e.key === 'ArrowUp') next = index - cols;
			else return;
			next = Math.min(items.length - 1, Math.max(0, next));
			e.preventDefault();
			if (next === index) return;
			const target = items[next]!;
			if (e.shiftKey) selectWith(target, { additive: false, range: true });
			else if (!(e.ctrlKey || e.metaKey)) {
				selected = [target.id];
				anchorId = target.id;
			}
			focusIndex(next);
		}
	}

	// ---------- Drag & Drop (Verschieben) ----------

	/** Gerade gezogene IDs (nur aus dieser Liste; `getData` ist in `dragover` nicht lesbar) */
	let dragIds = $state<string[] | null>(null);
	let dropTargetId = $state<string | null>(null);

	function canDrag(node: FileNode): boolean {
		return canEdit && node.access === 'edit' && !isCoarse;
	}

	function onDragStart(e: DragEvent, node: FileNode) {
		if (!e.dataTransfer || !canDrag(node)) return;
		const ids = selectedSet.has(node.id)
			? selectedNodes.filter((n) => n.access === 'edit').map((n) => n.id)
			: [node.id];
		dragIds = ids;
		e.dataTransfer.setData(DRAG_MIME, JSON.stringify(ids));
		e.dataTransfer.effectAllowed = 'move';
		if (ids.length > 1) {
			const ghost = document.createElement('div');
			ghost.className =
				'fixed -top-96 left-0 rounded-md bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground shadow';
			ghost.textContent = `${ids.length} Einträge`;
			document.body.appendChild(ghost);
			e.dataTransfer.setDragImage(ghost, 12, 12);
			setTimeout(() => ghost.remove(), 0);
		}
	}

	function onDragEnd() {
		dragIds = null;
		dropTargetId = null;
	}

	function isDropTarget(node: FileNode): boolean {
		return (
			node.kind === 'folder' && node.access === 'edit' && !(dragIds?.includes(node.id) ?? false)
		);
	}

	function onDragOver(e: DragEvent, node: FileNode) {
		const types = e.dataTransfer?.types ?? [];
		if (!types.includes(DRAG_MIME) || !isDropTarget(node)) return; // externe Dateien: UploadDropzone
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropTargetId = node.id;
	}

	function onDragLeave(e: DragEvent, node: FileNode) {
		const el = e.currentTarget as HTMLElement;
		if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
		if (dropTargetId === node.id) dropTargetId = null;
	}

	function onDrop(e: DragEvent, node: FileNode) {
		const raw = e.dataTransfer?.getData(DRAG_MIME);
		if (!raw || !isDropTarget(node)) return;
		e.preventDefault();
		e.stopPropagation();
		dropTargetId = null;
		dragIds = null;
		let ids: string[] = [];
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) ids = parsed.filter((v): v is string => typeof v === 'string');
		} catch {
			return;
		}
		ids = ids.filter((id) => id !== node.id);
		if (ids.length) onmove(ids, node.id);
	}

	// ---------- Darstellung ----------

	/** Vorschaubilder, die nicht geladen werden konnten */
	const failedThumbs = new SvelteSet<string>();

	function watchThumb(img: HTMLImageElement) {
		const fail = () => {
			const src = img.getAttribute('src');
			if (src) failedThumbs.add(src);
		};
		img.addEventListener('error', fail);
		if (img.complete && img.naturalWidth === 0) fail();
		return { destroy: () => img.removeEventListener('error', fail) };
	}

	function thumbOf(node: FileNode): string | null {
		const url = node.kind === 'file' ? thumbUrl(node) : null;
		return url && !failedThumbs.has(url) ? url : null;
	}

	function entriesText(count: number | null): string {
		const n = count ?? 0;
		if (n === 0) return 'Leer';
		return n === 1 ? '1 Eintrag' : `${n} Einträge`;
	}

	function sizeText(node: FileNode): string {
		return node.kind === 'folder' ? entriesText(node.childCount) : formatBytes(node.sizeBytes);
	}

	function kindText(node: FileNode): string {
		return node.kind === 'folder' ? 'Ordner' : 'Datei';
	}
</script>

{#snippet badges(node: FileNode)}
	{#if node.shared}
		<span class="inline-flex text-muted-foreground" title="Freigegeben">
			<Users class="size-3.5" aria-hidden="true" />
			<span class="sr-only">Freigegeben</span>
		</span>
	{/if}
	{#if node.linked}
		<span class="inline-flex text-muted-foreground" title="Öffentlicher Link aktiv">
			<Link class="size-3.5" aria-hidden="true" />
			<span class="sr-only">Öffentlicher Link aktiv</span>
		</span>
	{/if}
{/snippet}

{#snippet menu(node: FileNode, triggerClass: string, tabbable: boolean)}
	{@const edit = node.access === 'edit'}
	<DropdownMenu.Root
		bind:open={() => menuOpenId === node.id, (v) => (menuOpenId = v ? node.id : null)}
	>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="ghost"
					size="icon-sm"
					class={triggerClass}
					tabindex={tabbable ? 0 : -1}
					aria-label={`Aktionen für ${node.name}`}
				>
					<Ellipsis />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-52">
			<DropdownMenu.Item onclick={() => run('open', [node])}>
				<FolderOpen /> Öffnen
			</DropdownMenu.Item>
			{#if node.kind === 'file'}
				<DropdownMenu.Item onclick={() => run('download', [node])}>
					<Download /> Herunterladen
				</DropdownMenu.Item>
			{/if}
			{#if edit}
				<DropdownMenu.Item onclick={() => run('rename', [node])}>
					<Pencil /> Umbenennen
				</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => run('move', [node])}>
					<FolderInput /> Verschieben
				</DropdownMenu.Item>
			{/if}
			<!-- Freigaben/Links nur bereichsberechtigt (Bearbeiten über eine Freigabe reicht nicht) -->
			{#if node.canShare}
				<DropdownMenu.Item onclick={() => run('share', [node])}>
					<Share2 /> Freigeben
				</DropdownMenu.Item>
				{#if canLink}
					<DropdownMenu.Item onclick={() => run('link', [node])}>
						<Link /> Öffentlicher Link
					</DropdownMenu.Item>
				{/if}
			{/if}
			<DropdownMenu.Item onclick={() => run('info', [node])}>
				<Info /> Details
			</DropdownMenu.Item>
			{#if edit}
				<DropdownMenu.Separator />
				<DropdownMenu.Item variant="destructive" onclick={() => run('trash', [node])}>
					<Trash2 /> In den Papierkorb
				</DropdownMenu.Item>
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/snippet}

{#snippet selectBox(node: FileNode, extra: string)}
	<!-- Klicks auf die Checkbox nicht als Kachel-/Zeilenklick werten -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class={extra} onclick={(e) => e.stopPropagation()} ondblclick={(e) => e.stopPropagation()}>
		<Checkbox
			bind:checked={() => selectedSet.has(node.id), (v) => setSelected(node.id, v)}
			tabindex={-1}
			aria-label={`${node.name} auswählen`}
		/>
	</div>
{/snippet}

{#if view === 'grid'}
	{#if loading && items.length === 0}
		<div
			class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
			aria-busy="true"
			aria-label="Lade Dateien"
		>
			{#each Array.from({ length: 12 }, (_, i) => i) as i (i)}
				<div class="space-y-2 rounded-lg border p-2">
					<Skeleton class="aspect-[4/3] w-full" />
					<Skeleton class="h-4 w-3/4" />
					<Skeleton class="h-3 w-1/2" />
				</div>
			{/each}
		</div>
	{:else if items.length === 0}
		<EmptyState title={emptyTitle} description={emptyDescription}>
			{#if emptyAction}{@render emptyAction()}{/if}
		</EmptyState>
	{:else}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			bind:this={container}
			role="listbox"
			tabindex="-1"
			aria-multiselectable="true"
			aria-label="Dateien und Ordner"
			aria-busy={loading}
			class="grid grid-cols-2 gap-3 transition-opacity select-none sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
			class:opacity-60={loading}
			onclick={onBackgroundClick}
		>
			{#each items as node (node.id)}
				{@const Icon = iconFor(node.kind, node.contentType)}
				{@const thumb = thumbOf(node)}
				{@const isSel = selectedSet.has(node.id)}
				{@const isActive = node.id === activeId}
				<div
					data-node-item
					role="option"
					aria-selected={isSel}
					aria-label={`${node.name}, ${kindText(node)}`}
					tabindex={isActive ? 0 : -1}
					draggable={canDrag(node) ? 'true' : undefined}
					class={[
						'group relative flex min-w-0 cursor-default flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
						isSel && 'border-primary bg-primary/5 hover:bg-primary/10',
						dropTargetId === node.id && 'ring-2 ring-primary',
						dragIds?.includes(node.id) && 'opacity-50'
					]}
					onclick={(e) => onItemClick(e, node)}
					ondblclick={() => onItemDblClick(node)}
					oncontextmenu={(e) => onContextMenu(e, node)}
					onkeydown={(e) => onItemKeydown(e, node)}
					onfocus={() => (focusId = node.id)}
					ondragstart={(e) => onDragStart(e, node)}
					ondragend={onDragEnd}
					ondragover={(e) => onDragOver(e, node)}
					ondragleave={(e) => onDragLeave(e, node)}
					ondrop={(e) => onDrop(e, node)}
				>
					<div
						class="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/50"
					>
						{#if thumb}
							<img
								src={thumb}
								alt=""
								loading="lazy"
								draggable="false"
								class="size-full object-cover"
								use:watchThumb
							/>
						{:else if node.kind === 'folder'}
							<Icon class="size-14 text-primary/80" aria-hidden="true" />
						{:else}
							<Icon class="size-10 text-muted-foreground" aria-hidden="true" />
						{/if}
						{@render selectBox(
							node,
							[
								'absolute top-1.5 left-1.5 flex rounded-md bg-background/90 p-1 shadow-sm transition-opacity',
								isSel || selected.length > 0 || isCoarse
									? 'opacity-100'
									: 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
							].join(' ')
						)}
						<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
						<div
							class="absolute top-1.5 right-1.5"
							onclick={(e) => e.stopPropagation()}
							ondblclick={(e) => e.stopPropagation()}
						>
							{@render menu(node, 'bg-background/90 shadow-sm hover:bg-background', isActive)}
						</div>
					</div>
					<div class="flex min-w-0 flex-1 flex-col gap-0.5 p-2">
						<span
							class="line-clamp-2 text-sm leading-snug font-medium break-words"
							title={node.name}
						>
							{node.name}
						</span>
						<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
							<span class="truncate tabular-nums">
								{sizeText(node)} · {formatDateTime(node.updatedAt)}
							</span>
							<span class="ml-auto flex shrink-0 items-center gap-1">{@render badges(node)}</span>
						</span>
						{#if isSel}<span class="sr-only">ausgewählt</span>{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
{:else}
	{#snippet mobileToolbar()}
		<label class="flex items-center gap-2 text-sm">
			<Checkbox
				checked={allSelected}
				indeterminate={someSelected}
				onCheckedChange={(v) => toggleAll(v)}
			/>
			Alle auswählen
		</label>
		{#if selected.length}
			<span class="text-xs text-muted-foreground">{selected.length} ausgewählt</span>
		{/if}
	{/snippet}
	<div bind:this={container} class="select-none">
		<DataTable
			caption="Dateien und Ordner"
			mobile="cards"
			{loading}
			empty={items.length === 0}
			{emptyTitle}
			{emptyDescription}
			{emptyAction}
			skeletonRows={6}
			toolbar={isNarrow && items.length > 0 ? mobileToolbar : undefined}
		>
			{#snippet head()}
				<Table.Row>
					<Table.Head class="w-10">
						<Checkbox
							checked={allSelected}
							indeterminate={someSelected}
							onCheckedChange={(v) => toggleAll(v)}
							aria-label="Alle auswählen"
						/>
					</Table.Head>
					<Table.Head>Name</Table.Head>
					<Table.Head>Geändert</Table.Head>
					<Table.Head class="text-right">Größe</Table.Head>
					<Table.Head class="w-10"><span class="sr-only">Aktionen</span></Table.Head>
				</Table.Row>
			{/snippet}
			{#each items as node (node.id)}
				{@const Icon = iconFor(node.kind, node.contentType)}
				{@const thumb = thumbOf(node)}
				{@const isSel = selectedSet.has(node.id)}
				{@const isActive = node.id === activeId}
				<Table.Row
					data-node-item
					data-state={isSel ? 'selected' : undefined}
					tabindex={isActive ? 0 : -1}
					aria-label={`${node.name}, ${kindText(node)}${isSel ? ', ausgewählt' : ''}`}
					draggable={canDrag(node) ? 'true' : undefined}
					class={[
						'cursor-default outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
						dropTargetId === node.id && 'ring-2 ring-primary ring-inset',
						dragIds?.includes(node.id) && 'opacity-50'
					]}
					onclick={(e: MouseEvent) => onItemClick(e, node)}
					ondblclick={() => onItemDblClick(node)}
					oncontextmenu={(e: MouseEvent) => onContextMenu(e, node)}
					onkeydown={(e: KeyboardEvent) => onItemKeydown(e, node)}
					onfocus={() => (focusId = node.id)}
					ondragstart={(e: DragEvent) => onDragStart(e, node)}
					ondragend={onDragEnd}
					ondragover={(e: DragEvent) => onDragOver(e, node)}
					ondragleave={(e: DragEvent) => onDragLeave(e, node)}
					ondrop={(e: DragEvent) => onDrop(e, node)}
				>
					<Table.Cell class="w-10">
						{@render selectBox(node, 'flex')}
					</Table.Cell>
					<Table.Cell class="max-w-0 min-w-40 sm:w-full">
						<span class="flex min-w-0 items-center gap-2">
							<span
								class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/50"
							>
								{#if thumb}
									<img
										src={thumb}
										alt=""
										loading="lazy"
										draggable="false"
										class="size-full object-cover"
										use:watchThumb
									/>
								{:else}
									<Icon
										class={node.kind === 'folder'
											? 'size-5 text-primary/80'
											: 'size-5 text-muted-foreground'}
										aria-hidden="true"
									/>
								{/if}
							</span>
							<span class="truncate font-medium" title={node.name}>{node.name}</span>
							<span class="flex shrink-0 items-center gap-1">{@render badges(node)}</span>
						</span>
					</Table.Cell>
					<Table.Cell class="whitespace-nowrap text-muted-foreground tabular-nums">
						{formatDateTime(node.updatedAt)}
					</Table.Cell>
					<Table.Cell class="text-right whitespace-nowrap tabular-nums">
						{sizeText(node)}
					</Table.Cell>
					<Table.Cell
						class="w-10 text-right"
						onclick={(e: MouseEvent) => e.stopPropagation()}
						ondblclick={(e: MouseEvent) => e.stopPropagation()}
					>
						{@render menu(node, '', isActive)}
					</Table.Cell>
				</Table.Row>
			{/each}
		</DataTable>
	</div>
{/if}
