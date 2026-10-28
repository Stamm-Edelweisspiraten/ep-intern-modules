<script lang="ts">
	// Eigene Etikettgröße (Format) anlegen/bearbeiten (Bogen oder Rolle) mit Live-Vorschau des Bogens.
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import {
		formatProblem,
		labelsPerPage,
		LABEL_FORMAT_PRESETS,
		type LabelFormat
	} from '$lib/sdk/labels';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField, BUSY_SAVE } from '$lib/components/layout';
	import { labelFormatInput, type LabelFormatEntry } from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import SheetPreview from '../shared/SheetPreview.svelte';
	import { round2 } from './designer';

	let {
		open = $bindable(false),
		entry = null,
		onsaved
	}: {
		open?: boolean;
		/** Zu bearbeitendes eigenes Format; `null` = neu */
		entry?: LabelFormatEntry | null;
		onsaved?: (entry: LabelFormatEntry) => void | Promise<void>;
	} = $props();

	type Kind = 'sheet' | 'roll';
	let name = $state('');
	let kind = $state<Kind>('sheet');
	// Alle Werte in mm (bzw. Anzahl)
	let v = $state({
		pageWidthMm: 210,
		pageHeightMm: 297,
		cols: 3,
		rows: 8,
		labelWidthMm: 70,
		labelHeightMm: 37,
		marginTopMm: 0,
		marginLeftMm: 0,
		gapXMm: 0,
		gapYMm: 0
	});
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	function apply(f: LabelFormat) {
		kind = f.kind;
		if (f.kind === 'sheet') v = { ...f };
		else v = { ...v, labelWidthMm: f.labelWidthMm, labelHeightMm: f.labelHeightMm };
	}

	let initFor: string | null = null;
	$effect(() => {
		if (!open) {
			initFor = null;
			return;
		}
		const key = entry?.key ?? 'new';
		if (initFor === key) return;
		initFor = key;
		name = entry?.name ?? '';
		apply(entry?.format ?? LABEL_FORMAT_PRESETS[0]!.format);
		error = '';
		errors = {};
	});

	const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
	const format = $derived<LabelFormat>(
		kind === 'roll'
			? { kind: 'roll', labelWidthMm: num(v.labelWidthMm), labelHeightMm: num(v.labelHeightMm) }
			: {
					kind: 'sheet',
					pageWidthMm: num(v.pageWidthMm),
					pageHeightMm: num(v.pageHeightMm),
					cols: Math.round(num(v.cols)),
					rows: Math.round(num(v.rows)),
					labelWidthMm: num(v.labelWidthMm),
					labelHeightMm: num(v.labelHeightMm),
					marginTopMm: num(v.marginTopMm),
					marginLeftMm: num(v.marginLeftMm),
					gapXMm: num(v.gapXMm),
					gapYMm: num(v.gapYMm)
				}
	);
	const problem = $derived(formatProblem(format));

	function center() {
		const usedW = format.kind === 'sheet' ? v.cols * v.labelWidthMm + (v.cols - 1) * v.gapXMm : 0;
		const usedH = format.kind === 'sheet' ? v.rows * v.labelHeightMm + (v.rows - 1) * v.gapYMm : 0;
		v.marginLeftMm = round2(Math.max(0, (v.pageWidthMm - usedW) / 2));
		v.marginTopMm = round2(Math.max(0, (v.pageHeightMm - usedH) / 2));
	}

	const presetOptions = LABEL_FORMAT_PRESETS.map((p) => ({ value: p.key, label: p.name }));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const parsed = labelFormatInput.safeParse({ name, format });
		if (!parsed.success) {
			errors = fieldErrors(parsed.error);
			error = errors['format'] ?? '';
			return;
		}
		busy = true;
		error = '';
		errors = {};
		try {
			const saved = entry?.id
				? await apiFetch<LabelFormatEntry>(`${API}/label-formats/${entry.id}`, {
						method: 'PATCH',
						body: JSON.stringify(parsed.data)
					})
				: await apiFetch<LabelFormatEntry>(`${API}/label-formats`, {
						method: 'POST',
						body: JSON.stringify(parsed.data)
					});
			toast.success(entry ? 'Etikettgröße gespeichert' : 'Etikettgröße angelegt');
			open = false;
			await onsaved?.(saved);
		} catch (err) {
			errors = apiFieldErrors(err);
			error = errorText(err, 'Speichern fehlgeschlagen');
		} finally {
			busy = false;
		}
	}

	const sheetFields = [
		['pageWidthMm', 'Seitenbreite', 'mm'],
		['pageHeightMm', 'Seitenhöhe', 'mm'],
		['cols', 'Spalten', ''],
		['rows', 'Zeilen', ''],
		['labelWidthMm', 'Etikettbreite', 'mm'],
		['labelHeightMm', 'Etiketthöhe', 'mm'],
		['marginLeftMm', 'Rand links', 'mm'],
		['marginTopMm', 'Rand oben', 'mm'],
		['gapXMm', 'Abstand Spalten', 'mm'],
		['gapYMm', 'Abstand Zeilen', 'mm']
	] as const;
	const rollFields = [
		['labelWidthMm', 'Etikettbreite', 'mm'],
		['labelHeightMm', 'Etiketthöhe', 'mm']
	] as const;
	const fields = $derived(kind === 'sheet' ? sheetFields : rollFields);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>{entry ? 'Etikettgröße bearbeiten' : 'Neue Etikettgröße'}</Dialog.Title>
			<Dialog.Description>
				Maße laut Packung des Etikettenbogens bzw. der Etikettenrolle, alles in Millimetern.
			</Dialog.Description>
		</Dialog.Header>
		<form id="label-format-form" class="grid gap-4 sm:grid-cols-[1fr_auto]" onsubmit={submit}>
			<div class="min-w-0 space-y-4">
				<FormField label="Name" id="fmt-name" required error={errors['name']}>
					<Input id="fmt-name" bind:value={name} maxlength={150} placeholder="z. B. Herma 4360" />
				</FormField>
				<div class="grid gap-4 sm:grid-cols-2">
					<FormField label="Art" id="fmt-kind">
						<SelectField
							id="fmt-kind"
							label="Art"
							options={[
								{ value: 'sheet', label: 'Bogen (A4 o. Ä.)' },
								{ value: 'roll', label: 'Rolle (Etikettendrucker)' }
							]}
							value={kind}
							onchange={(k) => (kind = (k as Kind) ?? 'sheet')}
						/>
					</FormField>
					<FormField label="Werte übernehmen von" id="fmt-preset" hint="Vorgabe als Startpunkt">
						<SelectField
							id="fmt-preset"
							label="Werte übernehmen von"
							placeholder="Vorgabe wählen …"
							options={presetOptions}
							value={null}
							onchange={(k) => {
								const p = LABEL_FORMAT_PRESETS.find((x) => x.key === k);
								if (p) apply(p.format);
							}}
						/>
					</FormField>
				</div>
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
					{#each fields as [key, label, unit] (key)}
						<FormField {label} id={`fmt-${key}`} error={errors[`format.${key}`]}>
							<div class="relative">
								<Input
									id={`fmt-${key}`}
									type="number"
									inputmode="decimal"
									min="0"
									step={unit ? '0.1' : '1'}
									bind:value={v[key]}
									class={unit ? 'pr-9 tabular-nums' : 'tabular-nums'}
								/>
								{#if unit}
									<span
										class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground"
										>{unit}</span
									>
								{/if}
							</div>
						</FormField>
					{/each}
				</div>
				{#if kind === 'sheet'}
					<Button type="button" variant="outline" size="sm" onclick={center}>
						Ränder zentrieren
					</Button>
				{/if}
			</div>
			<div class="space-y-2">
				<SheetPreview {format} width={180} label="Vorschau des Formats" />
				<p class="text-xs text-muted-foreground tabular-nums">
					{format.kind === 'sheet'
						? `${labelsPerPage(format)} Etiketten je Seite`
						: 'Ein Etikett je Seite'}
				</p>
				{#if problem}
					<p class="max-w-48 text-xs text-destructive" role="alert">{problem}</p>
				{/if}
			</div>
		</form>
		{#if error && error !== problem}<p class="text-sm text-destructive" role="alert">
				{error}
			</p>{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button type="submit" form="label-format-form" disabled={busy || !!problem}>
				{busy ? BUSY_SAVE : 'Speichern'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
