<script lang="ts">
	// Orte-Baum (WAI-ARIA Tree): „Alle Orte“ + Lagerorte mit Stückzahl inkl. Unterorte.
	// Tastatur: ↑/↓ wechseln, → aufklappen bzw. erstes Kind, ← zuklappen bzw. Elternteil,
	// Pos1/Ende, Enter/Leertaste wählen. Ein Tab-Stopp (roving tabindex).
	import { UNPLACED } from '../helpers';
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { cn } from '$lib/utils';
	import type { Location } from '../../schemas';
	import { locationRows } from '../inventory/inventory';

	let {
		locations,
		selected,
		onselect,
		unplaced = 0,
		label = 'Lagerorte'
	}: {
		locations: Location[];
		/** Gewählter Ort, `null` = alle Orte */
		selected: string | null;
		onselect: (id: string | null) => void;
		/** Anzahl Stücke ohne Ort (> 0 → Eintrag „Ohne Ort“) */
		unplaced?: number;
		label?: string;
	} = $props();

	const ALL = '__all';

	const rows = $derived(locationRows(locations));
	const parentOf = $derived(
		new Map(
			rows.map((r) => [
				r.loc.id,
				r.loc.parentId && rows.some((x) => x.loc.id === r.loc.parentId) ? r.loc.parentId : null
			])
		)
	);
	const grandTotal = $derived(rows.filter((r) => r.depth === 0).reduce((s, r) => s + r.total, 0));

	const expanded = new SvelteSet<string>();
	let initialized = false;
	$effect(() => {
		// Wurzeln zu Beginn aufklappen, Vorfahren des gewählten Orts immer
		const sel = selected;
		const list = rows;
		untrack(() => {
			if (!initialized && list.length) {
				initialized = true;
				for (const r of list) if (r.depth === 0 && r.hasChildren) expanded.add(r.loc.id);
			}
			let p = sel ? (parentOf.get(sel) ?? null) : null;
			let guard = 0;
			while (p && guard++ < 50) {
				expanded.add(p);
				p = parentOf.get(p) ?? null;
			}
		});
	});

	function isVisible(id: string): boolean {
		let p = parentOf.get(id) ?? null;
		let guard = 0;
		while (p && guard++ < 50) {
			if (!expanded.has(p)) return false;
			p = parentOf.get(p) ?? null;
		}
		return true;
	}

	type Item = {
		key: string;
		id: string | null;
		name: string;
		total: number;
		level: number;
		hasChildren: boolean;
	};
	const items = $derived<Item[]>([
		{ key: ALL, id: null, name: 'Alle Orte', total: grandTotal, level: 1, hasChildren: false },
		...(unplaced > 0
			? [
					{
						key: UNPLACED,
						id: UNPLACED,
						name: 'Ohne Ort',
						total: unplaced,
						level: 1,
						hasChildren: false
					}
				]
			: []),
		...rows
			.filter((r) => isVisible(r.loc.id))
			.map((r) => ({
				key: r.loc.id,
				id: r.loc.id,
				name: r.loc.name,
				total: r.total,
				level: r.depth + 1,
				hasChildren: r.hasChildren
			}))
	]);

	const selectedKey = $derived(selected ?? ALL);
	let focusKey = $state<string | null>(null);
	const activeKey = $derived(
		focusKey && items.some((i) => i.key === focusKey) ? focusKey : selectedKey
	);

	let list = $state<HTMLUListElement | null>(null);
	function focusItem(key: string) {
		focusKey = key;
		list?.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus();
	}

	function toggle(id: string) {
		if (expanded.has(id)) expanded.delete(id);
		else expanded.add(id);
	}

	function onkeydown(e: KeyboardEvent, item: Item, index: number) {
		let handled = true;
		switch (e.key) {
			case 'ArrowDown':
				if (items[index + 1]) focusItem(items[index + 1]!.key);
				break;
			case 'ArrowUp':
				if (items[index - 1]) focusItem(items[index - 1]!.key);
				break;
			case 'Home':
				focusItem(items[0]!.key);
				break;
			case 'End':
				focusItem(items[items.length - 1]!.key);
				break;
			case 'ArrowRight':
				if (item.id && item.hasChildren) {
					if (!expanded.has(item.id)) expanded.add(item.id);
					else if (items[index + 1]) focusItem(items[index + 1]!.key);
				}
				break;
			case 'ArrowLeft':
				if (item.id && item.hasChildren && expanded.has(item.id)) expanded.delete(item.id);
				else if (item.id) focusItem(parentOf.get(item.id) ?? ALL);
				break;
			case 'Enter':
			case ' ':
				onselect(item.id);
				break;
			default:
				handled = false;
		}
		if (handled) e.preventDefault();
	}

	const countText = (n: number) => (n === 1 ? '1 Stück' : `${n.toLocaleString('de-DE')} Stücke`);
</script>

<ul bind:this={list} role="tree" aria-label={label} class="space-y-px">
	{#each items as item, i (item.key)}
		{@const isSel = item.key === selectedKey}
		{@const isOpen = item.id ? expanded.has(item.id) : undefined}
		<li
			role="treeitem"
			data-key={item.key}
			aria-level={item.level}
			aria-selected={isSel}
			aria-expanded={item.hasChildren ? isOpen : undefined}
			aria-label={`${item.name}, ${countText(item.total)}`}
			tabindex={item.key === activeKey ? 0 : -1}
			class={cn(
				'focus-ring flex min-h-9 cursor-pointer items-center gap-1 rounded-md pr-2 text-sm outline-none',
				isSel ? 'bg-muted font-medium text-foreground' : 'text-foreground hover:bg-muted/50'
			)}
			style:padding-left={`${0.25 + (item.level - 1) * 1}rem`}
			onclick={() => {
				focusKey = item.key;
				onselect(item.id);
			}}
			onkeydown={(e) => onkeydown(e, item, i)}
		>
			{#if item.hasChildren && item.id}
				{@const id = item.id}
				<button
					type="button"
					tabindex={-1}
					class="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
					aria-hidden="true"
					onclick={(e) => {
						e.stopPropagation();
						toggle(id);
					}}
				>
					<ChevronRight class={cn('size-4 transition-transform', isOpen && 'rotate-90')} />
				</button>
			{:else}
				<span class="size-7 shrink-0" aria-hidden="true"></span>
			{/if}
			<span class="min-w-0 flex-1 truncate">{item.name}</span>
			<span class="shrink-0 text-xs text-muted-foreground tabular-nums" aria-hidden="true">
				{item.total.toLocaleString('de-DE')}
			</span>
		</li>
	{/each}
</ul>
