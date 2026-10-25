<script lang="ts">
	import AlignLeft from '@lucide/svelte/icons/align-left';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import { Badge } from '$lib/components/ui/badge';
	import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from '$lib/components/ui/avatar';
	import type { TaskCard } from '../schemas';
	import { dueClass, dueLabel, initials, priorityLabel, priorityVariant } from './helpers';

	/**
	 * Karte einer Aufgabe im Board. Ganze Karte = Knopf zum Öffnen; ziehbar, wenn verschiebbar.
	 * Tastatur: Alt+←/→ schiebt in die Nachbarspalte (Ziehen geht nur mit der Maus).
	 */
	let {
		task,
		done = false,
		canLeft,
		canRight,
		onopen,
		ondragstart,
		ondragend,
		onshift
	}: {
		task: TaskCard;
		done?: boolean;
		canLeft: boolean;
		canRight: boolean;
		onopen: () => void;
		ondragstart: (e: DragEvent) => void;
		ondragend: () => void;
		onshift: (dir: -1 | 1) => void;
	} = $props();

	const checklistDone = $derived(
		task.checklist.total > 0 && task.checklist.done === task.checklist.total
	);

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onopen();
		} else if (task.canMove && e.altKey && e.key === 'ArrowLeft' && canLeft) {
			e.preventDefault();
			onshift(-1);
		} else if (task.canMove && e.altKey && e.key === 'ArrowRight' && canRight) {
			e.preventDefault();
			onshift(1);
		}
	}
</script>

<div
	role="button"
	tabindex="0"
	draggable={task.canMove}
	class="group block w-full cursor-pointer rounded-md border bg-card p-3 text-left text-sm shadow-xs transition-colors hover:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
	class:cursor-grab={task.canMove}
	aria-label={`${task.title}${task.canMove ? ' – Alt+Pfeil links/rechts verschiebt' : ''}`}
	onclick={onopen}
	{onkeydown}
	{ondragstart}
	{ondragend}
>
	<p class="font-medium break-words" class:line-through={done} class:text-muted-foreground={done}>
		{task.title}
	</p>

	<div class="mt-2 flex flex-wrap items-center gap-1.5">
		{#if task.priority !== 'medium'}
			<Badge variant={priorityVariant(task.priority)} class="px-1.5 py-0 text-xs">
				{priorityLabel(task.priority)}
			</Badge>
		{/if}
		{#if task.dueOn}
			<span class={`text-xs ${dueClass(task.dueOn, done)}`}>{dueLabel(task.dueOn, done)}</span>
		{/if}
		{#if task.hasDescription}
			<AlignLeft class="size-3.5 text-muted-foreground" aria-label="Mit Beschreibung" />
		{/if}
		{#if task.checklist.total}
			<span
				class="inline-flex items-center gap-1 text-xs tabular-nums"
				class:text-success={checklistDone}
				class:text-muted-foreground={!checklistDone}
				aria-label={`${task.checklist.done} von ${task.checklist.total} Unteraufgaben erledigt`}
			>
				<ListChecks class="size-3.5" aria-hidden="true" />
				{task.checklist.done}/{task.checklist.total}
			</span>
		{/if}
		{#if task.assignees.length}
			<AvatarGroup class="ml-auto">
				{#each task.assignees.slice(0, 3) as a (a.id)}
					<Avatar class="size-6 border-2 border-card" title={a.name}>
						{#if a.image}<AvatarImage src={a.image} alt={a.name} />{/if}
						<AvatarFallback class="text-xs">{initials(a.name)}</AvatarFallback>
					</Avatar>
				{/each}
				{#if task.assignees.length > 3}
					<span class="ml-1 text-xs text-muted-foreground">+{task.assignees.length - 3}</span>
				{/if}
			</AvatarGroup>
			<span class="sr-only">Zuständig: {task.assignees.map((a) => a.name).join(', ')}</span>
		{/if}
	</div>

	{#if task.canMove && (canLeft || canRight)}
		<!-- Touch/ohne Maus: in die Nachbarspalte schieben -->
		<div class="mt-2 flex justify-between sm:hidden">
			<button
				type="button"
				class="focus-ring inline-flex items-center gap-0.5 rounded-sm px-1 text-xs text-muted-foreground disabled:opacity-0"
				disabled={!canLeft}
				aria-label="In die linke Spalte"
				onclick={(e) => {
					e.stopPropagation();
					onshift(-1);
				}}
			>
				<ChevronLeft class="size-4" aria-hidden="true" /> Zurück
			</button>
			<button
				type="button"
				class="focus-ring inline-flex items-center gap-0.5 rounded-sm px-1 text-xs text-muted-foreground disabled:opacity-0"
				disabled={!canRight}
				aria-label="In die rechte Spalte"
				onclick={(e) => {
					e.stopPropagation();
					onshift(1);
				}}
			>
				Weiter <ChevronRight class="size-4" aria-hidden="true" />
			</button>
		</div>
	{/if}
</div>
