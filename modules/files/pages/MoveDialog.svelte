<script lang="ts">
	// VERTRAG (Welle 0) – Props nicht ändern; Implementierung: Welle 3.5.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Folder from '@lucide/svelte/icons/folder';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import Users from '@lucide/svelte/icons/users';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		SPACE_LABELS,
		type BulkResult,
		type FileNode,
		type FilesMeta,
		type FolderListing,
		type Space
	} from '../schemas';
	import { API, compareNodes, errorText } from './helpers';

	let {
		open = $bindable(false),
		nodes,
		meta,
		onmoved
	}: {
		open?: boolean;
		/** Zu verschiebende Einträge (alle aus einem Bereich) */
		nodes: FileNode[];
		/** Rechte-Flags: Stamm als Ziel nur mit `can.sharedEdit` */
		meta: FilesMeta | null;
		onmoved: () => void;
	} = $props();

	interface Branch {
		loading: boolean;
		error: string | null;
		folders: FileNode[];
	}
	interface Target {
		space: Space;
		id: string | null;
		name: string;
	}

	const keyOf = (space: Space, id: string | null) => `${space}:${id ?? 'root'}`;

	let branches = $state<Record<string, Branch>>({});
	let expanded = $state<Record<string, boolean>>({});
	let target = $state<Target | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const movingIds = $derived(new Set(nodes.map((n) => n.id)));
	const roots = $derived<Space[]>(meta?.can.sharedEdit ? ['personal', 'shared'] : ['personal']);
	const sourceSpace = $derived<Space>(nodes[0]?.space ?? 'personal');

	/** Ziel = aktueller Ort aller Einträge → nichts zu tun */
	const isCurrent = $derived(
		!!target &&
			nodes.length > 0 &&
			nodes.every((n) => n.space === target!.space && n.parentId === target!.id)
	);
	const canSubmit = $derived(!!target && !isCurrent && !busy && nodes.length > 0);

	async function load(space: Space, id: string | null) {
		const key = keyOf(space, id);
		branches[key] = { loading: true, error: null, folders: [] };
		try {
			const qs = new URLSearchParams({ space });
			if (id) qs.set('parent', id);
			const listing = await apiFetch<FolderListing>(`${API}/nodes?${qs}`);
			branches[key] = {
				loading: false,
				error: null,
				folders: listing.items
					.filter((n) => n.kind === 'folder' && !movingIds.has(n.id))
					.sort(compareNodes)
			};
		} catch (e) {
			branches[key] = {
				loading: false,
				error: errorText(e, 'Ordner konnten nicht geladen werden'),
				folders: []
			};
		}
	}

	function toggle(space: Space, id: string | null) {
		const key = keyOf(space, id);
		const next = !expanded[key];
		expanded[key] = next;
		if (next && !branches[key]) void load(space, id);
	}

	function select(space: Space, id: string | null, name: string) {
		target = { space, id, name };
		error = null;
	}

	const isSelected = (space: Space, id: string | null) =>
		!!target && target.space === space && target.id === id;

	/** Beim Öffnen zurücksetzen; Wurzel des Herkunftsbereichs aufklappen */
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			untrack(() => {
				branches = {};
				expanded = {};
				target = null;
				error = null;
				busy = false;
				const start = roots.includes(sourceSpace) ? sourceSpace : 'personal';
				toggle(start, null);
			});
		}
		wasOpen = open;
	});

	async function submit() {
		if (!target || !canSubmit) return;
		busy = true;
		error = null;
		try {
			const res = await apiFetch<BulkResult>(`${API}/nodes/move`, {
				method: 'POST',
				body: JSON.stringify({
					ids: nodes.map((n) => n.id),
					targetId: target.id,
					space: target.space
				})
			});
			const n = res?.affected ?? nodes.length;
			toast.success(n === 1 ? '1 Eintrag verschoben' : `${n} Einträge verschoben`);
			open = false;
			onmoved();
		} catch (e) {
			error = errorText(e, 'Verschieben fehlgeschlagen');
		} finally {
			busy = false;
		}
	}

	const countLabel = $derived(
		nodes.length === 1 ? `„${nodes[0]!.name}“` : `${nodes.length} Einträge`
	);
</script>

{#snippet row(
	space: Space,
	id: string | null,
	name: string,
	depth: number,
	selectable: boolean,
	hasChildren: boolean,
	isRoot: boolean
)}
	{@const key = keyOf(space, id)}
	{@const isOpen = !!expanded[key]}
	<li>
		<div
			class="flex items-center gap-1 rounded-md pr-2 {isSelected(space, id)
				? 'bg-primary/10'
				: 'hover:bg-muted'}"
			style="padding-left: {depth * 1.25}rem"
		>
			{#if hasChildren}
				<Button
					variant="ghost"
					size="icon"
					class="size-7 shrink-0"
					aria-expanded={isOpen}
					aria-label={isOpen ? `${name} zuklappen` : `${name} aufklappen`}
					onclick={() => toggle(space, id)}
				>
					{#if isOpen}
						<ChevronDown class="size-4" aria-hidden="true" />
					{:else}
						<ChevronRight class="size-4" aria-hidden="true" />
					{/if}
				</Button>
			{:else}
				<span class="size-7 shrink-0" aria-hidden="true"></span>
			{/if}
			<button
				type="button"
				class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				aria-pressed={isSelected(space, id)}
				disabled={!selectable}
				title={selectable ? undefined : 'Keine Berechtigung zum Bearbeiten'}
				onclick={() => select(space, id, name)}
				ondblclick={() => hasChildren && toggle(space, id)}
			>
				{#if isRoot}
					{#if space === 'shared'}
						<Users class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					{:else}
						<HardDrive class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					{/if}
				{:else}
					<Folder class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				{/if}
				<span class="truncate {isRoot ? 'font-medium' : ''}">{name}</span>
			</button>
		</div>
		{#if hasChildren && isOpen}
			{@const branch = branches[key]}
			<ul class="grid gap-0.5">
				{#if !branch || branch.loading}
					<li style="padding-left: {(depth + 1) * 1.25 + 2}rem" class="py-1">
						<Skeleton class="h-5 w-40" />
					</li>
				{:else if branch.error}
					<li
						style="padding-left: {(depth + 1) * 1.25 + 2}rem"
						class="flex flex-wrap items-center gap-2 py-1 text-xs text-destructive"
					>
						<span role="alert">{branch.error}</span>
						<Button variant="link" size="sm" class="h-auto p-0" onclick={() => load(space, id)}>
							Erneut versuchen
						</Button>
					</li>
				{:else if branch.folders.length === 0}
					<li
						style="padding-left: {(depth + 1) * 1.25 + 2}rem"
						class="py-1 text-xs text-muted-foreground"
					>
						Keine Unterordner
					</li>
				{:else}
					{#each branch.folders as f (f.id)}
						{@render row(
							space,
							f.id,
							f.name,
							depth + 1,
							f.access === 'edit',
							(f.childCount ?? 1) > 0,
							false
						)}
					{/each}
				{/if}
			</ul>
		{/if}
	</li>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content class="flex flex-col sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Verschieben</Dialog.Title>
			<Dialog.Description>Wähle den Zielordner für {countLabel}.</Dialog.Description>
		</Dialog.Header>

		<nav
			aria-label="Zielordner"
			class="max-h-[50vh] min-h-40 overflow-y-auto rounded-md border p-1"
		>
			<ul class="grid gap-0.5">
				{#each roots as space (space)}
					{@render row(
						space,
						null,
						SPACE_LABELS[space],
						0,
						space === 'personal' || !!meta?.can.sharedEdit,
						true,
						true
					)}
				{/each}
			</ul>
		</nav>

		<p class="text-xs text-muted-foreground" aria-live="polite">
			{#if !target}
				Noch kein Ziel gewählt.
			{:else if isCurrent}
				Die Einträge liegen bereits in „{target.name}“.
			{:else}
				Ziel: {SPACE_LABELS[target.space]}{target.id ? ` / ${target.name}` : ''}
			{/if}
		</p>

		{#if error}
			<p role="alert" class="text-sm text-destructive">{error}</p>
		{/if}

		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (open = false)} disabled={busy}>
				Abbrechen
			</Button>
			<Button type="button" disabled={!canSubmit} onclick={submit}>
				{busy ? 'Verschiebt …' : 'Hierher verschieben'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
