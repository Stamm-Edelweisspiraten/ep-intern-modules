<script lang="ts">
	// Lager → Sets: Karten je Set mit Vollständigkeit, Artikeln und nächster Verwendung. Pflege
	// (Anlegen/Bearbeiten/Auflösen) mit `material.inventory.manage`.
	import { toast } from 'svelte-sonner';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { ConfirmDialog, EmptyState, ErrorState, LoadingState } from '$lib/components/layout';
	import type { MaterialSet } from '../../schemas';
	import { API, errorText, formatPeriod } from '../helpers';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import SetDialog from './SetDialog.svelte';

	let {
		sets,
		loading,
		error,
		canManage,
		onretry,
		onchanged,
		onopenitem,
		onfilter
	}: {
		sets: MaterialSet[];
		loading: boolean;
		error: string;
		canManage: boolean;
		onretry: () => void;
		onchanged: () => void;
		onopenitem: (id: string) => void;
		/** Lagertabelle auf dieses Set filtern */
		onfilter: (id: string) => void;
	} = $props();

	let dialogOpen = $state(false);
	let editing = $state<MaterialSet | null>(null);
	let removing = $state<MaterialSet | null>(null);
	let confirmOpen = $state(false);

	export function create() {
		editing = null;
		dialogOpen = true;
	}

	function edit(s: MaterialSet) {
		editing = s;
		dialogOpen = true;
	}

	async function remove() {
		if (!removing) return;
		try {
			await apiFetch(`${API}/sets/${removing.id}`, { method: 'DELETE' });
			toast.success(`Set „${removing.name}“ aufgelöst`);
			onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Set konnte nicht aufgelöst werden'));
		}
	}
</script>

{#if loading && !sets.length}
	<LoadingState rows={3} />
{:else if error}
	<ErrorState title="Sets konnten nicht geladen werden" message={error} {onretry} />
{:else if !sets.length}
	<EmptyState
		title="Noch keine Sets"
		description="Ein Set fasst zusammengehörige Artikel zusammen – z. B. die sechs Kohtenbahnen KJ1.1 bis KJ1.6 eines Jurtendachs. Beim Reservieren werden ganze Sets bevorzugt."
	>
		{#if canManage}
			<Button onclick={create}><Plus /> Set anlegen</Button>
		{/if}
	</EmptyState>
{:else}
	<ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Sets">
		{#each sets as s (s.id)}
			<li>
				<Card.Root class="h-full gap-3">
					<Card.Header>
						<Card.Title level={3} class="flex flex-wrap items-center gap-2">
							Set {s.name}
							{#if !s.items.length}
								<Badge variant="outline">Leer</Badge>
							{:else if s.complete}
								<Badge variant="success">Vollständig</Badge>
							{:else}
								<Badge variant="warning">{s.usable} von {s.total} nutzbar</Badge>
							{/if}
						</Card.Title>
						<Card.Description>
							{[s.items.length === 1 ? '1 Artikel' : `${s.items.length} Artikel`, s.notes]
								.filter(Boolean)
								.join(' · ')}
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-3">
						{#if s.items.length}
							<ul class="flex flex-wrap gap-1.5" aria-label={`Artikel in Set ${s.name}`}>
								{#each s.items as i (i.id)}
									<li>
										<button
											type="button"
											class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs hover:bg-muted"
											title={[i.code, i.typeName, i.locationName].filter(Boolean).join(' · ')}
											onclick={() => onopenitem(i.id)}
										>
											{i.name}
											{#if i.quantity > 1}<span class="tabular-nums">× {i.quantity}</span>{/if}
											{#if !i.usable}<ConditionBadge condition={i.condition} hideOk />{/if}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
						{#if s.nextUse}
							<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
								<CalendarClock class="size-3.5" aria-hidden="true" />
								Zugeteilt: {s.nextUse.title}, {formatPeriod(s.nextUse.startsOn, s.nextUse.endsOn)}
							</p>
						{/if}
						<div class="flex flex-wrap gap-2">
							<Button size="sm" variant="outline" onclick={() => onfilter(s.id)}>
								In der Tabelle zeigen
							</Button>
							{#if canManage}
								<Button size="sm" variant="outline" onclick={() => edit(s)}>
									<Pencil /> Bearbeiten
								</Button>
								<Button
									size="sm"
									variant="ghost"
									aria-label={`Set ${s.name} auflösen`}
									onclick={() => {
										removing = s;
										confirmOpen = true;
									}}
								>
									<Trash2 />
								</Button>
							{/if}
						</div>
					</Card.Content>
				</Card.Root>
			</li>
		{/each}
	</ul>
{/if}

<SetDialog bind:open={dialogOpen} set={editing} onsaved={onchanged} />

<ConfirmDialog
	bind:open={confirmOpen}
	title="Set auflösen?"
	description={`Set „${removing?.name ?? ''}“ wird aufgelöst. Die Artikel bleiben im Lager und lassen sich weiter reservieren.`}
	confirmLabel="Auflösen"
	destructive
	onconfirm={remove}
/>
