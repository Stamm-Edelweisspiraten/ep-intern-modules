<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { page } from '$app/state';
	import { AssistTextarea, BUSY_SAVE, FileField, FormField } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { ColorPicker } from '$lib/components/ui/color-picker';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Tabs from '$lib/components/ui/tabs';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import {
		formatAgeRange,
		GROUP_IMAGE_CONTENT_TYPES,
		GROUP_TYPE_LABELS,
		GROUP_TYPES,
		type Group,
		type GroupFormInput,
		type GroupLeaderUser,
		type GroupType,
		groupInput,
		MAX_GROUP_IMAGE_BYTES,
		MAX_GROUP_SLUG,
		type MemberList,
		type MemberRef,
		WEEKDAY_LABELS,
		WEEKDAYS
	} from '../schemas';
	import { slugFromName } from '../slug';
	import { imageUrl, personName } from './group-actions';
	import LeaderUserPicker from './LeaderUserPicker.svelte';

	type DialogTab = 'general' | 'website';

	/** Gruppe anlegen (`group = null`) oder bearbeiten; `onsaved` nach erfolgreichem Speichern */
	let {
		open = $bindable(false),
		group = null,
		initialTab = 'general',
		onsaved
	}: {
		open?: boolean;
		group?: Group | null;
		initialTab?: DialogTab;
		onsaved?: (group: Group) => void | Promise<void>;
	} = $props();

	const permissions = $derived((page.data.permissions ?? []) as string[]);

	// Mitglieder für die Leitungsauswahl (nur mit `members.member.view`), beim ersten Öffnen geladen
	let members = $state<MemberRef[]>([]);
	let membersLoaded = false;
	async function loadMembers() {
		if (membersLoaded || !can(permissions, 'members.member.view')) return;
		membersLoaded = true;
		try {
			const all: MemberRef[] = [];
			let offset = 0;
			for (;;) {
				const res = await apiFetch<MemberList>(
					`/modules/members/members?status=all&limit=200&offset=${offset}`
				);
				all.push(...res.items);
				offset += res.items.length;
				if (res.items.length === 0 || offset >= res.total) break;
			}
			members = all.sort((a, b) => personName(a).localeCompare(personName(b), 'de'));
		} catch {
			membersLoaded = false;
		}
	}

	// Beim Öffnen die Felder aus der Gruppe (bzw. leer) übernehmen
	let wasOpen = false;
	$effect(() => {
		const o = open;
		untrack(() => {
			if (o && !wasOpen) {
				if (group) openEdit(group);
				else openCreate();
				dialogTab = initialTab;
				void loadMembers();
			}
			wasOpen = o;
		});
	});

	let busy = $state(false);
	let formError = $state('');
	let editing = $state<Group | null>(null);
	let name = $state('');
	let type = $state<string | null>(null);
	let leaderIds = $state<string[]>([]);
	let leaderUsers = $state<GroupLeaderUser[]>([]);
	let description = $state('');
	let meetingPlace = $state('');
	let meetingTime = $state('');
	let meetingEndTime = $state('');
	let meetingWeekday = $state<string | null>(null);
	let color = $state<string | null>(null);
	let fieldErrors = $state<Record<string, string>>({});
	let imageFile = $state<File | null>(null);
	let imagePreview = $state<string | null>(null);
	let removeImage = $state(false);

	// --- Website-Steckbrief -----------------------------------------------------------
	let dialogTab = $state<DialogTab>('general');
	let onWebsite = $state(false);
	let slug = $state('');
	/** true, sobald die Adresse von Hand geändert wurde (dann folgt sie nicht mehr dem Namen) */
	let slugTouched = $state(false);
	let websiteText = $state('');
	// `type="number"` bindet Zahlen (leer → null)
	let ageMin = $state<number | string | null>('');
	let ageMax = $state<number | string | null>('');
	/** Frühere Freitext-Angabe ohne lesbare Zahlen (nur Hinweis) */
	let legacyAgeText = $state('');
	const ageNumber = (v: number | string | null): number | null =>
		v == null || String(v).trim() === '' ? null : Number(v);
	const agePreview = $derived.by(() => {
		const min = ageNumber(ageMin);
		const max = ageNumber(ageMax);
		return min != null && max != null && max < min ? null : formatAgeRange(min, max);
	});
	let contactEmail = $state('');
	const nameSlug = $derived(slugFromName(name));
	const slugPreview = $derived(slug.trim().toLowerCase() || nameSlug || 'adresse');
	const websiteHasError = $derived(Object.keys(fieldErrors).some((k) => k.startsWith('website.')));
	const generalHasError = $derived(Object.keys(fieldErrors).some((k) => !k.startsWith('website.')));

	function onNameInput() {
		if (!slugTouched) slug = slugFromName(name);
	}

	const imageAccept = GROUP_IMAGE_CONTENT_TYPES.join(',');
	const typeOptions = GROUP_TYPES.map((t) => ({ value: t, label: GROUP_TYPE_LABELS[t] }));
	const weekdayOptions = WEEKDAYS.map((d) => ({
		value: String(d),
		label: WEEKDAY_LABELS[d] ?? String(d)
	}));

	/** Formularwerte für die Schreibhilfe (Gruppentexte) */
	function groupAssistExtra(): Record<string, string> {
		const day = weekdayOptions.find((o) => o.value === meetingWeekday)?.label ?? '';
		const time = meetingTime
			? `${meetingTime}${meetingEndTime ? `–${meetingEndTime}` : ''} Uhr`
			: '';
		const min = ageNumber(ageMin);
		const max = ageNumber(ageMax);
		const ages =
			min != null && max != null
				? `${min} bis ${max} Jahre`
				: min != null
					? `ab ${min} Jahren`
					: max != null
						? `bis ${max} Jahre`
						: '';
		return { name, ages, meeting: [day, time, meetingPlace].filter(Boolean).join(', ') };
	}

	const leaderOptions = $derived(members.map((m) => ({ value: m.id, label: personName(m) })));

	function setPreview(url: string | null) {
		if (imagePreview) URL.revokeObjectURL(imagePreview);
		imagePreview = url;
	}

	$effect(() => {
		const f = imageFile;
		setPreview(f ? URL.createObjectURL(f) : null);
		if (f) removeImage = false;
	});

	const shownImage = $derived(
		imagePreview ?? (editing?.hasImage && !removeImage ? imageUrl(editing) : null)
	);

	function openCreate() {
		editing = null;
		name = '';
		type = null;
		leaderIds = [];
		leaderUsers = [];
		description = '';
		meetingPlace = '';
		meetingTime = '';
		meetingEndTime = '';
		meetingWeekday = null;
		color = null;
		setWebsite(null);
		resetImage();
		fieldErrors = {};
		formError = '';
	}

	function setWebsite(g: Group | null) {
		dialogTab = 'general';
		onWebsite = g?.website.onWebsite ?? false;
		slug = g?.website.slug ?? (g ? slugFromName(g.name) : '');
		slugTouched = Boolean(g?.website.slug);
		websiteText = g?.website.description ?? '';
		ageMin = g?.website.ageMin ?? '';
		ageMax = g?.website.ageMax ?? '';
		legacyAgeText =
			g && g.website.ageMin == null && g.website.ageMax == null ? (g.website.ageRange ?? '') : '';
		contactEmail = g?.website.contactEmail ?? '';
	}

	function openEdit(g: Group) {
		editing = g;
		name = g.name;
		type = g.type;
		leaderIds = g.leaders.map((l) => l.id);
		leaderUsers = g.leaderUsers.map((u) => ({ ...u }));
		description = g.description ?? '';
		meetingPlace = g.meetingPlace ?? '';
		meetingTime = g.meetingTime ?? '';
		meetingEndTime = g.meetingEndTime ?? '';
		meetingWeekday = g.meetingWeekday ? String(g.meetingWeekday) : null;
		color = g.color;
		setWebsite(g);
		resetImage();
		fieldErrors = {};
		formError = '';
	}

	function resetImage() {
		imageFile = null;
		removeImage = false;
		setPreview(null);
	}

	const fieldIds: Record<string, string> = {
		name: 'g-name',
		type: 'g-type',
		leaderIds: 'g-leaders',
		leaderUserIds: 'g-leader-users',
		description: 'g-desc',
		meetingPlace: 'g-place',
		meetingWeekday: 'g-weekday',
		meetingTime: 'g-time',
		meetingEndTime: 'g-time-end',
		color: 'g-color',
		'website.onWebsite': 'g-web-on',
		'website.slug': 'g-web-slug',
		'website.description': 'g-web-text',
		'website.ageMin': 'g-web-age-min',
		'website.ageMax': 'g-web-age-max',
		'website.contactEmail': 'g-web-mail'
	};

	/** Fehlerschlüssel: Website-Felder als `website.<feld>`, sonst das erste Pfadsegment */
	function errorKey(path: readonly PropertyKey[] | undefined): string {
		const first = String(path?.[0] ?? '');
		return first === 'website' && path?.[1] != null ? `website.${String(path[1])}` : first;
	}

	async function focusFirstError() {
		if (generalHasError) dialogTab = 'general';
		else if (websiteHasError) dialogTab = 'website';
		await tick();
		for (const k of Object.keys(fieldIds)) {
			if (!fieldErrors[k]) continue;
			const el = document.getElementById(fieldIds[k] ?? '');
			if (el) {
				el.scrollIntoView({ block: 'center' });
				el.focus();
				return;
			}
		}
	}

	function applyDetails(details: unknown) {
		const out: Record<string, string> = {};
		const issues = (details as { issues?: { path?: (string | number)[]; message?: string }[] })
			?.issues;
		if (Array.isArray(issues)) {
			for (const i of issues) {
				const key = errorKey(i.path);
				if (key && i.message && !out[key]) out[key] = i.message;
			}
		}
		fieldErrors = out;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		formError = '';
		fieldErrors = {};
		const input: GroupFormInput = {
			name,
			type: type as GroupType,
			leaderIds,
			leaderUserIds: leaderUsers.map((u) => u.id),
			description: description || null,
			meetingPlace: meetingPlace || null,
			meetingWeekday: meetingWeekday ? Number(meetingWeekday) : null,
			meetingTime: meetingTime || null,
			meetingEndTime: meetingEndTime || null,
			color,
			website: {
				onWebsite,
				slug: slug.trim() || null,
				description: websiteText.trim() || null,
				ageMin: ageNumber(ageMin),
				ageMax: ageNumber(ageMax),
				contactEmail: contactEmail.trim() || null
			}
		};
		const parsed = groupInput.safeParse(input);
		const errs: Record<string, string> = {};
		if (!parsed.success) {
			for (const i of parsed.error.issues) {
				const key = errorKey(i.path);
				if (key && !errs[key]) errs[key] = i.message;
			}
		}
		if (!type) errs.type = 'Bitte einen Typ wählen';
		if (!parsed.success || Object.keys(errs).length) {
			fieldErrors = errs;
			formError = 'Bitte die markierten Felder prüfen.';
			void focusFirstError();
			return;
		}
		busy = true;
		try {
			const body = JSON.stringify(parsed.data);
			let saved: Group;
			if (editing) {
				saved = await apiFetch<Group>(`/modules/members/groups/${editing.id}`, {
					method: 'PUT',
					body
				});
				toast.success('Gruppe gespeichert');
			} else {
				saved = await apiFetch<Group>('/modules/members/groups', { method: 'POST', body });
				toast.success('Gruppe angelegt');
			}
			const gid = saved?.id ?? editing?.id;
			if (gid) {
				try {
					if (imageFile) {
						const fd = new FormData();
						fd.append('file', imageFile);
						await apiFetch(`/modules/members/groups/${gid}/image`, { method: 'POST', body: fd });
					} else if (removeImage && editing?.hasImage) {
						await apiFetch(`/modules/members/groups/${gid}/image`, { method: 'DELETE' });
					}
				} catch (err) {
					toast.error(
						`Gruppenbild: ${err instanceof ApiClientError ? err.message : 'Upload fehlgeschlagen'}`
					);
				}
			}
			open = false;
			resetImage();
			await onsaved?.(saved);
		} catch (err) {
			if (err instanceof ApiClientError) {
				formError = err.message;
				applyDetails(err.details);
				// Doppelte Website-Adresse (409) am Feld zeigen
				if (err.status === 409 && /Website-Adresse/.test(err.message)) {
					fieldErrors = { ...fieldErrors, 'website.slug': err.message };
				}
				void focusFirstError();
			} else {
				formError = 'Speichern fehlgeschlagen.';
			}
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{editing ? 'Gruppe bearbeiten' : 'Gruppe anlegen'}</Dialog.Title>
			<Dialog.Description>Pflichtfelder sind mit * markiert.</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<Tabs.Root bind:value={dialogTab} class="gap-4">
				<Tabs.List variant="line" class="w-full justify-start">
					<Tabs.Trigger value="general" class="flex-none">
						Allgemein
						{#if generalHasError}
							<span class="size-1.5 rounded-full bg-destructive" aria-hidden="true"></span>
							<span class="sr-only">(enthält Fehler)</span>
						{/if}
					</Tabs.Trigger>
					<Tabs.Trigger value="website" class="flex-none">
						Website
						{#if websiteHasError}
							<span class="size-1.5 rounded-full bg-destructive" aria-hidden="true"></span>
							<span class="sr-only">(enthält Fehler)</span>
						{:else if onWebsite}
							<span class="size-1.5 rounded-full bg-primary" aria-hidden="true"></span>
							<span class="sr-only">(aktiv)</span>
						{/if}
					</Tabs.Trigger>
				</Tabs.List>
				<Tabs.Content value="general" class="space-y-4">
					<FormField label="Name *" id="g-name" error={fieldErrors.name}>
						<Input
							id="g-name"
							required
							maxlength={100}
							bind:value={name}
							oninput={onNameInput}
							aria-invalid={!!fieldErrors.name}
							aria-describedby={fieldErrors.name ? 'g-name-error' : undefined}
						/>
					</FormField>

					<FormField label="Typ *" id="g-type" error={fieldErrors.type}>
						<SelectField
							id="g-type"
							label="Typ"
							options={typeOptions}
							bind:value={type}
							placeholder="Typ wählen"
							invalid={!!fieldErrors.type}
						/>
					</FormField>

					<fieldset class="min-w-0 space-y-3">
						<legend class="text-sm font-medium">Gruppenleitung *</legend>
						<p class="-mt-1 text-xs text-muted-foreground">
							Mindestens eine Leitung – ein Mitglied oder ein Benutzerkonto. Leitungen mit Konto
							sehen die Mitglieder der Gruppe{contactEmail.trim()
								? ` und bekommen das Postfach ${contactEmail.trim()}`
								: ''}.
						</p>
						{#if members.length}
							<MultiSelect
								id="g-leaders"
								label="Mitglieder"
								options={leaderOptions}
								bind:value={leaderIds}
								placeholder="Mitglieder auswählen"
								searchPlaceholder="Mitglieder durchsuchen …"
								emptyText="Keine Treffer."
								invalid={!!fieldErrors.leaderIds}
							/>
						{/if}
						<div class="space-y-1.5">
							<label for="g-leader-users" class="text-sm font-medium">Benutzerkonten</label>
							<LeaderUserPicker
								id="g-leader-users"
								bind:value={leaderUsers}
								invalid={!!fieldErrors.leaderIds || !!fieldErrors.leaderUserIds}
							/>
						</div>
						{#if fieldErrors.leaderIds}
							<p role="alert" class="text-xs text-destructive">{fieldErrors.leaderIds}</p>
						{/if}
						{#if fieldErrors.leaderUserIds}
							<p role="alert" class="text-xs text-destructive">{fieldErrors.leaderUserIds}</p>
						{/if}
					</fieldset>

					<FormField label="Beschreibung" id="g-desc" error={fieldErrors.description}>
						<AssistTextarea
							id="g-desc"
							assist={{ module: 'members', purpose: 'group-description', extra: groupAssistExtra }}
							rows={3}
							maxlength={2000}
							bind:value={description}
							aria-invalid={!!fieldErrors.description}
							aria-describedby={fieldErrors.description ? 'g-desc-error' : undefined}
						/>
					</FormField>

					<FormField label="Treffpunkt" id="g-place" error={fieldErrors.meetingPlace}>
						<Input
							id="g-place"
							maxlength={200}
							bind:value={meetingPlace}
							aria-invalid={!!fieldErrors.meetingPlace}
							aria-describedby={fieldErrors.meetingPlace ? 'g-place-error' : undefined}
						/>
					</FormField>

					<div class="grid gap-4 sm:grid-cols-3">
						<FormField label="Wochentag" id="g-weekday" error={fieldErrors.meetingWeekday}>
							<SelectField
								id="g-weekday"
								label="Wochentag"
								options={weekdayOptions}
								bind:value={meetingWeekday}
								emptyLabel="Kein Wochentag"
								invalid={!!fieldErrors.meetingWeekday}
							/>
						</FormField>
						<FormField label="Uhrzeit" id="g-time" error={fieldErrors.meetingTime}>
							<Input
								id="g-time"
								type="time"
								bind:value={meetingTime}
								aria-invalid={!!fieldErrors.meetingTime}
								aria-describedby={fieldErrors.meetingTime ? 'g-time-error' : undefined}
							/>
						</FormField>
						<FormField label="bis" id="g-time-end" error={fieldErrors.meetingEndTime}>
							<Input
								id="g-time-end"
								type="time"
								bind:value={meetingEndTime}
								aria-invalid={!!fieldErrors.meetingEndTime}
								aria-describedby={fieldErrors.meetingEndTime ? 'g-time-end-error' : undefined}
							/>
						</FormField>
					</div>

					<div class="space-y-1.5">
						<ColorPicker
							id="g-color"
							label="Gruppenfarbe"
							bind:value={color}
							allowClear
							invalid={!!fieldErrors.color}
						/>
						{#if fieldErrors.color}
							<p role="alert" class="text-xs text-destructive">{fieldErrors.color}</p>
						{/if}
					</div>

					<div class="space-y-2">
						<label for="g-image" class="text-sm font-medium">Gruppenbild</label>
						{#if shownImage}
							<img
								src={shownImage}
								alt="Vorschau des Gruppenbilds"
								class="size-16 rounded-full border-2 object-cover"
								style:border-color={color ?? 'transparent'}
							/>
						{/if}
						<FileField
							id="g-image"
							bind:file={imageFile}
							accept={imageAccept}
							maxBytes={MAX_GROUP_IMAGE_BYTES}
							crop={{
								shape: 'circle',
								maxEdge: 1200,
								title: 'Gruppenbild zuschneiden',
								background: color ?? '#ffffff'
							}}
							existingName={editing?.hasImage && !removeImage && !imageFile
								? 'Aktuelles Gruppenbild'
								: null}
							existingHref={editing?.hasImage ? imageUrl(editing) : null}
							canRemove
							onremove={() => (removeImage = true)}
						/>
						<p class="text-xs text-muted-foreground">
							JPEG, PNG oder WebP. Nach der Auswahl wählst du den Ausschnitt{editing
								? ''
								: '; das Bild wird nach dem Anlegen hochgeladen'}.
						</p>
					</div>
				</Tabs.Content>

				<Tabs.Content value="website" class="space-y-4">
					<p class="text-sm text-muted-foreground">
						Steckbrief für die Stammeswebsite. Gezeigt werden Name, Typ, Text, Alter, Treffen,
						Farbe, Gruppenbild, E-Mail-Adresse und die Vornamen der leitenden Mitglieder.
					</p>
					<div class="flex items-center gap-2">
						<Checkbox id="g-web-on" bind:checked={onWebsite} />
						<label for="g-web-on" class="text-sm font-medium">Auf der Website zeigen</label>
					</div>

					<FormField
						label={onWebsite ? 'Adresse *' : 'Adresse'}
						id="g-web-slug"
						error={fieldErrors['website.slug']}
						hint={`Vorschau: /gruppen/${slugPreview} – nur Kleinbuchstaben, Ziffern und Bindestriche.`}
					>
						<Input
							id="g-web-slug"
							maxlength={MAX_GROUP_SLUG}
							autocomplete="off"
							spellcheck={false}
							bind:value={slug}
							oninput={() => (slugTouched = true)}
							placeholder={nameSlug || 'z. B. woelflinge'}
							aria-invalid={!!fieldErrors['website.slug']}
							aria-describedby={fieldErrors['website.slug']
								? 'g-web-slug-error'
								: 'g-web-slug-hint'}
						/>
					</FormField>
					{#if nameSlug && slug.trim() !== nameSlug}
						<Button
							type="button"
							variant="link"
							size="sm"
							class="-mt-2 h-auto px-0"
							onclick={() => {
								slug = nameSlug;
								slugTouched = false;
							}}
						>
							Vorschlag übernehmen: {nameSlug}
						</Button>
					{/if}

					<FormField
						label="Text für die Website"
						id="g-web-text"
						error={fieldErrors['website.description']}
						hint="Leer = die interne Beschreibung wird gezeigt."
					>
						<AssistTextarea
							id="g-web-text"
							assist={{
								module: 'members',
								purpose: 'group-website-text',
								extra: groupAssistExtra
							}}
							rows={5}
							maxlength={5000}
							bind:value={websiteText}
							placeholder={description || undefined}
							aria-invalid={!!fieldErrors['website.description']}
							aria-describedby={fieldErrors['website.description']
								? 'g-web-text-error'
								: 'g-web-text-hint'}
						/>
					</FormField>

					<div class="grid gap-4 sm:grid-cols-2">
						<fieldset class="grid gap-2">
							<legend class="mb-2 text-sm font-medium">Alter</legend>
							<div class="grid grid-cols-2 gap-3">
								<FormField label="von" id="g-web-age-min" error={fieldErrors['website.ageMin']}>
									<Input
										id="g-web-age-min"
										type="number"
										inputmode="numeric"
										min="0"
										max="99"
										bind:value={ageMin}
										placeholder="z. B. 7"
										aria-invalid={!!fieldErrors['website.ageMin']}
										aria-describedby={fieldErrors['website.ageMin']
											? 'g-web-age-min-error'
											: 'g-web-age-hint'}
									/>
								</FormField>
								<FormField label="bis" id="g-web-age-max" error={fieldErrors['website.ageMax']}>
									<Input
										id="g-web-age-max"
										type="number"
										inputmode="numeric"
										min="0"
										max="99"
										bind:value={ageMax}
										placeholder="offen"
										aria-invalid={!!fieldErrors['website.ageMax']}
										aria-describedby={fieldErrors['website.ageMax']
											? 'g-web-age-max-error'
											: 'g-web-age-hint'}
									/>
								</FormField>
							</div>
							<p id="g-web-age-hint" class="text-sm text-muted-foreground">
								{#if agePreview}
									Auf der Website: „{agePreview}“
								{:else if legacyAgeText}
									Bisher: „{legacyAgeText}“ – bitte als Zahlen eintragen.
								{:else}
									Nur „von“ ausgefüllt wird zu „ab … Jahren“. Die Probestunde ordnet Kinder danach
									zu.
								{/if}
							</p>
						</fieldset>
						<FormField
							label="E-Mail-Adresse der Gruppe"
							id="g-web-mail"
							error={fieldErrors['website.contactEmail']}
							hint="Zugleich das Postfach der Gruppenleitungen unter Nachrichten."
						>
							<Input
								id="g-web-mail"
								type="email"
								maxlength={200}
								autocomplete="off"
								bind:value={contactEmail}
								placeholder="z. B. woelflinge@stamm.de"
								aria-invalid={!!fieldErrors['website.contactEmail']}
								aria-describedby={fieldErrors['website.contactEmail']
									? 'g-web-mail-error'
									: 'g-web-mail-hint'}
							/>
						</FormField>
					</div>
				</Tabs.Content>
			</Tabs.Root>

			{#if formError}
				<p class="text-sm text-destructive" role="alert">{formError}</p>
			{/if}
			<Dialog.Footer sticky>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
