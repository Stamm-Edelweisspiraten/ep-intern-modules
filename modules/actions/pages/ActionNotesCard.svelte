<script lang="ts">
	// Karte „Notizen“ in der Übersicht: Notizen des Moduls „Notizen“ zu dieser Aktion öffnen oder anlegen.
	// Nur über die REST-API von `notes` (kein Import aus dem Modul); ohne aktives Modul/Recht unsichtbar.
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import NotebookPen from '@lucide/svelte/icons/notebook-pen';
	import Plus from '@lucide/svelte/icons/plus';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';

	let { actionId, actionName }: { actionId: string; actionName: string } = $props();

	interface NotesInfo {
		notes: { id: string; title: string; color: string | null; updatedAt: string }[];
		canCreate: boolean;
	}

	let info = $state<NotesInfo | null>(null);
	let busy = $state(false);

	$effect(() => {
		const id = actionId;
		let stale = false;
		apiFetch<NotesInfo>(`/modules/notes/notes/by-action/${id}`)
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
			const note = await apiFetch<{ id: string }>('/modules/notes/notes', {
				method: 'POST',
				body: JSON.stringify({ title: actionName, actionId })
			});
			await goto(`/modules/notes/${note.id}`);
		} catch (e) {
			toast.error(
				e instanceof ApiClientError && e.message ? e.message : 'Notiz konnte nicht angelegt werden'
			);
		} finally {
			busy = false;
		}
	}

	const dateText = (iso: string) =>
		new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
</script>

{#if info && (info.notes.length || info.canCreate)}
	<Card.Root>
		<Card.Header class="flex flex-row items-center justify-between gap-2 space-y-0">
			<Card.Title class="flex items-center gap-2">
				<NotebookPen class="size-4 text-muted-foreground" aria-hidden="true" /> Notizen
			</Card.Title>
			{#if info.canCreate}
				<Button
					size="sm"
					variant={info.notes.length ? 'outline' : 'default'}
					onclick={create}
					disabled={busy}
				>
					<Plus /> Notiz
				</Button>
			{/if}
		</Card.Header>
		<Card.Content>
			{#if info.notes.length}
				<ul class="divide-y">
					{#each info.notes as n (n.id)}
						<li>
							<a
								href={`/modules/notes/${n.id}`}
								class="flex items-center gap-2 rounded-sm py-2 text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
							>
								<span
									class="size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
									style:background-color={n.color ?? undefined}
									aria-hidden="true"
								></span>
								<span class="min-w-0 flex-1 truncate font-medium">{n.title || 'Ohne Titel'}</span>
								<span class="text-xs text-muted-foreground tabular-nums"
									>{dateText(n.updatedAt)}</span
								>
							</a>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-muted-foreground">
					Plane Programm, Packlisten und Absprachen gemeinsam in einer Notiz. Wer die Aktion sehen
					oder bearbeiten darf, darf das auch bei der Notiz.
				</p>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
