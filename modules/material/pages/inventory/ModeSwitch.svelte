<script lang="ts" generics="T extends string">
	// Kleiner Umschalter (Einfachauswahl) als Knopfgruppe, z. B. „Lagerort | Kiste“.
	import { cn } from '$lib/utils';

	let {
		value,
		options,
		label,
		onchange,
		size = 'default',
		class: className
	}: {
		value: T;
		options: { value: T; label: string }[];
		/** Zugänglicher Name der Gruppe */
		label: string;
		onchange: (value: T) => void;
		size?: 'sm' | 'default';
		class?: string;
	} = $props();
</script>

<div
	role="group"
	aria-label={label}
	class={cn('inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1', className)}
>
	{#each options as o (o.value)}
		{@const active = o.value === value}
		<button
			type="button"
			aria-pressed={active}
			class={cn(
				'rounded-md px-3 font-medium transition-colors',
				size === 'sm' ? 'h-7 text-xs' : 'h-8 text-sm',
				active
					? 'bg-background text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground'
			)}
			onclick={() => onchange(o.value)}
		>
			{o.label}
		</button>
	{/each}
</div>
