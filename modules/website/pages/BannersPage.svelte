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
	import type { Banner } from '../schemas';
	import BannerDialog from './BannerDialog.svelte';
	import WebsiteTabs from './WebsiteTabs.svelte';
	import { BANNER_STATE_LABELS, BASE, errorText, formatDateTime } from './helpers';

	let banners = $state<Banner[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let dialogOpen = $state(false);
	let editing = $state<Banner | null>(null);
	let deleting = $state<Banner | null>(null);
	let deleteOpen = $state(false);
	let liveMessage = $state('');

	async function load() {
		try {
			banners = await apiFetch<Banner[]>(`${BASE}/banners`);
			loadError = '';
		} catch (e) {
			loadError = errorText(e, 'Laden fehlgeschlagen');
		} finally {
			loading = false;
		}
	}

	onMount(() => void load());

	async function move(index: number, to: number) {
		const ids = banners.map((b) => b.id);
		const [id] = ids.splice(index, 1);
		ids.splice(to, 0, id!);
		try {
			banners = await apiFetch<Banner[]>(`${BASE}/banners/order`, {
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
			await apiFetch(`${BASE}/banners/${deleting.id}`, { method: 'DELETE' });
			toast.success('Banner gelöscht');
			await load();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		}
	}

	function stateVariant(b: Banner) {
		return b.state === 'live' ? 'success' : b.state === 'scheduled' ? 'info' : 'outline';
	}

	function windowText(b: Banner) {
		if (b.startsAt && b.endsAt) return `${formatDateTime(b.startsAt)} – ${formatDateTime(b.endsAt)}`;
		if (b.startsAt) return `ab ${formatDateTime(b.startsAt)}`;
		if (b.endsAt) return `bis ${formatDateTime(b.endsAt)}`;
		return 'ohne Zeitraum';
	}
</script>

<div class="space-y-6">
	<PageHeader
		title="Website"
		description="Hinweise auf der Stammeswebsite: als Leiste oben auf allen Seiten oder als Kasten auf der Startseite."
	>
		{#snippet actions()}
			<Button
				onclick={() => {
					editing = null;
					dialogOpen = true;
				}}
			>
				<Plus /> Banner anlegen
			</Button>
		{/snippet}
	</PageHeader>
	<WebsiteTabs />

	<p class="sr-only" aria-live="polite">{liveMessage}</p>

	{#if loading}
		<LoadingState label="Banner werden geladen" rows={3} />
	{:else if loadError}
		<ErrorState message={loadError} onretry={load} />
	{:else if banners.length === 0}
		<EmptyState
			title="Noch keine Banner"
			description="Lege einen Hinweis an, z. B. „In den Ferien finden keine Gruppenstunden statt“."
		/>
	{:else}
		<ol class="space-y-3">
			{#each banners as b, i (b.id)}
				<li>
					<Card.Root>
						<Card.Content class="flex flex-col gap-3 sm:flex-row sm:items-start">
							<div class="min-w-0 flex-1 space-y-1.5">
								<div class="flex flex-wrap items-center gap-2">
									<Badge variant={stateVariant(b)}>{BANNER_STATE_LABELS[b.state]}</Badge>
									<Badge variant="outline">
										{b.placement === 'bar' ? 'Leiste auf allen Seiten' : 'Startseite'}
									</Badge>
									{#if b.level === 'important'}<Badge variant="warning">Wichtig</Badge>{/if}
								</div>
								<p class="text-sm">
									{#if b.title}<strong>{b.title}:</strong>{/if}
									{b.text}
								</p>
								<p class="text-xs text-muted-foreground">
									{windowText(b)}{#if b.linkUrl}
										· Link: {b.linkLabel ?? b.linkUrl}{/if}
								</p>
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
									disabled={i === banners.length - 1}
									onclick={() => move(i, i + 1)}><ArrowDown /></Button
								>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Bearbeiten"
									onclick={() => {
										editing = b;
										dialogOpen = true;
									}}><Pencil /></Button
								>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Löschen"
									onclick={() => {
										deleting = b;
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

<BannerDialog bind:open={dialogOpen} banner={editing} onsaved={load} />
<ConfirmDialog
	bind:open={deleteOpen}
	title="Banner löschen?"
	description="Der Hinweis verschwindet sofort von der Website."
	confirmLabel="Löschen"
	destructive
	onconfirm={confirmDelete}
/>
