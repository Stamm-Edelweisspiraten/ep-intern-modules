<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import Check from '@lucide/svelte/icons/check';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Loader from '@lucide/svelte/icons/loader-circle';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import type { FieldDefinition } from '$lib/forms';
	import { FormBuilder } from '$lib/components/forms';
	import { formConfigInput, type FormConfig } from '../schemas';
	import DisclaimerEditor from './DisclaimerEditor.svelte';
	import FormSettings, { type FormDraft } from './FormSettings.svelte';

	let {
		actionId,
		canEdit,
		onchanged,
		onopencalculation,
		onopenparticipants
	}: {
		actionId: string;
		canEdit: boolean;
		onchanged?: () => void;
		onopencalculation?: () => void;
		onopenparticipants?: () => void;
	} = $props();

	// Zusatzfelder aus dem Mitgliedsprofil (zum Einbinden in das Formular)
	let memberFields = $state<{ key: string; field: FieldDefinition }[]>([]);
	let memberFieldPick = $state<string | null>(null);
	const memberFieldOptions = $derived(
		memberFields
			.filter((m) => !draft?.definition.fields.some((f) => f.memberKey === m.key))
			.map((m) => ({ value: m.key, label: m.field.label }))
	);
	$effect(() => {
		if (!canEdit) return;
		apiFetch<{ fields: { key: string; field: FieldDefinition }[] }>(
			`/modules/actions/actions/${encodeURIComponent(actionId)}/form/member-fields`
		)
			.then((r) => (memberFields = r.fields))
			.catch(() => (memberFields = []));
	});
	function addMemberField() {
		const m = memberFields.find((x) => x.key === memberFieldPick);
		if (!m || !draft) return;
		const key = `mf_${m.key}`.slice(0, 40);
		if (draft.definition.fields.some((f) => f.key === key || f.memberKey === m.key)) return;
		const field = {
			...m.field,
			id: crypto.randomUUID(),
			key,
			memberKey: m.key,
			required: false,
			locked: undefined,
			hidden: undefined
		} as FieldDefinition;
		// vor die Zustimmungsfelder einsortieren (diese bleiben am Ende)
		const at = draft.definition.fields.findIndex((f) => f.type === 'consent');
		const fields = [...draft.definition.fields];
		fields.splice(at < 0 ? fields.length : at, 0, field);
		draft.definition = { ...draft.definition, fields };
		memberFieldPick = null;
	}

	const path = $derived(`/modules/actions/actions/${encodeURIComponent(actionId)}/form`);

	let server = $state<FormConfig | null>(null);
	let draft = $state<FormDraft | null>(null);
	let loading = $state(true);
	let loadError = $state('');

	type SaveState = 'idle' | 'saving' | 'saved' | 'error';
	let saveState = $state<SaveState>('idle');
	let saveError = $state('');
	let lastSaved = $state('');
	let saving = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function toDraft(c: FormConfig): FormDraft {
		return {
			enabled: c.enabled,
			opensAt: c.opensAt,
			closesAt: c.closesAt,
			maxParticipants: c.maxParticipants,
			intro: c.intro ?? '',
			disclaimerTemplate: c.disclaimerTemplate,
			privacyUrl: c.privacyUrl ?? '',
			requireLogin: c.requireLogin,
			definition: c.definition
		};
	}

	function toInput(d: FormDraft) {
		return {
			enabled: d.enabled,
			opensAt: d.opensAt,
			closesAt: d.closesAt,
			maxParticipants: d.maxParticipants,
			intro: d.intro,
			disclaimerTemplate: d.disclaimerTemplate,
			privacyUrl: d.privacyUrl.trim() || null,
			requireLogin: d.requireLogin,
			definition: d.definition
		};
	}

	const snapshot = () => (draft ? JSON.stringify(toInput(draft)) : '');
	const dirty = $derived(!!draft && snapshot() !== lastSaved);
	const validation = $derived(draft ? formConfigInput.safeParse(toInput(draft)) : null);
	const validationMessage = $derived.by(() => {
		if (!validation || validation.success) return '';
		return validation.error.issues[0]?.message ?? 'Ungültige Eingabe';
	});

	async function load() {
		loading = true;
		loadError = '';
		try {
			const cfg = await apiFetch<FormConfig>(path);
			server = cfg;
			draft = toDraft(cfg);
			lastSaved = JSON.stringify(toInput(draft));
			saveState = 'idle';
		} catch (e) {
			loadError =
				e instanceof ApiClientError ? e.message : 'Anmeldeformular konnte nicht geladen werden.';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void actionId;
		untrack(() => {
			server = null;
			draft = null;
			void load();
		});
	});

	async function flush(keepalive = false) {
		if (!draft || !canEdit) return;
		while (saving) await new Promise((r) => setTimeout(r, 50));
		const snap = snapshot();
		if (snap === lastSaved) return;
		const parsed = formConfigInput.safeParse(toInput(draft));
		if (!parsed.success) return;
		saving = true;
		saveState = 'saving';
		saveError = '';
		try {
			const cfg = await apiFetch<FormConfig>(path, {
				method: 'PUT',
				body: JSON.stringify(parsed.data),
				keepalive
			});
			// Nur Server-Stand übernehmen; laufende Eingaben im Entwurf bleiben unangetastet.
			server = cfg;
			lastSaved = snap;
			saveState = 'saved';
			onchanged?.();
		} catch (e) {
			saveState = 'error';
			saveError = e instanceof ApiClientError ? e.message : 'Speichern fehlgeschlagen.';
		} finally {
			saving = false;
		}
		if (saveState === 'saved' && snapshot() !== lastSaved && !keepalive) void flush();
	}

	function saveNow() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		void flush();
	}

	$effect(() => {
		if (!draft || !canEdit) return;
		const snap = JSON.stringify(toInput(draft));
		const valid = validation?.success ?? false;
		if (snap === untrack(() => lastSaved)) return;
		if (timer) clearTimeout(timer);
		if (!valid) {
			timer = null;
			return;
		}
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, 800);
		return () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		};
	});

	onDestroy(() => {
		if (timer) clearTimeout(timer);
		void flush(true);
	});

	function onrotated(cfg: FormConfig) {
		if (server) {
			server = { ...server, token: cfg.token, publicPath: cfg.publicPath, status: cfg.status };
		}
	}
</script>

<div class="flex flex-col gap-4">
	{#if loading && !draft}
		<div class="grid gap-4 lg:grid-cols-2" aria-busy="true">
			<Skeleton class="h-96 w-full" />
			<div class="flex flex-col gap-4">
				<Skeleton class="h-80 w-full" />
				<Skeleton class="h-56 w-full" />
			</div>
		</div>
	{:else if loadError || !draft || !server}
		<Card.Root>
			<Card.Content class="flex flex-col items-start gap-3">
				<p class="text-destructive text-sm" role="alert">
					{loadError || 'Anmeldeformular konnte nicht geladen werden.'}
				</p>
				<Button variant="outline" onclick={load}>Erneut versuchen</Button>
			</Card.Content>
		</Card.Root>
	{:else}
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="flex items-center gap-2">
				{#if !canEdit}<Badge variant="secondary">Nur Ansicht</Badge>{/if}
			</div>
			<div class="flex min-h-8 items-center gap-2 text-sm" aria-live="polite">
				{#if !canEdit}
					<span class="text-muted-foreground">Änderungen sind nicht möglich.</span>
				{:else if validationMessage}
					<span class="text-destructive flex items-center gap-1.5">
						<CircleAlert class="size-4" /> Nicht gespeichert: {validationMessage}
					</span>
				{:else if saveState === 'error'}
					<span class="text-destructive flex items-center gap-1.5">
						<CircleAlert class="size-4" />
						{saveError || 'Speichern fehlgeschlagen.'}
					</span>
					<Button size="sm" variant="outline" onclick={() => flush()}>Erneut versuchen</Button>
				{:else if saveState === 'saving'}
					<span class="text-muted-foreground flex items-center gap-1.5">
						<Loader class="size-4 animate-spin" /> Speichert …
					</span>
				{:else if dirty}
					<span class="text-muted-foreground">Ungespeicherte Änderungen …</span>
				{:else}
					<span class="text-muted-foreground flex items-center gap-1.5">
						<Check class="size-4" /> Gespeichert
					</span>
				{/if}
			</div>
		</div>

		{#if !server.fee}
			<div
				class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
				role="status"
			>
				<span>
					Noch kein Beitrag übernommen – im Disclaimer erscheint {'{{beitrag}}'} erst nach der Übernahme
					in der Kalkulation.
				</span>
				{#if onopencalculation}
					<Button size="sm" variant="outline" onclick={onopencalculation}>Zur Kalkulation</Button>
				{/if}
			</div>
		{/if}

		<div class="grid items-start gap-4 lg:grid-cols-2">
			<Card.Root class="min-w-0">
				<Card.Header>
					<Card.Title>Formular</Card.Title>
					<Card.Description>Standardfelder und eigene Felder der Anmeldung.</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					{#if canEdit && memberFields.length}
						<div class="flex flex-wrap items-end gap-2">
							<div class="min-w-48 flex-1 space-y-1.5">
								<Label for="reg-member-field">Mitgliedsfeld hinzufügen</Label>
								<SelectField
									id="reg-member-field"
									label="Mitgliedsfeld"
									placeholder="Feld aus dem Mitgliedsprofil wählen …"
									options={memberFieldOptions}
									bind:value={memberFieldPick}
								/>
							</div>
							<Button variant="outline" disabled={!memberFieldPick} onclick={addMemberField}>
								Hinzufügen
							</Button>
						</div>
						<p class="text-xs text-muted-foreground">
							Mitgliedsfelder werden bei einer Anmeldung mit Mitglied vorausgefüllt; Änderungen
							werden im Mitgliedsprofil gespeichert.
						</p>
					{/if}
					<FormBuilder bind:definition={draft.definition} disabled={!canEdit} />
				</Card.Content>
			</Card.Root>

			<div class="flex min-w-0 flex-col gap-4">
				<Card.Root>
					<Card.Header>
						<Card.Title>Anmeldelink</Card.Title>
						<Card.Description>Wer sich wann anmelden kann.</Card.Description>
					</Card.Header>
					<Card.Content>
						<FormSettings
							{actionId}
							bind:draft
							{server}
							{canEdit}
							onsavenow={saveNow}
							{onrotated}
							{onopenparticipants}
						/>
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Disclaimer</Card.Title>
						<Card.Description>Verbindliche Erklärung und Zahlungsinformationen.</Card.Description>
					</Card.Header>
					<Card.Content>
						<DisclaimerEditor
							bind:value={draft.disclaimerTemplate}
							preview={server.disclaimerPreview}
							disabled={!canEdit}
						/>
					</Card.Content>
				</Card.Root>
			</div>
		</div>
	{/if}
</div>
