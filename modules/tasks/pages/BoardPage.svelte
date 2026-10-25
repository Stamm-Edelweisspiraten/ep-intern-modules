<script lang="ts">
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Tent from '@lucide/svelte/icons/tent';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import type { PrincipalInfo } from '$lib/sdk/types/sharing';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import { Label } from '$lib/components/ui/label';
	import {
		ConfirmDialog,
		EmptyState,
		ErrorState,
		FormField,
		LoadingState,
		PageHeader,
		PageTitle,
		ShareMenu,
		type ShareCandidate,
		type ShareEntry
	} from '$lib/components/layout';
	import { shareKey } from '$lib/components/layout/share-types';
	import {
		MAX_COLUMN_NAME,
		PRIORITIES,
		PRIORITY_LABELS,
		SHARE_LEVELS,
		SHARE_LEVEL_LABELS,
		type BoardDetail,
		type BoardShares,
		type Column,
		type TaskCard
	} from '../schemas';
	import BoardDialog from './BoardDialog.svelte';
	import TaskCardView from './TaskCardView.svelte';
	import TaskDialog from './TaskDialog.svelte';
	import { BASE, errMsg } from './helpers';

	let { params }: ModulePageProps = $props();
	const id = $derived(params.id ?? '');
	const myId = $derived((page.data.user as { id?: string } | null | undefined)?.id ?? null);

	let board = $state<BoardDetail | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let notFound = $state(false);
	let shares = $state<BoardShares | null>(null);

	// Filter (lokal)
	let search = $state('');
	let onlyMine = $state(false);
	let priorityFilter = $state<string | null>(null);

	// Dialoge
	let taskOpen = $state(false);
	let taskId = $state<string | null>(null);
	let newTaskColumn = $state<string | null>(null);
	let editOpen = $state(false);
	let deleteOpen = $state(false);
	let columnOpen = $state(false);
	let columnEdit = $state<Column | null>(null);
	let columnName = $state('');
	let columnError = $state('');
	let columnDelete = $state<Column | null>(null);
	let columnMoveTo = $state<string | null>(null);
	let quickAdd = $state<Record<string, string>>({});

	const canEdit = $derived(board?.access.level === 'edit');
	const shareLevels = SHARE_LEVELS.map((l) => ({ value: l, label: SHARE_LEVEL_LABELS[l] }));
	const priorityOptions = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));

	async function load() {
		try {
			board = await apiFetch<BoardDetail>(`${BASE}/boards/${id}`);
			notFound = false;
			loadError = '';
		} catch (e) {
			if ((e as { status?: number }).status === 404) notFound = true;
			else loadError = errMsg(e, 'Board konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	async function loadShares() {
		try {
			shares = await apiFetch<BoardShares>(`${BASE}/boards/${id}/shares`);
		} catch {
			shares = null;
		}
	}

	$effect(() => {
		void id;
		untrack(() => {
			loading = true;
			void load();
			void loadShares();
			// Deep-Link `?task=<id>` (Benachrichtigung, Suche) öffnet die Aufgabe
			const fromUrl = page.url.searchParams.get('task');
			if (fromUrl) {
				openTask(fromUrl);
				const url = new URL(page.url);
				url.searchParams.delete('task');
				replaceState(url, page.state);
			}
		});
	});

	// --- Filter und Spalten ----------------------------------------------------

	function matches(t: TaskCard): boolean {
		// „Nur meine“: direkt zugewiesen; bei Lesezugriff zeigt `canMove` auch Unteraufgaben-Zuweisungen
		const mine = t.assignees.some((a) => a.id === myId) || (!canEdit && t.canMove);
		if (onlyMine && !mine) return false;
		if (priorityFilter && t.priority !== priorityFilter) return false;
		const q = search.trim().toLowerCase();
		return !q || t.title.toLowerCase().includes(q);
	}

	const filtering = $derived(!!(search.trim() || onlyMine || priorityFilter));

	function tasksOf(columnId: string): TaskCard[] {
		return (board?.tasks ?? [])
			.filter((t) => t.columnId === columnId && matches(t))
			.sort((a, b) => a.position - b.position);
	}

	function countOf(columnId: string): number {
		return (board?.tasks ?? []).filter((t) => t.columnId === columnId).length;
	}

	// --- Ziehen und Ablegen ----------------------------------------------------

	let dragId = $state<string | null>(null);
	let dropTarget = $state<{ columnId: string; index: number } | null>(null);

	function onDragStart(e: DragEvent, task: TaskCard) {
		dragId = task.id;
		e.dataTransfer?.setData('text/plain', task.id);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}

	function onDragEnd() {
		dragId = null;
		dropTarget = null;
	}

	/** Einfügeposition aus der Mausposition über den Karten der Spalte */
	function indexAt(e: DragEvent, list: HTMLElement): number {
		const cards = [...list.querySelectorAll<HTMLElement>('[data-task-id]')].filter(
			(el) => el.dataset.taskId !== dragId
		);
		for (let i = 0; i < cards.length; i++) {
			const r = cards[i]!.getBoundingClientRect();
			if (e.clientY < r.top + r.height / 2) return i;
		}
		return cards.length;
	}

	function onDragOver(e: DragEvent, columnId: string) {
		if (!dragId) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropTarget = { columnId, index: indexAt(e, e.currentTarget as HTMLElement) };
	}

	async function onDrop(e: DragEvent, columnId: string) {
		e.preventDefault();
		const moved = dragId ?? e.dataTransfer?.getData('text/plain') ?? null;
		// `dragleave` kann das Ziel kurz vor dem Ablegen gelöscht haben → Position direkt bestimmen
		const index = indexAt(e, e.currentTarget as HTMLElement);
		onDragEnd();
		if (!moved || !board || !board.tasks.some((t) => t.id === moved && t.canMove)) return;
		// sichtbare Reihenfolge → Position in der vollständigen Spalte
		const visible = tasksOf(columnId).filter((t) => t.id !== moved);
		const all = board.tasks
			.filter((t) => t.columnId === columnId && t.id !== moved)
			.sort((a, b) => a.position - b.position);
		const anchor = visible[index];
		const position = anchor ? all.findIndex((t) => t.id === anchor.id) : all.length;
		await moveTask(moved, columnId, position);
	}

	async function moveTask(taskIdToMove: string, columnId: string, position: number) {
		if (!board) return;
		// sofort anzeigen, danach mit dem Server abgleichen
		const done = board.columns.find((c) => c.id === columnId)?.isDone ?? false;
		const others = board.tasks
			.filter((t) => t.columnId === columnId && t.id !== taskIdToMove)
			.sort((a, b) => a.position - b.position);
		const task = board.tasks.find((t) => t.id === taskIdToMove);
		if (!task) return;
		others.splice(Math.min(position, others.length), 0, task);
		const order = new Map(others.map((t, i) => [t.id, i]));
		board.tasks = board.tasks.map((t) =>
			t.id === taskIdToMove
				? {
						...t,
						columnId,
						position: order.get(t.id)!,
						completedAt: done ? (t.completedAt ?? new Date().toISOString()) : null
					}
				: order.has(t.id)
					? { ...t, position: order.get(t.id)! }
					: t
		);
		try {
			await apiFetch(`${BASE}/tasks/${taskIdToMove}/move`, {
				method: 'POST',
				body: JSON.stringify({ columnId, position })
			});
		} catch (e) {
			toast.error(errMsg(e, 'Verschieben fehlgeschlagen'));
		}
		await load();
	}

	/** Tastatur/Mobil: in die Nachbarspalte schieben */
	async function shift(task: TaskCard, dir: -1 | 1) {
		if (!board) return;
		const idx = board.columns.findIndex((c) => c.id === task.columnId);
		const next = board.columns[idx + dir];
		if (next) await moveTask(task.id, next.id, countOf(next.id));
	}

	// --- Aufgaben --------------------------------------------------------------

	function openTask(tid: string) {
		taskId = tid;
		newTaskColumn = null;
		taskOpen = true;
	}

	function newTask(columnId: string | null) {
		taskId = null;
		newTaskColumn = columnId;
		taskOpen = true;
	}

	async function addQuick(columnId: string) {
		const title = (quickAdd[columnId] ?? '').trim();
		if (!title) return;
		quickAdd[columnId] = '';
		try {
			await apiFetch(`${BASE}/boards/${id}/tasks`, {
				method: 'POST',
				body: JSON.stringify({ columnId, title })
			});
			await load();
		} catch (e) {
			quickAdd[columnId] = title;
			toast.error(errMsg(e, 'Anlegen fehlgeschlagen'));
		}
	}

	// --- Spalten ---------------------------------------------------------------

	function openColumn(col: Column | null) {
		columnEdit = col;
		columnName = col?.name ?? '';
		columnError = '';
		columnOpen = true;
	}

	async function saveColumn(e: SubmitEvent) {
		e.preventDefault();
		const name = columnName.trim();
		if (!name) {
			columnError = 'Pflichtfeld';
			return;
		}
		try {
			board = await apiFetch<BoardDetail>(
				columnEdit
					? `${BASE}/boards/${id}/columns/${columnEdit.id}`
					: `${BASE}/boards/${id}/columns`,
				{ method: columnEdit ? 'PATCH' : 'POST', body: JSON.stringify({ name }) }
			);
			columnOpen = false;
		} catch (err) {
			columnError = errMsg(err, 'Speichern fehlgeschlagen');
		}
	}

	async function columnAction(
		path: string,
		init: Parameters<typeof apiFetch>[1],
		fallback: string
	) {
		try {
			board = await apiFetch<BoardDetail>(`${BASE}/boards/${id}${path}`, init);
		} catch (e) {
			toast.error(errMsg(e, fallback));
		}
	}

	function markDone(col: Column) {
		void columnAction(
			`/columns/${col.id}`,
			{ method: 'PATCH', body: JSON.stringify({ isDone: !col.isDone }) },
			'Speichern fehlgeschlagen'
		);
	}

	function moveColumn(col: Column, dir: -1 | 1) {
		if (!board) return;
		const ids = board.columns.map((c) => c.id);
		const i = ids.indexOf(col.id);
		const j = i + dir;
		if (j < 0 || j >= ids.length) return;
		[ids[i], ids[j]] = [ids[j]!, ids[i]!];
		void columnAction(
			'/columns/order',
			{ method: 'PUT', body: JSON.stringify({ ids }) },
			'Umsortieren fehlgeschlagen'
		);
	}

	function askDeleteColumn(col: Column) {
		columnDelete = col;
		columnMoveTo = board?.columns.find((c) => c.id !== col.id)?.id ?? null;
	}

	async function deleteColumn() {
		const col = columnDelete;
		if (!col) return;
		const hasTasks = countOf(col.id) > 0;
		await columnAction(
			`/columns/${col.id}${hasTasks && columnMoveTo ? `?moveTo=${columnMoveTo}` : ''}`,
			{ method: 'DELETE' },
			'Löschen fehlgeschlagen'
		);
		columnDelete = null;
	}

	// --- Board -----------------------------------------------------------------

	async function deleteBoard() {
		try {
			await apiFetch(`${BASE}/boards/${id}`, { method: 'DELETE' });
			toast.success('Board gelöscht');
			await goto(BASE);
		} catch (e) {
			toast.error(errMsg(e, 'Löschen fehlgeschlagen'));
		}
	}

	// --- Freigaben -------------------------------------------------------------

	async function searchPrincipals(q: string): Promise<ShareCandidate[]> {
		const found = await apiFetch<PrincipalInfo[]>(
			`${BASE}/principals?search=${encodeURIComponent(q)}`
		);
		return found
			.filter((p) => !(p.type === 'user' && p.id === board?.owner.id))
			.map((p) => ({
				id: p.id,
				type: p.type,
				name: p.name,
				detail: p.detail ?? null,
				color: p.color ?? null,
				image: p.image ?? null
			}));
	}

	async function saveShares(next: ShareEntry[]) {
		try {
			shares = await apiFetch<BoardShares>(`${BASE}/boards/${id}/shares`, {
				method: 'PUT',
				body: JSON.stringify({
					shares: next.map((s) => ({ type: s.type ?? 'user', id: s.userId, level: s.level }))
				})
			});
		} catch (e) {
			throw new Error(errMsg(e, 'Freigabe fehlgeschlagen'), { cause: e });
		}
	}

	async function addShare(c: ShareCandidate, level: string) {
		const current = shares?.shares ?? [];
		const entry: ShareEntry = {
			userId: c.id,
			type: c.type ?? 'user',
			name: c.name,
			detail: c.detail ?? null,
			color: c.color ?? null,
			image: c.image ?? null,
			level
		};
		if (current.some((s) => shareKey(s) === shareKey(entry))) return;
		await saveShares([...current, entry]);
	}
</script>

<PageTitle title={board?.name ?? 'Board'} />

<nav aria-label="Navigation" class="mb-2">
	<a
		href={BASE}
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" aria-hidden="true" /> Alle Boards
	</a>
</nav>

{#if loading && !board}
	<LoadingState label="Board" rows={1} rowClass="h-96 w-full" />
{:else if notFound}
	<EmptyState
		title="Board nicht gefunden"
		description="Das Board existiert nicht oder du hast keinen Zugriff darauf."
	>
		<Button href={BASE} variant="outline"><ArrowLeft /> Zurück zu den Boards</Button>
	</EmptyState>
{:else if loadError && !board}
	<ErrorState message={loadError} onretry={load} />
{:else if board}
	<PageHeader title={board.name} description={board.description ?? undefined}>
		{#snippet actions()}
			{#if board?.action}
				<Button variant="outline" href={`/modules/actions/${board.action.id}`}>
					<Tent />
					{board.action.name}
				</Button>
			{/if}
			{#if shares && board}
				<ShareMenu
					shares={shares.shares}
					owner={{
						name: board.access.isOwner ? `${shares.owner.name} (du)` : shares.owner.name,
						image: shares.owner.image
					}}
					levels={shareLevels}
					defaultLevel="edit"
					canManage={shares.canManage}
					search={searchPrincipals}
					onadd={addShare}
					onchange={(key, level) =>
						saveShares(
							(shares?.shares ?? []).map((s) => (shareKey(s) === key ? { ...s, level } : s))
						)}
					onremove={(key) => saveShares((shares?.shares ?? []).filter((s) => shareKey(s) !== key))}
					description={board.action
						? 'Wer das Board sehen oder bearbeiten darf – zusätzlich alle mit Zugriff auf die Aktion.'
						: 'Wer das Board sehen oder bearbeiten darf.'}
					everyoneLabel={shares.everyoneLabel}
					placeholder="Gruppe, Rolle, Person suchen …"
					searchLabel="Freigabe hinzufügen"
					emptyResultText="Niemand gefunden"
				/>
			{/if}
			{#if canEdit}
				<Button onclick={() => newTask(null)}><Plus /> Aufgabe</Button>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="outline" aria-label="Mehr"><Ellipsis /></Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-56">
						<DropdownMenu.Item onclick={() => (editOpen = true)}>
							<Pencil /> Board bearbeiten
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => openColumn(null)}>
							<Plus /> Spalte hinzufügen
						</DropdownMenu.Item>
						{#if board?.access.canShare}
							<DropdownMenu.Separator />
							<DropdownMenu.Item class="text-destructive" onclick={() => (deleteOpen = true)}>
								<Trash2 /> Board löschen
							</DropdownMenu.Item>
						{/if}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="mb-4 flex flex-wrap items-center gap-3">
		<Input
			class="w-full sm:w-64"
			type="search"
			placeholder="Aufgaben filtern …"
			aria-label="Aufgaben filtern"
			bind:value={search}
		/>
		<SelectField
			class="w-full sm:w-44"
			label="Priorität"
			options={priorityOptions}
			bind:value={priorityFilter}
			emptyLabel="Alle Prioritäten"
			placeholder="Alle Prioritäten"
		/>
		{#if myId}
			<div class="flex items-center gap-2">
				<Switch id="only-mine" bind:checked={onlyMine} />
				<Label for="only-mine">Nur meine</Label>
			</div>
		{/if}
		{#if board.access.level === 'read'}
			<Badge variant="secondary"
				>Nur Ansicht{board.tasks.some((t) => t.canMove)
					? ' – eigene Aufgaben verschiebbar'
					: ''}</Badge
			>
		{/if}
	</div>

	<div
		class="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-4 sm:snap-none"
		role="list"
		aria-label="Spalten"
	>
		{#each board.columns as col, ci (col.id)}
			{@const list = tasksOf(col.id)}
			<section
				class="flex w-[85vw] max-w-80 shrink-0 snap-start flex-col rounded-lg border bg-muted/40 sm:w-72"
				role="listitem"
				aria-labelledby={`col-${col.id}`}
			>
				<header class="flex items-center gap-2 px-3 pt-3 pb-2">
					<h2 id={`col-${col.id}`} class="min-w-0 flex-1 truncate text-sm font-semibold">
						{col.name}
					</h2>
					{#if col.isDone}
						<CircleCheck class="size-4 text-success" aria-label="Erledigt-Spalte" />
					{/if}
					<span class="text-xs text-muted-foreground tabular-nums" aria-label="Anzahl">
						{filtering ? `${list.length}/${countOf(col.id)}` : countOf(col.id)}
					</span>
					{#if canEdit}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="icon"
										class="size-7"
										aria-label={`Spalte „${col.name}“`}
									>
										<Ellipsis />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end" class="w-60">
								<DropdownMenu.Item onclick={() => newTask(col.id)}
									><Plus /> Aufgabe hinzufügen</DropdownMenu.Item
								>
								<DropdownMenu.Item onclick={() => openColumn(col)}
									><Pencil /> Umbenennen</DropdownMenu.Item
								>
								<DropdownMenu.Item onclick={() => markDone(col)}>
									<CircleCheck />
									{col.isDone
										? 'Nicht mehr als „erledigt“ werten'
										: 'Als Erledigt-Spalte festlegen'}
								</DropdownMenu.Item>
								<DropdownMenu.Item disabled={ci === 0} onclick={() => moveColumn(col, -1)}>
									<ArrowLeft /> Nach links
								</DropdownMenu.Item>
								<DropdownMenu.Item
									disabled={ci === board.columns.length - 1}
									onclick={() => moveColumn(col, 1)}
								>
									<ArrowRight /> Nach rechts
								</DropdownMenu.Item>
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									class="text-destructive"
									disabled={board.columns.length <= 1}
									onclick={() => askDeleteColumn(col)}
								>
									<Trash2 /> Spalte löschen
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/if}
				</header>

				<ul
					class="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2"
					class:ring-2={dropTarget?.columnId === col.id}
					class:ring-ring={dropTarget?.columnId === col.id}
					class:rounded-md={dropTarget?.columnId === col.id}
					aria-label={`Aufgaben in ${col.name}`}
					ondragover={(e) => onDragOver(e, col.id)}
					ondragleave={(e) => {
						if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
							if (dropTarget?.columnId === col.id) dropTarget = null;
						}
					}}
					ondrop={(e) => onDrop(e, col.id)}
				>
					{#each list as task, ti (task.id)}
						{#if dropTarget?.columnId === col.id && dropTarget.index === ti && dragId !== task.id}
							<li class="h-1 rounded-full bg-primary" aria-hidden="true"></li>
						{/if}
						<li data-task-id={task.id} class:opacity-40={dragId === task.id}>
							<TaskCardView
								{task}
								done={col.isDone}
								canLeft={ci > 0}
								canRight={ci < board.columns.length - 1}
								onopen={() => openTask(task.id)}
								ondragstart={(e) => onDragStart(e, task)}
								ondragend={onDragEnd}
								onshift={(dir) => shift(task, dir)}
							/>
						</li>
					{/each}
					{#if dropTarget?.columnId === col.id && list.some((t) => t.id !== dragId) && dropTarget.index >= list.filter((t) => t.id !== dragId).length}
						<li class="h-1 rounded-full bg-primary" aria-hidden="true"></li>
					{/if}
					{#if !list.length}
						<li class="px-2 py-6 text-center text-xs text-muted-foreground">
							{filtering && countOf(col.id) ? 'Keine Treffer' : 'Keine Aufgaben'}
						</li>
					{/if}
				</ul>

				{#if canEdit}
					<form
						class="px-2 pb-2"
						onsubmit={(e) => {
							e.preventDefault();
							void addQuick(col.id);
						}}
					>
						<Input
							class="h-8 bg-background"
							placeholder="+ Aufgabe hinzufügen"
							aria-label={`Neue Aufgabe in ${col.name}`}
							maxlength={200}
							value={quickAdd[col.id] ?? ''}
							oninput={(e) => (quickAdd[col.id] = e.currentTarget.value)}
						/>
					</form>
				{/if}
			</section>
		{/each}
	</div>

	<TaskDialog
		bind:open={taskOpen}
		{taskId}
		boardId={board.id}
		columns={board.columns}
		defaultColumnId={newTaskColumn}
		canEditBoard={canEdit}
		onchanged={load}
	/>
	<BoardDialog bind:open={editOpen} {board} onsaved={(b) => (board = b)} />
{/if}

<Dialog.Root bind:open={columnOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>{columnEdit ? 'Spalte umbenennen' : 'Neue Spalte'}</Dialog.Title>
			<Dialog.Description class="sr-only">Name der Spalte</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={saveColumn} novalidate>
			<FormField label="Name" id="column-name" required error={columnError}>
				<Input
					id="column-name"
					bind:value={columnName}
					maxlength={MAX_COLUMN_NAME}
					autocomplete="off"
				/>
			</FormField>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (columnOpen = false)}
					>Abbrechen</Button
				>
				<Button type="submit">{columnEdit ? 'Speichern' : 'Anlegen'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={!!columnDelete} onOpenChange={(v) => !v && (columnDelete = null)}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Spalte „{columnDelete?.name}“ löschen?</Dialog.Title>
			<Dialog.Description>
				{columnDelete && countOf(columnDelete.id)
					? `Die ${countOf(columnDelete.id)} Aufgaben der Spalte werden verschoben.`
					: 'Die Spalte ist leer.'}
			</Dialog.Description>
		</Dialog.Header>
		{#if columnDelete && countOf(columnDelete.id) && board}
			<FormField label="Aufgaben verschieben nach" id="column-move-to">
				<SelectField
					id="column-move-to"
					label="Aufgaben verschieben nach"
					options={board.columns
						.filter((c) => c.id !== columnDelete?.id)
						.map((c) => ({ value: c.id, label: c.name }))}
					bind:value={columnMoveTo}
				/>
			</FormField>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (columnDelete = null)}>Abbrechen</Button>
			<Button variant="destructive-solid" onclick={deleteColumn}>Löschen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Board löschen?"
	description="Das Board mit allen Spalten, Aufgaben und Unteraufgaben wird endgültig gelöscht."
	confirmLabel="Löschen"
	destructive
	onconfirm={deleteBoard}
/>
