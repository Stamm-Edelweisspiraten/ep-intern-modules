<script lang="ts">
	// Set anlegen oder umbauen: Vorlage, Name, eigener Code, Notizen und Stücke (UnitPicker, Vorschlag:
	// Artikel der Vorlage). Stücke aus anderen Sets wandern herüber – das wird vorher angezeigt.
	import { SvelteMap } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SelectField } from '$lib/components/ui/select-field';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import {
		MAX_CODE,
		MAX_NAME,
		MAX_TEXT,
		setInput,
		setUpdateInput,
		type MaterialSet,
		type SetTemplate,
		type UnitSummary
	} from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import UnitPicker from '../shared/UnitPicker.svelte';

	let {
		open = $bindable(false),
		set = null,
		templates,
		templateId: presetTemplate = null,
		onsaved
	}: {
		open?: boolean;
		/** Zu bearbeitendes Set; `null` = neu */
		set?: MaterialSet | null;
		templates: SetTemplate[];
		/** Vorlage vorwählen (neues Set) */
		templateId?: string | null;
		onsaved?: (s: MaterialSet) => void | Promise<void>;
	} = $props();

	const ALL = '__all__';
	let templateId = $state<string | null>(null);
	let name = $state('');
	let code = $state('');
	let notes = $state('');
	let unitIds = $state<string[]>([]);
	let filter = $state<string | null>(null);
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});
	const known = new SvelteMap<string, UnitSummary>();

	const template = $derived(templates.find((t) => t.id === templateId) ?? null);
	/** Einzelstück-Teile (bilden das Set); Mengen kommen beim Reservieren aus dem Lager dazu */
	const unitParts = $derived((template?.parts ?? []).filter((p) => p.kind === 'unit'));
	const bulkParts = $derived((template?.parts ?? []).filter((p) => p.kind === 'bulk'));
	const filterOptions = $derived([
		...unitParts.map((p) => ({ value: p.articleId, label: p.articleName })),
		{ value: ALL, label: 'Alle Artikel' }
	]);

	let initFor: string | null = null;
	$effect(() => {
		if (!open) {
			initFor = null;
			return;
		}
		const key = set?.id ?? `new:${presetTemplate ?? ''}`;
		if (initFor === key) return;
		initFor = key;
		known.clear();
		for (const u of set?.units ?? []) known.set(u.id, u);
		templateId = set?.templateId ?? presetTemplate ?? templates[0]?.id ?? null;
		name = set?.name ?? '';
		code = set?.code ?? '';
		notes = set?.notes ?? '';
		unitIds = set?.units.map((u) => u.id) ?? [];
		error = '';
		errors = {};
	});

	// Beim Vorlagenwechsel: Filter auf das erste Teil, Stücke der Vorlagen-Artikel laden (für Zähler/Hinweise)
	let loadedTemplate: string | null = null;
	$effect(() => {
		const t = template;
		if (!open || !t || loadedTemplate === t.id) return;
		loadedTemplate = t.id;
		const units = t.parts.filter((p) => p.kind === 'unit');
		filter = units[0]?.articleId ?? ALL;
		void Promise.all(
			units.map((p) =>
				apiFetch<{ items: UnitSummary[] }>(`${API}/units?articleId=${p.articleId}&limit=500`)
					.then((r) => r.items.forEach((u) => known.set(u.id, u)))
					.catch(() => undefined)
			)
		);
	});
	$effect(() => {
		if (!open) loadedTemplate = null;
	});

	// Stücke, die über „Alle Artikel“ gewählt wurden, nachladen
	$effect(() => {
		for (const id of unitIds) {
			if (known.has(id)) continue;
			void apiFetch<UnitSummary>(`${API}/units/${id}`)
				.then((u) => known.set(u.id, u))
				.catch(() => undefined);
		}
	});

	const chosen = $derived(unitIds.map((id) => known.get(id)).filter((u): u is UnitSummary => !!u));
	const counts = $derived.by(() => {
		const m = new Map<string, number>();
		for (const u of chosen) m.set(u.articleId, (m.get(u.articleId) ?? 0) + 1);
		return m;
	});
	const others = $derived.by(() => {
		const partIds = new Set(unitParts.map((p) => p.articleId));
		const m = new Map<string, number>();
		for (const u of chosen) {
			if (!partIds.has(u.articleId)) m.set(u.articleName, (m.get(u.articleName) ?? 0) + 1);
		}
		return [...m];
	});
	/** Stücke aus anderen Sets, gruppiert nach Set */
	const movers = $derived.by(() => {
		const m = new Map<string, { setName: string; units: string[] }>();
		for (const u of chosen) {
			if (!u.setId || u.setId === set?.id) continue;
			const entry = m.get(u.setId) ?? { setName: u.setName ?? 'anderes Set', units: [] };
			entry.units.push(u.name);
			m.set(u.setId, entry);
		}
		return [...m.values()];
	});
	const issued = $derived(chosen.filter((u) => u.issued));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const trimmedCode = code.trim();
		let body: unknown;
		if (set) {
			const parsed = setUpdateInput.safeParse({
				name,
				notes,
				unitIds,
				...(trimmedCode && trimmedCode !== set.code ? { code: trimmedCode } : {})
			});
			if (!parsed.success) {
				errors = fieldErrors(parsed.error);
				return;
			}
			body = parsed.data;
		} else {
			const parsed = setInput.safeParse({
				templateId,
				name,
				code: trimmedCode || null,
				notes,
				unitIds
			});
			if (!parsed.success) {
				errors = fieldErrors(parsed.error);
				return;
			}
			body = parsed.data;
		}
		busy = true;
		error = '';
		errors = {};
		try {
			const saved = set
				? await apiFetch<MaterialSet>(`${API}/sets/${set.id}`, {
						method: 'PATCH',
						body: JSON.stringify(body)
					})
				: await apiFetch<MaterialSet>(`${API}/sets`, {
						method: 'POST',
						body: JSON.stringify(body)
					});
			toast.success(set ? 'Set gespeichert' : 'Set angelegt');
			open = false;
			await onsaved?.(saved);
		} catch (err) {
			errors = apiFieldErrors(err);
			error = errorText(err, 'Speichern fehlgeschlagen');
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{set ? `Set „${set.name}“ umbauen` : 'Neues Set'}</Dialog.Title>
			<Dialog.Description>
				Ein Set fasst konkrete Stücke zusammen, z. B. die vier Bahnen von „Kohte 3“.
			</Dialog.Description>
		</Dialog.Header>
		<form id="set-form" class="space-y-4" onsubmit={submit}>
			<div class="grid gap-4 sm:grid-cols-2">
				{#if !set}
					<FormField label="Set-Typ" id="set-template" required error={errors['templateId']}>
						<SelectField
							id="set-template"
							label="Set-Typ"
							options={templates.map((t) => ({ value: t.id, label: t.name }))}
							bind:value={templateId}
						/>
					</FormField>
				{:else}
					<FormField label="Set-Typ" id="set-template-ro">
						<Input id="set-template-ro" value={set.templateName} disabled />
					</FormField>
				{/if}
				<FormField label="Name" id="set-name" required error={errors['name']}>
					<Input id="set-name" bind:value={name} maxlength={MAX_NAME} placeholder="z. B. Kohte 3" />
				</FormField>
				<FormField
					label="Code"
					id="set-code"
					error={errors['code']}
					hint={set ? 'Ändern nur, wenn ein neues Etikett klebt.' : 'Leer = automatisch (S-…)'}
				>
					<Input
						id="set-code"
						bind:value={code}
						maxlength={MAX_CODE}
						autocomplete="off"
						data-scan-field
					/>
				</FormField>
				<FormField label="Notizen" id="set-notes" error={errors['notes']}>
					<Textarea id="set-notes" bind:value={notes} maxlength={MAX_TEXT} rows={1} />
				</FormField>
			</div>

			<fieldset class="space-y-2">
				<legend class="text-sm font-medium">Stücke</legend>
				{#if template}
					<ul class="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Teile laut Set-Typ">
						{#each unitParts as p (p.articleId)}
							{@const n = counts.get(p.articleId) ?? 0}
							<li
								class={n === p.quantity
									? 'text-success'
									: n < p.quantity
										? 'text-warning'
										: 'text-info'}
							>
								<span class="tabular-nums">{n}/{p.quantity}</span>
								{p.articleName}
							</li>
						{/each}
						{#each others as [articleName, n] (articleName)}
							<li class="text-info">
								<span class="tabular-nums">{n}</span>
								{articleName} (nicht im Set-Typ)
							</li>
						{/each}
					</ul>
					{#if bulkParts.length}
						<p class="text-xs text-muted-foreground">
							Dazu aus dem Lager beim Reservieren:
							{bulkParts.map((p) => `${p.quantity} ${p.unitLabel} ${p.articleName}`).join(', ')}
						</p>
					{/if}
				{/if}
				<div class="max-w-64">
					<SelectField
						label="Stücke filtern nach Artikel"
						size="sm"
						options={filterOptions}
						bind:value={filter}
					/>
				</div>
				<UnitPicker
					bind:selected={unitIds}
					known={[...known.values()]}
					articleId={filter && filter !== ALL ? filter : undefined}
					label="Stücke für das Set suchen"
				/>
				{#if errors['unitIds']}
					<p class="text-xs text-destructive" role="alert">{errors['unitIds']}</p>
				{/if}
			</fieldset>

			{#if movers.length}
				<Alert.Root variant="warning">
					<Alert.Title>Stücke wechseln das Set</Alert.Title>
					<Alert.Description>
						<ul class="list-disc pl-4">
							{#each movers as m (m.setName)}
								<li>
									{m.units.join(', ')}
									{m.units.length === 1 ? 'kommt' : 'kommen'} aus „{m.setName}“ – das Set wird
									dadurch unvollständig.
								</li>
							{/each}
						</ul>
					</Alert.Description>
				</Alert.Root>
			{/if}
			{#if issued.length}
				<p class="text-xs text-muted-foreground">
					{issued.length === 1 ? 'Ein Stück ist' : `${issued.length} Stücke sind`} gerade ausgegeben.
				</p>
			{/if}
		</form>
		{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button type="submit" form="set-form" disabled={busy || (!set && !templateId)}>
				{busy ? BUSY_SAVE : set ? 'Speichern' : 'Set anlegen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
