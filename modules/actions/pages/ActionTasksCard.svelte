<script lang="ts">
	// Karte „Aufgaben“ in der Übersicht: Board des Moduls „Aufgaben“ zu dieser Aktion öffnen oder anlegen.
	// Nur über die REST-API von `tasks` (kein Import aus dem Modul); ohne aktives Modul/Recht unsichtbar.
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import Plus from '@lucide/svelte/icons/plus';
	import SquareKanban from '@lucide/svelte/icons/square-kanban';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';

	let { actionId, actionName }: { actionId: string; actionName: string } = $props();

	interface BoardInfo {
		board: {
			id: string;
			counts: { total: number; open: number; done: number; overdue: number };
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

	async function create() {
		busy = true;
		try {
			const board = await apiFetch<{ id: string }>('/modules/tasks/boards', {
				method: 'POST',
				body: JSON.stringify({ name: actionName, actionId })
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
				<Button size="sm" onclick={create} disabled={busy}><Plus /> Board anlegen</Button>
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
			{:else}
				<p class="text-sm text-muted-foreground">
					Verteile die Vorbereitung als Aufgaben mit Zuständigen, Fälligkeiten und Unteraufgaben.
					Wer die Aktion sehen oder bearbeiten darf, darf das auch beim Board.
				</p>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
