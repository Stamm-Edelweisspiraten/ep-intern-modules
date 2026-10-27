<script lang="ts">
	// Bogen-/Rollen-Skizze im Maßstab (SVG). Optional: Startfeld per Klick wählen (angebrochene Bögen)
	// und belegte Felder der ersten Seite hervorheben.
	import { labelPageSize, labelsPerPage, type LabelFormat } from '$lib/sdk/labels';
	import { cn } from '$lib/utils';

	let {
		format,
		startIndex = $bindable(0),
		selectable = false,
		count = 0,
		width = 180,
		label = 'Bogenvorschau',
		class: className
	}: {
		format: LabelFormat;
		/** Erstes Feld (0-basiert, zeilenweise) */
		startIndex?: number;
		/** Startfeld per Klick wählbar */
		selectable?: boolean;
		/** So viele Etiketten werden gedruckt (Hervorhebung auf der ersten Seite) */
		count?: number;
		/** Breite der Skizze in px */
		width?: number;
		label?: string;
		class?: string;
	} = $props();

	const page = $derived(labelPageSize(format));
	const height = $derived(
		page.widthMm > 0 ? Math.min(width * (page.heightMm / page.widthMm), width * 2.5) : width
	);
	const cells = $derived.by(() => {
		if (format.kind === 'roll') return [];
		const out: { i: number; x: number; y: number; w: number; h: number }[] = [];
		for (let r = 0; r < format.rows; r++) {
			for (let c = 0; c < format.cols; c++) {
				out.push({
					i: r * format.cols + c,
					x: format.marginLeftMm + c * (format.labelWidthMm + format.gapXMm),
					y: format.marginTopMm + r * (format.labelHeightMm + format.gapYMm),
					w: format.labelWidthMm,
					h: format.labelHeightMm
				});
			}
		}
		return out;
	});
	const perPage = $derived(labelsPerPage(format));

	function state(i: number): 'skipped' | 'used' | 'free' {
		if (i < startIndex) return 'skipped';
		if (i < startIndex + count) return 'used';
		return 'free';
	}

	function pick(i: number) {
		if (selectable) startIndex = Math.min(Math.max(0, i), perPage - 1);
	}
</script>

<svg
	viewBox={`0 0 ${page.widthMm} ${page.heightMm}`}
	{width}
	{height}
	preserveAspectRatio="xMidYMid meet"
	class={cn('block max-w-full rounded-sm border bg-background', className)}
	role={selectable ? 'group' : 'img'}
	aria-label={label}
>
	{#if format.kind === 'roll'}
		<rect
			x="0"
			y="0"
			width={format.labelWidthMm}
			height={format.labelHeightMm}
			class="fill-muted stroke-muted-foreground"
			stroke-width={Math.max(page.widthMm, page.heightMm) / 150}
		/>
	{:else}
		{#each cells as c (c.i)}
			{@const s = state(c.i)}
			{@const cls = cn(
				'stroke-muted-foreground/60',
				s === 'used' && 'fill-primary/60',
				s === 'skipped' && 'fill-muted-foreground/25',
				s === 'free' && 'fill-muted',
				selectable && 'cursor-pointer hover:fill-primary/30'
			)}
			{#if selectable}
				<rect
					x={c.x}
					y={c.y}
					width={c.w}
					height={c.h}
					rx="1"
					stroke-width="0.6"
					class={cls}
					role="button"
					tabindex="0"
					aria-label={`Mit Feld ${c.i + 1} beginnen`}
					aria-pressed={c.i === startIndex}
					onclick={() => pick(c.i)}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							pick(c.i);
						}
					}}
				/>
			{:else}
				<rect x={c.x} y={c.y} width={c.w} height={c.h} rx="1" stroke-width="0.6" class={cls} />
			{/if}
		{/each}
	{/if}
</svg>
