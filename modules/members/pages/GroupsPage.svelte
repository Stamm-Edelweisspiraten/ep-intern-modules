<script lang="ts">
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import FileDown from '@lucide/svelte/icons/file-down';
	import Mail from '@lucide/svelte/icons/mail';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import { tick, untrack } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { ColorPicker } from '$lib/components/ui/color-picker';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		ConfirmDialog,
		DataTable,
		EntityAvatar,
		FileField,
		FormField,
		MobileActionBar,
		PageHeader,
		PdfExportDialog,
		BUSY_SAVE
	} from '$lib/components/layout';
	import type { ListCatalog, ListSelection } from '$lib/pdf-lists/types';
	import { downloadPdf } from './download';
	import LeaderUserPicker from './LeaderUserPicker.svelte';
	import { slugFromName } from '../slug';
	import {
		GROUP_IMAGE_CONTENT_TYPES,
		GROUP_TYPES,
		GROUP_TYPE_LABELS,
		MAX_GROUP_IMAGE_BYTES,
		MAX_GROUP_SLUG,
		WEEKDAYS,
		WEEKDAY_LABELS,
		groupInput,
		type GroupFormInput,
		type Group,
		type GroupLeaderUser,
		type GroupType,
		type MemberList,
		type MemberRef
	} from '../schemas';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canEdit = $derived(can(permissions, 'members.group.edit'));
	const canDelete = $derived(can(permissions, 'members.group.delete'));
	const canExport = $derived(
		can(permissions, 'members.data.export') && can(permissions, 'members.member.view')
	);

	// E-Mail an Gruppen: nur mit aktivem Modul „Nachrichten“ (Recht existiert nur dann)
	const canMail = $derived(
		can(permissions, 'messages.message.send') && can(permissions, 'members.member.view')
	);
	const canSelect = $derived(canExport || canMail);

	/** Auswahl an „Neue Nachricht“ übergeben (Modul messages, Schlüssel `messages:compose`) */
	function composeFor(groupIds: string[]) {
		try {
			sessionStorage.setItem('messages:compose', JSON.stringify({ groupIds }));
		} catch {
			// ohne Speicher startet die Nachricht ohne Vorauswahl
		}
		location.assign('/modules/messages/new');
	}

	let groups = $state<Group[]>([]);

	// --- Mitgliedsdaten-PDF (Seite je Gruppe) ---------------------------------------
	let selected = $state<string[]>([]);
	let sheetsBusy = $state(false);
	const allSelected = $derived(groups.length > 0 && groups.every((g) => selected.includes(g.id)));
	const someSelected = $derived(!allSelected && groups.some((g) => selected.includes(g.id)));
	const SHEETS_MAX_GROUPS = 20;

	function toggle(id: string, on: boolean) {
		if (on && selected.length >= SHEETS_MAX_GROUPS && !selected.includes(id)) {
			toast.error(`Höchstens ${SHEETS_MAX_GROUPS} Gruppen auf einmal`);
			return;
		}
		selected = on ? [...new Set([...selected, id])] : selected.filter((i) => i !== id);
	}
	function toggleAll(on: boolean) {
		selected = on ? groups.map((g) => g.id).slice(0, SHEETS_MAX_GROUPS) : [];
	}
	let sheetsOpen = $state(false);
	let sheetCatalog = $state<ListCatalog | null>(null);
	/** Ziel des Dialogs: gewählte Gruppen bzw. eine einzelne Zeile */
	let sheetTarget = $state<{ ids: string[]; fileName: string }>({
		ids: [],
		fileName: 'Gruppen.pdf'
	});
	const sheetCount = $derived(
		groups.filter((g) => sheetTarget.ids.includes(g.id)).reduce((s, g) => s + g.memberCount, 0)
	);

	/** Öffnet den Spalten-Dialog; der Katalog (inkl. Zusatzfelder) kommt vom Server */
	async function openSheets(ids: string[], fileName: string) {
		sheetTarget = { ids, fileName };
		if (!sheetCatalog) {
			try {
				sheetCatalog = await apiFetch<ListCatalog>('/modules/members/members/sheet-columns');
			} catch (e) {
				toast.error(e instanceof Error ? e.message : 'Spalten konnten nicht geladen werden');
				return;
			}
		}
		sheetsOpen = true;
	}
	async function groupSheets(selection: ListSelection) {
		sheetsBusy = true;
		try {
			await downloadPdf(
				'/api/v1/modules/members/groups/sheets.pdf',
				{ method: 'POST', body: JSON.stringify({ groupIds: sheetTarget.ids, selection }) },
				sheetTarget.fileName
			);
			toast.success('Mitgliederliste erzeugt');
			sheetsOpen = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'PDF konnte nicht erzeugt werden');
		} finally {
			sheetsBusy = false;
		}
	}
	let members = $state<MemberRef[]>([]);
	let loading = $state(true);
	let loadError = $state('');

	let formOpen = $state(false);
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
	type DialogTab = 'general' | 'website';
	let dialogTab = $state<DialogTab>('general');
	let onWebsite = $state(false);
	let slug = $state('');
	/** true, sobald die Adresse von Hand geändert wurde (dann folgt sie nicht mehr dem Namen) */
	let slugTouched = $state(false);
	let websiteText = $state('');
	let ageRange = $state('');
	let contactEmail = $state('');
	const nameSlug = $derived(slugFromName(name));
	const slugPreview = $derived(slug.trim().toLowerCase() || nameSlug || 'adresse');
	const websiteHasError = $derived(Object.keys(fieldErrors).some((k) => k.startsWith('website.')));
	const generalHasError = $derived(Object.keys(fieldErrors).some((k) => !k.startsWith('website.')));

	function onNameInput() {
		if (!slugTouched) slug = slugFromName(name);
	}

	const imageAccept = GROUP_IMAGE_CONTENT_TYPES.join(',');
	const maxImageMb = MAX_GROUP_IMAGE_BYTES / 1024 / 1024;
	const typeOptions = GROUP_TYPES.map((t) => ({ value: t, label: GROUP_TYPE_LABELS[t] }));
	const weekdayOptions = WEEKDAYS.map((d) => ({
		value: String(d),
		label: WEEKDAY_LABELS[d] ?? String(d)
	}));

	let deleteOpen = $state(false);
	let toDelete = $state<Group | null>(null);

	function personName(m: MemberRef) {
		const base = `${m.firstName} ${m.lastName}`;
		return m.scoutName ? `${m.scoutName} (${base})` : base;
	}

	const leaderOptions = $derived(members.map((m) => ({ value: m.id, label: personName(m) })));

	/** Leitende Mitglieder und Konten für die Tabelle */
	function leaderText(g: Group) {
		return [...g.leaders.map(personName), ...g.leaderUsers.map((u) => u.name)].join(', ') || '–';
	}

	function imageUrl(g: Group) {
		return `/api/v1/modules/members/groups/${g.id}/image?v=${encodeURIComponent(g.imageVersion ?? '')}`;
	}
	function meetingText(g: Group) {
		const day = g.meetingWeekday ? WEEKDAY_LABELS[g.meetingWeekday] : null;
		const time =
			g.meetingTime && g.meetingEndTime ? `${g.meetingTime}–${g.meetingEndTime}` : g.meetingTime;
		if (day && time) return `${day}, ${time}`;
		return day ?? time ?? '–';
	}

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

	async function load() {
		loading = true;
		loadError = '';
		try {
			groups = await apiFetch<Group[]>('/modules/members/groups');
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
		} catch (e) {
			loadError = e instanceof ApiClientError ? e.message : 'Gruppen konnten nicht geladen werden.';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void load();
	});

	// Deep-Link (globale Suche): `?open=<id>` hebt die Gruppe hervor, mit Bearbeitungsrecht öffnet der Dialog
	let highlightId = $state('');
	let openedId = '';
	$effect(() => {
		const id = page.url.searchParams.get('open') ?? '';
		if (!id || loading || id === openedId) return;
		const g = groups.find((x) => x.id === id);
		if (!g) return;
		openedId = id;
		untrack(() => {
			highlightId = id;
			if (canEdit) openEdit(g);
			void tick().then(() =>
				document.getElementById(`group-${id}`)?.scrollIntoView({ block: 'center' })
			);
		});
	});

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
		formOpen = true;
	}

	function setWebsite(g: Group | null) {
		dialogTab = 'general';
		onWebsite = g?.website.onWebsite ?? false;
		slug = g?.website.slug ?? (g ? slugFromName(g.name) : '');
		slugTouched = Boolean(g?.website.slug);
		websiteText = g?.website.description ?? '';
		ageRange = g?.website.ageRange ?? '';
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
		formOpen = true;
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
		'website.ageRange': 'g-web-age',
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
				ageRange: ageRange.trim() || null,
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
			formOpen = false;
			resetImage();
			await load();
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

	async function confirmDelete() {
		if (!toDelete) return;
		try {
			await apiFetch(`/modules/members/groups/${toDelete.id}`, { method: 'DELETE' });
			toast.success('Gruppe gelöscht');
			await load();
		} catch (err) {
			toast.error(err instanceof ApiClientError ? err.message : 'Löschen fehlgeschlagen.');
		}
	}
</script>

<svelte:head><title>Gruppen</title></svelte:head>

<PageHeader title="Gruppen" description="Sippen und Meuten des Stammes verwalten.">
	{#snippet actions()}
		{#if canEdit}<Button onclick={openCreate}>Gruppe anlegen</Button>{/if}
	{/snippet}
</PageHeader>

<div class={selected.length ? 'pb-20 sm:pb-0' : ''}>
	<DataTable
		caption="Gruppen"
		mobile="cards"
		{loading}
		error={loadError}
		empty={groups.length === 0}
		emptyTitle="Noch keine Gruppen"
		emptyDescription="Lege die erste Sippe oder Meute an."
	>
		{#snippet toolbar()}
			<MobileActionBar
				show={canSelect && selected.length > 0}
				label="Sammelaktionen"
				class="sm:w-full sm:rounded-md sm:border sm:bg-muted/40 sm:px-3 sm:py-2"
			>
				<span class="text-sm font-medium" aria-live="polite">{selected.length} ausgewählt</span>
				{#if canExport}
					<Button
						size="sm"
						variant="outline"
						disabled={sheetsBusy}
						onclick={() => openSheets(selected, 'Gruppen.pdf')}
					>
						<FileDown />
						{sheetsBusy ? 'Erzeuge PDF …' : 'Mitgliederlisten (PDF)'}
					</Button>
				{/if}
				{#if canMail}
					<Button size="sm" variant="outline" onclick={() => composeFor(selected)}>
						<Mail /> E-Mail senden
					</Button>
				{/if}
				<Button size="sm" variant="ghost" class="ml-auto" onclick={() => (selected = [])}>
					<X /> Auswahl aufheben
				</Button>
			</MobileActionBar>
		{/snippet}
		{#snippet head()}
			<Table.Row>
				{#if canSelect}
					<Table.Head class="w-10">
						<Checkbox
							aria-label="Alle Gruppen auswählen"
							checked={allSelected}
							indeterminate={someSelected}
							onCheckedChange={(v) => toggleAll(v === true)}
						/>
					</Table.Head>
				{/if}
				<Table.Head>Name</Table.Head>
				<Table.Head>Typ</Table.Head>
				<Table.Head>Leitung</Table.Head>
				<Table.Head class="text-right">Mitglieder</Table.Head>
				<Table.Head>Treffpunkt</Table.Head>
				<Table.Head>Treffen</Table.Head>
				{#if canEdit || canDelete || canExport || canMail}<Table.Head class="text-right"
						>Aktionen</Table.Head
					>{/if}
			</Table.Row>
		{/snippet}
		{#each groups as g (g.id)}
			<Table.Row
				id={`group-${g.id}`}
				class={highlightId === g.id ? 'bg-muted' : undefined}
				data-state={selected.includes(g.id) ? 'selected' : undefined}
			>
				{#if canSelect}
					<Table.Cell>
						<Checkbox
							aria-label={`Gruppe ${g.name} auswählen`}
							checked={selected.includes(g.id)}
							onCheckedChange={(v) => toggle(g.id, v === true)}
						/>
					</Table.Cell>
				{/if}
				<Table.Cell class="font-medium">
					<div class="flex items-center gap-3">
						<EntityAvatar name={g.name} src={g.hasImage ? imageUrl(g) : null} color={g.color} />
						<span>{g.name}</span>
						{#if g.website.onWebsite && g.website.slug}
							<Badge
								variant="outline"
								class="font-normal text-muted-foreground"
								title={`Steckbrief auf der Website: /gruppen/${g.website.slug}`}>Website</Badge
							>
						{/if}
					</div>
				</Table.Cell>
				<Table.Cell>
					<Badge variant={g.type === 'sippe' ? 'default' : 'secondary'}>
						{GROUP_TYPE_LABELS[g.type]}
					</Badge>
				</Table.Cell>
				<Table.Cell>{leaderText(g)}</Table.Cell>
				<Table.Cell class="text-right">{g.memberCount}</Table.Cell>
				<Table.Cell>{g.meetingPlace ?? '–'}</Table.Cell>
				<Table.Cell>{meetingText(g)}</Table.Cell>
				{#if canEdit || canDelete || canExport || canMail}
					<Table.Cell class="text-right">
						<div class="flex justify-end gap-1">
							{#if canMail}
								<Button
									size="icon"
									variant="ghost"
									aria-label="E-Mail an die Gruppe {g.name}"
									title="E-Mail an die Gruppe"
									onclick={() => composeFor([g.id])}
								>
									<Mail class="size-4" />
								</Button>
							{/if}
							{#if canExport}
								<Button
									size="icon"
									variant="ghost"
									aria-label="Mitgliederliste der Gruppe {g.name} als PDF"
									title="Mitgliederliste (PDF)"
									disabled={sheetsBusy}
									onclick={() => openSheets([g.id], `Gruppe-${g.name}.pdf`)}
								>
									<FileDown class="size-4" />
								</Button>
							{/if}
							{#if canEdit}
								<Button
									size="icon"
									variant="ghost"
									aria-label="Gruppe {g.name} bearbeiten"
									onclick={() => openEdit(g)}
								>
									<Pencil class="size-4" />
								</Button>
							{/if}
							{#if canDelete}
								<Button
									size="icon"
									variant="ghost"
									aria-label="Gruppe {g.name} löschen"
									onclick={() => {
										toDelete = g;
										deleteOpen = true;
									}}
								>
									<Trash2 class="size-4" />
								</Button>
							{/if}
						</div>
					</Table.Cell>
				{/if}
			</Table.Row>
		{/each}
	</DataTable>
</div>

<Dialog.Root bind:open={formOpen}>
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
						<Textarea
							id="g-desc"
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
							existingName={editing?.hasImage && !removeImage && !imageFile
								? 'Aktuelles Gruppenbild'
								: null}
							existingHref={editing?.hasImage ? imageUrl(editing) : null}
							canRemove
							onremove={() => (removeImage = true)}
						/>
						<p class="text-xs text-muted-foreground">
							JPEG, PNG oder WebP, max. {maxImageMb} MB{editing
								? ''
								: '; wird nach dem Anlegen hochgeladen'}.
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
						<Textarea
							id="g-web-text"
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
						<FormField label="Alter" id="g-web-age" error={fieldErrors['website.ageRange']}>
							<Input
								id="g-web-age"
								maxlength={50}
								bind:value={ageRange}
								placeholder="z. B. 7 bis 10 Jahre"
								aria-invalid={!!fieldErrors['website.ageRange']}
								aria-describedby={fieldErrors['website.ageRange'] ? 'g-web-age-error' : undefined}
							/>
						</FormField>
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

			{#if formError}<p class="text-sm text-destructive" role="alert">{formError}</p>{/if}
			<Dialog.Footer sticky>
				<Button type="button" variant="outline" onclick={() => (formOpen = false)}>
					Abbrechen
				</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Gruppe löschen?"
	description={`Die Gruppe „${toDelete?.name ?? ''}“ wird gelöscht.`}
	confirmLabel="Löschen"
	destructive
	onconfirm={confirmDelete}
/>

{#if sheetCatalog}
	<PdfExportDialog
		bind:open={sheetsOpen}
		title="Mitgliederliste der Gruppe(n)"
		catalog={sheetCatalog}
		count={sheetCount}
		storageKey="pdf-list:groups"
		busy={sheetsBusy}
		onexport={groupSheets}
	/>
{/if}
