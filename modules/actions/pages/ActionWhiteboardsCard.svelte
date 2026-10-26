<script lang="ts">
	// Karte „Whiteboards“ in der Übersicht: Whiteboards des Moduls „Whiteboards“ zu dieser Aktion öffnen oder anlegen.
	// Nur über die REST-API von `whiteboard` (kein Import aus dem Modul); ohne aktives Modul/Recht unsichtbar.
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import Plus from '@lucide/svelte/icons/plus';
	import Presentation from '@lucide/svelte/icons/presentation';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';

	let { actionId, actionName }: { actionId: string; actionName: string } = $props();

	interface BoardsInfo {
		boards: { id: string; name: string; color: string | null; elementCount: number }[];
		canCreate: boolean;
	}

	let info = $state<BoardsInfo | null>(null);
	let busy = $state(false);

	$effect(() => {
		const id = actionId;
		let stale = false;
		apiFetch<BoardsInfo>(`/modules/whiteboard/boards/by-action/${id}`)
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
			const n = info?.boards.length ?? 0;
			const board = await apiFetch<{ id: string }>('/modules/whiteboard/boards', {
				method: 'POST',
				body: JSON.stringify({ name: n ? `${actionName} (${n + 1})` : actionName, actionId })
			});
			await goto(`/modules/whiteboard/${board.id}`);
		} catch (e) {
			toast.error(
				e instanceof ApiClientError && e.message
					? e.message
					: 'Whiteboard konnte nicht angelegt werden'
			);
		} finally {
			busy = false;
		}
	}
</script>

{#if info && (info.boards.length || info.canCreate)}
	<Card.Root>
		<Card.Header class="flex flex-row items-center justify-between gap-2 space-y-0">
			<Card.Title class="flex items-center gap-2">
				<Presentation class="size-4 text-muted-foreground" aria-hidden="true" /> Whiteboards
			</Card.Title>
			{#if info.canCreate}
				<Button
					size="sm"
					variant={info.boards.length ? 'outline' : 'default'}
					onclick={create}
					disabled={busy}
				>
					<Plus /> Whiteboard
				</Button>
			{/if}
		</Card.Header>
		<Card.Content>
			{#if info.boards.length}
				<ul class="divide-y">
					{#each info.boards as b (b.id)}
						<li>
							<a
								href={`/modules/whiteboard/${b.id}`}
								class="flex items-center gap-2 rounded-sm py-2 text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
							>
								<span
									class="size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
									style:background-color={b.color ?? undefined}
									aria-hidden="true"
								></span>
								<span class="min-w-0 flex-1 truncate font-medium">{b.name}</span>
								<span class="text-xs text-muted-foreground tabular-nums">
									{b.elementCount}
									{b.elementCount === 1 ? 'Element' : 'Elemente'}
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-muted-foreground">
					Sammle Ideen, Programm und Notizen gemeinsam auf einem Whiteboard. Wer die Aktion sehen
					oder bearbeiten darf, darf das auch beim Whiteboard.
				</p>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
