<script lang="ts">
	// Form, Notizzettel oder Text mit umbrochenem Text (SVG-<text>, auch für den Bild-Export)
	import type { ShapeData } from '../../schemas';
	import { shapePath, textArea } from './geometry';
	import { textOn } from './render';
	import { FONT_FAMILY, layoutText } from './text-layout';
	import type { RenderContext } from './types';

	let { id, data, rc }: { id: string; data: ShapeData; rc: RenderContext } = $props();

	const d = $derived(shapePath(data.kind, data.w, data.h));
	const dash = $derived(
		data.strokeStyle === 'dashed'
			? `${data.strokeWidth * 3} ${data.strokeWidth * 2}`
			: data.strokeStyle === 'dotted'
				? `${data.strokeWidth} ${data.strokeWidth * 1.6}`
				: undefined
	);
	const color = $derived(data.textColor ?? textOn(data.fill));
	const layout = $derived(
		data.text && rc.editingId !== id
			? layoutText(
					data.text,
					textArea(data.kind, data.w, data.h),
					{
						fontSize: data.fontSize,
						align: data.align,
						valign: data.valign,
						bold: data.bold,
						italic: data.italic
					},
					rc.measure
				)
			: null
	);
	const transform = $derived(
		`rotate(${data.rotation} ${data.x + data.w / 2} ${data.y + data.h / 2}) translate(${data.x} ${data.y})`
	);
</script>

<g data-el={id} {transform}>
	{#if data.kind === 'note'}
		<path {d} transform="translate(3 4)" fill="#000000" opacity="0.08" />
	{/if}
	<path
		{d}
		fill={data.fill === 'transparent' ? (rc.exporting ? 'none' : 'transparent') : data.fill}
		stroke={data.stroke === 'transparent' ? 'none' : data.stroke}
		stroke-width={data.stroke === 'transparent' ? 0 : data.strokeWidth}
		stroke-dasharray={dash}
		stroke-linejoin="round"
	/>
	{#if layout}
		<text
			fill={color}
			font-family={FONT_FAMILY}
			font-size={data.fontSize}
			font-weight={data.bold ? 700 : 400}
			font-style={data.italic ? 'italic' : 'normal'}
			text-anchor={layout.anchor}
			style="white-space: pre"
		>
			{#each layout.lines as line, i (i)}
				<tspan x={line.x} y={line.y}>{line.text}</tspan>
			{/each}
		</text>
	{/if}
</g>
