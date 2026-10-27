<script lang="ts">
	// Vorschau eines Etiketts – gleiches Modell und gleiche Darstellung wie das PDF
	// (`core/pdf/labels.ts`): absolute mm-Rahmen, Text mit Zeilenbegrenzung, Barcode-SVG füllt den Rahmen,
	// Rahmen/Linien als SVG in mm. Gerendert in echten CSS-mm/pt und per `transform: scale` gezoomt.
	import { SvelteMap } from 'svelte/reactivity';
	import { logoKey, resolveLayout, type LabelLayout } from '$lib/sdk/labels';
	import { cn } from '$lib/utils';
	import { PX_PER_MM } from '../labels/designer';
	import { barcodeUrl, loadLogos } from './label-assets';

	let {
		layout,
		values,
		zoom,
		maxWidth,
		maxHeight,
		showInvalid = false,
		class: className
	}: {
		layout: LabelLayout;
		/** Platzhalter-Werte (z. B. Beispielwerte aus `LABEL_FIELDS`) */
		values: Record<string, string>;
		/** Vergrößerung gegenüber echter Größe (1 = 1 mm Bildschirm-mm) */
		zoom?: number;
		/** Statt `zoom`: in diese Fläche (px) einpassen */
		maxWidth?: number;
		maxHeight?: number;
		/** Ungültige Barcodes als markierten Rahmen zeigen (Designer) */
		showInvalid?: boolean;
		class?: string;
	} = $props();

	const FONT = "'Carlito', Calibri, Arial, sans-serif";

	const scale = $derived.by(() => {
		if (zoom) return zoom;
		const w = layout.widthMm * PX_PER_MM;
		const h = layout.heightMm * PX_PER_MM;
		const candidates = [maxWidth ? maxWidth / w : Infinity, maxHeight ? maxHeight / h : Infinity];
		const s = Math.min(...candidates);
		return Number.isFinite(s) && s > 0 ? s : 1;
	});

	const elements = $derived(resolveLayout(layout, values));
	const codes = new SvelteMap<string, string | null>();
	let logos = $state<Record<string, string> | null>(null);

	const key = (type: string, value: string) => `${type}\n${value}`;

	$effect(() => {
		for (const el of elements) {
			if (el.type !== 'barcode') continue;
			const k = key(el.symbology, el.value);
			if (codes.has(k)) continue;
			void barcodeUrl(el.symbology, el.value).then((url) => codes.set(k, url));
		}
	});

	$effect(() => {
		if (!logos && elements.some((e) => e.type === 'image')) {
			void loadLogos().then((l) => (logos = l));
		}
	});

	const n = (v: number) => Math.round(v * 1000) / 1000;
	const mm = (v: number) => `${n(v)}mm`;
	const JUSTIFY = { left: 'flex-start', center: 'center', right: 'flex-end' } as const;
	const ITEMS = { top: 'flex-start', middle: 'center', bottom: 'flex-end' } as const;
</script>

<!--
	Etikettenfläche ist bewusst immer weiß mit schwarzer Schrift (wie das gedruckte Papier und
	QR-Codes), unabhängig von Hell/Dunkel – daher `bg-white` statt Token.
-->
<div
	class={cn('relative shrink-0 overflow-hidden bg-white', className)}
	style:width={`${layout.widthMm * PX_PER_MM * scale}px`}
	style:height={`${layout.heightMm * PX_PER_MM * scale}px`}
	aria-hidden="true"
>
	<div
		style:position="absolute"
		style:left="0"
		style:top="0"
		style:width={mm(layout.widthMm)}
		style:height={mm(layout.heightMm)}
		style:transform={`scale(${scale})`}
		style:transform-origin="0 0"
		style:font-family={FONT}
		style:color="#000"
	>
		{#each elements as el (el.id)}
			<div
				style:position="absolute"
				style:left={mm(el.x)}
				style:top={mm(el.y)}
				style:width={mm(el.w)}
				style:height={mm(el.h)}
				style:display={el.type === 'text' ? 'flex' : undefined}
				style:justify-content={el.type === 'text' ? JUSTIFY[el.align] : undefined}
				style:align-items={el.type === 'text' ? ITEMS[el.valign] : undefined}
				style:overflow={el.type === 'text' ? 'hidden' : undefined}
				style:font-size={el.type === 'text' ? `${n(el.fontSizePt)}pt` : undefined}
				style:line-height={el.type === 'text' ? '1.15' : undefined}
				style:font-weight={el.type === 'text' ? (el.bold ? 700 : 400) : undefined}
			>
				{#if el.type === 'text'}
					<span
						style:display="-webkit-box"
						style:-webkit-box-orient="vertical"
						style:-webkit-line-clamp={String(el.maxLines)}
						style:line-clamp={String(el.maxLines)}
						style:overflow="hidden"
						style:text-align={el.align}
						style:white-space="pre-line"
						style:overflow-wrap="anywhere">{el.text}</span
					>
				{:else if el.type === 'barcode'}
					{@const url = codes.get(key(el.symbology, el.value))}
					{#if url}
						<img src={url} alt="" style:width="100%" style:height="100%" style:display="block" />
					{:else if url === null && showInvalid}
						<div
							class="flex size-full items-center justify-center border border-dashed border-destructive text-center text-destructive"
							style:font-size="6pt"
						>
							Inhalt ungültig
						</div>
					{/if}
				{:else if el.type === 'image'}
					{#if logos}
						<img
							src={logos[logoKey(el)] ?? logos[el.logo]}
							alt=""
							style:width="100%"
							style:height="100%"
							style:object-fit="contain"
							style:display="block"
						/>
					{/if}
				{:else if el.type === 'rect'}
					<svg
						width="100%"
						height="100%"
						viewBox={`0 0 ${n(el.w)} ${n(el.h)}`}
						style:display="block"
						style:overflow="visible"
					>
						<rect
							x={n(el.stroke / 2)}
							y={n(el.stroke / 2)}
							width={n(Math.max(0, el.w - el.stroke))}
							height={n(Math.max(0, el.h - el.stroke))}
							rx={n(el.radius)}
							fill={el.filled ? '#000' : 'none'}
							stroke={el.stroke > 0 ? '#000' : 'none'}
							stroke-width={n(el.stroke)}
						/>
					</svg>
				{:else if el.type === 'line'}
					<svg
						width="100%"
						height="100%"
						viewBox={`0 0 ${n(el.w)} ${n(el.h)}`}
						style:display="block"
						style:overflow="visible"
					>
						{#if el.orientation === 'horizontal'}
							<line
								x1="0"
								y1={n(el.stroke / 2)}
								x2={n(el.w)}
								y2={n(el.stroke / 2)}
								stroke="#000"
								stroke-width={n(el.stroke)}
							/>
						{:else}
							<line
								x1={n(el.stroke / 2)}
								y1="0"
								x2={n(el.stroke / 2)}
								y2={n(el.h)}
								stroke="#000"
								stroke-width={n(el.stroke)}
							/>
						{/if}
					</svg>
				{/if}
			</div>
		{/each}
	</div>
</div>
