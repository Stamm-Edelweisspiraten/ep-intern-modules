<script lang="ts">
	import * as Sheet from '$lib/components/ui/sheet';
	import type { HistoryKind } from '../history-labels';
	import HistoryPanel from './HistoryPanel.svelte';

	/** Verlauf einer Buchung/Auszahlung als Seitenpanel (mobil volle Breite) */
	let {
		open = $bindable(false),
		kind,
		id,
		title
	}: { open?: boolean; kind: HistoryKind; id: string | null; title: string } = $props();
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-md">
		<Sheet.Header class="border-b">
			<Sheet.Title>Verlauf</Sheet.Title>
			<Sheet.Description>{title}</Sheet.Description>
		</Sheet.Header>
		<div class="p-4">
			{#if id}<HistoryPanel {kind} {id} />{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
