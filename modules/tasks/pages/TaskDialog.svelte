<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch, ApiClientError } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { SelectField } from '$lib/components/ui/select-field';
	import {
		BUSY_SAVE,
		ConfirmDialog,
		FormField,
		LoadingState,
		ErrorState
	} from '$lib/components/layout';
	import {
		MAX_CHECKLIST_TITLE,
		MAX_TASK_DESCRIPTION,
		MAX_TASK_TITLE,
		MAX_TASKS_PER_BOARD,
		PRIORITIES,
		PRIORITY_LABELS,
		taskInput,
		type ChecklistItem,
		type Column,
		type TaskDetail,
		type UserRef
	} from '../schemas';
	import { BASE, dueClass, dueLabel, errMsg } from './helpers';

	let {
		open = $bindable(false),
		taskId = null,
		boardId,
		columns,
		defaultColumnId = null,
		canEditBoard,
		onchanged
	}: {
		open?: boolean;
		/** `null` = neue Aufgabe */
		taskId?: string | null;
		boardId: string;
		columns: Column[];
		defaultColumnId?: string | null;
		canEditBoard: boolean;
		/** Board neu laden (nach jeder Änderung) */
		onchanged: () => void;
	} = $props();

	const priorityOptions = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));
	const columnOptions = $derived(columns.map((c) => ({ value: c.id, label: c.name })));

	let detail = $state<TaskDetail | null>(null);
	let loading = $state(false);
	let loadError = $state('');
	let people = $state<UserRef[]>([]);

	// Entwurf der Hauptfelder
	let title = $state('');
	let description = $state('');
	let priority = $state<string | null>('medium');
	let dueOn = $state('');
	let assigneeIds = $state<string[]>([]);
	let columnId = $state<string | null>(null);
	/** Unteraufgaben beim Anlegen (lokal) */
	let draftItems = $state<{ key: string; title: string }[]>([]);
	let newItem = $state('');
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);
	let deleteOpen = $state(false);

	const creating = $derived(!taskId);
	const canEdit = $derived(creating ? canEditBoard : (detail?.canEdit ?? false));
	const canMove = $derived(creating ? canEditBoard : (detail?.canMove ?? false));
	const peopleOptions = $derived.by(() => {
		const map = new Map<string, UserRef>();
		for (const p of people) map.set(p.id, p);
		for (const a of detail?.assignees ?? []) map.set(a.id, a);
		for (const i of detail?.items ?? []) if (i.assignee) map.set(i.assignee.id, i.assignee);
		return [...map.values()]
			.sort((a, b) => a.name.localeCompare(b.name, 'de'))
			.map((p) => ({ value: p.id, label: p.name }));
	});
	const dirty = $derived(
		!!detail &&
			(title !== detail.title ||
				description !== (detail.description ?? '') ||
				priority !== detail.priority ||
				dueOn !== (detail.dueOn ?? '') ||
				assigneeIds.join(',') !== detail.assignees.map((a) => a.id).join(','))
	);

	function fill(d: TaskDetail) {
		detail = d;
		title = d.title;
		description = d.description ?? '';
		priority = d.priority;
		dueOn = d.dueOn ?? '';
		assigneeIds = d.assignees.map((a) => a.id);
		columnId = d.columnId;
	}

	$effect(() => {
		if (!open) return;
		const id = taskId;
		untrack(() => {
			errors = {};
			newItem = '';
			draftItems = [];
			detail = null;
			loadError = '';
			if (id) void load(id);
			else {
				title = '';
				description = '';
				priority = 'medium';
				dueOn = '';
				assigneeIds = [];
				columnId = defaultColumnId ?? columns[0]?.id ?? null;
				void tick().then(() => document.getElementById('task-title')?.focus());
			}
			if (canEditBoard) void loadPeople();
		});
	});

	async function load(id: string) {
		loading = true;
		try {
			fill(await apiFetch<TaskDetail>(`${BASE}/tasks/${id}`));
		} catch (e) {
			loadError = errMsg(e, 'Aufgabe konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	async function loadPeople() {
		try {
			people = await apiFetch<UserRef[]>(`${BASE}/boards/${boardId}/people`);
		} catch {
			people = [];
		}
	}

	function fieldErrors(e: unknown) {
		if (e instanceof ApiClientError && Array.isArray(e.details)) {
			errors = Object.fromEntries(
				(e.details as { path?: (string | number)[]; message: string }[]).map((d) => [
					String(d.path?.[0] ?? ''),
					d.message
				])
			);
		}
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (creating) await create();
		else await saveMain();
	}

	async function create() {
		const parsed = taskInput.safeParse({
			columnId: columnId ?? undefined,
			title,
			description,
			priority: priority ?? 'medium',
			dueOn: dueOn || null,
			assigneeIds,
			checklist: draftItems.map((i) => ({ title: i.title }))
		});
		if (!parsed.success) {
			errors = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
			return;
		}
		busy = true;
		try {
			await apiFetch(`${BASE}/boards/${boardId}/tasks`, {
				method: 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success('Aufgabe angelegt');
			open = false;
			onchanged();
		} catch (err) {
			fieldErrors(err);
			toast.error(errMsg(err, 'Anlegen fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function saveMain() {
		if (!detail) return;
		if (!title.trim()) {
			errors = { title: 'Pflichtfeld' };
			return;
		}
		busy = true;
		try {
			fill(
				await apiFetch<TaskDetail>(`${BASE}/tasks/${detail.id}`, {
					method: 'PATCH',
					body: JSON.stringify({
						title,
						description,
						priority,
						dueOn: dueOn || null,
						assigneeIds
					})
				})
			);
			errors = {};
			toast.success('Gespeichert');
			onchanged();
		} catch (err) {
			fieldErrors(err);
			toast.error(errMsg(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	/** Sofort-Aktionen (Spalte, Unteraufgaben) */
	async function run(path: string, init: Parameters<typeof apiFetch>[1], fallback: string) {
		try {
			fill(await apiFetch<TaskDetail>(`${BASE}${path}`, init));
			onchanged();
		} catch (err) {
			toast.error(errMsg(err, fallback));
			if (detail) await load(detail.id);
		}
	}

	async function moveTo(next: string | null) {
		if (creating) {
			columnId = next;
			return;
		}
		if (!detail || !next || next === detail.columnId) return;
		await run(
			`/tasks/${detail.id}/move`,
			{ method: 'POST', body: JSON.stringify({ columnId: next, position: MAX_TASKS_PER_BOARD }) },
			'Verschieben fehlgeschlagen'
		);
	}

	async function addItem() {
		const value = newItem.trim();
		if (!value) return;
		newItem = '';
		if (creating) {
			draftItems = [...draftItems, { key: crypto.randomUUID(), title: value }];
			return;
		}
		if (!detail) return;
		await run(
			`/tasks/${detail.id}/checklist`,
			{ method: 'POST', body: JSON.stringify({ title: value }) },
			'Hinzufügen fehlgeschlagen'
		);
	}

	async function patchItem(item: ChecklistItem, body: Record<string, unknown>) {
		if (!detail) return;
		await run(
			`/tasks/${detail.id}/checklist/${item.id}`,
			{ method: 'PATCH', body: JSON.stringify(body) },
			'Speichern fehlgeschlagen'
		);
	}

	async function removeItem(item: ChecklistItem) {
		if (!detail) return;
		await run(
			`/tasks/${detail.id}/checklist/${item.id}`,
			{ method: 'DELETE' },
			'Löschen fehlgeschlagen'
		);
	}

	function renameItem(item: ChecklistItem, value: string) {
		const v = value.trim();
		if (v && v !== item.title) void patchItem(item, { title: v });
	}

	async function deleteTask() {
		if (!detail) return;
		try {
			await apiFetch(`${BASE}/tasks/${detail.id}`, { method: 'DELETE' });
			toast.success('Aufgabe gelöscht');
			open = false;
			onchanged();
		} catch (err) {
			toast.error(errMsg(err, 'Löschen fehlgeschlagen'));
		}
	}

	const doneColumn = $derived(columns.find((c) => c.id === detail?.columnId)?.isDone ?? false);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
		<Dialog.Header class="border-b px-6 pt-6 pb-4">
			<Dialog.Title
				>{creating ? 'Neue Aufgabe' : canEdit ? 'Aufgabe bearbeiten' : 'Aufgabe'}</Dialog.Title
			>
			<Dialog.Description class="sr-only">
				Titel, Beschreibung, Priorität, Fälligkeit, Zuständige und Unteraufgaben
			</Dialog.Description>
		</Dialog.Header>

		{#if loading}
			<div class="p-6"><LoadingState label="Aufgabe" rows={4} /></div>
		{:else if loadError}
			<div class="p-6">
				<ErrorState
					message={loadError}
					onretry={() => (taskId ? load(taskId) : undefined)}
					compact
				/>
			</div>
		{:else}
			<form
				id="task-form"
				class="flex-1 space-y-5 overflow-y-auto px-6 py-5"
				onsubmit={submit}
				novalidate
			>
				<fieldset class="space-y-4" disabled={!canEdit}>
					<legend class="sr-only">Aufgabe</legend>
					<FormField label="Titel" id="task-title" required error={errors.title}>
						<Input
							id="task-title"
							bind:value={title}
							maxlength={MAX_TASK_TITLE}
							autocomplete="off"
						/>
					</FormField>
					<FormField label="Beschreibung" id="task-description" error={errors.description}>
						<Textarea
							id="task-description"
							bind:value={description}
							rows={4}
							maxlength={MAX_TASK_DESCRIPTION}
							placeholder={canEdit ? 'Details, Links, Absprachen …' : ''}
						/>
					</FormField>
					<div class="grid gap-4 sm:grid-cols-2">
						<FormField label="Priorität" id="task-priority" error={errors.priority}>
							<SelectField
								id="task-priority"
								label="Priorität"
								options={priorityOptions}
								bind:value={priority}
								disabled={!canEdit}
							/>
						</FormField>
						<FormField label="Fällig am" id="task-due" error={errors.dueOn}>
							<Input id="task-due" type="date" bind:value={dueOn} />
						</FormField>
					</div>
					<FormField
						label="Zuständig"
						id="task-assignees"
						error={errors.assigneeIds}
						hint={canEdit
							? 'Personen mit Zugriff auf das Board. Weitere über „Teilen“ hinzufügen.'
							: undefined}
					>
						<MultiSelect
							id="task-assignees"
							label="Zuständig"
							options={peopleOptions}
							bind:value={assigneeIds}
							placeholder="Niemand"
							searchPlaceholder="Person suchen …"
							emptyText="Niemand gefunden"
							disabled={!canEdit}
						/>
					</FormField>
				</fieldset>

				<FormField label="Spalte" id="task-column">
					<SelectField
						id="task-column"
						label="Spalte"
						options={columnOptions}
						value={creating ? columnId : (detail?.columnId ?? null)}
						onchange={moveTo}
						disabled={!canMove}
					/>
				</FormField>

				<section class="space-y-2" aria-labelledby="checklist-title">
					<div class="flex items-baseline justify-between">
						<h3 id="checklist-title" class="text-sm font-medium">Unteraufgaben</h3>
						{#if detail && detail.checklist.total}
							<span class="text-xs text-muted-foreground tabular-nums">
								{detail.checklist.done} von {detail.checklist.total} erledigt
							</span>
						{/if}
					</div>
					<ul
						class="divide-y rounded-md border"
						class:hidden={creating ? !draftItems.length : !detail?.items.length}
					>
						{#if creating}
							{#each draftItems as item (item.key)}
								<li class="flex items-center gap-2 px-3 py-2">
									<span class="min-w-0 flex-1 truncate text-sm">{item.title}</span>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										aria-label={`„${item.title}“ entfernen`}
										onclick={() => (draftItems = draftItems.filter((d) => d.key !== item.key))}
									>
										<X />
									</Button>
								</li>
							{/each}
						{:else}
							{#each detail?.items ?? [] as item (item.id)}
								<li class="flex flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap">
									<Checkbox
										checked={item.done}
										disabled={!canMove}
										aria-label={`„${item.title}“ erledigt`}
										onCheckedChange={(v) => patchItem(item, { done: v === true })}
									/>
									{#if canEdit}
										<Input
											class={`h-8 min-w-0 flex-1 border-transparent shadow-none hover:border-input ${item.done ? 'text-muted-foreground line-through' : ''}`}
											value={item.title}
											maxlength={MAX_CHECKLIST_TITLE}
											aria-label="Titel der Unteraufgabe"
											onblur={(e) => renameItem(item, e.currentTarget.value)}
											onkeydown={(e) => {
												if (e.key === 'Enter') {
													e.preventDefault();
													e.currentTarget.blur();
												}
											}}
										/>
									{:else}
										<span
											class="min-w-0 flex-1 text-sm"
											class:line-through={item.done}
											class:text-muted-foreground={item.done}>{item.title}</span
										>
									{/if}
									<div
										class="flex w-full flex-wrap items-center gap-2 pl-6 sm:w-auto sm:flex-nowrap sm:pl-0"
									>
										{#if canEdit}
											<SelectField
												size="sm"
												class="w-full sm:w-40"
												label={`Zuständig für „${item.title}“`}
												options={peopleOptions}
												value={item.assignee?.id ?? null}
												emptyLabel="Niemand"
												placeholder="Niemand"
												onchange={(v) => patchItem(item, { assigneeId: v })}
											/>
											<Input
												type="date"
												class="h-8 min-w-0 flex-1 sm:w-36 sm:flex-none"
												aria-label={`Fällig am (${item.title})`}
												value={item.dueOn ?? ''}
												onchange={(e) => patchItem(item, { dueOn: e.currentTarget.value || null })}
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												aria-label={`„${item.title}“ löschen`}
												onclick={() => removeItem(item)}
											>
												<Trash2 />
											</Button>
										{:else}
											{#if item.assignee}
												<span class="text-xs text-muted-foreground">{item.assignee.name}</span>
											{/if}
											{#if item.dueOn}
												<span class={`text-xs ${dueClass(item.dueOn, item.done)}`}>
													{dueLabel(item.dueOn, item.done)}
												</span>
											{/if}
										{/if}
									</div>
								</li>
							{/each}
						{/if}
					</ul>
					{#if canEdit}
						<div class="flex gap-2">
							<Input
								bind:value={newItem}
								maxlength={MAX_CHECKLIST_TITLE}
								placeholder="Unteraufgabe hinzufügen …"
								aria-label="Neue Unteraufgabe"
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										void addItem();
									}
								}}
							/>
							<Button type="button" variant="outline" onclick={addItem} disabled={!newItem.trim()}>
								<Plus /> Hinzufügen
							</Button>
						</div>
					{/if}
				</section>

				{#if detail}
					<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<CalendarClock class="size-3.5" aria-hidden="true" />
						Angelegt {detail.createdBy ? `von ${detail.createdBy.name} ` : ''}am
						{new Date(detail.createdAt).toLocaleDateString('de-DE')}
						{#if doneColumn && detail.completedAt}
							· erledigt am {new Date(detail.completedAt).toLocaleDateString('de-DE')}
						{/if}
					</p>
				{/if}
			</form>
		{/if}

		<Dialog.Footer class="mx-0 mb-0 border-t px-6 py-4">
			{#if detail && canEdit}
				<Button
					type="button"
					variant="ghost"
					class="mr-auto text-destructive"
					onclick={() => (deleteOpen = true)}
				>
					<Trash2 /> Löschen
				</Button>
			{/if}
			<Button type="button" variant="outline" onclick={() => (open = false)}>
				{canEdit && (creating || dirty) ? 'Abbrechen' : 'Schließen'}
			</Button>
			{#if canEdit && !loadError}
				<Button type="submit" form="task-form" disabled={busy || (!creating && !dirty)}>
					{busy ? BUSY_SAVE : creating ? 'Anlegen' : 'Speichern'}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Aufgabe löschen?"
	description="Die Aufgabe und ihre Unteraufgaben werden endgültig gelöscht."
	confirmLabel="Löschen"
	destructive
	onconfirm={deleteTask}
/>
