<script lang="ts">
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { ContactListField, FileField, FormField } from '$lib/components/layout';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormRenderer } from '$lib/components/forms';
	import type { FieldDefinition, FormValues } from '$lib/forms';
	import AddressFields from './AddressFields.svelte';
	import {
		DOCUMENT_CONTENT_TYPES,
		DOCUMENT_KINDS,
		DOCUMENT_LABELS,
		GROUP_TYPE_LABELS,
		MAX_DOCUMENT_BYTES,
		ageFromBirthDate,
		memberInput,
		STAGES,
		STAGE_LABELS,
		type DocumentKind,
		type Group,
		type ContactEntry,
		type Member,
		type MemberFormInput,
		type Stage
	} from '../schemas';

	let {
		open = $bindable(false),
		member = null,
		groups,
		canUpload,
		canRemoveDoc,
		onsaved
	}: {
		open?: boolean;
		member?: Member | null;
		groups: Group[];
		canUpload: boolean;
		canRemoveDoc: boolean;
		onsaved: () => void | Promise<void>;
	} = $props();

	const base = '/api/v1/modules/members/members';
	const accept = DOCUMENT_CONTENT_TYPES.join(',');
	const maxMb = MAX_DOCUMENT_BYTES / 1024 / 1024;
	const hasGroups = $derived(groups.length > 0);
	const today = new Date().toISOString().slice(0, 10);
	const groupOptions = $derived(
		groups.map((g) => ({ value: g.id, label: g.name, description: GROUP_TYPE_LABELS[g.type] }))
	);
	const toRows = (list: ContactEntry[]) =>
		list.map((c) => ({ name: c.name ?? '', value: c.value }));

	let firstName = $state('');
	let lastName = $state('');
	let scoutName = $state('');
	let birthDate = $state('');
	const age = $derived(birthDate ? ageFromBirthDate(birthDate) : null);
	/** Aktive Zusatzfelder und deren Werte */
	let customFields = $state<FieldDefinition[]>([]);
	let custom = $state<FormValues>({});
	let street = $state('');
	let postalCode = $state('');
	let city = $state('');
	let country = $state('DE');
	let phones = $state<{ name: string; value: string }[]>([]);
	let emails = $state<{ name: string; value: string }[]>([]);
	let stage = $state<Stage | ''>('');
	let groupIds = $state<string[]>([]);
	let consentSocialMedia = $state(false);
	let consentWebsite = $state(false);
	let consentPrint = $state(false);
	let files = $state<Record<DocumentKind, File | null>>({ privacy: null, registration: null });
	let docNames = $state<Record<DocumentKind, string | null>>({
		privacy: null,
		registration: null
	});
	let busy = $state(false);
	let error = $state('');
	let fieldErrors = $state<Record<string, string>>({});

	// Formular bei jedem Oeffnen neu befuellen
	$effect(() => {
		if (!open) return;
		const m = member;
		firstName = m?.firstName ?? '';
		lastName = m?.lastName ?? '';
		scoutName = m?.scoutName ?? '';
		birthDate = m?.birthDate ?? '';
		custom = {};
		void loadCustomFields(m?.custom ?? {});
		street = m?.street ?? '';
		postalCode = m?.postalCode ?? '';
		city = m?.city ?? '';
		country = m?.country ?? 'DE';
		phones = m ? toRows(m.phones) : [];
		emails = m ? toRows(m.emails) : [];
		stage = m?.stage ?? '';
		groupIds = m ? m.groups.map((g) => g.id) : [];
		consentSocialMedia = m?.consentSocialMedia ?? false;
		consentWebsite = m?.consentWebsite ?? false;
		consentPrint = m?.consentPrint ?? false;
		files = { privacy: null, registration: null };
		docNames = {
			privacy: m?.privacyConsent?.name ?? null,
			registration: m?.registration?.name ?? null
		};
		error = '';
		fieldErrors = {};
		busy = false;
	});

	async function loadCustomFields(values: Record<string, unknown>) {
		try {
			const r = await apiFetch<{ fields: { active: boolean; field: FieldDefinition }[] }>(
				'/modules/members/fields'
			);
			customFields = r.fields.filter((d) => d.active).map((d) => d.field);
			custom = Object.fromEntries(
				customFields.map((f) => [f.key, (values[f.key] ?? null) as FormValues[string]])
			);
		} catch {
			customFields = [];
		}
	}

	async function uploadDoc(id: string, kind: DocumentKind, file: File) {
		const fd = new FormData();
		fd.append('file', file);
		await apiFetch<{ name: string }>(`/modules/members/members/${id}/documents/${kind}`, {
			method: 'POST',
			body: fd
		});
	}

	async function removeDoc(kind: DocumentKind) {
		if (!member) return;
		try {
			await apiFetch(`/modules/members/members/${member.id}/documents/${kind}`, {
				method: 'DELETE'
			});
			docNames[kind] = null;
			toast.success(`${DOCUMENT_LABELS[kind]} entfernt`);
			await onsaved();
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Entfernen fehlgeschlagen');
		}
	}

	type RowMap = { phones: number[]; emails: number[] };

	function remapPath(path: (string | number)[], rowMap?: RowMap): string {
		const [head, idx, ...rest] = path;
		if (rowMap && (head === 'phones' || head === 'emails') && typeof idx === 'number') {
			return [head, rowMap[head][idx] ?? idx, ...rest].join('.');
		}
		return path.join('.');
	}

	/** Serverfehler (details.issues mit Pfaden) auf Felder/Zeilen mappen. */
	function applyDetails(details: unknown, rowMap?: RowMap) {
		const out: Record<string, string> = {};
		const issues = (details as { issues?: { path?: (string | number)[]; message?: string }[] })
			?.issues;
		if (Array.isArray(issues)) {
			for (const i of issues) {
				const key = remapPath(i.path ?? [], rowMap);
				if (key && i.message && !out[key]) out[key] = i.message;
			}
		} else if (details && typeof details === 'object') {
			for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
				const msg = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '';
				if (msg) out[k] = msg;
			}
		}
		fieldErrors = out;
	}

	const fieldOrder = [
		'firstName',
		'lastName',
		'scoutName',
		'birthDate',
		'street',
		'postalCode',
		'city',
		'country',
		'phones',
		'emails',
		'stage',
		'groupIds'
	];
	const fieldIds: Record<string, string> = {
		firstName: 'm-first',
		lastName: 'm-last',
		scoutName: 'm-scout',
		birthDate: 'm-birth',
		street: 'm-street',
		postalCode: 'm-postal',
		city: 'm-city',
		country: 'm-country',
		phones: 'm-phones',
		emails: 'm-emails',
		stage: 'm-stage',
		groupIds: 'm-groups'
	};
	function idFor(key: string): string {
		const m = /^(phones|emails)\.(\d+)\.(name|value)$/.exec(key);
		if (m) return `m-${m[1]}-${m[2]}-${m[3]}`;
		return fieldIds[key] ?? '';
	}

	async function focusFirstError() {
		await tick();
		const rank = (k: string) => {
			const i = fieldOrder.indexOf(k.split('.')[0] ?? '');
			return i < 0 ? 99 : i;
		};
		const keys = Object.keys(fieldErrors).sort(
			(a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true })
		);
		for (const k of keys) {
			const el = document.getElementById(idFor(k));
			if (el) {
				el.scrollIntoView({ block: 'center' });
				el.focus();
				return;
			}
		}
	}

	function rowErrors(list: 'phones' | 'emails') {
		const out: Record<number, { name?: string; value?: string }> = {};
		for (const [k, msg] of Object.entries(fieldErrors)) {
			const m = /^(phones|emails)\.(\d+)\.(name|value)$/.exec(k);
			if (m && m[1] === list) (out[Number(m[2])] ??= {})[m[3] as 'name' | 'value'] = msg;
		}
		return out;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		fieldErrors = {};
		// Leere Zeilen verwerfen; Zuordnung neuer -> urspruenglicher Index fuer Fehler merken
		const rowMap: RowMap = { phones: [], emails: [] };
		const keep = (list: 'phones' | 'emails') => {
			const rows = list === 'phones' ? phones : emails;
			const out: { name: string; value: string }[] = [];
			rows.forEach((r, i) => {
				if (!r.name.trim() && !r.value.trim()) return;
				rowMap[list].push(i);
				out.push({ name: r.name, value: r.value });
			});
			return out;
		};
		const input: MemberFormInput = {
			firstName,
			lastName,
			scoutName: scoutName || null,
			birthDate,
			street,
			postalCode,
			city,
			country,
			phones: keep('phones'),
			emails: keep('emails'),
			stage: stage as Stage,
			groupIds,
			consentSocialMedia,
			consentWebsite,
			consentPrint,
			custom: { ...custom }
		};
		const parsed = memberInput.safeParse(input);
		const errs: Record<string, string> = {};
		if (!parsed.success) {
			for (const i of parsed.error.issues) {
				const path = i.path.filter((p): p is string | number => typeof p !== 'symbol');
				const key = remapPath(path, rowMap);
				if (!errs[key]) errs[key] = i.message;
			}
		}
		if (!stage) errs.stage = 'Bitte einen Stand wählen';
		if (!parsed.success || Object.keys(errs).length) {
			fieldErrors = errs;
			error = 'Bitte die markierten Felder prüfen.';
			void focusFirstError();
			return;
		}
		const body = parsed.data;
		busy = true;
		try {
			const saved = member
				? await apiFetch<Member>(`/modules/members/members/${member.id}`, {
						method: 'PUT',
						body: JSON.stringify(body)
					})
				: await apiFetch<Member>('/modules/members/members', {
						method: 'POST',
						body: JSON.stringify(body)
					});
			toast.success(member ? 'Mitglied gespeichert' : 'Mitglied angelegt');
			if (canUpload) {
				for (const kind of DOCUMENT_KINDS) {
					const f = files[kind];
					if (!f) continue;
					try {
						await uploadDoc(saved.id, kind, f);
					} catch (err) {
						const msg = err instanceof ApiClientError ? err.message : 'Upload fehlgeschlagen';
						toast.error(`${DOCUMENT_LABELS[kind]}: ${msg}`);
					}
				}
			}
			open = false;
			await onsaved();
		} catch (err) {
			if (err instanceof ApiClientError) {
				error = err.message;
				applyDetails(err.details, rowMap);
				void focusFirstError();
			} else {
				error = 'Speichern fehlgeschlagen';
			}
		} finally {
			busy = false;
		}
	}

	const docs = DOCUMENT_KINDS.map((kind) => ({ kind, label: DOCUMENT_LABELS[kind] }));
	const stageOptions = STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }));
	const checkClass = 'size-4 rounded border-input accent-primary';
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{member ? 'Mitglied bearbeiten' : 'Mitglied anlegen'}</Dialog.Title>
			<Dialog.Description>Pflichtfelder sind mit * markiert.</Dialog.Description>
		</Dialog.Header>

		<form class="space-y-4" onsubmit={submit} novalidate>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Vorname *" id="m-first" error={fieldErrors.firstName}>
					<Input
						id="m-first"
						aria-invalid={!!fieldErrors.firstName}
						aria-describedby={fieldErrors.firstName ? 'm-first-error' : undefined}
						bind:value={firstName}
						required
						maxlength={100}
					/>
				</FormField>
				<FormField label="Nachname *" id="m-last" error={fieldErrors.lastName}>
					<Input
						id="m-last"
						aria-invalid={!!fieldErrors.lastName}
						aria-describedby={fieldErrors.lastName ? 'm-last-error' : undefined}
						bind:value={lastName}
						required
						maxlength={100}
					/>
				</FormField>
				<FormField label="Fahrtenname" id="m-scout" error={fieldErrors.scoutName}>
					<Input
						id="m-scout"
						aria-invalid={!!fieldErrors.scoutName}
						aria-describedby={fieldErrors.scoutName ? 'm-scout-error' : undefined}
						bind:value={scoutName}
						maxlength={100}
					/>
				</FormField>
				<FormField label="Geburtsdatum *" id="m-birth" error={fieldErrors.birthDate}>
					<div class="flex items-center gap-2">
						<Input
							id="m-birth"
							type="date"
							max={today}
							bind:value={birthDate}
							required
							aria-invalid={!!fieldErrors.birthDate}
							aria-describedby={fieldErrors.birthDate ? 'm-birth-error' : undefined}
						/>
						{#if age !== null && age >= 0}
							<span class="text-sm whitespace-nowrap text-muted-foreground" aria-live="polite"
								>({age}&nbsp;{age === 1 ? 'Jahr' : 'Jahre'})</span
							>
						{/if}
					</div>
				</FormField>
			</div>
			<AddressFields bind:street bind:postalCode bind:city bind:country errors={fieldErrors} />

			<div class="grid gap-4">
				<ContactListField
					id="m-phones"
					label="Telefonnummern"
					type="tel"
					valueLabel="Telefonnummer"
					valuePlaceholder="Telefonnummer"
					bind:items={phones}
					errors={rowErrors('phones')}
					listError={fieldErrors.phones}
				/>
				<ContactListField
					id="m-emails"
					label="E-Mail-Adressen"
					type="email"
					valueLabel="E-Mail-Adresse"
					valuePlaceholder="E-Mail-Adresse"
					bind:items={emails}
					errors={rowErrors('emails')}
					listError={fieldErrors.emails}
				/>
			</div>

			<FormField label="Stand *" id="m-stage" error={fieldErrors.stage}>
				<SelectField
					id="m-stage"
					label="Stand"
					placeholder="Bitte wählen"
					options={stageOptions}
					bind:value={stage}
					invalid={!!fieldErrors.stage}
				/>
			</FormField>

			<div class="space-y-1.5">
				{#if hasGroups}
					<MultiSelect
						id="m-groups"
						label="Gruppen"
						options={groupOptions}
						bind:value={groupIds}
						placeholder="Gruppen auswählen (optional)"
						searchPlaceholder="Gruppe suchen …"
						emptyText="Keine Gruppe gefunden."
						invalid={!!fieldErrors.groupIds}
					/>
				{:else}
					<p class="text-sm font-medium">Gruppen</p>
					<p class="text-sm text-muted-foreground">Noch keine Gruppen vorhanden.</p>
				{/if}
				{#if fieldErrors.groupIds}
					<p role="alert" class="text-xs text-destructive">{fieldErrors.groupIds}</p>
				{/if}
			</div>

			<fieldset class="space-y-2">
				<legend class="text-sm font-medium">Darf gezeigt werden auf</legend>
				<div class="flex flex-wrap gap-4">
					<label class="flex items-center gap-2 text-sm">
						<input type="checkbox" class={checkClass} bind:checked={consentSocialMedia} /> Socialmedia
					</label>
					<label class="flex items-center gap-2 text-sm">
						<input type="checkbox" class={checkClass} bind:checked={consentWebsite} /> Stammeswebsite
					</label>
					<label class="flex items-center gap-2 text-sm">
						<input type="checkbox" class={checkClass} bind:checked={consentPrint} /> Print
					</label>
				</div>
			</fieldset>

			{#if customFields.length}
				<fieldset class="space-y-3">
					<legend class="text-sm font-medium">Weitere Angaben</legend>
					<FormRenderer
						definition={{ version: 1, fields: customFields }}
						bind:values={custom}
						idPrefix="m-custom"
						errors={Object.fromEntries(
							Object.entries(fieldErrors)
								.filter(([k]) => k.startsWith('custom.'))
								.map(([k, v]) => [k.slice(7), v])
						)}
					/>
				</fieldset>
			{/if}

			<div class="grid gap-4 sm:grid-cols-2">
				{#each docs as d (d.kind)}
					{@const name = docNames[d.kind]}
					<div class="space-y-2">
						<label for={`m-doc-${d.kind}`} class="text-sm font-medium">{d.label}</label>
						<FileField
							id={`m-doc-${d.kind}`}
							bind:file={files[d.kind]}
							{accept}
							maxBytes={MAX_DOCUMENT_BYTES}
							existingName={member ? name : null}
							existingHref={member ? `${base}/${member.id}/documents/${d.kind}` : null}
							{canUpload}
							canRemove={canRemoveDoc}
							onremove={() => removeDoc(d.kind)}
						/>
						{#if canUpload}
							<p class="text-xs text-muted-foreground">
								{name ? 'Eine neue Datei ersetzt die vorhandene. ' : ''}PDF oder Bild, max. {maxMb} MB{member
									? ''
									: '; wird nach dem Anlegen hochgeladen'}.
							</p>
						{:else if !name}
							<p class="text-sm text-muted-foreground">Kein Dokument hinterlegt.</p>
						{/if}
					</div>
				{/each}
			</div>

			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? 'Speichere …' : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
