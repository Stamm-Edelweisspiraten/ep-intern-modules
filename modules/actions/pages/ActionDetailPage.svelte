<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Download from '@lucide/svelte/icons/download';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Card from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		ConfirmDialog,
		EmptyState,
		PageHeader,
		PdfExportDialog,
		ShareMenu,
		type ShareCandidate,
		type ShareEntry
	} from '$lib/components/layout';
	import { shareKey } from '$lib/components/layout/share-types';
	import type { PrincipalInfo } from '$lib/sdk/types/sharing';
	import {
		SHARE_LEVELS,
		SHARE_LEVEL_LABELS,
		type ActionShares,
		type ActionSummary,
		type Participant,
		type ShareLevel
	} from '../schemas';
	import { downloadPdf } from '$lib/components/layout/download';
	import type { ListCatalog, ListSelection } from '$lib/pdf-lists/types';
	import { fmtPeriod } from './format';
	import { formatEuro } from '$lib/components/layout/money';
	import ActionForm from './ActionForm.svelte';
	import ParticipantForm from './ParticipantForm.svelte';
	import ParticipantsTab from './ParticipantsTab.svelte';
	import AccountingTab from './AccountingTab.svelte';
	import CalculationTab from './CalculationTab.svelte';
	import RegistrationTab from './RegistrationTab.svelte';
	import ActionAssistTools from './ActionAssistTools.svelte';
	import ActionTasksCard from './ActionTasksCard.svelte';
	import ActionWhiteboardsCard from './ActionWhiteboardsCard.svelte';
	import ActionNotesCard from './ActionNotesCard.svelte';
	import ActionMaterialCard from './ActionMaterialCard.svelte';

	let { params }: ModulePageProps = $props();
	const id = $derived(params.id ?? '');

	const permissions = $derived((page.data.permissions ?? []) as string[]);

	let action = $state<ActionSummary | null>(null);
	let loading = $state(true);
	let notFound = $state(false);
	let loadError = $state('');
	/** Start-Tab aus `?tab=` (z. B. Dashboard-Link `?tab=accounting`) */
	const TAB_IDS = ['overview', 'calculation', 'registration', 'participants', 'accounting'];
	const initialTab = page.url.searchParams.get('tab') ?? '';
	let tab = $state(TAB_IDS.includes(initialTab) ? initialTab : 'overview');

	let participants = $state<Participant[]>([]);
	let partLoading = $state(true);
	let partError = $state('');

	let shares = $state<ActionShares | null>(null);
	let sharesLoading = $state(true);
	let sharesError = $state('');

	let editOpen = $state(false);
	let deleteOpen = $state(false);
	let partFormOpen = $state(false);
	let editParticipant = $state<Participant | null>(null);
	let partDeleteOpen = $state(false);
	let deleteParticipant = $state<Participant | null>(null);

	const canEdit = $derived(action?.access.level === 'edit');
	/**
	 * Stabile ID für Kind-Komponenten: `action.id` direkt als Prop würde bei jedem Neuladen der Aktion
	 * (neues Objekt) deren `$effect`s erneut auslösen (Reiter laden neu, Seite springt nach oben).
	 */
	const actionId = $derived(action?.id ?? id);
	const canDelete = $derived(
		!!action &&
			can(permissions, 'actions.action.delete') &&
			(action.access.isOwner || action.access.level === 'edit')
	);
	const base = $derived(`/modules/actions/actions/${id}`);
	/** Kasse aktiv: Teilnehmende tragen einen Zahlstand (auch `null` = keine Rechnung) */
	const showPayments = $derived(
		participants.some((p) => !!p.payment) ||
			(!action?.isPast && participants.some((p) => p.payment !== undefined))
	);
	const canOpenInvoices = $derived(can(permissions, 'treasury.cash.view'));
	const canExportSheets = $derived(can(permissions, 'members.data.export'));
	let sheetsBusy = $state(false);
	let sheetsOpen = $state(false);
	let sheetCatalog = $state<ListCatalog | null>(null);

	/** Öffnet den Spalten-Dialog; der Katalog (Mitglieds- + Aktionsspalten) kommt vom Server */
	async function openSheets() {
		if (!sheetCatalog) {
			try {
				sheetCatalog = await apiFetch<ListCatalog>(`${base}/participants/pdf-columns`);
			} catch (e) {
				toast.error(e instanceof Error ? e.message : 'Spalten konnten nicht geladen werden');
				return;
			}
		}
		sheetsOpen = true;
	}
	async function participantSheets(selection: ListSelection) {
		sheetsBusy = true;
		try {
			await downloadPdf(
				`/api/v1${base}/participants.pdf`,
				{ method: 'POST', body: JSON.stringify({ selection }) },
				'Teilnehmende.pdf'
			);
			sheetsOpen = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'PDF konnte nicht erzeugt werden');
		} finally {
			sheetsBusy = false;
		}
	}
	const paymentSummary = $derived.by(() => {
		if (!showPayments && action?.isPast) {
			return 'Liegt in der Vergangenheit – keine Rechnungen in der Kasse.';
		}
		if (!showPayments) return undefined;
		const withInvoice = participants.filter((p) => p.payment);
		if (!withInvoice.length) return 'Noch keine Beitragsrechnungen in der Kasse.';
		const paid = withInvoice.filter(
			(p) => p.payment!.status === 'paid' || p.payment!.status === 'waived'
		).length;
		const open = withInvoice.reduce((s, p) => s + p.payment!.openCents, 0);
		const overdue = withInvoice.filter((p) => p.payment!.overdue).length;
		return `Beiträge: ${paid} von ${withInvoice.length} bezahlt${
			open > 0 ? ` · ${formatEuro(open)} offen` : ''
		}${overdue > 0 ? ` · ${overdue} überfällig` : ''}`;
	});

	function errMsg(e: unknown, fallback: string) {
		return e instanceof ApiClientError ? e.message : fallback;
	}

	async function loadAction() {
		try {
			action = await apiFetch<ActionSummary>(base);
			notFound = false;
			loadError = '';
		} catch (e) {
			if (e instanceof ApiClientError && (e.status === 404 || e.status === 403)) {
				notFound = true;
			} else {
				loadError = errMsg(e, 'Laden fehlgeschlagen');
			}
		} finally {
			loading = false;
		}
	}

	async function loadParticipants() {
		try {
			participants = await apiFetch<Participant[]>(`${base}/participants`);
			partError = '';
		} catch (e) {
			partError = errMsg(e, 'Teilnehmende konnten nicht geladen werden');
		} finally {
			partLoading = false;
		}
	}

	async function loadShares() {
		try {
			shares = await apiFetch<ActionShares>(`${base}/shares`);
			sharesError = '';
		} catch (e) {
			sharesError = errMsg(e, 'Freigaben konnten nicht geladen werden');
		} finally {
			sharesLoading = false;
		}
	}

	$effect(() => {
		void id;
		loading = true;
		partLoading = true;
		sharesLoading = true;
		notFound = false;
		void loadAction();
		void loadParticipants();
		void loadShares();
	});

	async function confirmDelete() {
		try {
			await apiFetch(base, { method: 'DELETE' });
			toast.success('Aktion gelöscht');
			await goto('/modules/actions');
		} catch (e) {
			toast.error(errMsg(e, 'Löschen fehlgeschlagen'));
		}
	}

	function openAddParticipant() {
		editParticipant = null;
		partFormOpen = true;
	}
	function openEditParticipant(p: Participant) {
		editParticipant = p;
		partFormOpen = true;
	}
	function openDeleteParticipant(p: Participant) {
		deleteParticipant = p;
		partDeleteOpen = true;
	}
	async function confirmDeleteParticipant() {
		if (!deleteParticipant) return;
		try {
			await apiFetch(`${base}/participants/${deleteParticipant.id}`, { method: 'DELETE' });
			toast.success('Teilnehmende*r entfernt');
			await Promise.all([loadParticipants(), loadAction()]);
		} catch (e) {
			toast.error(errMsg(e, 'Löschen fehlgeschlagen'));
		}
	}

	async function refreshAfterParticipant() {
		await Promise.all([loadParticipants(), loadAction()]);
	}

	// Freigaben
	const shareLevels = SHARE_LEVELS.map((l) => ({ value: l, label: SHARE_LEVEL_LABELS[l] }));

	async function searchPrincipals(q: string): Promise<ShareCandidate[]> {
		const found = await apiFetch<PrincipalInfo[]>(
			`/modules/actions/principals?search=${encodeURIComponent(q)}`
		);
		const ownerId = shares?.owner.userId;
		return found
			.filter((p) => !(p.type === 'user' && p.id === ownerId))
			.map((p) => ({
				id: p.id,
				type: p.type,
				name: p.name,
				detail: p.detail ?? null,
				color: p.color ?? null,
				image: p.image ?? null
			}));
	}
	/** PUT ersetzt alle Freigaben der Aktion */
	async function saveShares(next: ShareEntry[]) {
		try {
			shares = await apiFetch<ActionShares>(`${base}/shares`, {
				method: 'PUT',
				body: JSON.stringify({
					shares: next.map((s) => ({ type: s.type ?? 'user', id: s.userId, level: s.level }))
				})
			});
		} catch (e) {
			throw new Error(errMsg(e, 'Freigabe fehlgeschlagen'), { cause: e });
		}
	}
	async function addShare(c: ShareCandidate, level: string) {
		const current = shares?.shares ?? [];
		const entry: ShareEntry = {
			userId: c.id,
			type: c.type ?? 'user',
			name: c.name,
			detail: c.detail ?? null,
			color: c.color ?? null,
			image: c.image ?? null,
			level
		};
		if (current.some((s) => shareKey(s) === shareKey(entry))) return;
		await saveShares([...current, entry]);
	}
	async function changeShare(key: string, level: string) {
		await saveShares(
			(shares?.shares ?? []).map((s) => (shareKey(s) === key ? { ...s, level } : s))
		);
	}
	async function removeShare(key: string) {
		await saveShares((shares?.shares ?? []).filter((s) => shareKey(s) !== key));
	}

	function levelLabel(l: ShareLevel) {
		return SHARE_LEVEL_LABELS[l];
	}
</script>

<svelte:head><title>{action?.name ?? 'Aktion'}</title></svelte:head>

{#if loading}
	<div class="space-y-4" aria-busy="true" aria-label="Aktion wird geladen">
		<Skeleton class="h-8 w-64" />
		<Skeleton class="h-5 w-96 max-w-full" />
		<Skeleton class="h-64 w-full" />
	</div>
{:else if notFound}
	<EmptyState
		title="Aktion nicht gefunden"
		description="Die Aktion existiert nicht oder du hast keinen Zugriff darauf."
	>
		<Button href="/modules/actions" variant="outline"><ArrowLeft /> Zurück zu den Aktionen</Button>
	</EmptyState>
{:else if loadError || !action}
	<div class="space-y-4">
		<p class="text-sm text-destructive" role="alert">{loadError || 'Laden fehlgeschlagen'}</p>
		<Button href="/modules/actions" variant="outline"><ArrowLeft /> Zurück zu den Aktionen</Button>
	</div>
{:else}
	<nav aria-label="Navigation" class="mb-2">
		<a
			href="/modules/actions"
			class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
		>
			<ArrowLeft class="size-4" aria-hidden="true" /> Alle Aktionen
		</a>
	</nav>

	<PageHeader
		title={action.name}
		description={`${fmtPeriod(action)}${action.location ? ` · ${action.location}` : ''}`}
	>
		{#snippet actions()}
			{#if action?.isPast}<Badge variant="outline">Vergangen</Badge>{/if}
			{#if shares}
				<ShareMenu
					shares={shares.shares}
					owner={shares.owner}
					levels={shareLevels}
					defaultLevel="read"
					canManage={shares.canManage}
					search={searchPrincipals}
					onadd={addShare}
					onchange={changeShare}
					onremove={removeShare}
					everyoneLabel={shares.everyoneLabel}
					placeholder="Gruppe, Rolle, Person suchen …"
					searchLabel="Freigabe hinzufügen"
					emptyResultText="Niemand gefunden"
				/>
			{:else if sharesLoading}
				<Skeleton class="h-9 w-28" />
			{:else if sharesError}
				<span class="text-xs text-destructive" role="alert" title={sharesError}>
					Freigaben nicht verfügbar
				</span>
			{/if}
			{#if canEdit}
				<Button variant="outline" onclick={() => (editOpen = true)}><Pencil /> Bearbeiten</Button>
			{/if}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" aria-label="Mehr Aktionen"
							><Ellipsis /> Mehr</Button
						>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-72">
					<DropdownMenu.Item
						onclick={() => {
							window.location.href = `/api/v1${base}/export`;
						}}
						class="flex-col items-start"
					>
						<span class="flex items-center gap-1.5"><Download /> Exportieren (ZIP)</span>
						<span class="text-xs text-muted-foreground">
							Enthält alle Daten und Belege als ZIP (Bankdaten nur mit Kassenrecht)
						</span>
					</DropdownMenu.Item>
					{#if canDelete}
						<DropdownMenu.Separator />
						<DropdownMenu.Item variant="destructive" onclick={() => (deleteOpen = true)}>
							<Trash2 /> Löschen
						</DropdownMenu.Item>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/snippet}
	</PageHeader>

	<Tabs.Root bind:value={tab}>
		<Tabs.List variant="line" class="mb-4">
			<Tabs.Trigger value="overview">Übersicht</Tabs.Trigger>
			<Tabs.Trigger value="calculation">Kalkulation</Tabs.Trigger>
			<Tabs.Trigger value="registration">Anmeldung</Tabs.Trigger>
			<Tabs.Trigger value="participants">Teilnehmende ({participants.length})</Tabs.Trigger>
			<Tabs.Trigger value="accounting">Abrechnung</Tabs.Trigger>
		</Tabs.List>

		<Tabs.Content value="overview" class="space-y-4">
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
				<div class="bg-card ring-foreground/10 flex flex-col gap-1 rounded-xl px-4 py-3 ring-1">
					<span class="text-muted-foreground text-xs">Zeitraum</span>
					<span class="text-sm font-medium">{fmtPeriod(action)}</span>
				</div>
				<div class="bg-card ring-foreground/10 flex flex-col gap-1 rounded-xl px-4 py-3 ring-1">
					<span class="text-muted-foreground text-xs">Ort</span>
					<span class={['text-sm font-medium', !action.location && 'text-muted-foreground']}>
						{action.location || '–'}
					</span>
				</div>
				<div class="bg-card ring-foreground/10 flex flex-col gap-1 rounded-xl px-4 py-3 ring-1">
					<span class="text-muted-foreground text-xs">Teilnehmende</span>
					<span class="flex items-baseline justify-between gap-2">
						<span class="text-sm font-medium tabular-nums">{action.participantCount}</span>
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
							onclick={() => (tab = 'participants')}
						>
							Ansehen
						</button>
					</span>
				</div>
				<div class="bg-card ring-foreground/10 flex flex-col gap-1 rounded-xl px-4 py-3 ring-1">
					<span class="text-muted-foreground text-xs">Beitrag</span>
					{#if action.fee}
						<span class="text-sm font-medium tabular-nums">
							{formatEuro(action.fee.participantCents)} pro Teilnehmende*r
						</span>
						{#if action.fee.teamCents > 0}
							<span class="text-muted-foreground text-xs tabular-nums">
								Team {formatEuro(action.fee.teamCents)}
							</span>
						{/if}
					{:else}
						<span class="text-muted-foreground text-sm">Noch nicht festgelegt</span>
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground self-start text-xs underline-offset-2 hover:underline"
							onclick={() => (tab = 'calculation')}
						>
							In der Kalkulation festlegen
						</button>
					{/if}
				</div>
				<div class="bg-card ring-foreground/10 flex flex-col gap-1 rounded-xl px-4 py-3 ring-1">
					<span class="text-muted-foreground text-xs">Besitzer*in</span>
					<span class="flex items-center justify-between gap-2">
						<span class="min-w-0 truncate text-sm font-medium">{action.owner.name}</span>
						<Badge variant="secondary" class="shrink-0">
							{action.access.isOwner ? 'Eigene' : levelLabel(action.access.level)}
						</Badge>
					</span>
				</div>
			</div>
			<Card.Root>
				<Card.Header class="flex flex-wrap items-center justify-between gap-2">
					<Card.Title>Beschreibung</Card.Title>
					<ActionAssistTools {action} canWebsite={can(permissions, 'website.post.write')} />
				</Card.Header>
				<Card.Content>
					{#if action.description}
						<p class="text-sm whitespace-pre-line">{action.description}</p>
					{:else}
						<p class="text-muted-foreground text-sm">Keine Beschreibung hinterlegt.</p>
					{/if}
				</Card.Content>
			</Card.Root>
			{#if can(permissions, 'tasks.board.view')}
				<ActionTasksCard {actionId} actionName={action.name} />
			{/if}
			{#if can(permissions, 'whiteboard.board.view')}
				<ActionWhiteboardsCard {actionId} actionName={action.name} />
			{/if}
			{#if can(permissions, 'notes.note.view')}
				<ActionNotesCard {actionId} actionName={action.name} />
			{/if}
			{#if can(permissions, 'material.inventory.view')}
				<ActionMaterialCard
					{actionId}
					actionName={action.name}
					startsOn={action.startsOn}
					endsOn={action.endsOn}
				/>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="participants">
			<ParticipantsTab
				{participants}
				loading={partLoading}
				error={partError}
				{base}
				startsOn={action.startsOn}
				{canEdit}
				{showPayments}
				description={paymentSummary}
				{canOpenInvoices}
				{canExportSheets}
				{sheetsBusy}
				onadd={openAddParticipant}
				onedit={openEditParticipant}
				ondelete={openDeleteParticipant}
				onsheets={openSheets}
				onchanged={refreshAfterParticipant}
			/>
		</Tabs.Content>

		<Tabs.Content value="accounting">
			{#if tab === 'accounting'}
				<AccountingTab {actionId} {canEdit} isPast={action.isPast} />
			{/if}
		</Tabs.Content>

		<Tabs.Content value="registration">
			{#if tab === 'registration'}
				<RegistrationTab
					{actionId}
					isPast={action.isPast}
					{canEdit}
					onchanged={loadAction}
					onopencalculation={() => (tab = 'calculation')}
					onopenparticipants={() => (tab = 'participants')}
				/>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="calculation">
			{#if tab === 'calculation'}
				<CalculationTab
					{actionId}
					startsOn={action.startsOn}
					endsOn={action.endsOn}
					{canEdit}
					participantsCount={participants.length}
					onfeechanged={loadAction}
				/>
			{/if}
		</Tabs.Content>
	</Tabs.Root>

	<ActionForm
		bind:open={editOpen}
		{action}
		onsaved={async () => {
			await loadAction();
		}}
	/>
	<ParticipantForm
		bind:open={partFormOpen}
		actionId={id}
		participant={editParticipant}
		healthVisible={canExportSheets}
		onsaved={refreshAfterParticipant}
	/>
	<ConfirmDialog
		bind:open={deleteOpen}
		title="Aktion löschen?"
		description={`„${action.name}“ wird samt Teilnehmenden und Freigaben unwiderruflich gelöscht.`}
		confirmLabel="Löschen"
		destructive
		onconfirm={confirmDelete}
	/>
	<ConfirmDialog
		bind:open={partDeleteOpen}
		title="Teilnehmende*n entfernen?"
		description={deleteParticipant
			? `${deleteParticipant.name} wird aus der Aktion entfernt.`
			: undefined}
		confirmLabel="Entfernen"
		destructive
		onconfirm={confirmDeleteParticipant}
	/>
	{#if sheetCatalog}
		<PdfExportDialog
			bind:open={sheetsOpen}
			title="Teilnehmerliste (PDF)"
			catalog={sheetCatalog}
			count={participants.length}
			storageKey="pdf-list:action"
			busy={sheetsBusy}
			onexport={participantSheets}
		/>
	{/if}
{/if}
