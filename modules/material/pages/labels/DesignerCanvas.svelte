<script lang="ts">
	// Zeichenfläche des Etiketten-Designers: echte Vorschau (LabelPreview) + Bedienebene mit Auswahl,
	// Ziehen und Größen-Griffen (Pointer Events → Maus, Stift, Touch). Rechnen in `designer.ts`.
	import type { LabelElement, LabelLayout } from '$lib/sdk/labels';
	import { cn } from '$lib/utils';
	import LabelPreview from '../shared/LabelPreview.svelte';
	import { HANDLES, moveBox, PX_PER_MM, resizeBox, type Box, type Handle } from './designer';

	let {
		layout,
		values,
		zoom,
		step,
		grid = true,
		selectedId = $bindable(null),
		readonly = false,
		onpreview,
		oncommit
	}: {
		layout: LabelLayout;
		values: Record<string, string>;
		/** Vergrößerung gegenüber echter Größe */
		zoom: number;
		/** Raster zum Einrasten in mm (0 = aus) */
		step: number;
		grid?: boolean;
		selectedId?: string | null;
		readonly?: boolean;
		/** Live-Vorschau während des Ziehens (ohne Verlaufsschritt) */
		onpreview: (id: string, box: Box | null) => void;
		/** Ziehen beendet: endgültige Position/Größe */
		oncommit: (id: string, box: Box) => void;
	} = $props();

	const scale = $derived(PX_PER_MM * zoom);
	const px = (mm: number) => `${mm * scale}px`;

	type Drag = {
		id: string;
		mode: 'move' | Handle;
		pointerId: number;
		startX: number;
		startY: number;
		start: Box;
		last: Box | null;
		keepAspect: boolean;
	};
	let drag: Drag | null = null;

	const keepsAspect = (el: LabelElement) =>
		el.type === 'image' || (el.type === 'barcode' && el.symbology !== 'code128');

	function begin(e: PointerEvent, el: LabelElement, mode: Drag['mode']) {
		if (e.button !== 0) return;
		e.stopPropagation();
		selectedId = el.id;
		if (readonly) return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		drag = {
			id: el.id,
			mode,
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			start: { x: el.x, y: el.y, w: el.w, h: el.h },
			last: null,
			keepAspect: keepsAspect(el)
		};
	}

	function move(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		const dx = (e.clientX - drag.startX) / scale;
		const dy = (e.clientY - drag.startY) / scale;
		// Kleine Zitterbewegungen beim Antippen nicht als Verschieben werten
		if (!drag.last && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 3) return;
		const bounds = { width: layout.widthMm, height: layout.heightMm };
		const box =
			drag.mode === 'move'
				? moveBox(drag.start, dx, dy, { step, bounds })
				: resizeBox(drag.start, drag.mode, dx, dy, {
						step,
						bounds,
						keepAspect: drag.keepAspect && !e.shiftKey
					});
		drag.last = box;
		onpreview(drag.id, box);
	}

	function end(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		const d = drag;
		drag = null;
		onpreview(d.id, null);
		if (d.last && e.type === 'pointerup') oncommit(d.id, d.last);
	}

	const HANDLE_POS: Record<Handle, { left: string; top: string; cursor: string }> = {
		nw: { left: '0%', top: '0%', cursor: 'nwse-resize' },
		n: { left: '50%', top: '0%', cursor: 'ns-resize' },
		ne: { left: '100%', top: '0%', cursor: 'nesw-resize' },
		e: { left: '100%', top: '50%', cursor: 'ew-resize' },
		se: { left: '100%', top: '100%', cursor: 'nwse-resize' },
		s: { left: '50%', top: '100%', cursor: 'ns-resize' },
		sw: { left: '0%', top: '100%', cursor: 'nesw-resize' },
		w: { left: '0%', top: '50%', cursor: 'ew-resize' }
	};

	/** Waagerechte Linien brauchen nur links/rechts, senkrechte nur oben/unten */
	function handlesFor(el: LabelElement): Handle[] {
		if (el.type === 'line') return el.orientation === 'horizontal' ? ['w', 'e'] : ['n', 's'];
		return HANDLES;
	}

	const gridCell = $derived(scale >= 7 ? 1 : 5);
	// Raster auf der (immer weißen) Etikettenfläche: feste, dezente Linienfarbe
	const gridStyle = $derived(
		grid
			? `background-image: linear-gradient(to right, rgb(0 0 0 / 0.07) 1px, transparent 1px), linear-gradient(to bottom, rgb(0 0 0 / 0.07) 1px, transparent 1px); background-size: ${gridCell * scale}px ${gridCell * scale}px;`
			: ''
	);

	function label(el: LabelElement): string {
		switch (el.type) {
			case 'text':
				return `Text ${el.text}`;
			case 'barcode':
				return `Barcode ${el.value}`;
			case 'image':
				return 'Logo';
			case 'rect':
				return 'Rahmen';
			case 'line':
				return 'Linie';
		}
	}
</script>

<div
	class="relative shadow-md ring-1 ring-border"
	style:width={px(layout.widthMm)}
	style:height={px(layout.heightMm)}
>
	<LabelPreview {layout} {values} {zoom} showInvalid />
	<!-- Bedienebene: gleiche Größe, Elemente als unsichtbare Schaltflächen, Auswahl mit Griffen -->
	<div
		class="absolute inset-0 touch-none select-none"
		style={gridStyle}
		role="presentation"
		onpointerdown={(e) => {
			if (e.target === e.currentTarget) selectedId = null;
		}}
	>
		{#each layout.elements as el (el.id)}
			{@const selected = el.id === selectedId}
			<button
				type="button"
				tabindex="-1"
				aria-label={label(el)}
				class={cn(
					'absolute block outline-none',
					readonly ? 'cursor-pointer' : 'cursor-move',
					selected
						? 'outline-2 outline-offset-0 outline-ring'
						: 'hover:outline-1 hover:outline-dashed hover:outline-ring/70'
				)}
				style:left={px(el.x)}
				style:top={px(el.y)}
				style:width={px(el.w)}
				style:height={px(el.h)}
				onpointerdown={(e) => begin(e, el, 'move')}
				onpointermove={move}
				onpointerup={end}
				onpointercancel={end}
			>
				{#if selected && !readonly}
					{#each handlesFor(el) as h (h)}
						<span
							role="presentation"
							class="absolute z-10 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-ring bg-background after:absolute after:-inset-2 pointer-coarse:size-4"
							style:left={HANDLE_POS[h].left}
							style:top={HANDLE_POS[h].top}
							style:cursor={HANDLE_POS[h].cursor}
							onpointerdown={(e) => begin(e, el, h)}
							onpointermove={move}
							onpointerup={end}
							onpointercancel={end}
						></span>
					{/each}
				{/if}
			</button>
		{/each}
	</div>
</div>
