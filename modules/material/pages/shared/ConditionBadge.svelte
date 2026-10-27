<script lang="ts">
	// Zustand eines Stücks (überall gleiche Farben und Texte).
	import { Badge } from '$lib/components/ui/badge';
	import type { Condition } from '../../schemas';
	import { CONDITION_LABELS, CONDITION_VARIANTS } from '../helpers';

	let {
		condition,
		hideOk = false,
		class: className = ''
	}: { condition: Condition; hideOk?: boolean; class?: string } = $props();
</script>

{#if !(hideOk && condition === 'ok')}
	<Badge variant={CONDITION_VARIANTS[condition]} class={className}>
		{CONDITION_LABELS[condition]}
	</Badge>
{/if}
