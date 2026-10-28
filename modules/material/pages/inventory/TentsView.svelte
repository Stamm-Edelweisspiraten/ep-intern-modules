<script lang="ts">
	// Lager → Zelte: Baupläne als Karten mit ihren Teilen. Pflege (Anlegen/Bearbeiten/Archivieren/Löschen)
	// mit `material.inventory.manage`; verwendete Zelte lassen sich nur archivieren.
	import { toast } from 'svelte-sonner';
	import Archive from '@lucide/svelte/icons/archive';
	import ArchiveRestore from '@lucide/svelte/icons/archive-restore';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Tent from '@lucide/svelte/icons/tent';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { ConfirmDialog, EmptyState, ErrorState, LoadingState } from '$lib/components/layout';
	import type { Category, Tent as TentPlan } from '../../schemas';
	import { API, errorText } from '../helpers';
	import TentDialog from './TentDialog.svelte';

	let {
		tents,
		categories,
		loading,
		error,
		canManage,
		onretry,
		onchanged,
		onreserve
	}: {
		tents: TentPlan[];
		categories: Category[];
		loading: boolean;
		error: string;
		canManage: boolean;
		onretry: () => void;
		onchanged: () => void;
		onreserve: () => void;
	} = $props();

	let dialogOpen = $state(false);
	let editing = $state<TentPlan | null>(null);
	let removing = $state<TentPlan | null>(null);
	let confirmOpen = $state(false);

	export function create() {
		editing = null;
		dialogOpen = true;
	}

	export function openTent(id: string) {
		const t = tents.find((x) => x.id === id);
		if (t && canManage) {
			editing = t;
			dialogOpen = true;
		}
	}

	async function setArchived(t: TentPlan, archived: boolean) {
		try {
			await apiFetch(`${API}/tents/${t.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ archived })
			});
			toast.success(archived ? `„${t.name}“ archiviert` : `„${t.name}“ wiederhergestellt`);
			onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Das hat nicht geklappt'));
		}
	}

	async function remove() {
		if (!removing) return;
		try {
			await apiFetch(`${API}/tents/${removing.id}`, { method: 'DELETE' });
			toast.success(`„${removing.name}“ gelöscht`);
			onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Zelt konnte nicht gelöscht werden'));
		}
	}
</script>

{#if loading && !tents.length}
	<LoadingState rows={3} />
{:else if error}
	<ErrorState title="Zelte konnten nicht geladen werden" message={error} {onretry} />
{:else if !tents.length}
	<EmptyState
		title="Noch keine Zelte"
		description="Lege fest, woraus ein Zelt besteht – z. B. Jurte = Dach aus 6 Kohtenbahnen eines Sets, Wand aus 12 Kohtenbahnen und ein Abspannseil. Dann lassen sich ganze Zelte reservieren."
	>
		{#if canManage}
			<Button onclick={create}><Plus /> Zelt anlegen</Button>
		{/if}
	</EmptyState>
{:else}
	<ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Zelte">
		{#each tents as t (t.id)}
			<li>
				<Card.Root class={['h-full gap-3', t.archived ? 'opacity-70' : ''].join(' ')}>
					<Card.Header>
						<Card.Title level={3} class="flex flex-wrap items-center gap-2">
							<Tent class="size-4 text-muted-foreground" aria-hidden="true" />
							{t.name}
							{#if t.archived}<Badge variant="outline">Archiviert</Badge>{/if}
						</Card.Title>
						<Card.Description>
							{[t.category?.name ?? 'Ohne Kategorie', t.description].filter(Boolean).join(' · ')}
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-3">
						<ul class="divide-y rounded-md border text-sm">
							{#each t.parts as p (p.id)}
								<li class="flex items-baseline justify-between gap-3 px-3 py-1.5">
									<span class="min-w-0">
										{#if p.label}<span class="font-medium">{p.label}:</span>{/if}
										{p.name}
										{#if p.fromOneSet}
											<span class="block text-xs text-muted-foreground"
												>möglichst aus einem Set</span
											>
										{/if}
									</span>
									<span class="shrink-0 tabular-nums">{p.quantity} ×</span>
								</li>
							{/each}
						</ul>
						<div class="flex flex-wrap gap-2">
							{#if !t.archived}
								<Button size="sm" variant="outline" onclick={onreserve}>Reservieren</Button>
							{/if}
							{#if canManage}
								<Button
									size="sm"
									variant="outline"
									onclick={() => {
										editing = t;
										dialogOpen = true;
									}}
								>
									<Pencil /> Bearbeiten
								</Button>
								<Button
									size="sm"
									variant="ghost"
									aria-label={t.archived ? `${t.name} wiederherstellen` : `${t.name} archivieren`}
									title={t.archived ? 'Wiederherstellen' : 'Archivieren'}
									onclick={() => setArchived(t, !t.archived)}
								>
									{#if t.archived}<ArchiveRestore />{:else}<Archive />{/if}
								</Button>
								{#if !t.used}
									<Button
										size="sm"
										variant="ghost"
										aria-label={`${t.name} löschen`}
										onclick={() => {
											removing = t;
											confirmOpen = true;
										}}
									>
										<Trash2 />
									</Button>
								{/if}
							{/if}
						</div>
					</Card.Content>
				</Card.Root>
			</li>
		{/each}
	</ul>
{/if}

<TentDialog bind:open={dialogOpen} tent={editing} {categories} onsaved={onchanged} />

<ConfirmDialog
	bind:open={confirmOpen}
	title="Zelt löschen?"
	description={`„${removing?.name ?? ''}“ wird gelöscht. Das Material im Lager bleibt unverändert.`}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
