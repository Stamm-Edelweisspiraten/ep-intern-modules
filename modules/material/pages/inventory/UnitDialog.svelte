<script lang="ts">
	// Stück(e) erfassen (auch mehrere nummeriert) bzw. ein Stück bearbeiten.
	// Ort und Zustand eines bestehenden Stücks ändern eigene Aktionen (Umlagern, Zustand melden).
	// Der Aufrufer rendert per `{#key}` neu.
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { BUSY_SAVE, FormField, MoneyInput, NumberStepper } from '$lib/components/layout';
	import {
		CONDITIONS,
		CONDITION_LABELS,
		MAX_BATCH_UNITS,
		MAX_CODE,
		MAX_NAME,
		MAX_TEXT,
		unitInput,
		unitUpdateInput,
		type Article,
		type Location,
		type UnitDetail,
		type UnitSummary
	} from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import HolderField from './HolderField.svelte';
	import { dateInput } from './inventory';

	let {
		open = $bindable(false),
		unit = null,
		articleId: presetArticle = null,
		placement = null,
		articles,
		locations,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neu erfassen */
		unit?: UnitDetail | null;
		/** Vorbelegung beim Erfassen */
		articleId?: string | null;
		/** Vorbelegung des Ortes beim Erfassen */
		placement?: {
			locationId: string | null;
			containerId: string | null;
			containerName: string;
		} | null;
		articles: Article[];
		locations: Location[];
		/** Nach dem Speichern; beim Erfassen die neuen Stücke */
		onsaved: (created: UnitSummary[]) => void | Promise<void>;
	} = $props();

	const initial = untrack(() => unit);
	const start = untrack(() => placement);
	const isNew = !initial;

	let articleId = $state<string | null>(initial?.articleId ?? untrack(() => presetArticle));
	let label = $state(initial?.label ?? '');
	let code = $state(initial?.code ?? '');
	let isContainer = $state(initial?.isContainer ?? false);
	let locationId = $state<string | null>(start?.locationId ?? null);
	let containerId = $state<string | null>(start?.containerId ?? null);
	let containerName = $state(start?.containerName ?? '');
	let condition = $state<string | null>('ok');
	let purchasedOn = $state(dateInput(initial?.purchasedOn));
	let valueCents = $state(initial?.valueCents ?? 0);
	let notes = $state(initial?.notes ?? '');
	let count = $state(1);
	let numbered = $state(false);
	let numberFrom = $state(1);

	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	const articleOptions = $derived(
		articles
			.filter((a) => a.kind === 'unit' && (!a.archived || a.id === articleId))
			.map((a) => ({
				value: a.id,
				label: a.categoryName ? `${a.name} · ${a.categoryName}` : a.name
			}))
	);
	const conditionOptions = CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }));
	const article = $derived(articles.find((a) => a.id === articleId) ?? null);
	const showNumbers = $derived(isNew && (count > 1 || numbered));
	const preview = $derived.by(() => {
		if (!showNumbers) return '';
		const base = label.trim() || article?.name || 'Bezeichnung';
		const first = `${base} ${String(numberFrom).padStart(2, '0')}`;
		if (count === 1) return first;
		return `${first} … ${base} ${String(numberFrom + count - 1).padStart(2, '0')}`;
	});

	async function focusFirstError() {
		await tick();
		const key = Object.keys(errors)[0];
		if (key) document.getElementById(`unit-${key}`)?.focus();
	}

	function createBody() {
		return {
			articleId,
			label,
			code: count === 1 && code.trim() ? code : null,
			isContainer,
			locationId,
			containerId,
			condition,
			purchasedOn: purchasedOn || null,
			valueCents: valueCents > 0 ? valueCents : null,
			notes,
			count,
			numberFrom,
			numbered
		};
	}

	function updateBody() {
		return {
			articleId: articleId ?? undefined,
			label,
			...(code.trim() ? { code } : {}),
			isContainer,
			purchasedOn: purchasedOn || null,
			valueCents: valueCents > 0 ? valueCents : null,
			notes
		};
	}

	async function save() {
		const data = isNew ? createBody() : updateBody();
		const parsed = (isNew ? unitInput : unitUpdateInput).safeParse(data);
		if (!parsed.success) {
			errors = fieldErrors(parsed.error.issues);
			await focusFirstError();
			return;
		}
		errors = {};
		busy = true;
		try {
			if (initial) {
				await apiFetch<UnitDetail>(`${API}/units/${initial.id}`, {
					method: 'PATCH',
					body: JSON.stringify(data)
				});
				toast.success('Gespeichert');
				open = false;
				await onsaved([]);
			} else {
				const created = await apiFetch<UnitSummary[]>(`${API}/units`, {
					method: 'POST',
					body: JSON.stringify(data)
				});
				toast.success(
					created.length === 1
						? `${created[0]!.name} erfasst (${created[0]!.code})`
						: `${created.length} Stücke erfasst`
				);
				open = false;
				await onsaved(created);
			}
		} catch (e) {
			errors = apiFieldErrors(e);
			await focusFirstError();
			toast.error(errorText(e, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	const err = (k: string) => errors[k] ?? null;
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>
				{isNew ? 'Stücke erfassen' : initial?.isContainer ? 'Kiste bearbeiten' : 'Stück bearbeiten'}
			</Dialog.Title>
			<Dialog.Description>
				{isNew
					? 'Jedes Stück bekommt einen Code für Etikett und Scan.'
					: `${initial?.name} · ${initial?.code}`}
			</Dialog.Description>
		</Dialog.Header>

		<form
			id="unit-form"
			class="space-y-4"
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<FormField
				label="Artikel"
				id="unit-articleId"
				error={err('articleId')}
				required
				hint={articleOptions.length
					? undefined
					: 'Lege zuerst einen Artikel mit der Art „Einzelstücke“ an.'}
			>
				<SelectField
					id="unit-articleId"
					options={articleOptions}
					bind:value={articleId}
					label="Artikel"
					placeholder="Artikel wählen …"
				/>
			</FormField>

			{#if isNew}
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<FormField
						label="Anzahl"
						id="unit-count"
						error={err('count')}
						hint={`1–${MAX_BATCH_UNITS} gleichartige Stücke auf einmal`}
					>
						<NumberStepper
							id="unit-count"
							bind:value={count}
							min={1}
							max={MAX_BATCH_UNITS}
							label="Anzahl"
						/>
					</FormField>
					<FormField
						label="Bezeichnung"
						id="unit-label"
						error={err('label')}
						hint="Leer = Artikelname"
					>
						<Input
							id="unit-label"
							bind:value={label}
							maxlength={MAX_NAME}
							placeholder={article?.name ?? 'z. B. Kohtenbahn'}
						/>
					</FormField>
				</div>
				{#if count === 1}
					<div class="flex items-center gap-3">
						<Switch id="unit-numbered" bind:checked={numbered} />
						<Label for="unit-numbered" class="font-normal">Mit Nummer versehen</Label>
					</div>
				{/if}
				{#if showNumbers}
					<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<FormField label="Nummer ab" id="unit-numberFrom" error={err('numberFrom')}>
							<NumberStepper
								id="unit-numberFrom"
								bind:value={numberFrom}
								min={0}
								max={99999}
								label="Nummer ab"
							/>
						</FormField>
						<div class="space-y-1.5 text-sm">
							<p class="font-medium">Vorschau</p>
							<p class="text-muted-foreground">{preview}</p>
						</div>
					</div>
				{/if}
			{:else}
				<FormField
					label="Bezeichnung"
					id="unit-label"
					error={err('label')}
					hint="Leer = Artikelname"
				>
					<Input id="unit-label" bind:value={label} maxlength={MAX_NAME} />
				</FormField>
			{/if}

			{#if !isNew || count === 1}
				<FormField
					label={isNew ? 'Eigener Code' : 'Code'}
					id="unit-code"
					error={err('code')}
					hint={isNew
						? 'Optional: vorab gedrucktes Etikett scannen oder Code eintippen. Leer = automatisch.'
						: 'Etikett ersetzt? Neuen Code scannen oder eintippen.'}
				>
					<Input
						id="unit-code"
						bind:value={code}
						maxlength={MAX_CODE}
						autocomplete="off"
						placeholder={isNew ? 'automatisch' : ''}
						data-scan-field
						onkeydown={(e) => {
							// USB-Scanner schicken am Ende Enter – das soll nicht gleich speichern
							if (e.key === 'Enter') e.preventDefault();
						}}
					/>
				</FormField>
			{/if}

			<div class="flex items-start gap-3">
				<Switch id="unit-isContainer" bind:checked={isContainer} class="mt-0.5" />
				<div class="space-y-0.5">
					<Label for="unit-isContainer" class="font-normal">Ist eine Kiste</Label>
					<p class="text-xs text-muted-foreground">
						In Kisten können andere Stücke und Mengen liegen; sie bekommen eine Packliste.
					</p>
				</div>
			</div>

			{#if isNew}
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<FormField label="Ort" id="unit-locationId">
						<HolderField
							id="unit-locationId"
							bind:locationId
							bind:containerId
							bind:containerName
							{locations}
							allowNone
							locationError={err('locationId')}
							containerError={err('containerId')}
						/>
					</FormField>
					<FormField label="Zustand" id="unit-condition" error={err('condition')}>
						<SelectField
							id="unit-condition"
							options={conditionOptions}
							bind:value={condition}
							label="Zustand"
						/>
					</FormField>
				</div>
			{/if}

			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<FormField label="Angeschafft am" id="unit-purchasedOn" error={err('purchasedOn')}>
					<Input id="unit-purchasedOn" type="date" bind:value={purchasedOn} />
				</FormField>
				<FormField
					label="Wert je Stück"
					id="unit-valueCents"
					error={err('valueCents')}
					hint="Optional, z. B. für die Versicherung"
				>
					<MoneyInput id="unit-valueCents" bind:cents={valueCents} label="Wert je Stück" />
				</FormField>
			</div>

			<FormField label="Notiz" id="unit-notes" error={err('notes')}>
				<Textarea id="unit-notes" bind:value={notes} rows={2} maxlength={MAX_TEXT} />
			</FormField>
		</form>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button type="submit" form="unit-form" disabled={busy}>
				{busy
					? BUSY_SAVE
					: isNew
						? count > 1
							? `${count} Stücke erfassen`
							: 'Erfassen'
						: 'Speichern'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
