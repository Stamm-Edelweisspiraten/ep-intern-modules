<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import type { HistoryKind } from '../history-labels';
	import HistoryPanel from './HistoryPanel.svelte';

	let {
		kind,
		id,
		class: className = ''
	}: { kind: HistoryKind; id: string; class?: string } = $props();
</script>

<Card.Root class={className}>
	<Card.Header>
		<Card.Title>Verlauf</Card.Title>
		<Card.Description>Wer hat wann etwas an dieser Rechnung geändert.</Card.Description>
	</Card.Header>
	<Card.Content>
		<HistoryPanel {kind} {id} />
	</Card.Content>
</Card.Root>
