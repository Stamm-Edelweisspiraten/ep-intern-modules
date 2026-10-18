<script lang="ts" module>
	export type MemberFormTab = 'person' | 'contact' | 'membership' | 'custom' | 'consent';
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Link2 from '@lucide/svelte/icons/link-2';
	import Pencil from '@lucide/svelte/icons/pencil';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { Switch } from '$lib/components/ui/switch';
	import * as Tabs from '$lib/components/ui/tabs';
	import { ColorBadge, ContactListField, FileField, FormField } from '$lib/components/layout';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormRenderer } from '$lib/components/forms';
	import type { FieldDefinition, FormValues } from '$lib/forms';
	import AddressFields from './AddressFields.svelte';
	import {
		DOCUMENT_CONTENT_TYPES,
		DOCUMENT_KINDS,
		DOCUMENT_LABELS,
		FEE_LEVELS,
		FEE_LEVEL_LABELS,
		GROUP_TYPE_LABELS,
		MAX_DOCUMENT_BYTES,
		ageFromBirthDate,
		memberInput,
		STAGES,
		STAGE_LABELS,
		type DocumentKind,
		type FeeLevel,
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
		initialTab = 'person',
		readonly = $bindable(false),
		canEdit = false,
		canLinkView = false,
		linkCount = 0,
		onlinks,
		onsaved
	}: {
		open?: boolean;
		member?: Member | null;
		groups: Group[];
		canUpload: boolean;
		canRemoveDoc: boolean;
		/** Tab beim Öffnen (Standard „Person“) */
		initialTab?: MemberFormTab;
		/** Nur Ansicht: alle Felder gesperrt, „Bearbeiten“ schaltet im selben Dialog frei */
		readonly?: boolean;
		canEdit?: boolean;
		canLinkView?: boolean;
		linkCount?: number;
		onlinks?: (m: Member) => void;
		onsaved: () => void | Promise<void>;
	} = $props();

	const viewing = $derived(readonly && !!member);

	const base = '/api/v1/modules/members/members';
	const accept = DOCUMENT_CONTENT_TYPES.join(',');
	const maxMb = MAX_DOCUMENT_BYTES / 1024 / 1024;
	const hasGroups = $derived(groups.length > 0);
	const today = new Date().toISOString().slice(0, 10);
	const left = $derived(!!member?.exitDate && member.exitDate <= today);
	const groupOptions = $derived(
		groups.map((g) => ({ value: g.id, label: g.name, description: GROUP_TYPE_LABELS[g.type] }))
	);
	const toRows = (list: ContactEntry[]) =>
		list.map((c) => ({ name: c.name ?? '', value: c.value }));

	let tab = $state<MemberFormTab>('person');
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
	let entryDate = $state('');
	let exitDate = $state('');
	let secondaryMember = $state(false);
	let feeLevels = $state<FeeLevel[]>([...FEE_LEVELS]);
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

	const visibleCustomFields = $derived(customFields.filter((f) => !f.hidden));

	// Formular bei jedem Oeffnen neu befuellen
	$effect(() => {
		if (!open) return;
		const m = member;
		tab = initialTab;
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
		entryDate = m?.entryDate ?? '';
		exitDate = m?.exitDate ?? '';
		secondaryMember = m?.secondaryMember ?? false;
		feeLevels = m ? [...m.feeLevels] : [...FEE_LEVELS];
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

	// Schutz gegen ueberholte Antworten, wenn das Formular schnell fuer ein anderes Mitglied neu oeffnet
	let customLoad = 0;
	async function loadCustomFields(values: Record<string, unknown>) {
		const seq = ++customLoad;
		try {
			const r = await apiFetch<{ fields: { active: boolean; field: FieldDefinition }[] }>(
				'/modules/members/fields'
			);
			if (seq !== customLoad) return;
			customFields = r.fields.filter((d) => d.active).map((d) => d.field);
			custom = Object.fromEntries(
				customFields.map((f) => [f.key, (values[f.key] ?? null) as FormValues[string]])
			);
		} catch {
			if (seq === customLoad) customFields = [];
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

	function toggleLevel(level: FeeLevel, on: boolean) {
		const next = on ? [...feeLevels, level] : feeLevels.filter((l) => l !== level);
		feeLevels = FEE_LEVELS.filter((l) => next.includes(l));
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

	/** Feld → Tab (Reihenfolge der Tabs = Reihenfolge der Fehlersuche) */
	const TAB_ORDER: MemberFormTab[] = ['person', 'contact', 'membership', 'custom', 'consent'];
	const TAB_FIELDS: Record<MemberFormTab, string[]> = {
		person: [
			'firstName',
			'lastName',
			'scoutName',
			'birthDate',
			'street',
			'postalCode',
			'city',
			'country'
		],
		contact: ['phones', 'emails'],
		membership: ['stage', 'groupIds', 'entryDate', 'exitDate', 'secondaryMember', 'feeLevels'],
		custom: ['custom'],
		consent: ['consentSocialMedia', 'consentWebsite', 'consentPrint']
	};
	const fieldOrder = TAB_ORDER.flatMap((t) => TAB_FIELDS[t]);
	function tabOf(key: string): MemberFormTab | null {
		const head = key.split('.')[0] ?? '';
		const t = TAB_ORDER.find((x) => TAB_FIELDS[x].includes(head)) ?? null;
		// Ohne sichtbare Zusatzfelder gibt es den Tab nicht – Fehler dort keinem Tab zuordnen
		return t === 'custom' && !visibleCustomFields.length ? null : t;
	}
	const tabErrors = $derived(
		new Set(
			Object.keys(fieldErrors)
				.map(tabOf)
				.filter((t): t is MemberFormTab => t !== null)
		)
	);

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
		groupIds: 'm-groups',
		entryDate: 'm-entry',
		exitDate: 'm-exit',
		secondaryMember: 'm-secondary',
		feeLevels: 'm-fee-stamm'
	};
	function idFor(key: string): string {
		const m = /^(phones|emails)\.(\d+)\.(name|value)$/.exec(key);
		if (m) return `m-${m[1]}-${m[2]}-${m[3]}`;
		const c = /^custom\.(.+)$/.exec(key);
		if (c) {
			const f = customFields.find((d) => d.key === c[1]);
			return f ? `m-custom-${f.id}-input` : '';
		}
		return fieldIds[key] ?? '';
	}

	/** Wechselt zum ersten Tab mit Fehler und fokussiert dort das erste Feld. */
	async function focusFirstError() {
		const rank = (k: string) => {
			const i = fieldOrder.indexOf(k.split('.')[0] ?? '');
			return i < 0 ? 99 : i;
		};
		const keys = Object.keys(fieldErrors).sort(
			(a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true })
		);
		const target = keys.map(tabOf).find((t) => t !== null);
		if (target) tab = target;
		await tick();
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
		if (viewing) return;
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
			entryDate: entryDate || null,
			exitDate: exitDate || null,
			secondaryMember,
			// Nicht-Zweitmitglieder zahlen alle Ebenen bei uns
			feeLevels: secondaryMember ? feeLevels : [...FEE_LEVELS],
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

	/** Von der Ansicht in die Bearbeitung wechseln (gleicher Dialog, aktueller Tab bleibt). */
	async function startEdit() {
		readonly = false;
		await tick();
		document.getElementById(fieldIds[TAB_FIELDS[tab][0] ?? ''] ?? '')?.focus();
	}

	const docs = DOCUMENT_KINDS.map((kind) => ({ kind, label: DOCUMENT_LABELS[kind] }));
	const stageOptions = STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }));
	const consentItems = [
		{ id: 'm-consent-social', label: 'Socialmedia', key: 'consentSocialMedia' },
		{ id: 'm-consent-web', label: 'Stammeswebsite', key: 'consentWebsite' },
		{ id: 'm-consent-print', label: 'Print', key: 'consentPrint' }
	] as const;
	const tabs = $derived([
		{ value: 'person' as const, label: 'Person' },
		{ value: 'contact' as const, label: 'Kontakt' },
		{ value: 'membership' as const, label: 'Mitgliedschaft' },
		...(visibleCustomFields.length ? [{ value: 'custom' as const, label: 'Weitere Angaben' }] : []),
		{ value: 'consent' as const, label: 'Einwilligungen & Dokumente' }
	] satisfies { value: MemberFormTab; label: string }[]);
</script>

{#snippet dateInput(id: string, key: 'entryDate' | 'exitDate', label: string)}
	<FormField {label} {id} error={fieldErrors[key]}>
		{#if key === 'entryDate'}
			<Input
				{id}
				type="date"
				bind:value={entryDate}
				aria-invalid={!!fieldErrors[key]}
				aria-describedby={fieldErrors[key] ? `${id}-error` : undefined}
			/>
		{:else}
			<Input
				{id}
				type="date"
				min={entryDate || undefined}
				bind:value={exitDate}
				aria-invalid={!!fieldErrors[key]}
				aria-describedby={fieldErrors[key] ? `${id}-error` : undefined}
			/>
		{/if}
	</FormField>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[90vh] flex-col sm:max-w-2xl">
		<Dialog.Header>
			{#if viewing && member}
				<Dialog.Title class="flex flex-wrap items-center gap-2">
					{member.firstName}
					{member.lastName}
					<Badge variant="secondary">{STAGE_LABELS[member.stage]}</Badge>
					{#if member.secondaryMember}<Badge variant="outline">Zweitmitglied</Badge>{/if}
					{#if left}<Badge variant="destructive">ausgetreten</Badge>{/if}
				</Dialog.Title>
				<Dialog.Description>
					Nur Ansicht{canEdit ? ' – zum Ändern auf „Bearbeiten“ klicken.' : '.'}
				</Dialog.Description>
			{:else}
				<Dialog.Title>{member ? 'Mitglied bearbeiten' : 'Mitglied anlegen'}</Dialog.Title>
				<Dialog.Description>Pflichtfelder sind mit * markiert.</Dialog.Description>
			{/if}
		</Dialog.Header>

		<form class="flex min-h-0 flex-1 flex-col gap-4" onsubmit={submit} novalidate>
			<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col gap-3">
				<Tabs.List
					variant="line"
					class="w-full flex-wrap justify-start gap-y-2 group-data-[orientation=horizontal]/tabs:h-auto"
				>
					{#each tabs as t (t.value)}
						<Tabs.Trigger value={t.value} class="flex-none">
							{t.label}
							{#if tabErrors.has(t.value)}
								<span class="size-1.5 rounded-full bg-destructive" aria-hidden="true"></span>
								<span class="sr-only">(enthält Fehler)</span>
							{/if}
						</Tabs.Trigger>
					{/each}
				</Tabs.List>

				<div class="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1 sm:min-h-[26rem]">
					<!-- Ansicht: das deaktivierte fieldset sperrt alle Felder; gesperrte Felder bleiben gut lesbar -->
					<fieldset
						disabled={viewing}
						class={[
							'min-w-0',
							viewing &&
								'[&_:disabled]:cursor-default [&_:disabled]:opacity-100 [&_input:disabled]:bg-muted/40 [&_label]:opacity-100 [&_textarea:disabled]:bg-muted/40'
						]}
					>
						<Tabs.Content value="person" class="space-y-4">
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
											<span
												class="text-sm whitespace-nowrap text-muted-foreground"
												aria-live="polite">({age}&nbsp;{age === 1 ? 'Jahr' : 'Jahre'})</span
											>
										{/if}
									</div>
								</FormField>
							</div>
							<AddressFields
								bind:street
								bind:postalCode
								bind:city
								bind:country
								errors={fieldErrors}
							/>
						</Tabs.Content>

						<Tabs.Content value="contact" class="space-y-4">
							<ContactListField
								id="m-phones"
								label="Telefonnummern"
								type="tel"
								valueLabel="Telefonnummer"
								valuePlaceholder="Telefonnummer"
								bind:items={phones}
								readonly={viewing}
								emptyText="Keine Telefonnummer hinterlegt."
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
								readonly={viewing}
								emptyText="Keine E-Mail-Adresse hinterlegt."
								errors={rowErrors('emails')}
								listError={fieldErrors.emails}
							/>
						</Tabs.Content>

						<Tabs.Content value="membership" class="space-y-4">
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
								{#if viewing}
									<p class="text-sm font-medium">Gruppen</p>
									<div
										id="m-groups"
										class="flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input bg-muted/40 px-2 py-1 text-sm"
									>
										{#each member?.groups ?? [] as g (g.id)}
											<ColorBadge color={g.color}>{g.name}</ColorBadge>
										{:else}
											<span class="text-muted-foreground">Keine Gruppe</span>
										{/each}
									</div>
								{:else if hasGroups}
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

							<div class="grid gap-4 sm:grid-cols-2">
								{@render dateInput('m-entry', 'entryDate', 'Eintritt')}
								{@render dateInput('m-exit', 'exitDate', 'Austritt')}
							</div>
							<p class="-mt-2 text-xs text-muted-foreground" hidden={viewing}>
								Mit erreichtem Austrittsdatum erscheint das Mitglied nur noch im Filter
								„Ausgetreten“.
							</p>

							<div class="space-y-3 rounded-md border p-3">
								<div class="flex items-center justify-between gap-4">
									<label for="m-secondary" class="space-y-0.5">
										<span class="block text-sm font-medium">Zweitmitglied</span>
										<span class="block text-xs text-muted-foreground">
											Hauptmitgliedschaft in einem anderen Stamm.
										</span>
									</label>
									<Switch id="m-secondary" bind:checked={secondaryMember} />
								</div>
								{#if secondaryMember}
									<fieldset class="space-y-2">
										<legend class="text-sm font-medium">Beitrag bei uns zahlen für</legend>
										<div class="flex flex-wrap gap-x-5 gap-y-2">
											{#each FEE_LEVELS as level (level)}
												<div class="flex items-center gap-2">
													<Checkbox
														id={`m-fee-${level}`}
														checked={feeLevels.includes(level)}
														aria-invalid={!!fieldErrors.feeLevels}
														onCheckedChange={(v) => toggleLevel(level, v === true)}
													/>
													<label for={`m-fee-${level}`} class="text-sm">
														{FEE_LEVEL_LABELS[level]}
													</label>
												</div>
											{/each}
										</div>
										<p class="text-xs text-muted-foreground">
											Nur angehakte Ebenen werden im Jahresbeitrag berechnet.
										</p>
										{#if fieldErrors.feeLevels}
											<p role="alert" class="text-xs text-destructive">{fieldErrors.feeLevels}</p>
										{/if}
									</fieldset>
								{/if}
							</div>
						</Tabs.Content>

						{#if visibleCustomFields.length}
							<Tabs.Content value="custom" class="space-y-3">
								{#if !viewing}
									<p class="text-xs text-muted-foreground">Alle Angaben sind freiwillig.</p>
								{/if}
								<FormRenderer
									readonly={viewing}
									definition={{ version: 1, fields: customFields }}
									bind:values={custom}
									idPrefix="m-custom"
									errors={Object.fromEntries(
										Object.entries(fieldErrors)
											.filter(([k]) => k.startsWith('custom.'))
											.map(([k, v]) => [k.slice(7), v])
									)}
								/>
							</Tabs.Content>
						{/if}

						<Tabs.Content value="consent" class="space-y-6">
							<fieldset class="space-y-2">
								<legend class="text-sm font-medium">Darf gezeigt werden auf</legend>
								<div class="flex flex-wrap gap-x-5 gap-y-2">
									{#each consentItems as c (c.id)}
										<div class="flex items-center gap-2">
											{#if c.key === 'consentSocialMedia'}
												<Checkbox id={c.id} bind:checked={consentSocialMedia} />
											{:else if c.key === 'consentWebsite'}
												<Checkbox id={c.id} bind:checked={consentWebsite} />
											{:else}
												<Checkbox id={c.id} bind:checked={consentPrint} />
											{/if}
											<label for={c.id} class="text-sm">{c.label}</label>
										</div>
									{/each}
								</div>
							</fieldset>

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
											canUpload={canUpload && !viewing}
											canRemove={canRemoveDoc && !viewing}
											onremove={() => removeDoc(d.kind)}
										/>
										{#if canUpload && !viewing}
											<p class="text-xs text-muted-foreground">
												{name ? 'Eine neue Datei ersetzt die vorhandene. ' : ''}PDF oder Bild, max. {maxMb}
												MB{member ? '' : '; wird nach dem Anlegen hochgeladen'}.
											</p>
										{:else if !name}
											<p class="text-sm text-muted-foreground">Kein Dokument hinterlegt.</p>
										{/if}
									</div>
								{/each}
							</div>
						</Tabs.Content>
					</fieldset>
				</div>
			</Tabs.Root>

			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				{#if viewing && member}
					{#if canLinkView && onlinks}
						<Button
							type="button"
							variant="outline"
							class="sm:mr-auto"
							onclick={() => member && onlinks(member)}
						>
							<Link2 /> Verknüpfte Konten ({linkCount})
						</Button>
					{/if}
					<Button type="button" variant="outline" onclick={() => (open = false)}>Schließen</Button>
					{#if canEdit}
						<Button type="button" onclick={startEdit}><Pencil /> Bearbeiten</Button>
					{/if}
				{:else}
					<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
					<Button type="submit" disabled={busy}>{busy ? 'Speichert …' : 'Speichern'}</Button>
				{/if}
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
