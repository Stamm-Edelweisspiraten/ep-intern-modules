<script lang="ts">
	import { apiFetch } from '$lib/sdk/client';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import type { HistoryEntry, HistoryKind } from '../history-labels';
	import { BASE, errorMessage, fmtDateTime } from './helpers';

	/** Verlauf aus dem Audit-Log (wer hat wann was geändert) – ohne personenbezogene Details */
	let { kind, id }: { kind: HistoryKind; id: string } = $props();

	let items = $state<HistoryEntry[] | null>(null);
	let error = $state('');

	async function load(k: HistoryKind, i: string) {
		items = null;
		error = '';
		try {
			const r = await apiFetch<{ items: HistoryEntry[] }>(`${BASE}/history?kind=${k}&id=${i}`);
			items = r.items;
		} catch (e) {
			error = errorMessage(e, 'Verlauf konnte nicht geladen werden');
		}
	}

	$effect(() => {
		void load(kind, id);
	});
</script>

{#if error}
	<p class="text-sm text-destructive" role="alert">{error}</p>
{:else if !items}
	<div class="space-y-2" aria-busy="true" aria-label="Verlauf lädt …">
		<Skeleton class="h-8 w-full" />
		<Skeleton class="h-8 w-full" />
	</div>
{:else if !items.length}
	<p class="text-sm text-muted-foreground">Noch keine Einträge.</p>
{:else}
	<ol class="divide-y text-sm">
		{#each items as e (e.id)}
			<li class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2">
				<span class={e.related ? 'text-muted-foreground' : 'font-medium'}>
					{e.label}{#if e.related}<span class="text-xs"> (Buchung)</span>{/if}
				</span>
				<span class="text-xs text-muted-foreground">{fmtDateTime(e.at)} · {e.actor}</span>
			</li>
		{/each}
	</ol>
{/if}
