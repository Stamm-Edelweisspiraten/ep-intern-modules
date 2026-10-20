<script lang="ts">
	// Status einer Lieferantenbestellung (Einkauf).
	import { Badge, type BadgeVariant } from '$lib/components/ui/badge';
	import { SUPPLIER_STATUS_LABELS, type SupplierStatus } from '../schemas';

	let { status, class: className = '' }: { status: SupplierStatus; class?: string } = $props();

	const VARIANTS: Record<SupplierStatus, BadgeVariant> = {
		ordered: 'default',
		partial: 'outline',
		received: 'secondary',
		closed: 'outline'
	};
</script>

<Badge
	variant={VARIANTS[status] ?? 'outline'}
	class={[status === 'closed' ? 'text-muted-foreground' : '', className].filter(Boolean).join(' ')}
>
	{SUPPLIER_STATUS_LABELS[status] ?? status}
</Badge>
