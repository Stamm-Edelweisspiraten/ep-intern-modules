<script lang="ts">
	// Eigenschaften des gewählten Elements. Änderungen gehen als Teil-Objekt an `onchange`
	// (mit Schlüssel zum Zusammenfassen schneller Eingaben im Verlauf).
	import Braces from '@lucide/svelte/icons/braces';
	import BringToFront from '@lucide/svelte/icons/bring-to-front';
	import SendToBack from '@lucide/svelte/icons/send-to-back';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import Copy from '@lucide/svelte/icons/copy';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { BARCODE_TYPES, BARCODE_TYPE_LABELS, type LabelElement } from '$lib/sdk/labels';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField, NumberStepper } from '$lib/components/layout';
	import { LABEL_FIELDS, type LabelTarget } from '../../schemas';
	import { MATERIAL_LABEL_LOGOS, MATERIAL_LABEL_LOGO_LABELS } from '../../label-logos';
	import type { LayerMove } from './designer';

	type Patch = Partial<Omit<LabelElement, 'id' | 'type'>> & Record<string, unknown>;

	let {
		element,
		target,
		readonly = false,
		onchange,
		onlayer,
		onduplicate,
		ondelete
	}: {
		element: LabelElement;
		target: LabelTarget;
		readonly?: boolean;
		onchange: (patch: Patch, mergeKey: string | null) => void;
		onlayer: (move: LayerMove) => void;
		onduplicate: () => void;
		ondelete: () => void;
	} = $props();

	const fields = $derived(LABEL_FIELDS[target]);
	let textRef = $state<HTMLTextAreaElement | null>(null);

	const TYPE_LABELS = {
		text: 'Text',
		barcode: 'Barcode',
		image: 'Logo',
		rect: 'Rahmen',
		line: 'Linie'
	} as const;

	function numberChange(key: string, raw: number, min: number, max: number) {
		if (!Number.isFinite(raw)) return;
		const v = Math.round(Math.min(Math.max(raw, min), max) * 100) / 100;
		onchange({ [key]: v }, `${element.id}:${key}`);
	}

	function insertField(key: string) {
		if (element.type !== 'text') return;
		const token = `{${key}}`;
		const el = textRef;
		const text = element.text;
		const start = el?.selectionStart ?? text.length;
		const end = el?.selectionEnd ?? text.length;
		const next = (text.slice(0, start) + token + text.slice(end)).slice(0, 500);
		onchange({ text: next }, null);
		queueMicrotask(() => {
			if (!el) return;
			el.focus();
			el.setSelectionRange(start + token.length, start + token.length);
		});
	}

	const id = (k: string) => `el-${k}`;
</script>

{#snippet mm(key: 'x' | 'y' | 'w' | 'h', label: string, min: number)}
	<FormField {label} id={id(key)}>
		<div class="relative">
			<Input
				id={id(key)}
				type="number"
				inputmode="decimal"
				step="0.5"
				{min}
				max="400"
				value={element[key]}
				disabled={readonly}
				class="pr-9 tabular-nums"
				oninput={(e) => numberChange(key, e.currentTarget.valueAsNumber, min, 400)}
			/>
			<span
				class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground"
				>mm</span
			>
		</div>
	</FormField>
{/snippet}

<div class="space-y-4">
	<div class="flex items-center justify-between gap-2">
		<h3 class="text-sm font-semibold">{TYPE_LABELS[element.type]}</h3>
		{#if !readonly}
			<div class="flex items-center gap-0.5">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Duplizieren"
					title="Duplizieren (Strg+D)"
					onclick={onduplicate}
				>
					<Copy />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Löschen"
					title="Löschen (Entf)"
					onclick={ondelete}
				>
					<Trash2 />
				</Button>
			</div>
		{/if}
	</div>

	<div class="grid grid-cols-2 gap-2">
		{@render mm('x', 'X', 0)}
		{@render mm('y', 'Y', 0)}
		{@render mm('w', 'Breite', 1)}
		{@render mm('h', 'Höhe', 1)}
	</div>

	{#if element.type === 'text'}
		<FormField
			label="Text"
			id={id('text')}
			hint="Platzhalter in geschweiften Klammern, z. B. {'{name}'}"
		>
			<Textarea
				id={id('text')}
				bind:ref={textRef}
				value={element.text}
				maxlength={500}
				rows={3}
				disabled={readonly}
				oninput={(e) => onchange({ text: e.currentTarget.value }, `${element.id}:text`)}
			/>
		</FormField>
		{#if !readonly}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" size="sm">
							<Braces aria-hidden="true" /> Feld einfügen
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-64">
					{#each fields as f (f.key)}
						<DropdownMenu.Item onSelect={() => insertField(f.key)}>
							<span class="flex min-w-0 flex-col">
								<span>{f.label}</span>
								<span class="truncate text-xs text-muted-foreground">{f.sample}</span>
							</span>
						</DropdownMenu.Item>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}
		<div class="grid grid-cols-2 gap-2">
			<FormField label="Schriftgröße" id={id('font')}>
				<div class="relative">
					<Input
						id={id('font')}
						type="number"
						inputmode="decimal"
						step="0.5"
						min="4"
						max="96"
						value={element.fontSizePt}
						disabled={readonly}
						class="pr-8 tabular-nums"
						oninput={(e) => numberChange('fontSizePt', e.currentTarget.valueAsNumber, 4, 96)}
					/>
					<span
						class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground"
						>pt</span
					>
				</div>
			</FormField>
			<FormField label="Max. Zeilen" id={id('lines')}>
				<NumberStepper
					id={id('lines')}
					label="Maximale Zeilen"
					value={element.maxLines}
					min={1}
					max={20}
					disabled={readonly}
					onchange={(v) => onchange({ maxLines: v }, `${element.id}:lines`)}
				/>
			</FormField>
			<FormField label="Waagerecht" id={id('align')}>
				<SelectField
					id={id('align')}
					label="Waagerechte Ausrichtung"
					disabled={readonly}
					options={[
						{ value: 'left', label: 'Links' },
						{ value: 'center', label: 'Mitte' },
						{ value: 'right', label: 'Rechts' }
					]}
					value={element.align}
					onchange={(v) => v && onchange({ align: v }, null)}
				/>
			</FormField>
			<FormField label="Senkrecht" id={id('valign')}>
				<SelectField
					id={id('valign')}
					label="Senkrechte Ausrichtung"
					disabled={readonly}
					options={[
						{ value: 'top', label: 'Oben' },
						{ value: 'middle', label: 'Mitte' },
						{ value: 'bottom', label: 'Unten' }
					]}
					value={element.valign}
					onchange={(v) => v && onchange({ valign: v }, null)}
				/>
			</FormField>
		</div>
		<div class="flex items-center gap-2">
			<Checkbox
				id={id('bold')}
				checked={element.bold}
				disabled={readonly}
				onCheckedChange={(v) => onchange({ bold: v === true }, null)}
			/>
			<Label for={id('bold')}>Fett</Label>
		</div>
	{:else if element.type === 'barcode'}
		<FormField label="Art" id={id('symbology')}>
			<SelectField
				id={id('symbology')}
				label="Barcode-Art"
				disabled={readonly}
				options={BARCODE_TYPES.map((t) => ({ value: t, label: BARCODE_TYPE_LABELS[t] }))}
				value={element.symbology}
				onchange={(v) => v && onchange({ symbology: v }, null)}
			/>
		</FormField>
		<FormField
			label="Inhalt"
			id={id('value')}
			hint={element.symbology === 'qrcode'
				? 'Für das Handy: {url} öffnet direkt die Scan-Seite.'
				: 'Für Handscanner: {code} ist kurz und gut lesbar.'}
		>
			<Input
				id={id('value')}
				value={element.value}
				maxlength={300}
				disabled={readonly}
				oninput={(e) => {
					const v = e.currentTarget.value;
					if (v.length) onchange({ value: v }, `${element.id}:value`);
				}}
			/>
		</FormField>
		{#if !readonly}
			<div class="flex flex-wrap gap-1.5">
				{#each fields.filter((f) => f.key === 'url' || f.key === 'code') as f (f.key)}
					<Button
						variant="outline"
						size="xs"
						onclick={() => onchange({ value: `{${f.key}}` }, null)}
					>
						{f.label}
					</Button>
				{/each}
			</div>
		{/if}
		{#if element.symbology === 'code128' && element.value.includes('{url}')}
			<p class="text-xs text-warning" role="status">
				Ein Link als Strichcode wird sehr lang und schwer lesbar – nimm besser {'{code}'} oder einen QR-Code.
			</p>
		{/if}
	{:else if element.type === 'image'}
		<FormField label="Logo" id={id('logo')}>
			<SelectField
				id={id('logo')}
				label="Logo"
				disabled={readonly}
				options={MATERIAL_LABEL_LOGOS.map((l) => ({
					value: l,
					label: MATERIAL_LABEL_LOGO_LABELS[l]
				}))}
				value={element.logo}
				onchange={(v) => v && onchange({ logo: v }, null)}
			/>
		</FormField>
		<div class="flex items-center gap-2">
			<Switch
				id={id('monochrome')}
				checked={element.monochrome === true}
				disabled={readonly}
				onCheckedChange={(v) => onchange({ monochrome: v === true }, null)}
			/>
			<Label for={id('monochrome')}>Schwarz-Weiß</Label>
		</div>
		<p class="text-xs text-muted-foreground">
			Für Laser- und Thermodrucker ohne Farbe – druckt sauberer als ein gerastertes Farblogo.
		</p>
	{:else if element.type === 'rect'}
		<div class="grid grid-cols-2 gap-2">
			<FormField label="Linienstärke" id={id('stroke')} hint="0 = ohne Linie">
				<Input
					id={id('stroke')}
					type="number"
					inputmode="decimal"
					step="0.1"
					min="0"
					max="5"
					value={element.stroke}
					disabled={readonly}
					class="tabular-nums"
					oninput={(e) => numberChange('stroke', e.currentTarget.valueAsNumber, 0, 5)}
				/>
			</FormField>
			<FormField label="Eckenradius" id={id('radius')}>
				<Input
					id={id('radius')}
					type="number"
					inputmode="decimal"
					step="0.5"
					min="0"
					max="50"
					value={element.radius}
					disabled={readonly}
					class="tabular-nums"
					oninput={(e) => numberChange('radius', e.currentTarget.valueAsNumber, 0, 50)}
				/>
			</FormField>
		</div>
		<div class="flex items-center gap-2">
			<Checkbox
				id={id('filled')}
				checked={element.filled}
				disabled={readonly}
				onCheckedChange={(v) => onchange({ filled: v === true }, null)}
			/>
			<Label for={id('filled')}>Schwarz gefüllt</Label>
		</div>
	{:else if element.type === 'line'}
		<div class="grid grid-cols-2 gap-2">
			<FormField label="Linienstärke" id={id('stroke')} hint="in mm">
				<Input
					id={id('stroke')}
					type="number"
					inputmode="decimal"
					step="0.1"
					min="0.1"
					max="5"
					value={element.stroke}
					disabled={readonly}
					class="tabular-nums"
					oninput={(e) => numberChange('stroke', e.currentTarget.valueAsNumber, 0.1, 5)}
				/>
			</FormField>
			<FormField label="Richtung" id={id('orientation')}>
				<SelectField
					id={id('orientation')}
					label="Richtung"
					disabled={readonly}
					options={[
						{ value: 'horizontal', label: 'Waagerecht' },
						{ value: 'vertical', label: 'Senkrecht' }
					]}
					value={element.orientation}
					onchange={(v) => {
						if (!v || v === element.orientation) return;
						// Rahmen drehen, damit die Linie sichtbar lang bleibt
						onchange({ orientation: v, w: element.h, h: element.w }, null);
					}}
				/>
			</FormField>
		</div>
	{/if}

	{#if !readonly}
		<fieldset class="space-y-1.5">
			<legend class="text-xs font-medium text-muted-foreground">Ebene</legend>
			<div class="flex flex-wrap gap-1">
				<Button variant="outline" size="xs" onclick={() => onlayer('front')}>
					<BringToFront aria-hidden="true" /> Ganz nach vorne
				</Button>
				<Button
					variant="outline"
					size="xs"
					onclick={() => onlayer('forward')}
					aria-label="Eine Ebene nach vorne"
				>
					<ArrowUp aria-hidden="true" />
				</Button>
				<Button
					variant="outline"
					size="xs"
					onclick={() => onlayer('backward')}
					aria-label="Eine Ebene nach hinten"
				>
					<ArrowDown aria-hidden="true" />
				</Button>
				<Button variant="outline" size="xs" onclick={() => onlayer('back')}>
					<SendToBack aria-hidden="true" /> Ganz nach hinten
				</Button>
			</div>
		</fieldset>
	{/if}
</div>
