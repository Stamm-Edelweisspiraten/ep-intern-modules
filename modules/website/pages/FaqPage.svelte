<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import {
		ConfirmDialog,
		EmptyState,
		ErrorState,
		LoadingState,
		PageHeader
	} from '$lib/components/layout';
	import type { Faq } from '../schemas';
	import FaqDialog from './FaqDialog.svelte';
	import WebsiteTabs from './WebsiteTabs.svelte';
	import { BASE, errorText } from './helpers';

	let faqs = $state<Faq[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let dialogOpen = $state(false);
	let editing = $state<Faq | null>(null);
	let deleting = $state<Faq | null>(null);
	let deleteOpen = $state(false);
	let liveMessage = $state('');

	async function load() {
		try {
			faqs = await apiFetch<Faq[]>(`${BASE}/faqs`);
			loadError = '';
		} catch (e) {
			loadError = errorText(e, 'Laden fehlgeschlagen');
		} finally {
			loading = false;
		}
	}

	onMount(() => void load());

	async function move(index: number, to: number) {
		const ids = faqs.map((f) => f.id);
		const [id] = ids.splice(index, 1);
		ids.splice(to, 0, id!);
		try {
			faqs = await apiFetch<Faq[]>(`${BASE}/faqs/order`, {
				method: 'PUT',
				body: JSON.stringify({ ids })
			});
			liveMessage = `Position ${to + 1} von ${ids.length}`;
		} catch (e) {
			toast.error(errorText(e, 'Sortieren fehlgeschlagen'));
		}
	}

	async function confirmDelete() {
		if (!deleting) return;
		try {
			await apiFetch(`${BASE}/faqs/${deleting.id}`, { method: 'DELETE' });
			toast.success('Frage gelöscht');
			await load();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		}
	}

	/** Klartext-Vorschau der Antwort (das HTML ist serverseitig bereinigt, wird hier aber nicht gerendert) */
	function preview(html: string): string {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
		return text.length > 220 ? `${text.slice(0, 220)} …` : text;
	}
</script>

<div class="space-y-6">
	<PageHeader
		title="Website"
		description="Häufige Fragen der Stammeswebsite. Markierte Fragen erscheinen zusätzlich auf der Startseite."
	>
		{#snippet actions()}
			<Button
				onclick={() => {
					editing = null;
					dialogOpen = true;
				}}
			>
				<Plus /> Frage anlegen
			</Button>
		{/snippet}
	</PageHeader>
	<WebsiteTabs />

	<p class="sr-only" aria-live="polite">{liveMessage}</p>

	{#if loading}
		<LoadingState label="Fragen werden geladen" rows={4} />
	{:else if loadError}
		<ErrorState message={loadError} onretry={load} />
	{:else if faqs.length === 0}
		<EmptyState title="Noch keine Fragen" description="Lege die erste häufige Frage an." />
	{:else}
		<ol class="space-y-3">
			{#each faqs as f, i (f.id)}
				<li>
					<Card.Root>
						<Card.Content class="flex flex-col gap-3 sm:flex-row sm:items-start">
							<div class="min-w-0 flex-1 space-y-1">
								<div class="flex flex-wrap items-center gap-2">
									<p class="font-medium">{f.question}</p>
									{#if !f.active}<Badge variant="outline">Ausgeblendet</Badge>
									{:else if f.featured}<Badge variant="info">Startseite</Badge>{/if}
								</div>
								<p class="text-sm text-muted-foreground">{preview(f.answerHtml)}</p>
							</div>
							<div class="flex shrink-0 gap-1">
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Nach oben"
									disabled={i === 0}
									onclick={() => move(i, i - 1)}><ArrowUp /></Button
								>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Nach unten"
									disabled={i === faqs.length - 1}
									onclick={() => move(i, i + 1)}><ArrowDown /></Button
								>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Bearbeiten"
									onclick={() => {
										editing = f;
										dialogOpen = true;
									}}><Pencil /></Button
								>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Löschen"
									onclick={() => {
										deleting = f;
										deleteOpen = true;
									}}><Trash2 /></Button
								>
							</div>
						</Card.Content>
					</Card.Root>
				</li>
			{/each}
		</ol>
	{/if}
</div>

<FaqDialog bind:open={dialogOpen} faq={editing} onsaved={load} />
<ConfirmDialog
	bind:open={deleteOpen}
	title="Frage löschen?"
	description="Die Frage verschwindet sofort von der Website."
	confirmLabel="Löschen"
	destructive
	onconfirm={confirmDelete}
/>
