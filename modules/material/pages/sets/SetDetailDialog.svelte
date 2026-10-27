<script lang="ts">
	// Detail eines Sets: Vollständigkeit, Stückliste (Links in den Bestand), Aktionen.
	import Pencil from '@lucide/svelte/icons/pencil';
	import Printer from '@lucide/svelte/icons/printer';
	import Unlink from '@lucide/svelte/icons/unlink';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { ConfirmDialog, ErrorState, LoadingState } from '$lib/components/layout';
	import type { MaterialSet } from '../../schemas';
	import { API, errorText, unitHref } from '../helpers';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import { completenessView } from './set-helpers';

	let {
		open = $bindable(false),
		setId,
		canManage,
		canPrint,
		onedit,
		onprint,
		onchanged
	}: {
		open?: boolean;
		setId: string | null;
		canManage: boolean;
		canPrint: boolean;
		onedit: (s: MaterialSet) => void;
		onprint: (s: MaterialSet) => void;
		onchanged: () => void | Promise<void>;
	} = $props();

	let set = $state<MaterialSet | null>(null);
	let loading = $state(false);
	let error = $state('');
	let confirmOpen = $state(false);
	let busy = $state(false);

	let loadedFor: string | null = null;
	$effect(() => {
		if (!open) {
			loadedFor = null;
			return;
		}
		if (!setId || loadedFor === setId) return;
		loadedFor = setId;
		void load();
	});

	async function load() {
		if (!setId) return;
		loading = true;
		error = '';
		try {
			set = await apiFetch<MaterialSet>(`${API}/sets/${setId}`);
		} catch (e) {
			set = null;
			error = errorText(e, 'Das Set konnte nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	async function dissolve() {
		if (!set) return;
		busy = true;
		try {
			await apiFetch(`${API}/sets/${set.id}`, { method: 'DELETE' });
			toast.success(`Set „${set.name}“ aufgelöst – die Stücke bleiben im Bestand`);
			open = false;
			await onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Auflösen fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	const view = $derived(set ? completenessView(set.completeness) : null);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{set?.name ?? 'Set'}</Dialog.Title>
			<Dialog.Description>
				{#if set}{set.templateName} · <span class="tabular-nums">{set.code}</span>{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if loading && !set}
			<LoadingState label="Set" rows={4} />
		{:else if error}
			<ErrorState message={error} onretry={load} compact />
		{:else if set && view}
			<div class="space-y-4">
				<div class="flex flex-wrap items-center gap-2">
					<Badge variant={view.variant}>{view.label}</Badge>
					{#if set.issuedUnits}
						<Badge variant="warning">{set.issuedUnits} ausgegeben</Badge>
					{/if}
					<span class="text-sm text-muted-foreground tabular-nums">
						{set.units.length}
						{set.units.length === 1 ? 'Stück' : 'Stücke'}
					</span>
				</div>
				{#if view.details.length}
					<ul class="space-y-0.5 text-sm">
						{#each view.details as d (d)}<li>{d}</li>{/each}
					</ul>
				{/if}
				{#if set.notes}
					<p class="text-sm whitespace-pre-line text-muted-foreground">{set.notes}</p>
				{/if}
				{#if set.units.length}
					<ul class="divide-y rounded-md border" aria-label="Stücke im Set">
						{#each set.units as u (u.id)}
							<li class="flex items-center gap-3 px-3 py-2 text-sm">
								<div class="min-w-0 flex-1">
									<a
										href={unitHref(u.id)}
										class="block truncate font-medium text-link hover:underline"
									>
										{u.name}
									</a>
									<span class="block truncate text-xs text-muted-foreground">
										{u.code} · {u.articleName} · {u.locationPath}
									</span>
								</div>
								{#if u.issued}
									<Badge variant="warning" title={u.issued.title}>Ausgegeben</Badge>
								{/if}
								<ConditionBadge condition={u.condition} hideOk />
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">Dem Set sind noch keine Stücke zugeordnet.</p>
				{/if}
				{#if set.bulkParts.length}
					<p class="text-sm text-muted-foreground">
						Dazu aus dem Lager (kommt beim Reservieren automatisch mit):
						<span class="text-foreground">
							{set.bulkParts.map((p) => `${p.quantity} ${p.unitLabel} ${p.articleName}`).join(', ')}
						</span>
					</p>
				{/if}
			</div>
		{/if}

		{#if set}
			<Dialog.Footer class="flex-wrap">
				{#if canManage}
					<Button variant="destructive" onclick={() => (confirmOpen = true)} disabled={busy}>
						<Unlink aria-hidden="true" /> Auflösen
					</Button>
				{/if}
				{#if canPrint}
					<Button variant="outline" onclick={() => set && onprint(set)}>
						<Printer aria-hidden="true" /> Etikett
					</Button>
				{/if}
				{#if canManage}
					<Button onclick={() => set && onedit(set)}>
						<Pencil aria-hidden="true" /> Umbauen
					</Button>
				{/if}
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmOpen}
	title="Set auflösen?"
	description={set
		? `„${set.name}“ wird aufgelöst. Die Stücke bleiben als lose Stücke im Bestand. Ist das Set noch reserviert, geht das nicht.`
		: undefined}
	confirmLabel="Auflösen"
	destructive
	onconfirm={dissolve}
/>
