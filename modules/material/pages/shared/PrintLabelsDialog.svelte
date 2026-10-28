<script lang="ts">
	// Etiketten drucken: Layout (passend zum Ziel), Format, Kopien, Startfeld auf angebrochenen Bögen,
	// Umrisse für den Testdruck → PDF (`POST /labels.pdf`). Ohne `ids` (Testdruck aus Etikettenseite/Designer)
	// werden die Objekte hier gewählt (`ItemPicker`).
	// API: `<PrintLabelsDialog bind:open target={'item' | 'location' | 'blank'} ids={string[]} title?={string} />`
	import Printer from '@lucide/svelte/icons/printer';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { fitLayout, labelsPerPage, formatProblem, type LabelFormat } from '$lib/sdk/labels';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { ErrorState, FormField, LoadingState, NumberStepper } from '$lib/components/layout';
	import { downloadPdf } from '$lib/components/layout/download';
	import {
		BASE_PATH,
		LABEL_TARGET_LABELS,
		type LabelFormatEntry,
		type LabelTarget,
		type LabelTemplate
	} from '../../schemas';
	import { API, errorText } from '../helpers';
	import { formatSize, sampleValues } from '../labels/designer';
	import LabelPreview from './LabelPreview.svelte';
	import SheetPreview from './SheetPreview.svelte';
	import ItemPicker from './ItemPicker.svelte';

	let {
		open = $bindable(false),
		target,
		ids = [],
		codes = [],
		title,
		templateId
	}: {
		/** Dialog offen */
		open?: boolean;
		/** Art der Objekte */
		target: LabelTarget;
		/** IDs der Objekte (Lagerartikel oder Lagerorte), Reihenfolge = Druckreihenfolge; leer = hier wählen */
		ids?: string[];
		/** Untertitel, z. B. Name des Artikels („Kohtenbahn K1.1“) */
		title?: string;
		/** Nur `blank`: vorab vergebene Codes */
		codes?: string[];
		/** Layout vorwählen (z. B. Testdruck aus dem Designer) */
		templateId?: string;
	} = $props();

	let templates = $state<LabelTemplate[]>([]);
	let formats = $state<LabelFormatEntry[]>([]);
	let loading = $state(false);
	let loadError = $state('');
	let busy = $state(false);
	let error = $state('');

	let chosenTemplate = $state<string | null>(null);
	let formatKey = $state<string | null>(null);
	let copies = $state(1);
	let startIndex = $state(0);
	let outlines = $state(false);

	// Testdruck ohne vorgegebene Objekte
	let pickedIds = $state<string[]>([]);

	const probe = $derived(target === 'blank' ? codes.length === 0 : ids.length === 0);
	const PROBE_CODES = ['M-PROBE'];
	const effectiveIds = $derived(probe ? pickedIds : ids);
	const effectiveCodes = $derived(target === 'blank' ? (probe ? PROBE_CODES : codes) : []);
	const objectCount = $derived(target === 'blank' ? effectiveCodes.length : effectiveIds.length);

	const matching = $derived(templates.filter((t) => t.target === target));
	const template = $derived(matching.find((t) => t.id === chosenTemplate) ?? null);
	const format = $derived<LabelFormat | null>(
		formats.find((f) => f.key === formatKey)?.format ?? null
	);
	const total = $derived(objectCount * copies);
	const pages = $derived.by(() => {
		if (!format || !total) return 0;
		if (format.kind === 'roll') return total;
		return Math.ceil((startIndex + total) / labelsPerPage(format));
	});
	const scaled = $derived.by(() => {
		if (!template || !format) return null;
		const fit = fitLayout(template.layout, {
			width: format.labelWidthMm,
			height: format.labelHeightMm
		});
		return Math.abs(fit.scale - 1) > 0.005 ? fit.scale : null;
	});

	let loadedFor = false;
	$effect(() => {
		if (!open) {
			loadedFor = false;
			return;
		}
		if (loadedFor) return;
		loadedFor = true;
		error = '';
		copies = 1;
		startIndex = 0;
		pickedIds = [];
		void load();
	});

	async function load() {
		loading = true;
		loadError = '';
		try {
			const [t, f] = await Promise.all([
				apiFetch<LabelTemplate[]>(`${API}/label-templates`),
				apiFetch<LabelFormatEntry[]>(`${API}/label-formats`)
			]);
			templates = t;
			formats = f;
			const own = t.filter((x) => x.target === target);
			const pre = own.find((x) => x.id === templateId) ?? own[0] ?? null;
			chosenTemplate = pre?.id ?? null;
			formatKey = pre?.formatKey ?? null;
		} catch (e) {
			loadError = errorText(e, 'Etiketten-Layouts konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	function chooseTemplate(id: string | null) {
		chosenTemplate = id;
		const t = matching.find((x) => x.id === id);
		if (t) formatKey = t.formatKey;
		startIndex = 0;
	}

	const formatOptions = $derived(
		formats.map((f) => ({
			value: f.key,
			label: `${f.name} · ${formatSize(f.format)}${f.preset ? '' : ' (eigene)'}`
		}))
	);

	async function print() {
		if (!template || !formatKey) return;
		if (!objectCount) {
			error = 'Wähle mindestens ein Objekt.';
			return;
		}
		busy = true;
		error = '';
		try {
			await downloadPdf(
				`/api/v1${API}/labels.pdf`,
				{
					method: 'POST',
					body: JSON.stringify({
						templateId: template.id,
						formatKey,
						target,
						ids: target === 'blank' ? [] : effectiveIds,
						codes: effectiveCodes,
						copies,
						startIndex: format?.kind === 'sheet' ? startIndex : 0,
						outlines
					})
				},
				'Etiketten.pdf'
			);
			toast.success(total === 1 ? 'Etikett erstellt' : `${total} Etiketten erstellt`);
			open = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'PDF konnte nicht erstellt werden.';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Etiketten drucken</Dialog.Title>
			<Dialog.Description>
				{title ?? LABEL_TARGET_LABELS[target]}{probe
					? ' – Testdruck'
					: ids.length > 1 || !title
						? ` – ${objectCount} ${objectCount === 1 ? 'Objekt' : 'Objekte'}`
						: ''}
			</Dialog.Description>
		</Dialog.Header>

		{#if loading}
			<LoadingState label="Etiketten-Layouts" rows={3} />
		{:else if loadError}
			<ErrorState message={loadError} onretry={load} compact />
		{:else if !matching.length}
			<Alert.Root variant="info">
				<Alert.Title>Noch kein passendes Layout</Alert.Title>
				<Alert.Description>
					Für „{LABEL_TARGET_LABELS[target]}“ gibt es noch kein Etikett-Layout.
					<a
						class="text-link underline-offset-4 hover:underline"
						href={`${BASE_PATH}?tab=etiketten`}
					>
						Layout anlegen
					</a>
				</Alert.Description>
			</Alert.Root>
		{:else}
			<div class="grid gap-4 sm:grid-cols-[1fr_auto]">
				<div class="min-w-0 space-y-4">
					<FormField label="Layout" id="print-template">
						<SelectField
							id="print-template"
							label="Layout"
							options={matching.map((t) => ({ value: t.id, label: t.name }))}
							value={chosenTemplate}
							onchange={chooseTemplate}
						/>
					</FormField>
					<FormField
						label="Etikettgröße"
						id="print-format"
						hint={scaled
							? `Das Layout wird auf ${Math.round(scaled * 100)} % skaliert.`
							: 'Standard ist das Format des Layouts.'}
					>
						<SelectField
							id="print-format"
							label="Etikettgröße"
							options={formatOptions}
							value={formatKey}
							onchange={(v) => {
								formatKey = v;
								startIndex = 0;
							}}
						/>
					</FormField>

					{#if probe && target !== 'blank'}
						<div class="space-y-1.5">
							<Label for="print-objects">
								{target === 'location'
									? 'Lagerorte für den Testdruck'
									: 'Artikel für den Testdruck'}
							</Label>
							<ItemPicker
								id="print-objects"
								{target}
								bind:selected={pickedIds}
								label={target === 'location' ? 'Lagerorte suchen' : 'Artikel suchen'}
							/>
						</div>
					{:else if probe}
						<p class="text-xs text-muted-foreground">
							Testdruck mit dem Beispiel-Code „{PROBE_CODES[0]}“ (wird keinem Artikel zugeordnet).
						</p>
					{/if}

					<FormField label="Etiketten je Objekt" id="print-copies">
						<NumberStepper
							id="print-copies"
							label="Etiketten je Objekt"
							bind:value={copies}
							min={1}
							max={20}
						/>
					</FormField>

					<div class="flex items-start gap-2">
						<Checkbox id="print-outlines" bind:checked={outlines} />
						<div class="grid gap-0.5">
							<Label for="print-outlines">Umrisse drucken</Label>
							<span class="text-xs text-muted-foreground">
								Für einen Testdruck auf normalem Papier – zum Abgleich mit dem Etikettenbogen.
							</span>
						</div>
					</div>
				</div>

				<div class="space-y-3">
					{#if template}
						<div class="space-y-1">
							<p class="text-xs text-muted-foreground">Vorschau mit Beispielwerten</p>
							<div class="inline-block rounded-sm border shadow-sm">
								<LabelPreview
									layout={template.layout}
									values={sampleValues(target)}
									maxWidth={200}
									maxHeight={140}
								/>
							</div>
						</div>
					{/if}
					{#if format}
						{#if format.kind === 'sheet'}
							<div class="space-y-1">
								<p class="text-xs text-muted-foreground">
									Startfeld: <span class="tabular-nums">{startIndex + 1}</span> – klicke auf das erste
									freie Feld eines angebrochenen Bogens.
								</p>
								<SheetPreview
									{format}
									bind:startIndex
									selectable
									count={total}
									width={200}
									label="Startfeld auf dem Bogen wählen"
								/>
							</div>
						{:else}
							<p class="max-w-52 text-xs text-muted-foreground">
								Rolle: ein Etikett je PDF-Seite ({format.labelWidthMm} × {format.labelHeightMm} mm).
							</p>
						{/if}
						{#if formatProblem(format)}
							<p class="text-xs text-destructive" role="alert">{formatProblem(format)}</p>
						{/if}
					{/if}
				</div>
			</div>

			<p class="text-sm" aria-live="polite">
				<span class="tabular-nums">{total}</span>
				{total === 1 ? 'Etikett' : 'Etiketten'} auf
				<span class="tabular-nums">{pages}</span>
				{pages === 1 ? 'Seite' : 'Seiten'}
			</p>
		{/if}

		{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button onclick={print} disabled={busy || !template || !format || !total}>
				<Printer aria-hidden="true" />
				{busy ? 'Erstellt …' : 'PDF erstellen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
