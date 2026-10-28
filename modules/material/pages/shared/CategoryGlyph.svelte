<script lang="ts">
	// Kategorie als Farbfläche mit Icon in Kontrastfarbe (ohne Farbe grau, ohne Icon ein Kästchen).
	import { DynamicIcon } from '$lib/components/ui/icon-picker';
	import { contrastTextColor } from '$lib/components/ui/color-picker';
	import { cn } from '$lib/utils';
	import type { CategoryRef } from '../../schemas';

	let {
		category,
		size = 'md',
		class: className = ''
	}: {
		category: Pick<CategoryRef, 'name' | 'icon' | 'color'> | null;
		size?: 'sm' | 'md' | 'lg';
		class?: string;
	} = $props();

	const box = $derived(
		{ sm: 'size-5 rounded', md: 'size-8 rounded-md', lg: 'size-12 rounded-lg' }[size]
	);
	const icon = $derived({ sm: 'size-3', md: 'size-4', lg: 'size-6' }[size]);
	const fg = $derived(category?.color ? contrastTextColor(category.color) : undefined);
</script>

<span
	class={cn(
		'inline-flex shrink-0 items-center justify-center',
		box,
		!category?.color && 'bg-muted text-muted-foreground',
		className
	)}
	style:background-color={category?.color ?? undefined}
	style:color={fg}
	title={category?.name ?? 'Ohne Kategorie'}
	aria-hidden="true"
>
	<DynamicIcon name={category?.icon ?? 'package'} class={icon} />
</span>
