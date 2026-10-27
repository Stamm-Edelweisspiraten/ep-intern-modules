<script lang="ts">
	// Status einer Reservierung; überfällig hervorgehoben.
	import { Badge } from '$lib/components/ui/badge';
	import type { ReservationStatus } from '../../schemas';
	import { RESERVATION_STATUS_LABELS, STATUS_VARIANTS } from '../helpers';

	let {
		status,
		overdue = false,
		class: className = ''
	}: { status: ReservationStatus; overdue?: boolean; class?: string } = $props();
</script>

{#if overdue}
	<Badge variant="destructive" class={className}>Überfällig</Badge>
{:else}
	<Badge
		variant={STATUS_VARIANTS[status]}
		class={[status === 'cancelled' ? 'text-muted-foreground line-through' : '', className]
			.filter(Boolean)
			.join(' ')}
	>
		{RESERVATION_STATUS_LABELS[status]}
	</Badge>
{/if}
