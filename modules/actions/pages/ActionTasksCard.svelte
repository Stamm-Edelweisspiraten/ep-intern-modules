<script lang="ts">
	// Karte „Aufgaben“ in der Übersicht: Board des Moduls „Aufgaben“ zu dieser Aktion öffnen oder anlegen.
	// Nur über die REST-API von `tasks` (kein Import aus dem Modul); ohne aktives Modul/Recht unsichtbar.
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import Plus from '@lucide/svelte/icons/plus';
	import SquareKanban from '@lucide/svelte/icons/square-kanban';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { formatDateDe } from '$lib/sdk/dates';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';

	let { actionId, actionName }: { actionId: string; actionName: string } = $props();

	interface BoardInfo {
		board: {
			id: string;
			counts: { total: number; open: number; done: number; overdue: number };
			currentPhase: { name: string; color: string | null } | null;
			nextMilestone: { title: string; dueOn: string } | null;
		} | null;
		canCreate: boolean;
	}

	let info = $state<BoardInfo | null>(null);
	let busy = $state(false);

	$effect(() => {
		const id = actionId;
		let stale = false;
		apiFetch<BoardInfo>(`/modules/tasks/boards/by-action/${id}`)
			.then((res) => {
				if (!stale) info = res;
			})
			.catch(() => {
				if (!stale) info = null; // Modul aus, kein Recht oder kein Zugriff → Karte entfällt
			});
		return () => {
			stale = true;
		};
	});

	interface TemplateInfo {
		id: string;
		name: string;
		description: string | null;
	}
	let templates = $state<TemplateInfo[] | null>(null);

	async function loadTemplates() {
		if (templates) return;
		try {
			templates = await apiFetch<TemplateInfo[]>('/modules/tasks/templates');
		} catch {
			templates = [];
		}
	}

	async function create(templateId: string | null = null) {
		busy = true;
		try {
			const board = await apiFetch<{ id: string }>('/modules/tasks/boards', {
				method: 'POST',
				body: JSON.stringify({ name: actionName, actionId, templateId })
			});
			await goto(`/modules/tasks/${board.id}`);
		} catch (e) {
			toast.error(
				e instanceof ApiClientError && e.message ? e.message : 'Board konnte nicht angelegt werden'
			);
		} finally {
			busy = false;
		}
	}
</script>

{#if info && (info.board || info.canCreate)}
	<Card.Root>
		<Card.Header class="flex flex-row items-center justify-between gap-2 space-y-0">
			<Card.Title class="flex items-center gap-2">
				<SquareKanban class="size-4 text-muted-foreground" aria-hidden="true" /> Aufgaben
			</Card.Title>
			{#if info.board}
				<Button variant="outline" size="sm" href={`/modules/tasks/${info.board.id}`}>
					Board öffnen
				</Button>
			{:else}
				<DropdownMenu.Root onOpenChange={(o) => o && void loadTemplates()}>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props} size="sm" disabled={busy}><Plus /> Board anlegen</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-72">
						<DropdownMenu.Label>Vorlage</DropdownMenu.Label>
						<DropdownMenu.Item onclick={() => create(null)}>
							<span class="flex flex-col">
								<span>Leeres Board</span>
								<span class="text-xs text-muted-foreground"
									>Spalten Offen · In Arbeit · Erledigt</span
								>
							</span>
						</DropdownMenu.Item>
						{#if templates === null}
							<DropdownMenu.Item disabled>Vorlagen laden …</DropdownMenu.Item>
						{:else}
							{#each templates as t (t.id)}
								<DropdownMenu.Item onclick={() => create(t.id)}>
									<span class="flex flex-col">
										<span>{t.name}</span>
										{#if t.description}
											<span class="text-xs text-muted-foreground">{t.description}</span>
										{/if}
									</span>
								</DropdownMenu.Item>
							{/each}
						{/if}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		</Card.Header>
		<Card.Content>
			{#if info.board}
				<p class="flex flex-wrap items-center gap-2 text-sm">
					<span class="tabular-nums">
						{info.board.counts.open} offen · {info.board.counts.done} von {info.board.counts.total} erledigt
					</span>
					{#if info.board.counts.overdue}
						<Badge variant="destructive">{info.board.counts.overdue} überfällig</Badge>
					{/if}
				</p>
				{#if info.board.currentPhase || info.board.nextMilestone}
					<p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						{#if info.board.currentPhase}
							<span class="inline-flex items-center gap-1.5">
								<span
									class="size-2 rounded-full bg-muted-foreground/40"
									style:background-color={info.board.currentPhase.color ?? undefined}
									aria-hidden="true"
								></span>
								Phase: {info.board.currentPhase.name}
							</span>
						{/if}
						{#if info.board.nextMilestone}
							<span>
								◆ {info.board.nextMilestone.title} am {formatDateDe(info.board.nextMilestone.dueOn)}
							</span>
						{/if}
					</p>
				{/if}
			{:else}
				<p class="text-sm text-muted-foreground">
					Verteile die Vorbereitung als Aufgaben mit Zuständigen, Fälligkeiten und Unteraufgaben.
					Wer die Aktion sehen oder bearbeiten darf, darf das auch beim Board.
				</p>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
