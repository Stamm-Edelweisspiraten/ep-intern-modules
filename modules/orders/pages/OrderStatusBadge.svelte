<script lang="ts">
	// Status einer Mitgliedsbestellung (überall gleiche Farben und Texte).
	import { Badge, type BadgeVariant } from '$lib/components/ui/badge';
	import { ORDER_STATUS_LABELS, type OrderStatus } from '../schemas';

	let { status, class: className = '' }: { status: OrderStatus; class?: string } = $props();

	const VARIANTS: Record<OrderStatus, BadgeVariant> = {
		open: 'default',
		partial: 'outline',
		delivered: 'secondary',
		cancelled: 'outline'
	};
</script>

<Badge
	variant={VARIANTS[status] ?? 'outline'}
	class={[status === 'cancelled' ? 'text-muted-foreground line-through' : '', className]
		.filter(Boolean)
		.join(' ')}
>
	{ORDER_STATUS_LABELS[status] ?? status}
</Badge>
