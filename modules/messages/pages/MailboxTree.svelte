<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import Briefcase from '@lucide/svelte/icons/briefcase';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Info from '@lucide/svelte/icons/info';
	import Landmark from '@lucide/svelte/icons/landmark';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Send from '@lucide/svelte/icons/send';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import User from '@lucide/svelte/icons/user';
	import Users from '@lucide/svelte/icons/users';
	import * as ContextMenu from '$lib/components/ui/context-menu';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { CountBadge } from '$lib/components/layout';
	import { cn } from '$lib/utils';
	import { buildFolderTree, descendantIds, folderDepth, subtreeHeight } from '../folders';
	import type { FolderNode } from '../folders';
	import type { MailboxKind } from '../mailbox';
	import { MAX_FOLDER_DEPTH, type InboxFolder, type MailboxInfo } from '../schemas';
	import type { FolderAction } from './helpers';
	import {
		FOLDER_DRAG_MIME,
		MAIL_DRAG_MIME,
		inboxDrag,
		readDrop,
		setDragGhost
	} from './inbox-drag.svelte';

	let {
		mailboxes,
		mailbox,
		view,
		dnd = true,
		onselect,
		onfolderaction,
		onmovemails,
		onmovefolder
	}: {
		mailboxes: MailboxInfo[];
		mailbox: string | null;
		/** `inbox`, `sent`, `spam`, `trash` oder Ordner-ID */
		view: string;
		/** Drag & Drop erlauben (nicht auf Touch-Geräten) */
		dnd?: boolean;
		onselect: (mailbox: string, view: string) => void;
		/** Ordner anlegen (`folder` = Elternordner oder `null`), umbenennen, verschieben, löschen */
		onfolderaction: (action: FolderAction, box: MailboxInfo, folder: InboxFolder | null) => void;
		onmovemails: (mailbox: string, ids: string[], folderId: string | null) => void;
		onmovefolder: (mailbox: string, folderId: string, parentId: string | null) => void;
	} = $props();

	const KIND_ICONS: Record<MailboxKind, typeof User> = {
		personal: User,
		office: Briefcase,
		group: Users,
		stamm: Landmark,
		unassigned: Inbox
	};
	const SYSTEM_VIEWS = [
		{ view: 'sent', label: 'Gesendet', icon: Send },
		{ view: 'spam', label: 'Spam', icon: ShieldAlert },
		{ view: 'trash', label: 'Papierkorb', icon: Trash2 }
	] as const;

	// ---------- Auf-/Zuklappen (je Gerät gemerkt) ----------

	const STORAGE_KEY = 'messages:inbox-tree';
	/** `m:<postfach>` bzw. `f:<ordner>` → offen? Ohne Eintrag: Postfach offen, wenn gewählt; Ordner offen */
	let expanded = $state<Record<string, boolean>>({});

	onMount(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			const parsed: unknown = raw ? JSON.parse(raw) : null;
			if (parsed && typeof parsed === 'object') {
				expanded = Object.fromEntries(
					Object.entries(parsed as Record<string, unknown>).filter(
						(e): e is [string, boolean] => typeof e[1] === 'boolean'
					)
				);
			}
		} catch {
			// Speicher nicht verfügbar – Standard
		}
	});

	function setExpanded(key: string, value: boolean) {
		expanded = { ...expanded, [key]: value };
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(expanded));
		} catch {
			// egal
		}
	}
	const boxOpen = (key: string) => expanded[`m:${key}`] ?? key === mailbox;
	const folderOpen = (id: string) => expanded[`f:${id}`] ?? true;

	const trees = $derived(new Map(mailboxes.map((b) => [b.key, buildFolderTree(b.folders)])));
	/** Ungelesene im zugeklappten Ordner (inkl. Unterordner) */
	function deepUnread(node: FolderNode<InboxFolder>): number {
		return node.children.reduce((n, c) => n + deepUnread(c), node.folder.unread);
	}

	function selectBox(b: MailboxInfo) {
		if (!boxOpen(b.key)) setExpanded(`m:${b.key}`, true);
		onselect(b.key, 'inbox');
	}

	// ---------- Menü (gemeinsam für „…“ und Rechtsklick) ----------

	interface MenuEntry {
		key: string;
		label: string;
		icon: Component;
		run: () => void;
		destructive?: boolean;
		separator?: boolean;
	}

	let menuOpenId = $state<string | null>(null);

	function entriesFor(box: MailboxInfo, folder: InboxFolder | null): MenuEntry[] {
		const act = (action: FolderAction, target: InboxFolder | null) => () => {
			menuOpenId = null;
			ctxOpen = false;
			onfolderaction(action, box, target);
		};
		const details: MenuEntry = {
			key: 'details',
			label: 'Details',
			icon: Info,
			run: act('details', folder)
		};
		if (!folder) {
			return box.kind === 'unassigned'
				? [details]
				: [
						{ key: 'create', label: 'Ordner anlegen', icon: FolderPlus, run: act('create', null) },
						details
					];
		}
		const entries: MenuEntry[] = [];
		if (folderDepth(box.folders, folder.id) < MAX_FOLDER_DEPTH) {
			entries.push({
				key: 'create',
				label: 'Unterordner anlegen',
				icon: FolderPlus,
				run: act('create', folder)
			});
		}
		entries.push(
			{ key: 'rename', label: 'Umbenennen', icon: Pencil, run: act('rename', folder) },
			{ key: 'move', label: 'Verschieben nach …', icon: FolderInput, run: act('move', folder) },
			details,
			{
				key: 'delete',
				label: 'Ordner löschen …',
				icon: Trash2,
				run: act('delete', folder),
				destructive: true,
				separator: true
			}
		);
		return entries;
	}

	let ctxOpen = $state(false);
	let ctxPending: { box: string; folder: string | null } | null = null;
	let ctxEntries = $state<MenuEntry[]>([]);

	function targetAt(target: EventTarget | null): { box: string; folder: string | null } | null {
		const el = target instanceof Element ? target.closest('[data-ctx-box]') : null;
		const box = el?.getAttribute('data-ctx-box');
		return box ? { box, folder: el?.getAttribute('data-ctx-folder') || null } : null;
	}
	function resolve(t: { box: string; folder: string | null } | null) {
		const box = t ? mailboxes.find((b) => b.key === t.box) : undefined;
		if (!box) return null;
		const folder = t?.folder ? (box.folders.find((f) => f.id === t.folder) ?? null) : null;
		return { box, folder };
	}
	function onCtxMenu(e: MouseEvent) {
		ctxPending = targetAt(e.target);
		const r = resolve(ctxPending);
		if (!r || entriesFor(r.box, r.folder).length === 0) {
			e.preventDefault();
			return;
		}
		if (ctxOpen) onCtxOpenChange(true);
	}
	function onCtxPointerDown(e: PointerEvent) {
		if (e.pointerType !== 'mouse') ctxPending = targetAt(e.target);
	}
	function onCtxOpenChange(open: boolean) {
		if (!open) return;
		const r = resolve(ctxPending);
		const entries = r ? entriesFor(r.box, r.folder) : [];
		if (!entries.length) {
			ctxOpen = false;
			return;
		}
		menuOpenId = null;
		ctxEntries = entries;
	}
	function onRowKeydown(e: KeyboardEvent, id: string) {
		if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
			e.preventDefault();
			menuOpenId = id;
		}
	}

	// ---------- Drag & Drop ----------

	/** Ziel unter dem Mauszeiger: `box:<key>` (Postfach/Posteingang) oder Ordner-ID */
	let dropTarget = $state<string | null>(null);
	let expandTimer: ReturnType<typeof setTimeout> | undefined;

	/** Nimmt das Ziel (`folder` = `null` → Posteingang bzw. oberste Ebene) den aktuellen Ziehvorgang an? */
	function accepts(box: MailboxInfo, folder: InboxFolder | null, header = false): boolean {
		const drag = inboxDrag.current;
		if (!dnd || !drag || drag.mailbox !== box.key || box.kind === 'unassigned') return false;
		if (drag.kind === 'mails') return !header || folder === null;
		const moving = box.folders.find((f) => f.id === drag.id);
		if (!moving) return false;
		const target = folder?.id ?? null;
		if (moving.parentId === target) return false;
		if (target === null) return true;
		if (target === moving.id || descendantIds(box.folders, moving.id).includes(target))
			return false;
		return (
			folderDepth(box.folders, target) + subtreeHeight(box.folders, moving.id) <= MAX_FOLDER_DEPTH
		);
	}

	function onDragOver(
		e: DragEvent,
		box: MailboxInfo,
		folder: InboxFolder | null,
		key: string,
		expandKey: string | null,
		header = false
	) {
		const types = e.dataTransfer?.types ?? [];
		if (!types.includes(MAIL_DRAG_MIME) && !types.includes(FOLDER_DRAG_MIME)) return;
		if (!accepts(box, folder, header)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		if (dropTarget !== key) {
			dropTarget = key;
			clearTimeout(expandTimer);
			// Zugeklappte Postfächer/Ordner öffnen sich nach kurzem Halten
			if (expandKey) expandTimer = setTimeout(() => setExpanded(expandKey, true), 600);
		}
	}
	function onDragLeave(e: DragEvent, key: string) {
		const el = e.currentTarget as HTMLElement;
		if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
		if (dropTarget === key) {
			dropTarget = null;
			clearTimeout(expandTimer);
		}
	}
	function onDrop(e: DragEvent, box: MailboxInfo, folder: InboxFolder | null, header = false) {
		const ok = accepts(box, folder, header);
		dropTarget = null;
		clearTimeout(expandTimer);
		const data = readDrop(e);
		inboxDrag.current = null;
		if (!ok || !data || data.mailbox !== box.key) return;
		e.preventDefault();
		if (data.kind === 'mails') onmovemails(box.key, data.ids, folder?.id ?? null);
		else onmovefolder(box.key, data.id, folder?.id ?? null);
	}
	function onFolderDragStart(e: DragEvent, box: MailboxInfo, folder: InboxFolder) {
		if (!dnd || !e.dataTransfer) return;
		inboxDrag.current = { kind: 'folder', mailbox: box.key, id: folder.id };
		e.dataTransfer.setData(FOLDER_DRAG_MIME, JSON.stringify({ mailbox: box.key, id: folder.id }));
		e.dataTransfer.effectAllowed = 'move';
		setDragGhost(e, folder.name);
	}
	function onDragEnd() {
		inboxDrag.current = null;
		dropTarget = null;
		clearTimeout(expandTimer);
	}

	const rowClass = (active: boolean, dropping: boolean) =>
		cn(
			'group flex items-center gap-1 rounded-md text-sm',
			active ? 'bg-muted font-medium' : 'hover:bg-muted/60',
			dropping && 'bg-info-muted ring-2 ring-primary ring-inset'
		);
	const selectClass =
		'focus-ring flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 text-left';
</script>

{#snippet contextEntries(entries: MenuEntry[])}
	{#each entries as entry (entry.key)}
		{@const Icon = entry.icon}
		{#if entry.separator}<ContextMenu.Separator />{/if}
		<ContextMenu.Item variant={entry.destructive ? 'destructive' : 'default'} onclick={entry.run}>
			<Icon />
			{entry.label}
		</ContextMenu.Item>
	{/each}
{/snippet}

{#snippet folderMenu(box: MailboxInfo, folder: InboxFolder)}
	<DropdownMenu.Root
		bind:open={() => menuOpenId === folder.id, (v) => (menuOpenId = v ? folder.id : null)}
	>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					type="button"
					class="focus-ring mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-background hover:text-foreground data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
					aria-label={`Aktionen für Ordner ${folder.name}`}
				>
					<Ellipsis class="size-4" />
				</button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="w-52">
			{#each entriesFor(box, folder) as entry (entry.key)}
				{@const Icon = entry.icon}
				{#if entry.separator}<DropdownMenu.Separator />{/if}
				<DropdownMenu.Item
					variant={entry.destructive ? 'destructive' : 'default'}
					onclick={entry.run}
				>
					<Icon />
					{entry.label}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/snippet}

{#snippet folderRows(box: MailboxInfo, nodes: FolderNode<InboxFolder>[])}
	{#each nodes as node (node.folder.id)}
		{@const f = node.folder}
		{@const open = folderOpen(f.id)}
		{@const active = mailbox === box.key && view === f.id}
		{@const count = open || !node.children.length ? f.unread : deepUnread(node)}
		<li>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class={rowClass(active, dropTarget === f.id)}
				style:padding-left={`${node.depth * 1.1 + 0.25}rem`}
				data-ctx-box={box.key}
				data-ctx-folder={f.id}
				ondragover={(e) =>
					onDragOver(e, box, f, f.id, !open && node.children.length ? `f:${f.id}` : null)}
				ondragleave={(e) => onDragLeave(e, f.id)}
				ondrop={(e) => onDrop(e, box, f)}
			>
				{#if node.children.length}
					<button
						type="button"
						class="focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
						aria-label={open ? `${f.name} zuklappen` : `${f.name} aufklappen`}
						aria-expanded={open}
						onclick={() => setExpanded(`f:${f.id}`, !open)}
					>
						<ChevronRight class={cn('size-3.5 transition-transform', open && 'rotate-90')} />
					</button>
				{:else}
					<span class="w-6 shrink-0" aria-hidden="true"></span>
				{/if}
				<button
					type="button"
					class={selectClass}
					aria-current={active ? 'true' : undefined}
					draggable={dnd ? 'true' : undefined}
					ondragstart={(e) => onFolderDragStart(e, box, f)}
					ondragend={onDragEnd}
					onkeydown={(e) => onRowKeydown(e, f.id)}
					onclick={() => onselect(box.key, f.id)}
				>
					{#if active}
						<FolderOpen class="size-4 shrink-0 text-link" aria-hidden="true" />
					{:else}
						<Folder class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					{/if}
					<span class="min-w-0 flex-1 truncate">{f.name}</span>
					<CountBadge {count} variant="info" label={`${count} ungelesen`} />
				</button>
				{@render folderMenu(box, f)}
			</div>
			{#if open && node.children.length}
				<ul class="space-y-0.5">{@render folderRows(box, node.children)}</ul>
			{/if}
		</li>
	{/each}
{/snippet}

<ContextMenu.Root bind:open={ctxOpen} onOpenChange={onCtxOpenChange}>
	<ContextMenu.Trigger oncontextmenu={onCtxMenu} onpointerdown={onCtxPointerDown}>
		{#snippet child({ props })}
			<nav {...props} aria-label="Postfächer und Ordner" class="[-webkit-touch-callout:none]">
				<ul class="space-y-1">
					{#each mailboxes as b, i (b.key)}
						{@const Icon = KIND_ICONS[b.kind]}
						{@const open = boxOpen(b.key)}
						{@const headerKey = `box:${b.key}`}
						<li class={cn(i > 0 && 'border-t pt-1')}>
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class={rowClass(false, dropTarget === headerKey)}
								data-ctx-box={b.key}
								ondragover={(e) =>
									onDragOver(e, b, null, headerKey, open ? null : `m:${b.key}`, true)}
								ondragleave={(e) => onDragLeave(e, headerKey)}
								ondrop={(e) => onDrop(e, b, null, true)}
							>
								<button
									type="button"
									class="focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
									aria-label={open ? `${b.name} zuklappen` : `${b.name} aufklappen`}
									aria-expanded={open}
									onclick={() => setExpanded(`m:${b.key}`, !open)}
								>
									<ChevronRight class={cn('size-3.5 transition-transform', open && 'rotate-90')} />
								</button>
								<button
									type="button"
									class={cn(selectClass, 'items-start')}
									onclick={() => selectBox(b)}
								>
									<Icon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
									<span class="min-w-0 flex-1">
										<span class="block truncate font-medium">{b.name}</span>
										{#if b.address}
											<span class="block truncate text-xs text-muted-foreground">{b.address}</span>
										{/if}
									</span>
									{#if !open}
										<CountBadge count={b.unread} variant="info" class="mt-0.5" />
									{/if}
								</button>
							</div>
							{#if open}
								<ul class="mt-0.5 space-y-0.5">
									<li>
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div
											class={rowClass(
												mailbox === b.key && view === 'inbox',
												dropTarget === `inbox:${b.key}`
											)}
											style:padding-left="1.35rem"
											data-ctx-box={b.key}
											ondragover={(e) => onDragOver(e, b, null, `inbox:${b.key}`, null)}
											ondragleave={(e) => onDragLeave(e, `inbox:${b.key}`)}
											ondrop={(e) => onDrop(e, b, null)}
										>
											<span class="w-6 shrink-0" aria-hidden="true"></span>
											<button
												type="button"
												class={selectClass}
												aria-current={mailbox === b.key && view === 'inbox' ? 'true' : undefined}
												onclick={() => onselect(b.key, 'inbox')}
											>
												<Inbox class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
												<span class="flex-1">Posteingang</span>
												<CountBadge count={b.inboxUnread} variant="info" />
											</button>
										</div>
									</li>
									{@render folderRows(b, trees.get(b.key) ?? [])}
									{#each SYSTEM_VIEWS.filter((s) => s.view !== 'sent' || b.kind !== 'unassigned') as s (s.view)}
										{@const SysIcon = s.icon}
										{@const active = mailbox === b.key && view === s.view}
										<li>
											<div class={rowClass(active, false)} style:padding-left="1.35rem">
												<span class="w-6 shrink-0" aria-hidden="true"></span>
												<button
													type="button"
													class={cn(
														selectClass,
														'min-h-7 py-1 text-xs',
														!active && 'text-muted-foreground'
													)}
													aria-current={active ? 'true' : undefined}
													onclick={() => onselect(b.key, s.view)}
												>
													<SysIcon class="size-3.5 shrink-0" aria-hidden="true" />
													<span class="flex-1">{s.label}</span>
													{#if s.view === 'spam' && b.spamCount}
														<span class="tabular-nums">{b.spamCount}</span>
													{/if}
												</button>
											</div>
										</li>
									{/each}
									{#if b.kind !== 'unassigned'}
										<li>
											<div class="flex items-center gap-1" style:padding-left="1.35rem">
												<span class="w-6 shrink-0" aria-hidden="true"></span>
												<button
													type="button"
													class="focus-ring flex min-h-7 flex-1 items-center gap-2 rounded-md py-1 pr-2 text-left text-xs text-link hover:bg-muted/60"
													onclick={() => onfolderaction('create', b, null)}
												>
													<Plus class="size-3.5 shrink-0" aria-hidden="true" />
													Ordner anlegen
												</button>
											</div>
										</li>
									{/if}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
			</nav>
		{/snippet}
	</ContextMenu.Trigger>
	<ContextMenu.Content class="w-52">
		{@render contextEntries(ctxEntries)}
	</ContextMenu.Content>
</ContextMenu.Root>
