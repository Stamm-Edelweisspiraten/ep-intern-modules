<script lang="ts">
	// Empfänger einer Bestellung: Mitgliedsname bzw. Gruppenname/„Stamm“ mit kleinem Badge (ohne Rechnung).
	import { Badge } from '$lib/components/ui/badge';
	import { type Order, RECIPIENT_KIND_LABELS } from '../schemas';

	let { recipient, class: className = '' }: { recipient: Order['recipient']; class?: string } =
		$props();
</script>

<span class={['inline-flex max-w-full items-center gap-1.5', className].filter(Boolean).join(' ')}>
	{#if recipient.kind !== 'member'}
		<Badge variant="secondary" class="shrink-0">{RECIPIENT_KIND_LABELS[recipient.kind]}</Badge>
	{/if}
	{#if recipient.kind !== 'stamm'}
		<span class="truncate">{recipient.name}</span>
	{/if}
</span>
