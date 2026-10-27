<script lang="ts">
	// Etiketten-Designer (vollflächig): Zeichenfläche in mm, Elemente, Eigenschaften, Verlauf,
	// Format/Ziel, Speichern und Probedruck. `params.id` = Layout-ID oder `new` (`?starter=`).
	import { page } from '$app/state';
	import { beforeNavigate, goto } from '$app/navigation';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import Redo2 from '@lucide/svelte/icons/redo-2';
	import Type from '@lucide/svelte/icons/type';
	import QrCode from '@lucide/svelte/icons/qr-code';
	import Barcode from '@lucide/svelte/icons/barcode';
	import Image from '@lucide/svelte/icons/image';
	import Square from '@lucide/svelte/icons/square';
	import Minus from '@lucide/svelte/icons/minus';
	import SeparatorVertical from '@lucide/svelte/icons/separator-vertical';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ZoomIn from '@lucide/svelte/icons/zoom-in';
	import ZoomOut from '@lucide/svelte/icons/zoom-out';
	import Maximize from '@lucide/svelte/icons/maximize';
	import Printer from '@lucide/svelte/icons/printer';
	import Save from '@lucide/svelte/icons/save';
	import Lock from '@lucide/svelte/icons/lock';
	import { toast } from 'svelte-sonner';
	import { apiFetch, can } from '$lib/sdk/client';
	import {
		placeholdersIn,
		type LabelElement,
		type LabelElementType,
		type LabelLayout,
		type LabelLogo
	} from '$lib/sdk/labels';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { SelectField } from '$lib/components/ui/select-field';
	import {
		BUSY_SAVE,
		ErrorState,
		FormField,
		LoadingState,
		PageTitle,
		deviceLayout
	} from '$lib/components/layout';
	import {
		BASE_PATH,
		LABEL_FIELDS,
		LABEL_TARGETS,
		LABEL_TARGET_LABELS,
		PERMISSIONS,
		labelTemplateInput,
		type LabelFormatEntry,
		type LabelTarget,
		type LabelTemplate
	} from '../../schemas';
	import { API, errorText, fieldErrors } from '../helpers';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';
	import DesignerCanvas from './DesignerCanvas.svelte';
	import ElementProperties from './ElementProperties.svelte';
	import {
		clamp,
		createElement,
		createHistory,
		duplicateElement,
		MAX_ELEMENTS,
		nudge,
		overflowing,
		pushHistory,
		PX_PER_MM,
		redoHistory,
		reorder,
		round2,
		sampleValues,
		scaleLayout,
		undoHistory,
		type Box,
		type History,
		type LayerMove
	} from './designer';
	import { LABEL_STARTERS, starterLayout } from './starters';

	let { params }: ModulePageProps = $props();

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canDesign = $derived(can(permissions, PERMISSIONS.labels));
	const canPrint = $derived(canDesign || can(permissions, PERMISSIONS.manage));
	const phone = $derived(deviceLayout() === 'phone');
	const readonly = $derived(!canDesign || phone);
	const BACK = `${BASE_PATH}/etiketten`;

	type DesignState = { layout: LabelLayout; formatKey: string };

	let formats = $state<LabelFormatEntry[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let templateId = $state<string | null>(null);
	let name = $state('');
	let target = $state<LabelTarget>('unit');
	let hist = $state<History<DesignState>>(
		createHistory({ layout: { widthMm: 70, heightMm: 37, elements: [] }, formatKey: '' })
	);
	let savedJson = $state('');
	let saving = $state(false);
	let nameError = $state('');

	let selectedId = $state<string | null>(null);
	let live = $state<{ id: string; box: Box } | null>(null);
	let zoom = $state(3);
	let step = $state(0.5);
	let grid = $state(true);
	let rawPlaceholders = $state(false);
	let scaleOnFormat = $state(true);
	let printOpen = $state(false);
	let stageWidth = $state(0);
	let stageHeight = $state(0);
	let fitted = false;

	const layout = $derived(hist.present.layout);
	const formatKey = $derived(hist.present.formatKey);
	const displayLayout = $derived<LabelLayout>(
		live
			? {
					...layout,
					elements: layout.elements.map((e) => (e.id === live!.id ? { ...e, ...live!.box } : e))
				}
			: layout
	);
	const selected = $derived(displayLayout.elements.find((e) => e.id === selectedId) ?? null);
	const values = $derived(
		rawPlaceholders
			? Object.fromEntries(LABEL_FIELDS[target].map((f) => [f.key, `{${f.key}}`]))
			: sampleValues(target)
	);
	const currentJson = $derived(JSON.stringify({ name, target, ...hist.present }));
	const dirty = $derived(!loading && !loadError && currentJson !== savedJson);
	const outside = $derived(overflowing(layout));
	const unknownFields = $derived.by(() => {
		const known = new Set(LABEL_FIELDS[target].map((f) => f.key));
		const used = layout.elements.flatMap((e) =>
			e.type === 'text'
				? placeholdersIn(e.text)
				: e.type === 'barcode'
					? placeholdersIn(e.value)
					: []
		);
		return [...new Set(used.filter((k) => !known.has(k)))];
	});

	// --- Laden -----------------------------------------------------------------------

	let loadedId: string | null = null;
	$effect(() => {
		const id = params.id ?? 'new';
		if (id === loadedId) return;
		loadedId = id;
		void load(id);
	});

	async function load(id: string) {
		loading = true;
		loadError = '';
		selectedId = null;
		fitted = false;
		try {
			const [fmts, templates] = await Promise.all([
				apiFetch<LabelFormatEntry[]>(`${API}/label-formats`),
				id === 'new' ? Promise.resolve([]) : apiFetch<LabelTemplate[]>(`${API}/label-templates`)
			]);
			formats = fmts;
			if (id === 'new') {
				const key = page.url.searchParams.get('starter');
				const starter = LABEL_STARTERS.find((s) => s.id === key) ?? LABEL_STARTERS[0]!;
				const fmt = fmts.find((f) => f.key === starter.formatKey) ?? fmts[0];
				const w = fmt?.format.labelWidthMm ?? starter.widthMm;
				const h = fmt?.format.labelHeightMm ?? starter.heightMm;
				templateId = null;
				name = starter.id === 'empty' ? '' : starter.name;
				target = starter.target;
				hist = createHistory({ layout: starterLayout(starter, w, h), formatKey: fmt?.key ?? '' });
				// Neues Layout gilt erst nach dem Speichern als gesichert
				savedJson = '';
			} else {
				const t = templates.find((x) => x.id === id);
				if (!t) {
					loadError = 'Das Etikett-Layout gibt es nicht (mehr).';
					return;
				}
				templateId = t.id;
				name = t.name;
				target = t.target;
				hist = createHistory({ layout: t.layout, formatKey: t.formatKey });
				savedJson = JSON.stringify({ name, target, layout: t.layout, formatKey: t.formatKey });
			}
		} catch (e) {
			loadError = errorText(e, 'Das Layout konnte nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	// Beim ersten Anzeigen auf die Fläche einpassen
	$effect(() => {
		if (!fitted && !loading && stageWidth > 0 && stageHeight > 0) {
			fitted = true;
			fit();
		}
	});

	function fit() {
		const w = layout.widthMm * PX_PER_MM;
		const h = layout.heightMm * PX_PER_MM;
		const z = Math.min((stageWidth - 48) / w, (stageHeight - 48) / h);
		zoom = clamp(Math.floor(z * 10) / 10, 0.5, 12);
	}

	function zoomBy(f: number) {
		zoom = clamp(Math.round(zoom * f * 10) / 10, 0.5, 12);
	}

	// --- Änderungen --------------------------------------------------------------------

	function commit(next: DesignState, mergeKey: string | null = null) {
		hist = pushHistory(hist, next, mergeKey);
	}

	function setElements(elements: LabelElement[], mergeKey: string | null = null) {
		commit({ ...hist.present, layout: { ...layout, elements } }, mergeKey);
	}

	function boundBox(el: LabelElement): LabelElement {
		const w = clamp(el.w, 1, layout.widthMm);
		const h = clamp(el.h, 1, layout.heightMm);
		return {
			...el,
			w: round2(w),
			h: round2(h),
			x: round2(clamp(el.x, 0, layout.widthMm - w)),
			y: round2(clamp(el.y, 0, layout.heightMm - h))
		};
	}

	function patchSelected(patch: Record<string, unknown>, mergeKey: string | null) {
		if (readonly || !selectedId) return;
		const geometry = ['x', 'y', 'w', 'h'].some((k) => k in patch);
		setElements(
			layout.elements.map((e) => {
				if (e.id !== selectedId) return e;
				const next = { ...e, ...patch } as LabelElement;
				return geometry ? boundBox(next) : next;
			}),
			mergeKey
		);
	}

	function add(
		type: LabelElementType,
		opts: {
			logo?: LabelLogo;
			monochrome?: boolean;
			code128?: boolean;
			orientation?: 'horizontal' | 'vertical';
		} = {}
	) {
		if (readonly) return;
		if (layout.elements.length >= MAX_ELEMENTS) {
			toast.error(`Höchstens ${MAX_ELEMENTS} Elemente je Etikett`);
			return;
		}
		let el = createElement(type, layout, {
			target,
			logo: opts.logo,
			monochrome: opts.monochrome,
			orientation: opts.orientation
		});
		if (el.type === 'barcode' && opts.code128) {
			const w = round2(Math.min(layout.widthMm * 0.8, layout.widthMm));
			const h = round2(clamp(layout.heightMm * 0.35, 1, layout.heightMm));
			el = {
				...el,
				symbology: 'code128',
				value: '{code}',
				w,
				h,
				x: round2((layout.widthMm - w) / 2),
				y: round2((layout.heightMm - h) / 2)
			};
		}
		setElements([...layout.elements, el]);
		selectedId = el.id;
	}

	function removeSelected() {
		if (readonly || !selectedId) return;
		setElements(layout.elements.filter((e) => e.id !== selectedId));
		selectedId = null;
	}

	function duplicateSelected() {
		if (readonly || !selected) return;
		if (layout.elements.length >= MAX_ELEMENTS) return;
		const copy = duplicateElement(selected, { width: layout.widthMm, height: layout.heightMm });
		setElements([...layout.elements, copy]);
		selectedId = copy.id;
	}

	function layer(move: LayerMove) {
		if (!selectedId) return;
		setElements(reorder(layout.elements, selectedId, move));
	}

	function onCommitBox(id: string, box: Box) {
		setElements(layout.elements.map((e) => (e.id === id ? { ...e, ...box } : e)));
	}

	function changeFormat(key: string | null) {
		if (readonly || !key || key === formatKey) return;
		const f = formats.find((x) => x.key === key);
		if (!f) return;
		const w = f.format.labelWidthMm;
		const h = f.format.labelHeightMm;
		const next =
			scaleOnFormat && layout.elements.length
				? scaleLayout(layout, w, h)
				: { ...layout, widthMm: round2(w), heightMm: round2(h) };
		commit({ layout: next, formatKey: key });
		fitted = false;
	}

	function undo() {
		if (readonly) return;
		hist = undoHistory(hist);
		if (selectedId && !hist.present.layout.elements.some((e) => e.id === selectedId))
			selectedId = null;
	}
	function redo() {
		if (readonly) return;
		hist = redoHistory(hist);
	}

	// --- Tastatur ----------------------------------------------------------------------

	function onKeydown(e: KeyboardEvent) {
		if (loading || loadError || printOpen) return;
		const t = e.target as HTMLElement | null;
		if (
			t &&
			(t.isContentEditable ||
				['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) ||
				t.closest('[role="dialog"],[role="menu"],[role="listbox"]'))
		)
			return;
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key.toLowerCase() === 'z') {
			e.preventDefault();
			if (e.shiftKey) redo();
			else undo();
			return;
		}
		if (mod && e.key.toLowerCase() === 'y') {
			e.preventDefault();
			redo();
			return;
		}
		if (mod && e.key.toLowerCase() === 's') {
			e.preventDefault();
			void save();
			return;
		}
		if (!selected || readonly) {
			if (e.key === 'Escape') selectedId = null;
			return;
		}
		if (mod && e.key.toLowerCase() === 'd') {
			e.preventDefault();
			duplicateSelected();
		} else if (e.key === 'Delete' || e.key === 'Backspace') {
			e.preventDefault();
			removeSelected();
		} else if (e.key === 'Escape') {
			selectedId = null;
		} else if (e.key.startsWith('Arrow')) {
			const box = nudge(selected, e.key, e.shiftKey ? 5 : step || 0.5, {
				width: layout.widthMm,
				height: layout.heightMm
			});
			if (box) {
				e.preventDefault();
				setElements(
					layout.elements.map((x) => (x.id === selected.id ? { ...x, ...box } : x)),
					`${selected.id}:nudge`
				);
			}
		}
	}

	// --- Speichern ---------------------------------------------------------------------

	async function save(): Promise<boolean> {
		if (readonly || saving) return false;
		const payload = { name, target, layout, formatKey };
		const parsed = labelTemplateInput.safeParse(payload);
		if (!parsed.success) {
			const errs = fieldErrors(parsed.error);
			nameError = errs['name'] ?? '';
			const first = Object.entries(errs).find(([k]) => k !== 'name');
			toast.error(
				first
					? `Layout ungültig: ${first[1]}`
					: nameError
						? 'Bitte gib einen Namen ein'
						: 'Layout ungültig'
			);
			return false;
		}
		saving = true;
		nameError = '';
		try {
			const saved = templateId
				? await apiFetch<LabelTemplate>(`${API}/label-templates/${templateId}`, {
						method: 'PATCH',
						body: JSON.stringify(parsed.data)
					})
				: await apiFetch<LabelTemplate>(`${API}/label-templates`, {
						method: 'POST',
						body: JSON.stringify(parsed.data)
					});
			savedJson = currentJson;
			toast.success('Layout gespeichert');
			if (!templateId) {
				templateId = saved.id;
				loadedId = saved.id; // gleiches Layout, nicht neu laden
				await goto(`${BASE_PATH}/labels/${saved.id}`, { replaceState: true, noScroll: true });
			}
			return true;
		} catch (e) {
			toast.error(errorText(e, 'Speichern fehlgeschlagen'));
			return false;
		} finally {
			saving = false;
		}
	}

	async function testPrint() {
		if (dirty && !readonly) {
			const ok = await save();
			if (!ok) return;
		}
		if (!templateId) {
			toast.error('Speichere das Layout zuerst');
			return;
		}
		printOpen = true;
	}

	beforeNavigate((nav) => {
		if (!dirty || saving || readonly) return;
		if (nav.type === 'leave') {
			nav.cancel();
			return;
		}
		if (!confirm('Das Layout hat ungespeicherte Änderungen. Trotzdem verlassen?')) nav.cancel();
	});

	const formatOptions = $derived(
		formats.map((f) => ({ value: f.key, label: f.preset ? f.name : `${f.name} (eigenes)` }))
	);
	const fmtMm = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 2 });

	const ELEMENT_LABELS: Record<LabelElementType, string> = {
		text: 'Text',
		barcode: 'Barcode',
		image: 'Logo',
		rect: 'Rahmen',
		line: 'Linie'
	};
	function describe(el: LabelElement): string {
		if (el.type === 'text') return el.text || 'Text';
		if (el.type === 'image')
			return `${el.logo === 'lilie' ? 'Lilie' : 'Wappen'}${el.monochrome ? ' (schwarz-weiß)' : ''}`;
		if (el.type === 'line')
			return el.orientation === 'vertical' ? 'Linie senkrecht' : 'Linie waagerecht';
		if (el.type === 'barcode')
			return `${el.symbology === 'code128' ? 'Strichcode' : el.symbology === 'qrcode' ? 'QR' : 'DataMatrix'} ${el.value}`;
		return ELEMENT_LABELS[el.type];
	}
</script>

<svelte:window onkeydown={onKeydown} />

<PageTitle title={name ? `Etikett ${name}` : 'Etikett-Designer'} />

<div class="flex h-full min-h-0 flex-col">
	<header
		class="app-glass flex h-12 shrink-0 items-center gap-2 border-b bg-topbar-surface px-2 sm:px-3"
	>
		<Button
			variant="ghost"
			size="icon"
			href={BACK}
			aria-label="Zurück zu den Etiketten"
			title="Alle Etiketten"
		>
			<ArrowLeft />
		</Button>
		<div class="flex min-w-0 flex-1 items-center gap-2">
			{#if readonly}
				<h1 class="truncate text-sm font-semibold sm:text-base">{name || 'Etikett-Layout'}</h1>
				<Badge variant="secondary"><Lock aria-hidden="true" class="size-3" /> Nur Ansicht</Badge>
			{:else}
				<h1 class="sr-only">Etikett-Layout bearbeiten</h1>
				<Input
					aria-label="Name des Layouts"
					placeholder="Name des Layouts"
					bind:value={name}
					maxlength={150}
					aria-invalid={nameError ? true : undefined}
					class="h-8 max-w-xs min-w-0"
					oninput={() => (nameError = '')}
				/>
				{#if dirty}<span class="hidden text-xs text-muted-foreground sm:inline"
						>Nicht gespeichert</span
					>{/if}
			{/if}
		</div>
		{#if !readonly}
			<Button
				variant="ghost"
				size="icon"
				aria-label="Rückgängig"
				title="Rückgängig (Strg+Z)"
				disabled={!hist.past.length}
				onclick={undo}
			>
				<Undo2 />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				aria-label="Wiederholen"
				title="Wiederholen (Strg+Y)"
				disabled={!hist.future.length}
				onclick={redo}
			>
				<Redo2 />
			</Button>
		{/if}
		{#if canPrint}
			<Button
				variant="outline"
				size="sm"
				onclick={testPrint}
				disabled={loading || !!loadError || (!templateId && readonly)}
			>
				<Printer aria-hidden="true" /><span class="hidden sm:inline">Probedruck</span>
			</Button>
		{/if}
		{#if !readonly}
			<Button
				size="sm"
				onclick={save}
				disabled={saving || loading || !!loadError || (!dirty && !!templateId)}
			>
				<Save aria-hidden="true" />{saving ? BUSY_SAVE : 'Speichern'}
			</Button>
		{/if}
	</header>

	{#if loading}
		<div class="p-4"><LoadingState label="Layout" rows={4} rowClass="h-24 w-full" /></div>
	{:else if loadError}
		<div class="p-4">
			<ErrorState message={loadError} onretry={() => load(params.id ?? 'new')}>
				{#snippet details()}<Button href={BACK} variant="outline">Zu den Etiketten</Button
					>{/snippet}
			</ErrorState>
		</div>
	{:else}
		{#if phone && canDesign}
			<Alert.Root variant="info" class="m-2 w-auto">
				<Alert.Description>
					Auf dem Handy nur Ansicht – bearbeite das Layout am größeren Bildschirm.
				</Alert.Description>
			</Alert.Root>
		{/if}

		<!-- Werkzeugleiste -->
		<div class="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1.5">
			{#if !readonly}
				<Button variant="ghost" size="sm" onclick={() => add('text')}
					><Type aria-hidden="true" /> Text</Button
				>
				<Button variant="ghost" size="sm" onclick={() => add('barcode')}
					><QrCode aria-hidden="true" /> QR-Code</Button
				>
				<Button variant="ghost" size="sm" onclick={() => add('barcode', { code128: true })}>
					<Barcode aria-hidden="true" /> Strichcode
				</Button>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="ghost" size="sm">
								<Image aria-hidden="true" /> Logo <ChevronDown
									aria-hidden="true"
									class="size-3.5"
								/>
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start">
						<DropdownMenu.Item onSelect={() => add('image', { logo: 'wappen' })}>
							Wappen farbig
						</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => add('image', { logo: 'wappen', monochrome: true })}>
							Wappen schwarz-weiß
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item onSelect={() => add('image', { logo: 'lilie' })}>
							Lilie farbig
						</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => add('image', { logo: 'lilie', monochrome: true })}>
							Lilie schwarz-weiß
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
				<Button variant="ghost" size="sm" onclick={() => add('rect')}
					><Square aria-hidden="true" /> Rahmen</Button
				>
				<Button variant="ghost" size="sm" onclick={() => add('line')}
					><Minus aria-hidden="true" /> Linie waagerecht</Button
				>
				<Button variant="ghost" size="sm" onclick={() => add('line', { orientation: 'vertical' })}
					><SeparatorVertical aria-hidden="true" /> Linie senkrecht</Button
				>
				<span class="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden="true"></span>
			{/if}
			<div class="ml-auto flex flex-wrap items-center gap-1">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Verkleinern"
					onclick={() => zoomBy(1 / 1.25)}><ZoomOut /></Button
				>
				<span class="w-12 text-center text-xs tabular-nums" aria-live="polite"
					>{Math.round(zoom * 100)} %</span
				>
				<Button variant="ghost" size="icon-sm" aria-label="Vergrößern" onclick={() => zoomBy(1.25)}
					><ZoomIn /></Button
				>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Einpassen"
					title="Einpassen"
					onclick={fit}><Maximize /></Button
				>
				{#if !readonly}
					<SelectField
						label="Einrasten"
						size="sm"
						class="w-36 min-w-0"
						options={[
							{ value: '0', label: 'Frei' },
							{ value: '0.5', label: 'Raster 0,5 mm' },
							{ value: '1', label: 'Raster 1 mm' }
						]}
						value={String(step)}
						onchange={(v) => (step = Number(v ?? 0))}
					/>
				{/if}
				<div class="flex items-center gap-1.5 px-1">
					<Switch id="designer-grid" size="sm" bind:checked={grid} />
					<Label for="designer-grid" class="text-xs">Raster</Label>
				</div>
				<div class="flex items-center gap-1.5 px-1">
					<Switch id="designer-raw" size="sm" bind:checked={rawPlaceholders} />
					<Label for="designer-raw" class="text-xs">Platzhalter</Label>
				</div>
			</div>
		</div>

		<div class="flex min-h-0 flex-1 flex-col md:flex-row">
			<!-- Fläche -->
			<div
				class="relative min-h-64 flex-1 overflow-auto bg-muted"
				bind:clientWidth={stageWidth}
				bind:clientHeight={stageHeight}
			>
				<div
					class="flex min-h-full min-w-full items-center justify-center p-6"
					style="width: max-content"
				>
					<DesignerCanvas
						layout={displayLayout}
						{values}
						{zoom}
						{step}
						{grid}
						{readonly}
						bind:selectedId
						onpreview={(id, box) => (live = box ? { id, box } : null)}
						oncommit={onCommitBox}
					/>
				</div>
				<p
					class="pointer-events-none absolute bottom-2 left-3 text-xs text-muted-foreground tabular-nums"
				>
					{fmtMm(layout.widthMm)} × {fmtMm(layout.heightMm)} mm
				</p>
			</div>

			<!-- Seitenleiste -->
			<aside
				class="w-full shrink-0 space-y-5 overflow-y-auto border-t p-3 md:w-80 md:border-t-0 md:border-l"
			>
				{#if selected}
					<ElementProperties
						element={selected}
						{target}
						{readonly}
						onchange={patchSelected}
						onlayer={layer}
						onduplicate={duplicateSelected}
						ondelete={removeSelected}
					/>
				{:else}
					<section class="space-y-4" aria-labelledby="designer-label-heading">
						<h2 id="designer-label-heading" class="text-sm font-semibold">Etikett</h2>
						{#if readonly}
							<p class="text-sm text-muted-foreground">
								{LABEL_TARGET_LABELS[target]} · {formats.find((f) => f.key === formatKey)?.name ??
									formatKey}
							</p>
						{:else}
							<FormField label="Name" id="designer-name" required error={nameError}>
								<Input
									id="designer-name"
									bind:value={name}
									maxlength={150}
									oninput={() => (nameError = '')}
								/>
							</FormField>
							<FormField
								label="Ziel"
								id="designer-target"
								hint="Bestimmt, welche Felder es gibt und wo gedruckt wird."
							>
								<SelectField
									id="designer-target"
									label="Ziel"
									options={LABEL_TARGETS.map((t) => ({ value: t, label: LABEL_TARGET_LABELS[t] }))}
									value={target}
									onchange={(v) => v && (target = v as LabelTarget)}
								/>
							</FormField>
							<FormField
								label="Format"
								id="designer-format"
								hint="Die Etikettgröße des Formats ist die Größe des Layouts."
							>
								<SelectField
									id="designer-format"
									label="Format"
									options={formatOptions}
									value={formatKey || null}
									onchange={changeFormat}
								/>
							</FormField>
							<div class="flex items-center gap-2">
								<Checkbox id="designer-scale" bind:checked={scaleOnFormat} />
								<Label for="designer-scale">Elemente beim Formatwechsel mitskalieren</Label>
							</div>
						{/if}
						{#if outside.length}
							<p class="text-xs text-warning" role="status">
								{outside.length === 1 ? 'Ein Element ragt' : `${outside.length} Elemente ragen`} über
								den Rand und wird beim Druck abgeschnitten.
							</p>
						{/if}
						{#if unknownFields.length}
							<p class="text-xs text-warning" role="status">
								Für „{LABEL_TARGET_LABELS[target]}“ unbekannte Felder bleiben leer:
								{unknownFields.map((k) => `{${k}}`).join(', ')}
							</p>
						{/if}
						{#if !readonly}
							<p class="text-xs text-muted-foreground">
								Tipp: Element anklicken zum Bearbeiten, ziehen zum Verschieben, Griffe für die
								Größe. Pfeiltasten verschieben (mit Umschalt 5 mm), Entf löscht, Strg+Z/Y.
							</p>
						{/if}
					</section>
				{/if}

				<section class="space-y-2" aria-labelledby="designer-layers-heading">
					<h2 id="designer-layers-heading" class="text-sm font-semibold">
						Elemente <span class="font-normal text-muted-foreground tabular-nums"
							>({layout.elements.length}/{MAX_ELEMENTS})</span
						>
					</h2>
					{#if layout.elements.length}
						<ul class="space-y-0.5">
							{#each [...layout.elements].reverse() as el (el.id)}
								<li>
									<button
										type="button"
										class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted aria-pressed:bg-accent aria-pressed:text-accent-foreground"
										aria-pressed={el.id === selectedId}
										onclick={() => (selectedId = el.id === selectedId ? null : el.id)}
									>
										<span class="w-16 shrink-0 text-xs text-muted-foreground"
											>{ELEMENT_LABELS[el.type]}</span
										>
										<span class="truncate">{describe(el)}</span>
									</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-sm text-muted-foreground">Noch leer – füge oben Elemente hinzu.</p>
					{/if}
				</section>
			</aside>
		</div>
	{/if}
</div>

{#if templateId}
	<PrintLabelsDialog bind:open={printOpen} {target} ids={[]} {templateId} />
{/if}
