<script lang="ts">
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import FileDown from '@lucide/svelte/icons/file-down';
	import Mail from '@lucide/svelte/icons/mail';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import UserRound from '@lucide/svelte/icons/user-round';
	import Users from '@lucide/svelte/icons/users';
	import X from '@lucide/svelte/icons/x';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		ConfirmDialog,
		EmptyState,
		EntityAvatar,
		ErrorState,
		LoadingState,
		MobileActionBar,
		PageHeader
	} from '$lib/components/layout';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import { GROUP_TYPE_LABELS, type Group } from '../schemas';
	import GroupDialog from './GroupDialog.svelte';
	import GroupSheetsDialog from './GroupSheetsDialog.svelte';
	import {
		composeFor,
		groupHref,
		imageUrl,
		leaderNames,
		meetingText,
		memberCountText
	} from './group-actions';

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
	const hasMenu = $derived(canEdit || canDelete || canExport || canMail);

	let groups = $state<Group[]>([]);
	let loading = $state(true);
	let loadError = $state('');

	async function load() {
		loading = true;
		loadError = '';
		try {
			groups = await apiFetch<Group[]>('/modules/members/groups');
		} catch (e) {
			loadError = e instanceof ApiClientError ? e.message : 'Gruppen konnten nicht geladen werden.';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void load();
	});

	// Alte Deep-Links `?open=<id>` (frühere Suche, Lesezeichen) führen auf die Gruppenseite
	$effect(() => {
		const id = page.url.searchParams.get('open');
		if (id) void goto(groupHref(id), { replaceState: true });
	});

	// --- Auswahl (Sammelaktionen) ------------------------------------------------------
	const SHEETS_MAX_GROUPS = 20;
	let selected = $state<string[]>([]);
	const allSelected = $derived(groups.length > 0 && groups.every((g) => selected.includes(g.id)));
	const someSelected = $derived(!allSelected && groups.some((g) => selected.includes(g.id)));

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

	// --- Mitgliederliste (PDF) -----------------------------------------------------------
	let sheetsOpen = $state(false);
	let sheetTarget = $state<{ ids: string[]; fileName: string }>({
		ids: [],
		fileName: 'Gruppen.pdf'
	});
	const sheetCount = $derived(
		groups.filter((g) => sheetTarget.ids.includes(g.id)).reduce((s, g) => s + g.memberCount, 0)
	);
	function openSheets(ids: string[], fileName: string) {
		sheetTarget = { ids, fileName };
		sheetsOpen = true;
	}

	// --- Anlegen / Bearbeiten / Löschen -------------------------------------------------
	let formOpen = $state(false);
	let editing = $state<Group | null>(null);
	function openCreate() {
		editing = null;
		formOpen = true;
	}
	function openEdit(g: Group) {
		editing = g;
		formOpen = true;
	}

	let deleteOpen = $state(false);
	let toDelete = $state<Group | null>(null);
	async function confirmDelete() {
		if (!toDelete) return;
		try {
			await apiFetch(`/modules/members/groups/${toDelete.id}`, { method: 'DELETE' });
			toast.success('Gruppe gelöscht');
			selected = selected.filter((i) => i !== toDelete?.id);
			await load();
		} catch (err) {
			toast.error(err instanceof ApiClientError ? err.message : 'Löschen fehlgeschlagen.');
		}
	}
</script>

<svelte:head><title>Gruppen</title></svelte:head>

<PageHeader title="Gruppen" description="Sippen und Meuten des Stammes verwalten.">
	{#snippet actions()}
		{#if canEdit}
			<Button onclick={openCreate}>Gruppe anlegen</Button>
		{/if}
	{/snippet}
</PageHeader>

<div class={selected.length ? 'space-y-4 pb-20 sm:pb-0' : 'space-y-4'}>
	{#if canSelect && groups.length > 0}
		<div class="flex flex-wrap items-center gap-2">
			<label class="flex items-center gap-2 text-sm">
				<Checkbox
					checked={allSelected}
					indeterminate={someSelected}
					onCheckedChange={(v) => toggleAll(v === true)}
				/>
				Alle auswählen
			</label>
			<MobileActionBar
				show={selected.length > 0}
				label="Sammelaktionen"
				class="sm:flex-1 sm:rounded-md sm:border sm:bg-muted/40 sm:px-3 sm:py-2"
			>
				<span class="text-sm font-medium" aria-live="polite">{selected.length} ausgewählt</span>
				{#if canExport}
					<Button size="sm" variant="outline" onclick={() => openSheets(selected, 'Gruppen.pdf')}>
						<FileDown /> Mitgliederlisten (PDF)
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
		</div>
	{/if}

	{#if loadError}
		<Card.Root>
			<Card.Content class="pt-6">
				<ErrorState message={loadError} onretry={load} busy={loading} />
			</Card.Content>
		</Card.Root>
	{:else if loading && groups.length === 0}
		<LoadingState label="Gruppen" rows={3} rowClass="h-40 w-full" />
	{:else if groups.length === 0}
		<Card.Root>
			<Card.Content class="pt-6">
				<EmptyState title="Noch keine Gruppen" description="Lege die erste Sippe oder Meute an.">
					{#if canEdit}
						<Button onclick={openCreate}>Gruppe anlegen</Button>
					{/if}
				</EmptyState>
			</Card.Content>
		</Card.Root>
	{:else}
		<ul
			aria-label="Gruppen"
			class="grid grid-cols-1 gap-4 transition-opacity sm:grid-cols-2 xl:grid-cols-3"
			class:opacity-60={loading}
		>
			{#each groups as g (g.id)}
				{@const isSelected = selected.includes(g.id)}
				{@const leaders = leaderNames(g)}
				{@const meeting = meetingText(g)}
				<li id={`group-${g.id}`}>
					<Card.Root
						class="relative h-full gap-0 py-0 transition-colors hover:bg-muted/40 {isSelected
							? 'bg-muted/50 ring-2 ring-primary/50'
							: ''}"
					>
						<div class="flex h-full flex-col gap-3 p-4">
							<div class="flex items-start gap-3">
								{#if canSelect}
									<Checkbox
										class="relative z-10 mt-3"
										aria-label={`Gruppe ${g.name} auswählen`}
										checked={isSelected}
										onCheckedChange={(v) => toggle(g.id, v === true)}
									/>
								{/if}
								<EntityAvatar
									name={g.name}
									src={g.hasImage ? imageUrl(g) : null}
									color={g.color}
									size={48}
								/>
								<div class="min-w-0 flex-1 space-y-1.5">
									<h2 class="font-medium break-words">
										<!-- Stretched Link: die ganze Karte führt zur Gruppenseite -->
										<a
											href={groupHref(g.id)}
											class="after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
											>{g.name}</a
										>
									</h2>
									<div class="flex flex-wrap gap-1">
										<Badge variant={g.type === 'sippe' ? 'default' : 'secondary'}>
											{GROUP_TYPE_LABELS[g.type]}
										</Badge>
										{#if g.website.ageRange}
											<Badge variant="outline" class="font-normal">{g.website.ageRange}</Badge>
										{/if}
										{#if g.website.onWebsite && g.website.slug}
											<Badge
												variant="outline"
												class="font-normal text-muted-foreground"
												title={`Steckbrief auf der Website: /gruppen/${g.website.slug}`}
												>Website</Badge
											>
										{/if}
									</div>
								</div>
								{#if hasMenu}
									<DropdownMenu.Root>
										<DropdownMenu.Trigger>
											{#snippet child({ props })}
												<Button
													{...props}
													size="icon"
													variant="ghost"
													class="relative z-10 -mt-1 -mr-2 shrink-0"
													aria-label="Aktionen für {g.name}"
													title="Aktionen"
												>
													<Ellipsis class="size-4" />
												</Button>
											{/snippet}
										</DropdownMenu.Trigger>
										<DropdownMenu.Content align="end">
											{#if canEdit}
												<DropdownMenu.Item onclick={() => openEdit(g)}>
													<Pencil /> Bearbeiten
												</DropdownMenu.Item>
											{/if}
											{#if canMail}
												<DropdownMenu.Item onclick={() => composeFor([g.id])}>
													<Mail /> E-Mail an die Gruppe
												</DropdownMenu.Item>
											{/if}
											{#if canExport}
												<DropdownMenu.Item
													onclick={() => openSheets([g.id], `Gruppe-${g.name}.pdf`)}
												>
													<FileDown /> Mitgliederliste (PDF)
												</DropdownMenu.Item>
											{/if}
											{#if canDelete}
												{#if canEdit || canMail || canExport}
													<DropdownMenu.Separator />
												{/if}
												<DropdownMenu.Item
													variant="destructive"
													onclick={() => {
														toDelete = g;
														deleteOpen = true;
													}}
												>
													<Trash2 /> Löschen
												</DropdownMenu.Item>
											{/if}
										</DropdownMenu.Content>
									</DropdownMenu.Root>
								{/if}
							</div>

							<dl class="grid gap-1.5 text-sm">
								<div class="flex gap-2">
									<dt class="shrink-0 pt-0.5 text-muted-foreground">
										<UserRound class="size-4" aria-hidden="true" /><span class="sr-only"
											>Leitung</span
										>
									</dt>
									<dd class="min-w-0 break-words">{leaders.join(', ') || '–'}</dd>
								</div>
								<div class="flex gap-2">
									<dt class="shrink-0 pt-0.5 text-muted-foreground">
										<CalendarClock class="size-4" aria-hidden="true" /><span class="sr-only"
											>Gruppenstunde</span
										>
									</dt>
									<dd class="min-w-0 break-words">{meeting ?? 'Keine feste Gruppenstunde'}</dd>
								</div>
								{#if g.meetingPlace}
									<div class="flex gap-2">
										<dt class="shrink-0 pt-0.5 text-muted-foreground">
											<MapPin class="size-4" aria-hidden="true" /><span class="sr-only"
												>Treffpunkt</span
											>
										</dt>
										<dd class="min-w-0 break-words">{g.meetingPlace}</dd>
									</div>
								{/if}
							</dl>

							<p
								class="mt-auto flex items-center gap-2 border-t pt-3 text-sm text-muted-foreground tabular-nums"
							>
								<Users class="size-4" aria-hidden="true" />
								{memberCountText(g.memberCount)}
							</p>
						</div>
					</Card.Root>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<GroupDialog bind:open={formOpen} group={editing} onsaved={load} />

<ConfirmDialog
	bind:open={deleteOpen}
	title="Gruppe löschen?"
	description={`Die Gruppe „${toDelete?.name ?? ''}“ wird gelöscht.`}
	confirmLabel="Löschen"
	destructive
	onconfirm={confirmDelete}
/>

<GroupSheetsDialog
	bind:open={sheetsOpen}
	groupIds={sheetTarget.ids}
	fileName={sheetTarget.fileName}
	count={sheetCount}
/>
