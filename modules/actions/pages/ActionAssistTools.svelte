<script lang="ts">
	// Schreibhilfe-Werkzeuge der Aktion (Übersicht): Packliste vorschlagen (kopieren) und – nach dem
	// Ende – Rückblick als Blog-Entwurf auf der Website anlegen. Ohne Freigabe der Schreibhilfe unsichtbar.
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { AssistButton } from '$lib/components/layout';
	import { apiFetch, ApiClientError } from '$lib/sdk/client';
	import { todayBerlin } from '$lib/sdk/dates';
	import type { ActionSummary } from '../schemas';

	let { action, canWebsite }: { action: ActionSummary; canWebsite: boolean } = $props();

	const context = $derived({ module: 'actions', kind: 'action', id: action.id });
	const over = $derived((action.endsOn ?? action.startsOn) < todayBerlin() || action.isPast);
	let busy = $state(false);

	async function copyList(items: string[]) {
		const text = items.map((i) => `- ${i}`).join('\n');
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Packliste kopiert – z. B. in die Beschreibung oder eine Info-Mail einfügen');
		} catch {
			toast.error('Kopieren nicht möglich');
		}
	}

	/** Blog-Entwurf anlegen, Text setzen und den Editor öffnen (bleibt Entwurf) */
	async function createPost(html: string) {
		if (busy) return;
		busy = true;
		try {
			const post = await apiFetch<{ id: string }>('/modules/website/posts', {
				method: 'POST',
				body: JSON.stringify({ title: `Rückblick: ${action.name}`.slice(0, 150) })
			});
			await apiFetch(`/modules/website/posts/${post.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ bodyHtml: html })
			});
			toast.success('Blog-Entwurf angelegt');
			await goto(`/modules/website/posts/${post.id}`);
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Entwurf konnte nicht angelegt werden');
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-wrap gap-1">
	<AssistButton
		config={{ module: 'actions', purpose: 'packing-list', context }}
		label="Packliste vorschlagen"
		text={() => action.description ?? ''}
		onapply={() => {}}
		onitems={copyList}
	/>
	{#if over && canWebsite}
		<AssistButton
			config={{ module: 'actions', purpose: 'action-recap', context }}
			label="Rückblick für die Website"
			disabled={busy}
			text={() => ''}
			onapply={createPost}
		/>
	{/if}
</div>
