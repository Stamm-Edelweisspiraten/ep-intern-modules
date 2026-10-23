<script lang="ts">
	import { onMount, untrack, type Component } from 'svelte';
	import { page } from '$app/state';
	import { goto, replaceState } from '$app/navigation';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Folder from '@lucide/svelte/icons/folder';
	import Info from '@lucide/svelte/icons/info';
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import Mail from '@lucide/svelte/icons/mail';
	import MailOpen from '@lucide/svelte/icons/mail-open';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Reply from '@lucide/svelte/icons/reply';
	import Search from '@lucide/svelte/icons/search';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import X from '@lucide/svelte/icons/x';
	import { toast } from 'svelte-sonner';
	import { apiFetch, can } from '$lib/sdk/client';
	import { refreshNavBadges } from '$lib/sdk/client/nav-badges.svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as ContextMenu from '$lib/components/ui/context-menu';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as Table from '$lib/components/ui/table';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		ConfirmDialog,
		DataTable,
		ErrorState,
		LoadingState,
		PageHeader,
		PageTitle,
		toastWithUndo
	} from '$lib/components/layout';
	import { cn } from '$lib/utils';
	import { descendantIds, folderDepth, folderPath } from '../folders';
	import {
		MAX_FOLDER_DEPTH,
		MESSAGE_STATUS_LABELS,
		type BulkAction,
		type InboxFolder,
		type InboxListResponse,
		type InboxSummary,
		type MailboxesResponse,
		type MailboxInfo,
		type MailboxSentItem,
		type MailboxSentResponse,
		type MessageStatus,
		type MoveMailsResult,
		type PollResult
	} from '../schemas';
	import FolderDetailsDialog from './FolderDetailsDialog.svelte';
	import FolderDialog from './FolderDialog.svelte';
	import MailboxTree from './MailboxTree.svelte';
	import MessagesTabs from './MessagesTabs.svelte';
	import MoveToFolderDialog from './MoveToFolderDialog.svelte';
	import { BASE, errorText, formatDateTime, type FolderAction } from './helpers';
	import { MAIL_DRAG_MIME, inboxDrag, setDragGhost } from './inbox-drag.svelte';

	const PAGE_SIZE = 50;
	const SYSTEM_LABELS: Record<string, string> = {
		inbox: 'Posteingang',
		sent: 'Gesendet',
		spam: 'Spam',
		trash: 'Papierkorb'
	};
	const statusVariant = (s: MessageStatus) =>
		s === 'done'
			? 'success'
			: s === 'sending'
				? 'info'
				: s === 'partial'
					? 'warning'
					: 'destructive';
	const nachrichten = (n: number) => (n === 1 ? '1 Nachricht' : `${n} Nachrichten`);

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canSettings = $derived(can(permissions, 'messages.settings.manage'));

	let boxes = $state<MailboxesResponse | null>(null);
	let boxesError = $state('');
	let mailbox = $state<string | null>(null);
	/** `inbox`, `sent`, `spam`, `trash` oder Ordner-ID */
	let view = $state('inbox');
	let filter = $state<'all' | 'unread'>('all');
	let searchText = $state('');
	let query = $state('');
	let offset = $state(0);

	let items = $state<InboxSummary[]>([]);
	/** Ansicht „Gesendet“: von der Adresse des Postfachs gesendete Nachrichten */
	let sentItems = $state<MailboxSentItem[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let listError = $state('');
	let polling = $state(false);
	let selected = $state<string[]>([]);
	let treeOpen = $state(false);

	/** Touch-Geräte: kein Drag & Drop (Long-Press öffnet das Kontextmenü) */
	let isCoarse = $state(false);
	onMount(() => {
		const mq = window.matchMedia('(pointer: coarse)');
		const update = () => (isCoarse = mq.matches);
		update();
		mq.addEventListener('change', update);
		return () => mq.removeEventListener('change', update);
	});

	const current = $derived(boxes?.mailboxes.find((b) => b.key === mailbox) ?? null);
	const currentFolder = $derived(current?.folders.find((f) => f.id === view) ?? null);
	const path = $derived(current && currentFolder ? folderPath(current.folders, view) : []);
	const viewLabel = $derived(currentFolder?.name ?? SYSTEM_LABELS[view] ?? 'Posteingang');
	const showSent = $derived(view === 'sent');
	const isFolderView = $derived(view === 'inbox' || currentFolder !== null);
	/** Einsortieren: nicht in „Nicht zugeordnet“, Spam, Papierkorb, Gesendet */
	const canSort = $derived(!!current && current.kind !== 'unassigned' && isFolderView);
	const selectedSet = $derived(new Set(selected));
	const selectedItems = $derived(items.filter((m) => selectedSet.has(m.id)));
	const allSelected = $derived(items.length > 0 && items.every((m) => selectedSet.has(m.id)));

	const isView = (v: string | null): v is string => !!v && /^[A-Za-z0-9-]{1,100}$/.test(v);

	/** Postfächer laden; wählt beim ersten Mal Postfach und Ordner aus der URL bzw. das erste Postfach */
	async function loadBoxes() {
		try {
			const res = await apiFetch<MailboxesResponse>(`${BASE}/mailboxes`);
			boxes = res;
			boxesError = '';
			const keys = res.mailboxes.map((b) => b.key);
			const first = untrack(() => mailbox) === null;
			const params = new URLSearchParams(location.search);
			const wanted = untrack(() => mailbox) ?? params.get('mailbox');
			const next = wanted && keys.includes(wanted) ? wanted : (keys[0] ?? null);
			if (first) {
				const v = params.get('folder');
				if (isView(v)) view = v;
			}
			// Ordner inzwischen gelöscht (auch von jemand anderem) → Posteingang
			const box = res.mailboxes.find((b) => b.key === next);
			const v = untrack(() => view);
			if (box && !SYSTEM_LABELS[v] && !box.folders.some((f) => f.id === v)) view = 'inbox';
			if (box?.kind === 'unassigned' && untrack(() => view) === 'sent') view = 'inbox';
			if (next !== untrack(() => mailbox)) mailbox = next;
			if (!next) loading = false;
		} catch (e) {
			boxesError = errorText(e, 'Die Postfächer konnten nicht geladen werden.');
			loading = false;
		}
	}

	let inFlight = false;
	/** Liste laden; liest selbst keinen reaktiven Zustand (Aufruf aus `$effect` mit `untrack`) */
	async function loadList(
		key: string,
		v: string,
		f: 'all' | 'unread',
		q: string,
		at: number,
		silent = false
	): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		if (!silent) loading = true;
		try {
			const params = new URLSearchParams({
				mailbox: key,
				limit: String(PAGE_SIZE),
				offset: String(at)
			});
			if (q) params.set('search', q);
			if (v === 'sent') {
				const res = await apiFetch<MailboxSentResponse>(`${BASE}/mailboxes/sent?${params}`);
				sentItems = res.items;
				items = [];
				total = res.total;
			} else {
				if (v === 'spam' || v === 'trash') params.set('filter', v);
				else {
					params.set('filter', f);
					params.set('folder', v);
				}
				const res = await apiFetch<InboxListResponse>(`${BASE}/inbox?${params}`);
				items = res.items;
				sentItems = [];
				total = res.total;
			}
			// Auswahl nur behalten, soweit die Mails noch da sind
			const ids = new Set(items.map((m) => m.id));
			if (untrack(() => selected).some((id) => !ids.has(id))) {
				selected = untrack(() => selected).filter((id) => ids.has(id));
			}
			listError = '';
		} catch (e) {
			listError = errorText(e, 'Die Nachrichten konnten nicht geladen werden.');
		} finally {
			inFlight = false;
			loading = false;
		}
	}

	void loadBoxes();

	// Postfach, Ordner, Filter, Suche oder Seite geändert → Liste neu laden und Ort in der URL merken
	$effect(() => {
		const key = mailbox;
		const v = view;
		const f = filter;
		const q = query;
		const at = offset;
		if (!key) return;
		untrack(() => {
			const url = new URL(location.href);
			const folderParam = v === 'inbox' ? null : v;
			if (
				url.searchParams.get('mailbox') !== key ||
				url.searchParams.get('folder') !== folderParam
			) {
				url.searchParams.set('mailbox', key);
				if (folderParam) url.searchParams.set('folder', folderParam);
				else url.searchParams.delete('folder');
				replaceState(url, page.state);
			}
			void loadList(key, v, f, q, at);
		});
	});

	// Suche mit kurzer Verzögerung
	$effect(() => {
		const q = searchText.trim();
		const t = setTimeout(() => {
			if (q !== untrack(() => query)) {
				query = q;
				offset = 0;
			}
		}, 300);
		return () => clearTimeout(t);
	});

	// Neue Mails: jede Minute still aktualisieren (nur im sichtbaren Tab)
	$effect(() => {
		const t = setInterval(() => {
			if (document.hidden) return;
			untrack(() => void refresh());
		}, 60_000);
		return () => clearInterval(t);
	});

	/** Nach Änderungen: Postfächer (Zähler, Ordner), Liste und Seitenleiste still nachladen */
	async function refresh() {
		await loadBoxes();
		void refreshNavBadges();
		const key = untrack(() => mailbox);
		if (key) {
			await loadList(
				key,
				untrack(() => view),
				untrack(() => filter),
				untrack(() => query),
				untrack(() => offset),
				true
			);
		}
	}

	function select(key: string, v: string) {
		treeOpen = false;
		if (key === mailbox && v === view) return;
		mailbox = key;
		view = v;
		offset = 0;
		selected = [];
		if (v === 'spam' || v === 'trash' || v === 'sent') filter = 'all';
	}

	async function pollNow() {
		polling = true;
		try {
			const res = await apiFetch<PollResult>(`${BASE}/inbox/poll`, { method: 'POST' });
			toast.success(res.message);
			await refresh();
		} catch (e) {
			toast.error(errorText(e, 'Der Abruf ist fehlgeschlagen.'));
		} finally {
			polling = false;
		}
	}

	const open = (id: string) => goto(`${BASE}/inbox/${id}`);
	const folderName = (box: MailboxInfo, id: string | null) =>
		id ? (box.folders.find((f) => f.id === id)?.name ?? 'Ordner') : 'Posteingang';

	// ---------- Auswahl und Sammelaktionen ----------

	function setSelected(id: string, on: boolean) {
		selected = on ? [...new Set([...selected, id])] : selected.filter((s) => s !== id);
	}
	function setAll(on: boolean) {
		selected = on ? items.map((m) => m.id) : [];
	}

	async function bulk(action: BulkAction, ids: string[]) {
		if (!ids.length) return;
		try {
			await apiFetch(`${BASE}/inbox/bulk`, {
				method: 'POST',
				body: JSON.stringify({ ids, action })
			});
			selected = [];
			if (action === 'delete') {
				toastWithUndo({
					message: `${nachrichten(ids.length)} in den Papierkorb verschoben`,
					undo: () =>
						apiFetch(`${BASE}/inbox/bulk`, {
							method: 'POST',
							body: JSON.stringify({ ids, action: 'restore' })
						}),
					onundone: refresh
				});
			} else if (action === 'restore') {
				toast.success(`${nachrichten(ids.length)} wiederhergestellt`);
			} else {
				toast.success(action === 'read' ? 'Als gelesen markiert' : 'Als ungelesen markiert');
			}
		} catch (e) {
			toast.error(errorText(e, 'Das hat nicht geklappt.'));
		}
		await refresh();
	}

	// ---------- Verschieben ----------

	async function moveMails(boxKey: string, ids: string[], folderId: string | null) {
		const box = boxes?.mailboxes.find((b) => b.key === boxKey);
		if (!box || !ids.length) return;
		try {
			const res = await apiFetch<MoveMailsResult>(`${BASE}/inbox/move`, {
				method: 'POST',
				body: JSON.stringify({ ids, folderId })
			});
			selected = [];
			toastWithUndo({
				message: `${nachrichten(res.moved)} nach „${folderName(box, folderId)}“ verschoben`,
				undo: async () => {
					// Jede Mail zurück an ihren alten Ort (gruppiert nach Ordner)
					const back = new Map<string | null, string[]>();
					for (const p of res.previous)
						back.set(p.folderId, [...(back.get(p.folderId) ?? []), p.id]);
					for (const [target, list] of back) {
						await apiFetch(`${BASE}/inbox/move`, {
							method: 'POST',
							body: JSON.stringify({ ids: list, folderId: target })
						});
					}
				},
				onundone: refresh
			});
		} catch (e) {
			toast.error(errorText(e, 'Verschieben nicht möglich.'));
		}
		await refresh();
	}

	async function moveFolder(boxKey: string, folderId: string, parentId: string | null) {
		const box = boxes?.mailboxes.find((b) => b.key === boxKey);
		const folder = box?.folders.find((f) => f.id === folderId);
		if (!box || !folder) return;
		const before = folder.parentId;
		const patch = (target: string | null) =>
			apiFetch(`${BASE}/folders/${folderId}`, {
				method: 'PATCH',
				body: JSON.stringify({ parentId: target })
			});
		try {
			await patch(parentId);
			toastWithUndo({
				message: `„${folder.name}“ nach „${parentId ? folderName(box, parentId) : 'oberste Ebene'}“ verschoben`,
				undo: () => patch(before),
				onundone: refresh
			});
		} catch (e) {
			toast.error(errorText(e, 'Verschieben nicht möglich.'));
		}
		await refresh();
	}

	// ---------- Ordner-Dialoge ----------

	let folderDialog = $state<{
		open: boolean;
		mode: 'create' | 'rename';
		box: MailboxInfo | null;
		parentId: string | null;
		folder: InboxFolder | null;
	}>({ open: false, mode: 'create', box: null, parentId: null, folder: null });

	let moveDialog = $state<{
		open: boolean;
		box: MailboxInfo | null;
		ids: string[];
		folder: InboxFolder | null;
		current: string | null;
	}>({ open: false, box: null, ids: [], folder: null, current: null });

	let deleteDialog = $state<{
		open: boolean;
		box: MailboxInfo | null;
		folder: InboxFolder | null;
		description: string;
	}>({ open: false, box: null, folder: null, description: '' });

	let detailsDialog = $state<{ open: boolean; mailbox: string | null; folderId: string | null }>({
		open: false,
		mailbox: null,
		folderId: null
	});

	function onFolderAction(action: FolderAction, box: MailboxInfo, folder: InboxFolder | null) {
		treeOpen = false;
		if (action === 'details') {
			detailsDialog = { open: true, mailbox: box.key, folderId: folder?.id ?? null };
		} else if (action === 'create') {
			folderDialog = {
				open: true,
				mode: 'create',
				box,
				parentId: folder?.id ?? null,
				folder: null
			};
		} else if (action === 'rename' && folder) {
			folderDialog = { open: true, mode: 'rename', box, parentId: null, folder };
		} else if (action === 'move' && folder) {
			moveDialog = { open: true, box, ids: [], folder, current: folder.parentId };
		} else if (action === 'delete' && folder) {
			const ids = [folder.id, ...descendantIds(box.folders, folder.id)];
			const mails = box.folders.filter((f) => ids.includes(f.id)).reduce((n, f) => n + f.total, 0);
			const subs = ids.length - 1;
			deleteDialog = {
				open: true,
				box,
				folder,
				description:
					(subs
						? `Der Ordner und ${subs === 1 ? 'sein Unterordner werden' : `seine ${subs} Unterordner werden`} entfernt.`
						: 'Der Ordner wird entfernt.') +
					(mails
						? ` ${nachrichten(mails)} darin ${mails === 1 ? 'landet' : 'landen'} wieder im Posteingang – es geht nichts verloren.`
						: '') +
					(box.shared ? ' Das gilt für alle mit Zugriff auf das Postfach.' : '')
			};
		}
	}

	async function deleteFolder() {
		const { box, folder } = deleteDialog;
		if (!box || !folder) return;
		const gone = new Set([folder.id, ...descendantIds(box.folders, folder.id)]);
		try {
			const res = await apiFetch<{ movedMessages: number }>(`${BASE}/folders/${folder.id}`, {
				method: 'DELETE'
			});
			toast.success(
				res.movedMessages
					? `Ordner gelöscht · ${nachrichten(res.movedMessages)} im Posteingang`
					: 'Ordner gelöscht'
			);
			if (mailbox === box.key && gone.has(view)) {
				view = 'inbox';
				offset = 0;
			}
		} catch (e) {
			toast.error(errorText(e, 'Löschen nicht möglich.'));
		}
		await refresh();
	}

	function openMoveMails(ids: string[]) {
		if (!current || !ids.length) return;
		const folders = new Set(items.filter((m) => ids.includes(m.id)).map((m) => m.folderId));
		moveDialog = {
			open: true,
			box: current,
			ids,
			folder: null,
			current: folders.size === 1 ? ([...folders][0] ?? null) : '__mixed__'
		};
	}

	function onMovePick(target: string | null) {
		const { box, ids, folder } = moveDialog;
		if (!box) return;
		if (folder) void moveFolder(box.key, folder.id, target);
		else void moveMails(box.key, ids, target);
	}

	// ---------- Drag & Drop der Zeilen ----------

	function onRowDragStart(e: DragEvent, m: InboxSummary) {
		if (!canSort || isCoarse || !e.dataTransfer || !current) return;
		const ids = selectedSet.has(m.id) ? selected.slice() : [m.id];
		inboxDrag.current = { kind: 'mails', mailbox: current.key, ids };
		e.dataTransfer.setData(MAIL_DRAG_MIME, JSON.stringify({ mailbox: current.key, ids }));
		e.dataTransfer.effectAllowed = 'move';
		setDragGhost(e, nachrichten(ids.length));
	}
	function onRowDragEnd() {
		inboxDrag.current = null;
	}

	// ---------- Kontextmenü der Zeilen (und „…“ im Ordnerkopf) ----------

	interface MenuEntry {
		key: string;
		label: string;
		icon: Component;
		run: () => void;
		destructive?: boolean;
		separator?: boolean;
	}

	let ctxOpen = $state(false);
	let ctxPending: string | null = null;
	let ctxTitle = $state<string | null>(null);
	let ctxEntries = $state<MenuEntry[]>([]);

	function mailEntries(targets: InboxSummary[]): MenuEntry[] {
		const ids = targets.map((m) => m.id);
		const close = (fn: () => void) => () => {
			ctxOpen = false;
			fn();
		};
		const entries: MenuEntry[] = [];
		if (targets.length === 1) {
			entries.push({
				key: 'open',
				label: 'Öffnen',
				icon: MailOpen,
				run: close(() => open(ids[0]!))
			});
		}
		if (view !== 'trash') {
			if (targets.some((m) => !m.read)) {
				entries.push({
					key: 'read',
					label: 'Als gelesen markieren',
					icon: MailOpen,
					run: close(() => void bulk('read', ids))
				});
			}
			if (targets.some((m) => m.read)) {
				entries.push({
					key: 'unread',
					label: 'Als ungelesen markieren',
					icon: Mail,
					run: close(() => void bulk('unread', ids))
				});
			}
		}
		if (canSort) {
			entries.push({
				key: 'move',
				label: 'Verschieben nach …',
				icon: FolderInput,
				run: close(() => openMoveMails(ids))
			});
		}
		entries.push(
			view === 'trash'
				? {
						key: 'restore',
						label: 'Wiederherstellen',
						icon: Undo2,
						run: close(() => void bulk('restore', ids)),
						separator: entries.length > 0
					}
				: {
						key: 'delete',
						label: 'In den Papierkorb',
						icon: Trash2,
						run: close(() => void bulk('delete', ids)),
						destructive: true,
						separator: entries.length > 0
					}
		);
		return entries;
	}

	function mailIdAt(target: EventTarget | null): string | null {
		const el = target instanceof Element ? target.closest('[data-mail-id]') : null;
		const id = el?.getAttribute('data-mail-id') ?? null;
		return id && items.some((m) => m.id === id) ? id : null;
	}
	function onCtxMenu(e: MouseEvent) {
		ctxPending = mailIdAt(e.target);
		if (!ctxPending) {
			e.preventDefault();
			return;
		}
		if (ctxOpen) onCtxOpenChange(true);
	}
	function onCtxPointerDown(e: PointerEvent) {
		if (e.pointerType !== 'mouse') ctxPending = mailIdAt(e.target);
	}
	function onCtxOpenChange(isOpen: boolean) {
		if (!isOpen) return;
		const m = ctxPending ? items.find((i) => i.id === ctxPending) : undefined;
		if (!m) {
			ctxOpen = false;
			return;
		}
		// Rechtsklick auf eine nicht markierte Zeile gilt nur ihr; sonst der ganzen Auswahl
		const targets = selectedSet.has(m.id) ? selectedItems : [m];
		ctxTitle = targets.length > 1 ? `${nachrichten(targets.length)} ausgewählt` : null;
		ctxEntries = mailEntries(targets);
	}

	const folderHeaderEntries = $derived.by((): MenuEntry[] => {
		const box = current;
		const folder = currentFolder;
		if (!box || !folder) return [];
		const entries: MenuEntry[] = [];
		if (folderDepth(box.folders, folder.id) < MAX_FOLDER_DEPTH) {
			entries.push({
				key: 'create',
				label: 'Unterordner anlegen',
				icon: FolderPlus,
				run: () => onFolderAction('create', box, folder)
			});
		}
		entries.push(
			{
				key: 'rename',
				label: 'Umbenennen',
				icon: Pencil,
				run: () => onFolderAction('rename', box, folder)
			},
			{
				key: 'move',
				label: 'Verschieben nach …',
				icon: FolderInput,
				run: () => onFolderAction('move', box, folder)
			},
			{
				key: 'details',
				label: 'Details',
				icon: Info,
				run: () => onFolderAction('details', box, folder)
			},
			{
				key: 'delete',
				label: 'Ordner löschen …',
				icon: Trash2,
				run: () => onFolderAction('delete', box, folder),
				destructive: true,
				separator: true
			}
		);
		return entries;
	});

	const emptyTitle = $derived(
		filter === 'unread' && isFolderView
			? 'Keine ungelesenen Nachrichten.'
			: view === 'trash'
				? 'Der Papierkorb ist leer.'
				: view === 'spam'
					? 'Kein Spam.'
					: view === 'sent'
						? 'Von dieser Adresse wurde noch nichts gesendet.'
						: currentFolder
							? 'Dieser Ordner ist leer. Ziehe Nachrichten hierher oder nutze „Verschieben nach …“.'
							: 'Noch keine Nachrichten in diesem Postfach.'
	);
</script>

<PageTitle title="Posteingang" />

{#snippet tree(dnd: boolean)}
	{#if boxes}
		<MailboxTree
			mailboxes={boxes.mailboxes}
			{mailbox}
			{view}
			{dnd}
			onselect={select}
			onfolderaction={onFolderAction}
			onmovemails={(key, ids, folderId) => void moveMails(key, ids, folderId)}
			onmovefolder={(key, id, parentId) => void moveFolder(key, id, parentId)}
		/>
	{/if}
{/snippet}

<div class="space-y-6">
	<PageHeader
		title="Nachrichten"
		description="Antworten auf deine Mails und Post an deine Adressen."
	>
		{#snippet actions()}
			{#if boxes?.canManage && boxes.enabled}
				<Button variant="outline" onclick={pollNow} disabled={polling}>
					<RefreshCw class={cn('size-4', polling && 'animate-spin')} />
					{polling ? 'Ruft ab …' : 'Jetzt abrufen'}
				</Button>
			{/if}
			<Button href={`${BASE}/new`}><Plus class="size-4" /> Neue Nachricht</Button>
		{/snippet}
	</PageHeader>
	<MessagesTabs />

	{#if !boxes && !boxesError}
		<LoadingState label="Lädt …" rows={4} />
	{:else if boxesError || !boxes}
		<ErrorState message={boxesError} onretry={loadBoxes} />
	{:else}
		{#if !boxes.enabled}
			<Alert variant="info">
				<AlertDescription>
					Der Posteingang ist noch nicht eingerichtet: Antworten auf gesendete Nachrichten
					erscheinen erst hier, wenn das Catch-all-Postfach unter Administration → Einstellungen →
					Module hinterlegt ist.
					{#if canSettings}
						<a class="text-link underline" href="/admin/settings/modules">Zu den Einstellungen</a>
					{/if}
				</AlertDescription>
			</Alert>
		{:else if boxes.lastPoll?.status === 'error'}
			<Alert variant="warning">
				<AlertDescription>
					Letzter Abruf fehlgeschlagen{boxes.lastPoll.at
						? ` (${formatDateTime(boxes.lastPoll.at)})`
						: ''}: {boxes.lastPoll.message}
				</AlertDescription>
			</Alert>
		{/if}

		{#if boxes.mailboxes.length === 0}
			<Card.Root>
				<Card.Content class="py-10 text-center text-sm text-muted-foreground">
					Du hast noch kein Postfach. Postfächer entstehen aus deinen Absenderadressen: der
					persönlichen Adresse, deinen Ämtern und den Gruppen, die du leitest.
				</Card.Content>
			</Card.Root>
		{:else}
			<div class="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
				<!-- Postfächer und Ordner: links als Baum, mobil als Auswahl von unten -->
				<div class="lg:hidden">
					<Button
						variant="outline"
						class="h-auto w-full justify-start py-2 text-left"
						onclick={() => (treeOpen = true)}
					>
						<FolderOpen class="size-4 shrink-0" aria-hidden="true" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-xs text-muted-foreground">
								{[current?.name, ...path.slice(0, -1).map((f) => f.name)]
									.filter(Boolean)
									.join(' › ')}
							</span>
							<span class="block truncate font-medium">{viewLabel}</span>
						</span>
						<ChevronDown class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					</Button>
					<Sheet.Root bind:open={treeOpen}>
						<Sheet.Content side="bottom" class="max-h-[85dvh]">
							<Sheet.Header>
								<Sheet.Title>Postfach und Ordner</Sheet.Title>
							</Sheet.Header>
							<div class="overflow-y-auto px-3 pb-6">{@render tree(false)}</div>
						</Sheet.Content>
					</Sheet.Root>
				</div>
				<div class="hidden lg:block">{@render tree(!isCoarse)}</div>

				<div class="min-w-0 space-y-3">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div class="flex min-w-0 items-center gap-1">
							<h2 class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-section">
								<span class="sr-only">Ordner:</span>
								{#if current}
									<span class="truncate text-sm font-normal text-muted-foreground"
										>{current.name}</span
									>
									<span class="text-sm font-normal text-muted-foreground" aria-hidden="true">›</span
									>
								{/if}
								{#each path.slice(0, -1) as p (p.id)}
									<button
										type="button"
										class="focus-ring truncate rounded text-sm font-normal text-muted-foreground hover:text-foreground"
										onclick={() => mailbox && select(mailbox, p.id)}
									>
										{p.name}
									</button>
									<span class="text-sm font-normal text-muted-foreground" aria-hidden="true">›</span
									>
								{/each}
								<span class="truncate">{viewLabel}</span>
							</h2>
							{#if folderHeaderEntries.length}
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button
												{...props}
												variant="ghost"
												size="icon-sm"
												aria-label={`Aktionen für Ordner ${viewLabel}`}
											>
												<Ellipsis class="size-4" />
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="start" class="w-52">
										{#each folderHeaderEntries as entry (entry.key)}
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
							{/if}
						</div>
						<div class="relative w-full sm:w-64">
							<Search
								class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
								aria-hidden="true"
							/>
							<Input
								type="search"
								class="pl-8"
								placeholder={showSent ? 'Betreff oder Empfänger …' : `In „${viewLabel}“ suchen …`}
								aria-label="Nachrichten durchsuchen"
								bind:value={searchText}
							/>
						</div>
					</div>

					{#if selected.length}
						<div
							class="flex flex-wrap items-center gap-2 rounded-lg border border-info-border bg-info-muted px-3 py-2"
							role="toolbar"
							aria-label="Sammelaktionen"
						>
							<span class="mr-1 text-sm font-medium">{selected.length} ausgewählt</span>
							{#if canSort}
								<Button size="sm" variant="outline" onclick={() => openMoveMails(selected.slice())}>
									<FolderInput class="size-4" /> Verschieben nach
								</Button>
							{/if}
							{#if view === 'trash'}
								<Button
									size="sm"
									variant="outline"
									onclick={() => bulk('restore', selected.slice())}
								>
									<Undo2 class="size-4" /> Wiederherstellen
								</Button>
							{:else}
								<Button size="sm" variant="outline" onclick={() => bulk('read', selected.slice())}>
									<MailOpen class="size-4" /> Gelesen
								</Button>
								<Button
									size="sm"
									variant="outline"
									onclick={() => bulk('unread', selected.slice())}
								>
									<Mail class="size-4" /> Ungelesen
								</Button>
								<Button
									size="sm"
									variant="outline"
									onclick={() => bulk('delete', selected.slice())}
								>
									<Trash2 class="size-4" /> Löschen
								</Button>
							{/if}
							<Button
								size="icon-sm"
								variant="ghost"
								class="ml-auto"
								aria-label="Auswahl aufheben"
								onclick={() => (selected = [])}
							>
								<X class="size-4" />
							</Button>
						</div>
					{:else if isFolderView}
						<Tabs.Root
							value={filter}
							onValueChange={(v) => {
								filter = v === 'unread' ? 'unread' : 'all';
								offset = 0;
							}}
						>
							<Tabs.List aria-label="Filter">
								<Tabs.Trigger value="all">Alle</Tabs.Trigger>
								<Tabs.Trigger value="unread">Ungelesen</Tabs.Trigger>
							</Tabs.List>
						</Tabs.Root>
					{/if}

					<ContextMenu.Root bind:open={ctxOpen} onOpenChange={onCtxOpenChange}>
						<ContextMenu.Trigger oncontextmenu={onCtxMenu} onpointerdown={onCtxPointerDown}>
							{#snippet child({ props })}
								<div {...props} class="[-webkit-touch-callout:none]">
									<DataTable
										mobile="cards"
										caption={current
											? `${showSent ? 'Gesendet von' : 'Nachrichten in'} ${current.name}${currentFolder ? ` › ${currentFolder.name}` : ''}`
											: 'Nachrichten'}
										{loading}
										error={listError}
										onretry={() => void refresh()}
										empty={showSent ? sentItems.length === 0 : items.length === 0}
										{emptyTitle}
									>
										{#snippet head()}
											{#if showSent}
												<Table.Row>
													<Table.Head>An</Table.Head>
													<Table.Head>Betreff</Table.Head>
													<Table.Head>Von</Table.Head>
													<Table.Head class="text-right">Gesendet</Table.Head>
													<Table.Head>Status</Table.Head>
												</Table.Row>
											{:else}
												<Table.Row>
													<Table.Head class="w-8">
														<Checkbox
															checked={allSelected}
															indeterminate={selected.length > 0 && !allSelected}
															onCheckedChange={(v) => setAll(v === true)}
															aria-label="Alle auf dieser Seite auswählen"
														/>
													</Table.Head>
													<Table.Head>Von</Table.Head>
													<Table.Head>Betreff</Table.Head>
													<Table.Head class="text-right">Eingang</Table.Head>
												</Table.Row>
											{/if}
										{/snippet}
										{#each sentItems as s (s.id)}
											{@const href = `${BASE}/${s.id}?mailbox=${encodeURIComponent(mailbox ?? '')}`}
											<Table.Row class="cursor-pointer" onclick={() => goto(href)}>
												<Table.Cell class="max-w-56">
													<span class="block truncate" title={s.to}>{s.to || '–'}</span>
													{#if s.recipients > 1}
														<span class="text-xs text-muted-foreground">
															und {s.recipients - 1} weitere
														</span>
													{/if}
												</Table.Cell>
												<Table.Cell class="max-w-[28rem]">
													<div class="min-w-0 text-left">
														<a
															class="block truncate hover:underline"
															{href}
															onclick={(e) => e.stopPropagation()}
														>
															{s.subject}
														</a>
														{#if s.attachmentCount}
															<Paperclip
																class="inline size-3 text-muted-foreground"
																aria-label={`${s.attachmentCount} Anhänge`}
															/>
														{/if}
													</div>
												</Table.Cell>
												<Table.Cell class="max-w-40"
													><span class="block truncate">{s.createdByName}</span></Table.Cell
												>
												<Table.Cell class="text-right whitespace-nowrap tabular-nums">
													{formatDateTime(s.createdAt)}
												</Table.Cell>
												<Table.Cell>
													<Badge variant={statusVariant(s.status)}
														>{MESSAGE_STATUS_LABELS[s.status]}</Badge
													>
												</Table.Cell>
											</Table.Row>
										{/each}
										{#each items as m (m.id)}
											{@const isSelected = selectedSet.has(m.id)}
											<Table.Row
												class={cn(
													'cursor-pointer',
													!m.read && 'bg-info-muted/40',
													isSelected && 'bg-muted'
												)}
												data-mail-id={m.id}
												data-state={isSelected ? 'selected' : undefined}
												draggable={canSort && !isCoarse ? 'true' : undefined}
												ondragstart={(e) => onRowDragStart(e, m)}
												ondragend={onRowDragEnd}
												onclick={() => open(m.id)}
											>
												<Table.Cell class="w-8">
													<!-- Klick auf die Checkbox öffnet die Nachricht nicht -->
													<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
													<div class="flex" onclick={(e) => e.stopPropagation()}>
														<Checkbox
															checked={isSelected}
															onCheckedChange={(v) => setSelected(m.id, v === true)}
															aria-label={`${m.subject || 'Nachricht'} auswählen`}
														/>
													</div>
												</Table.Cell>
												<Table.Cell class={cn('max-w-56', !m.read && 'font-semibold')}>
													<span class="block truncate" title={m.from.address}>
														{m.from.name ?? m.from.address}
													</span>
												</Table.Cell>
												<Table.Cell class="max-w-[32rem]">
													<!-- ein Element: in der mobilen Kartenansicht bleibt Betreff über dem Auszug -->
													<div class="min-w-0 text-left">
														<a
															class={cn(
																'block truncate hover:underline',
																!m.read && 'font-semibold'
															)}
															href={`${BASE}/inbox/${m.id}`}
															draggable="false"
															onclick={(e) => e.stopPropagation()}
														>
															{#if !m.read}<span class="sr-only">Ungelesen: </span>{/if}
															{m.subject || '(kein Betreff)'}
														</a>
														<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
															{#if m.answered}
																<Reply class="size-3 shrink-0" aria-label="Beantwortet" />
															{/if}
															{#if m.attachmentCount}
																<Paperclip
																	class="size-3 shrink-0"
																	aria-label={`${m.attachmentCount} Anhänge`}
																/>
															{/if}
															{#if m.spam}<Badge variant="warning">Spam</Badge>{/if}
															{#if view === 'trash' && m.folderId && current}
																<span class="inline-flex shrink-0 items-center gap-0.5">
																	<Folder class="size-3" aria-hidden="true" />
																	{folderName(current, m.folderId)}
																</span>
															{/if}
															<span class="truncate">{m.snippet}</span>
														</span>
													</div>
												</Table.Cell>
												<Table.Cell class="text-right whitespace-nowrap tabular-nums">
													{formatDateTime(m.receivedAt)}
												</Table.Cell>
											</Table.Row>
										{/each}
										{#snippet footer()}
											{#if total > PAGE_SIZE}
												<div class="flex items-center justify-between gap-2 text-sm">
													<span class="text-muted-foreground tabular-nums">
														{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} von {total}
													</span>
													<span class="flex gap-2">
														<Button
															size="sm"
															variant="outline"
															disabled={offset === 0}
															onclick={() => (offset = Math.max(0, offset - PAGE_SIZE))}
															>Zurück</Button
														>
														<Button
															size="sm"
															variant="outline"
															disabled={offset + PAGE_SIZE >= total}
															onclick={() => (offset += PAGE_SIZE)}>Weiter</Button
														>
													</span>
												</div>
											{/if}
										{/snippet}
									</DataTable>
								</div>
							{/snippet}
						</ContextMenu.Trigger>
						<ContextMenu.Content class="w-56">
							{#if ctxTitle}
								<ContextMenu.Label>{ctxTitle}</ContextMenu.Label>
								<ContextMenu.Separator />
							{/if}
							{#each ctxEntries as entry (entry.key)}
								{@const Icon = entry.icon}
								{#if entry.separator}<ContextMenu.Separator />{/if}
								<ContextMenu.Item
									variant={entry.destructive ? 'destructive' : 'default'}
									onclick={entry.run}
								>
									<Icon />
									{entry.label}
								</ContextMenu.Item>
							{/each}
						</ContextMenu.Content>
					</ContextMenu.Root>
					{#if canSort && !isCoarse && items.length && !selected.length}
						<p class="text-xs text-muted-foreground">
							Tipp: Nachrichten auf einen Ordner links ziehen oder mit Rechtsklick verschieben.
						</p>
					{/if}
					{#if boxes.canManage && boxes.lastPoll?.at && boxes.lastPoll.status === 'ok'}
						<p class="text-xs text-muted-foreground">
							Letzter Abruf {formatDateTime(boxes.lastPoll.at)}: {boxes.lastPoll.message}
						</p>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</div>

<FolderDetailsDialog
	bind:open={detailsDialog.open}
	mailbox={detailsDialog.mailbox}
	folderId={detailsDialog.folderId}
/>
<FolderDialog
	bind:open={folderDialog.open}
	mode={folderDialog.mode}
	mailbox={folderDialog.box}
	parentId={folderDialog.parentId}
	folder={folderDialog.folder}
	onsaved={() => void refresh()}
/>
<MoveToFolderDialog
	bind:open={moveDialog.open}
	mailbox={moveDialog.box}
	title={moveDialog.folder ? `„${moveDialog.folder.name}“ verschieben` : 'Verschieben nach'}
	description={moveDialog.folder
		? 'Ziel innerhalb des Postfachs wählen.'
		: `${nachrichten(moveDialog.ids.length)} in einen Ordner von „${moveDialog.box?.name ?? ''}“ verschieben.`}
	current={moveDialog.current}
	movingFolderId={moveDialog.folder?.id ?? null}
	onpick={onMovePick}
/>
<ConfirmDialog
	bind:open={deleteDialog.open}
	title={`„${deleteDialog.folder?.name ?? ''}“ löschen?`}
	description={deleteDialog.description}
	confirmLabel="Ordner löschen"
	destructive
	onconfirm={deleteFolder}
/>
