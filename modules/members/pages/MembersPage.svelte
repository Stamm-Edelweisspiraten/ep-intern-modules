<script lang="ts">
	import { todayBerlin } from '$lib/sdk/dates';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import Check from '@lucide/svelte/icons/check';
	import FileDown from '@lucide/svelte/icons/file-down';
	import Link2 from '@lucide/svelte/icons/link-2';
	import Minus from '@lucide/svelte/icons/minus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import X from '@lucide/svelte/icons/x';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Table from '$lib/components/ui/table';
	import {
		ColorBadge,
		ConfirmDialog,
		DataTable,
		MobileActionBar,
		PageHeader,
		Pagination,
		PdfExportDialog,
		SearchInput
	} from '$lib/components/layout';
	import type { ListCatalog, ListSelection } from '$lib/pdf-lists/types';
	import { SelectField } from '$lib/components/ui/select-field';
	import {
		BULK_MAX_IDS,
		STAGES,
		STAGE_LABELS,
		ageFromBirthDate,
		type BulkResult,
		type Group,
		type Member,
		type MemberList
	} from '../schemas';
	import BulkDialog, { type BulkMode } from './BulkDialog.svelte';
	import { downloadPdf } from './download';
	import LinksDialog from './LinksDialog.svelte';
	import MemberForm from './MemberForm.svelte';

	const PAGE_SIZE = 20;

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canEdit = $derived(can(permissions, 'members.member.edit'));
	const canDelete = $derived(can(permissions, 'members.member.delete'));
	const canLinkView = $derived(can(permissions, 'members.link.view'));
	const canLinkManage = $derived(can(permissions, 'members.link.manage'));
	const canExport = $derived(can(permissions, 'members.data.export'));
	const canUpload = $derived(can(permissions, 'members.storage.write'));
	const canRemoveDoc = $derived(can(permissions, 'members.storage.delete'));

	const search = $derived(page.url.searchParams.get('search') ?? '');
	const stage = $derived(page.url.searchParams.get('stage') ?? '');
	const groupId = $derived(page.url.searchParams.get('groupId') ?? '');
	/** Mitgliedschaftsstatus: active (Standard) | left | all */
	const status = $derived(
		(['active', 'left', 'all'] as const).find((s) => s === page.url.searchParams.get('status')) ??
			'active'
	);
	const today = todayBerlin();
	const isLeft = (m: Member) => !!m.exitDate && m.exitDate <= today;
	const offset = $derived(Math.max(0, Number(page.url.searchParams.get('offset')) || 0));

	let items = $state<Member[]>([]);
	let total = $state(0);
	let groups = $state<Group[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let reloadTick = $state(0);

	let formOpen = $state(false);
	let editMember = $state<Member | null>(null);
	let deleteOpen = $state(false);
	let deleteMember = $state<Member | null>(null);
	/** Zeilenklick öffnet den Bearbeiten-Dialog als gesperrte Ansicht */
	let formReadonly = $state(false);
	// Verknüpfungen können sich bei offener Ansicht ändern: Zähler aus der frisch geladenen Liste
	const formLinkCount = $derived(
		items.find((x) => x.id === editMember?.id)?.linkCount ?? editMember?.linkCount ?? 0
	);

	// --- Sammelaktionen ---------------------------------------------------------
	let selected = $state<string[]>([]);
	let bulkOpen = $state(false);
	let bulkMode = $state<BulkMode>('add-groups');
	let bulkDeleteOpen = $state(false);
	const showSelect = $derived(canEdit || canDelete || canLinkManage || canExport);
	const allOnPage = $derived(items.length > 0 && items.every((m) => selected.includes(m.id)));
	const someOnPage = $derived(!allOnPage && items.some((m) => selected.includes(m.id)));

	// Filterwechsel: Auswahl verwerfen, damit nichts Unsichtbares mitgeändert wird
	let lastFilter = '';
	$effect(() => {
		const key = `${search}|${stage}|${groupId}|${status}`;
		if (lastFilter && key !== lastFilter) selected = [];
		lastFilter = key;
	});

	function toggle(id: string, on: boolean) {
		if (on && selected.length >= BULK_MAX_IDS && !selected.includes(id)) {
			toast.error(`Höchstens ${BULK_MAX_IDS} Mitglieder auf einmal`);
			return;
		}
		selected = on ? [...new Set([...selected, id])] : selected.filter((i) => i !== id);
	}
	function togglePage(on: boolean) {
		const pageIds = items.map((m) => m.id);
		if (!on) {
			selected = selected.filter((i) => !pageIds.includes(i));
			return;
		}
		const next = [...new Set([...selected, ...pageIds])];
		if (next.length > BULK_MAX_IDS) toast.error(`Höchstens ${BULK_MAX_IDS} Mitglieder auf einmal`);
		selected = next.slice(0, BULK_MAX_IDS);
	}
	let linksOpen = $state(false);
	let linksMember = $state<Member | null>(null);
	let lettersBusy = $state(false);
	let sheetsBusy = $state(false);
	function openLinks(m: Member) {
		linksMember = m;
		linksOpen = true;
	}
	async function bulkLetters() {
		lettersBusy = true;
		try {
			await downloadPdf(
				'/api/v1/modules/members/members/link-letters.pdf',
				{ method: 'POST', body: JSON.stringify({ ids: selected }) },
				'Konto-Verknuepfungen.pdf'
			);
			toast.success(`Briefe für ${selected.length} Mitglieder erzeugt`);
			reloadTick++;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'PDF konnte nicht erzeugt werden');
		} finally {
			lettersBusy = false;
		}
	}

	let sheetsOpen = $state(false);
	let sheetCatalog = $state<ListCatalog | null>(null);
	let sheetCatalogError = $state('');

	/** Öffnet den Spalten-Dialog; der Katalog (inkl. Zusatzfelder) kommt vom Server */
	async function openSheets() {
		sheetCatalogError = '';
		sheetsOpen = true;
		if (sheetCatalog) return;
		try {
			sheetCatalog = await apiFetch<ListCatalog>('/modules/members/members/sheet-columns');
		} catch (e) {
			sheetCatalogError = e instanceof Error ? e.message : 'Spalten konnten nicht geladen werden';
			toast.error(sheetCatalogError);
			sheetsOpen = false;
		}
	}

	async function bulkSheets(selection: ListSelection) {
		sheetsBusy = true;
		try {
			await downloadPdf(
				'/api/v1/modules/members/members/sheets.pdf',
				{ method: 'POST', body: JSON.stringify({ ids: selected, selection }) },
				'Mitgliederliste.pdf'
			);
			toast.success(`Liste mit ${selected.length} Mitgliedern erzeugt`);
			sheetsOpen = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'PDF konnte nicht erzeugt werden');
		} finally {
			sheetsBusy = false;
		}
	}

	function openBulk(mode: BulkMode) {
		bulkMode = mode;
		loadGroups();
		bulkOpen = true;
	}
	function bulkDone(r: BulkResult, verb: string) {
		if (r.affected)
			toast.success(`${verb}: ${r.affected} ${r.affected === 1 ? 'Mitglied' : 'Mitglieder'}`);
		if (r.skipped.length) {
			toast.warning(
				`${r.skipped.length} übersprungen: ${r.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}`,
				{ duration: 10000 }
			);
		}
		if (!r.affected && !r.skipped.length) toast.info('Keine Änderung nötig');
		selected = [];
		reloadTick++;
	}
	async function confirmBulkDelete() {
		try {
			const r = await apiFetch<BulkResult>('/modules/members/members/bulk', {
				method: 'POST',
				body: JSON.stringify({ action: 'delete', ids: selected })
			});
			bulkDone(r, 'Gelöscht');
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Löschen fehlgeschlagen');
		}
	}

	function loadGroups() {
		apiFetch<Group[]>('/modules/members/groups')
			.then((g) => (groups = g))
			.catch(() => {});
	}

	$effect(() => {
		loadGroups();
	});

	$effect(() => {
		void reloadTick;
		const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
		if (search) q.set('search', search);
		if (stage) q.set('stage', stage);
		if (groupId) q.set('groupId', groupId);
		q.set('status', status);
		let stale = false;
		loading = true;
		apiFetch<MemberList>(`/modules/members/members?${q}`)
			.then((r) => {
				if (stale) return;
				items = r.items;
				total = r.total;
				loadError = '';
			})
			.catch((e) => {
				if (!stale) loadError = e instanceof ApiClientError ? e.message : 'Laden fehlgeschlagen';
			})
			.finally(() => {
				if (!stale) loading = false;
			});
		return () => {
			stale = true;
		};
	});

	function setFilter(key: string, value: string) {
		const url = new URL(page.url);
		if (value) url.searchParams.set(key, value);
		else url.searchParams.delete(key);
		url.searchParams.delete('offset');
		goto(url, { keepFocus: true, noScroll: true });
	}

	function fmtDate(iso: string) {
		const [y, m, d] = iso.split('-');
		return `${d}.${m}.${y}`;
	}

	function fmtAge(iso: string) {
		const a = ageFromBirthDate(iso);
		return a === null || a < 0 ? '' : ` · ${a} J.`;
	}

	function openCreate() {
		editMember = null;
		formReadonly = false;
		loadGroups();
		formOpen = true;
	}
	function openEdit(m: Member) {
		editMember = m;
		formReadonly = false;
		loadGroups();
		formOpen = true;
	}
	function openView(m: Member) {
		editMember = m;
		formReadonly = true;
		loadGroups();
		formOpen = true;
	}
	// Deep-Link (globale Suche): `?open=<id>` öffnet die gesperrte Ansicht und entfernt den Parameter
	const openId = $derived(page.url.searchParams.get('open') ?? '');
	$effect(() => {
		const id = openId;
		if (!id) return;
		apiFetch<Member>(`/modules/members/members/${encodeURIComponent(id)}`)
			.then((m) => openView(m))
			.catch(() => toast.error('Mitglied nicht gefunden'))
			.finally(() => {
				const url = new URL(page.url);
				url.searchParams.delete('open');
				void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
			});
	});
	function rowKey(e: KeyboardEvent, m: Member) {
		if (e.target !== e.currentTarget) return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			openView(m);
		}
	}
	function openDelete(m: Member) {
		deleteMember = m;
		deleteOpen = true;
	}

	async function confirmDelete() {
		if (!deleteMember) return;
		try {
			await apiFetch(`/modules/members/members/${deleteMember.id}`, { method: 'DELETE' });
			toast.success('Mitglied gelöscht');
			reloadTick++;
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Löschen fehlgeschlagen');
		}
	}

	const stageOptions = STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }));
	const groupOptions = $derived(groups.map((g) => ({ value: g.id, label: g.name })));
	const statusOptions = [
		{ value: 'active', label: 'Aktiv' },
		{ value: 'left', label: 'Ausgetreten' },
		{ value: 'all', label: 'Alle' }
	];
	const consents = [
		{ key: 'consentSocialMedia', label: 'Socialmedia' },
		{ key: 'consentWebsite', label: 'Stammeswebsite' },
		{ key: 'consentPrint', label: 'Print' }
	] as const;
</script>

<svelte:head><title>Mitglieder</title></svelte:head>

<PageHeader title="Mitglieder" description="Mitglieder des Stammes verwalten.">
	{#snippet actions()}
		{#if canEdit}
			<Button onclick={openCreate}><UserPlus /> Mitglied anlegen</Button>
		{/if}
	{/snippet}
</PageHeader>

<div class={selected.length ? 'pb-20 sm:pb-0' : ''}>
	<DataTable
		caption="Mitglieder"
		mobile="cards"
		{loading}
		error={loadError}
		empty={!items.length}
		emptyTitle="Keine Mitglieder gefunden"
		emptyDescription={search || stage || groupId || status !== 'active'
			? 'Passe Suche oder Filter an.'
			: 'Es wurden noch keine Mitglieder angelegt.'}
	>
		{#snippet toolbar()}
			<SearchInput placeholder="Name suchen …" label="Mitglieder suchen" />
			<SelectField
				label="Nach Mitgliedschaft filtern"
				class="w-auto"
				options={statusOptions}
				value={status}
				onchange={(v) => setFilter('status', v && v !== 'active' ? v : '')}
			/>
			<SelectField
				label="Nach Stand filtern"
				emptyLabel="Alle Stände"
				class="w-auto"
				options={stageOptions}
				value={stage || null}
				onchange={(v) => setFilter('stage', v ?? '')}
			/>
			<SelectField
				label="Nach Gruppe filtern"
				emptyLabel="Alle Gruppen"
				class="w-auto"
				options={groupOptions}
				value={groupId || null}
				onchange={(v) => setFilter('groupId', v ?? '')}
			/>
			<MobileActionBar
				show={selected.length > 0}
				label="Sammelaktionen"
				class="sm:w-full sm:rounded-md sm:border sm:bg-muted/40 sm:px-3 sm:py-2"
			>
				<span class="text-sm font-medium" aria-live="polite">{selected.length} ausgewählt</span>
				{#if canEdit}
					<Button size="sm" variant="outline" onclick={() => openBulk('add-groups')}>
						Zu Gruppen hinzufügen
					</Button>
					<Button size="sm" variant="outline" onclick={() => openBulk('remove-groups')}>
						Aus Gruppen entfernen
					</Button>
					<Button size="sm" variant="outline" onclick={() => openBulk('set-stage')}>
						Stand setzen
					</Button>
					<Button size="sm" variant="outline" onclick={() => openBulk('set-consent')}>
						Einwilligungen
					</Button>
				{/if}
				{#if canLinkManage}
					<Button size="sm" variant="outline" disabled={lettersBusy} onclick={bulkLetters}>
						<FileDown />
						{lettersBusy ? 'Erzeuge PDF …' : 'Verknüpfungs-Briefe (PDF)'}
					</Button>
				{/if}
				{#if canExport}
					<Button size="sm" variant="outline" disabled={sheetsBusy} onclick={openSheets}>
						<FileDown />
						{sheetsBusy ? 'Erzeuge PDF …' : 'Mitgliederliste (PDF)'}
					</Button>
				{/if}
				{#if canDelete}
					<Button size="sm" variant="destructive" onclick={() => (bulkDeleteOpen = true)}>
						<Trash2 /> Löschen
					</Button>
				{/if}
				<Button size="sm" variant="ghost" class="ml-auto" onclick={() => (selected = [])}>
					<X /> Auswahl aufheben
				</Button>
			</MobileActionBar>
		{/snippet}
		{#snippet head()}
			<Table.Row>
				{#if showSelect}
					<Table.Head class="w-10">
						<Checkbox
							aria-label="Alle Mitglieder dieser Seite auswählen"
							checked={allOnPage}
							indeterminate={someOnPage}
							onCheckedChange={(v) => togglePage(v === true)}
						/>
					</Table.Head>
				{/if}
				<Table.Head>Name</Table.Head>
				<Table.Head>Stand</Table.Head>
				<Table.Head>Gruppen</Table.Head>
				<Table.Head>Geburtsdatum</Table.Head>
				<Table.Head>Darf gezeigt werden</Table.Head>
				{#if canEdit || canDelete || canLinkView}<Table.Head class="text-right">Aktionen</Table.Head
					>{/if}
			</Table.Row>
		{/snippet}
		{#each items as m (m.id)}
			<Table.Row
				data-state={selected.includes(m.id) ? 'selected' : undefined}
				class="cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
				tabindex={0}
				aria-label={`${m.firstName} ${m.lastName} anzeigen`}
				onclick={() => openView(m)}
				onkeydown={(e) => rowKey(e, m)}
			>
				{#if showSelect}
					<Table.Cell onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
						<Checkbox
							aria-label={`${m.firstName} ${m.lastName} auswählen`}
							checked={selected.includes(m.id)}
							onCheckedChange={(v) => toggle(m.id, v === true)}
						/>
					</Table.Cell>
				{/if}
				<Table.Cell class="font-medium">
					{m.firstName}
					{m.lastName}
					{#if m.scoutName}<span class="text-muted-foreground">„{m.scoutName}“</span>{/if}
					{#if m.secondaryMember}<Badge variant="outline" class="ml-1">Zweitmitglied</Badge>{/if}
					{#if isLeft(m)}<Badge variant="destructive" class="ml-1">ausgetreten</Badge>{/if}
				</Table.Cell>
				<Table.Cell><Badge variant="secondary">{STAGE_LABELS[m.stage]}</Badge></Table.Cell>
				<Table.Cell>
					<div class="flex flex-wrap gap-1">
						{#each m.groups as g (g.id)}
							<ColorBadge color={g.color}>{g.name}</ColorBadge>
						{/each}
						{#if !m.groups.length}<span class="text-muted-foreground">–</span>{/if}
					</div>
				</Table.Cell>
				<Table.Cell class="whitespace-nowrap"
					>{fmtDate(m.birthDate)}{fmtAge(m.birthDate)}</Table.Cell
				>
				<Table.Cell>
					<ul class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
						{#each consents as c (c.key)}
							{@const on = m[c.key]}
							<li class="flex items-center gap-1" class:text-muted-foreground={!on}>
								{#if on}
									<Check class="size-3.5 text-link" aria-hidden="true" />
								{:else}
									<Minus class="size-3.5" aria-hidden="true" />
								{/if}
								{c.label}<span class="sr-only">: {on ? 'ja' : 'nein'}</span>
							</li>
						{/each}
					</ul>
				</Table.Cell>
				{#if canEdit || canDelete || canLinkView}
					<Table.Cell
						class="text-right"
						onclick={(e) => e.stopPropagation()}
						onkeydown={(e) => e.stopPropagation()}
					>
						<div class="flex justify-end gap-2">
							{#if canLinkView}
								<Button
									size="icon"
									variant="outline"
									class="relative"
									aria-label={`Verknüpfte Konten von ${m.firstName} ${m.lastName} (${m.linkCount})`}
									title={`Verknüpfte Konten: ${m.linkCount}`}
									onclick={() => openLinks(m)}
									><Link2 />
									{#if m.linkCount}
										<span
											class="absolute -top-1.5 -right-1.5 grid size-4 place-content-center rounded-full bg-primary text-xs leading-none text-primary-foreground"
											aria-hidden="true">{m.linkCount}</span
										>
									{/if}
								</Button>
							{/if}
							{#if canEdit}
								<Button
									size="icon"
									variant="outline"
									aria-label={`${m.firstName} ${m.lastName} bearbeiten`}
									onclick={() => openEdit(m)}><Pencil /></Button
								>
							{/if}
							{#if canDelete}
								<Button
									size="icon"
									variant="destructive"
									aria-label={`${m.firstName} ${m.lastName} löschen`}
									onclick={() => openDelete(m)}><Trash2 /></Button
								>
							{/if}
						</div>
					</Table.Cell>
				{/if}
			</Table.Row>
		{/each}
		{#snippet footer()}
			{#if items.length}<Pagination {total} limit={PAGE_SIZE} {offset} />{/if}
		{/snippet}
	</DataTable>
</div>

{#if sheetCatalog}
	<PdfExportDialog
		bind:open={sheetsOpen}
		title="Mitgliederliste (PDF)"
		catalog={sheetCatalog}
		count={selected.length}
		storageKey="pdf-list:members"
		busy={sheetsBusy}
		onexport={bulkSheets}
	/>
{/if}

<LinksDialog
	bind:open={linksOpen}
	member={linksMember}
	canManage={canLinkManage}
	onchanged={() => reloadTick++}
/>

<MemberForm
	bind:open={formOpen}
	member={editMember}
	bind:readonly={formReadonly}
	{groups}
	{canUpload}
	{canRemoveDoc}
	{canEdit}
	{canLinkView}
	linkCount={formLinkCount}
	onlinks={(m) => openLinks(m)}
	onsaved={() => {
		reloadTick++;
	}}
/>

<BulkDialog
	bind:open={bulkOpen}
	mode={bulkMode}
	ids={selected}
	{groups}
	ondone={(r) => bulkDone(r, 'Geändert')}
/>

<ConfirmDialog
	bind:open={bulkDeleteOpen}
	title="Ausgewählte Mitglieder löschen?"
	description={`${selected.length} ${selected.length === 1 ? 'Mitglied wird' : 'Mitglieder werden'} unwiderruflich gelöscht. Einzige Leiter von Gruppen werden übersprungen.`}
	confirmLabel="Löschen"
	destructive
	onconfirm={confirmBulkDelete}
/>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Mitglied löschen?"
	description={deleteMember
		? `${deleteMember.firstName} ${deleteMember.lastName} wird unwiderruflich gelöscht.`
		: undefined}
	confirmLabel="Löschen"
	destructive
	onconfirm={confirmDelete}
/>
