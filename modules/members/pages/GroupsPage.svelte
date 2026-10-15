<script lang="ts">
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import { tick } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { ColorPicker } from '$lib/components/ui/color-picker';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		ConfirmDialog,
		DataTable,
		EntityAvatar,
		FileField,
		FormField,
		PageHeader
	} from '$lib/components/layout';
	import {
		GROUP_IMAGE_CONTENT_TYPES,
		GROUP_TYPES,
		GROUP_TYPE_LABELS,
		MAX_GROUP_IMAGE_BYTES,
		WEEKDAYS,
		WEEKDAY_LABELS,
		groupInput,
		type GroupFormInput,
		type Group,
		type GroupType,
		type MemberList,
		type MemberRef
	} from '../schemas';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canEdit = $derived(can(permissions, 'members.group.edit'));
	const canDelete = $derived(can(permissions, 'members.group.delete'));

	let groups = $state<Group[]>([]);
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
	let description = $state('');
	let meetingPlace = $state('');
	let meetingTime = $state('');
	let meetingWeekday = $state<string | null>(null);
	let color = $state<string | null>(null);
	let fieldErrors = $state<Record<string, string>>({});
	let imageFile = $state<File | null>(null);
	let imagePreview = $state<string | null>(null);
	let removeImage = $state(false);

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

	function imageUrl(g: Group) {
		return `/api/v1/modules/members/groups/${g.id}/image?v=${encodeURIComponent(g.imageVersion ?? '')}`;
	}
	function meetingText(g: Group) {
		const day = g.meetingWeekday ? WEEKDAY_LABELS[g.meetingWeekday] : null;
		if (day && g.meetingTime) return `${day}, ${g.meetingTime}`;
		return day ?? g.meetingTime ?? '–';
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
					`/modules/members/members?limit=200&offset=${offset}`
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

	function openCreate() {
		editing = null;
		name = '';
		type = null;
		leaderIds = [];
		description = '';
		meetingPlace = '';
		meetingTime = '';
		meetingWeekday = null;
		color = null;
		resetImage();
		fieldErrors = {};
		formError = '';
		formOpen = true;
	}

	function openEdit(g: Group) {
		editing = g;
		name = g.name;
		type = g.type;
		leaderIds = g.leaders.map((l) => l.id);
		description = g.description ?? '';
		meetingPlace = g.meetingPlace ?? '';
		meetingTime = g.meetingTime ?? '';
		meetingWeekday = g.meetingWeekday ? String(g.meetingWeekday) : null;
		color = g.color;
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
		description: 'g-desc',
		meetingPlace: 'g-place',
		meetingWeekday: 'g-weekday',
		meetingTime: 'g-time',
		color: 'g-color'
	};

	async function focusFirstError() {
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
				const key = String(i.path?.[0] ?? '');
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
			description: description || null,
			meetingPlace: meetingPlace || null,
			meetingWeekday: meetingWeekday ? Number(meetingWeekday) : null,
			meetingTime: meetingTime || null,
			color
		};
		const parsed = groupInput.safeParse(input);
		const errs: Record<string, string> = {};
		if (!parsed.success) {
			for (const i of parsed.error.issues) {
				const key = String(i.path[0] ?? '');
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

<DataTable
	caption="Gruppen"
	{loading}
	error={loadError}
	empty={groups.length === 0}
	emptyTitle="Noch keine Gruppen"
	emptyDescription="Lege die erste Sippe oder Meute an."
>
	{#snippet toolbar()}
		{#if !loading && !loadError && members.length === 0}
			<p class="w-full rounded-md border bg-muted/40 p-3 text-sm" role="status">
				Lege zuerst ein Mitglied an, das Gruppenleiter werden kann.
			</p>
		{/if}
	{/snippet}
	{#snippet head()}
		<Table.Row>
			<Table.Head>Name</Table.Head>
			<Table.Head>Typ</Table.Head>
			<Table.Head>Leiter</Table.Head>
			<Table.Head class="text-right">Mitglieder</Table.Head>
			<Table.Head>Treffpunkt</Table.Head>
			<Table.Head>Treffen</Table.Head>
			{#if canEdit || canDelete}<Table.Head class="text-right">Aktionen</Table.Head>{/if}
		</Table.Row>
	{/snippet}
	{#each groups as g (g.id)}
		<Table.Row>
			<Table.Cell class="font-medium">
				<div class="flex items-center gap-3">
					<EntityAvatar name={g.name} src={g.hasImage ? imageUrl(g) : null} color={g.color} />
					<span>{g.name}</span>
				</div>
			</Table.Cell>
			<Table.Cell>
				<Badge variant={g.type === 'sippe' ? 'default' : 'secondary'}>
					{GROUP_TYPE_LABELS[g.type]}
				</Badge>
			</Table.Cell>
			<Table.Cell>{g.leaders.map(personName).join(', ') || '–'}</Table.Cell>
			<Table.Cell class="text-right">{g.memberCount}</Table.Cell>
			<Table.Cell>{g.meetingPlace ?? '–'}</Table.Cell>
			<Table.Cell>{meetingText(g)}</Table.Cell>
			{#if canEdit || canDelete}
				<Table.Cell class="text-right">
					<div class="flex justify-end gap-1">
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

<Dialog.Root bind:open={formOpen}>
	<Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{editing ? 'Gruppe bearbeiten' : 'Gruppe anlegen'}</Dialog.Title>
			<Dialog.Description>Pflichtfelder sind mit * markiert.</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField label="Name *" id="g-name" error={fieldErrors.name}>
				<Input
					id="g-name"
					required
					maxlength={100}
					bind:value={name}
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

			<div class="space-y-1.5">
				{#if members.length === 0}
					<p class="text-sm font-medium">Gruppenleiter *</p>
					<p class="text-sm text-muted-foreground">
						Lege zuerst ein Mitglied an, das Gruppenleiter werden kann.
					</p>
				{:else}
					<MultiSelect
						id="g-leaders"
						label="Gruppenleiter *"
						options={leaderOptions}
						bind:value={leaderIds}
						placeholder="Leiter auswählen"
						searchPlaceholder="Mitglieder durchsuchen …"
						emptyText="Keine Treffer."
						invalid={!!fieldErrors.leaderIds}
					/>
				{/if}
				{#if fieldErrors.leaderIds}
					<p role="alert" class="text-xs text-destructive">{fieldErrors.leaderIds}</p>
				{/if}
			</div>

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

			<div class="grid gap-4 sm:grid-cols-2">
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

			{#if formError}<p class="text-sm text-destructive" role="alert">{formError}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (formOpen = false)}>
					Abbrechen
				</Button>
				<Button type="submit" disabled={busy}>{busy ? 'Speichere …' : 'Speichern'}</Button>
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
