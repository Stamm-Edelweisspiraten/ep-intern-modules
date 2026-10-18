<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Download from '@lucide/svelte/icons/download';
	import FileDown from '@lucide/svelte/icons/file-down';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Card from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Table from '$lib/components/ui/table';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		ConfirmDialog,
		DataTable,
		EmptyState,
		PageHeader,
		PdfExportDialog,
		ShareMenu,
		type ShareCandidate
	} from '$lib/components/layout';
	import {
		DIET_LABELS,
		PARTICIPANT_ROLE_LABELS,
		SHARE_LEVELS,
		SHARE_LEVEL_LABELS,
		ageAt,
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
	import PaymentCell from './PaymentCell.svelte';
	import AccountingTab from './AccountingTab.svelte';
	import CalculationTab from './CalculationTab.svelte';
	import RegistrationTab from './RegistrationTab.svelte';

	let { params }: ModulePageProps = $props();
	const id = $derived(params.id ?? '');

	const permissions = $derived((page.data.permissions ?? []) as string[]);

	let action = $state<ActionSummary | null>(null);
	let loading = $state(true);
	let notFound = $state(false);
	let loadError = $state('');
	let tab = $state('overview');

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

	async function searchUsers(q: string): Promise<ShareCandidate[]> {
		const res = await apiFetch<ShareCandidate[]>(
			`/modules/actions/users?search=${encodeURIComponent(q)}`
		);
		const ownerId = shares?.owner.userId;
		return res.filter((u) => u.id !== ownerId);
	}
	async function putShare(userId: string, level: string) {
		try {
			await apiFetch(`${base}/shares/${userId}`, {
				method: 'PUT',
				body: JSON.stringify({ level })
			});
		} catch (e) {
			throw new Error(errMsg(e, 'Freigabe fehlgeschlagen'), { cause: e });
		}
		await loadShares();
	}
	async function removeShare(userId: string) {
		try {
			await apiFetch(`${base}/shares/${userId}`, { method: 'DELETE' });
		} catch (e) {
			throw new Error(errMsg(e, 'Entfernen fehlgeschlagen'), { cause: e });
		}
		await loadShares();
	}

	function fmtAge(p: Participant): string {
		if (!p.birthDate || !action) return '–';
		const a = ageAt(p.birthDate, action.startsOn);
		return a === null || a < 0 ? '–' : String(a);
	}
	function truncate(s: string, n = 60) {
		return s.length > n ? `${s.slice(0, n - 1)}…` : s;
	}
	function levelLabel(l: ShareLevel) {
		return SHARE_LEVEL_LABELS[l];
	}
</script>

<svelte:head><title>{action?.name ?? 'Aktion'}</title></svelte:head>

{#if loading}
	<div class="space-y-4" aria-busy="true" aria-label="Lade Aktion">
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
					search={searchUsers}
					onadd={(user, level) => putShare(user.id, level)}
					onchange={putShare}
					onremove={removeShare}
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
		<Tabs.List variant="line" class="mb-4 h-auto flex-wrap">
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
				<Card.Header>
					<Card.Title>Beschreibung</Card.Title>
				</Card.Header>
				<Card.Content>
					{#if action.description}
						<p class="text-sm whitespace-pre-line">{action.description}</p>
					{:else}
						<p class="text-muted-foreground text-sm">Keine Beschreibung hinterlegt.</p>
					{/if}
				</Card.Content>
			</Card.Root>
		</Tabs.Content>

		<Tabs.Content value="participants">
			<DataTable
				caption="Teilnehmende"
				mobile="cards"
				title="Teilnehmende"
				description={paymentSummary}
				loading={partLoading}
				error={partError}
				empty={!participants.length}
				emptyTitle="Noch keine Teilnehmenden"
				emptyDescription="Füge Teilnehmende manuell hinzu."
			>
				{#snippet toolbar()}
					<Button variant="outline" href={`/api/v1${base}/participants.csv`} download>
						<Download /> CSV exportieren
					</Button>
					{#if canExportSheets}
						<Button variant="outline" disabled={sheetsBusy} onclick={openSheets}>
							<FileDown />
							{sheetsBusy ? 'Erzeuge PDF …' : 'Teilnehmerliste (PDF)'}
						</Button>
					{/if}
					{#if canEdit}
						<Button onclick={openAddParticipant}><UserPlus /> Teilnehmende*n hinzufügen</Button>
					{/if}
				{/snippet}
				{#snippet head()}
					<Table.Row>
						<Table.Head>Name</Table.Head>
						<Table.Head>Gruppe</Table.Head>
						<Table.Head>E-Mail</Table.Head>
						<Table.Head>Alter</Table.Head>
						<Table.Head>Rolle</Table.Head>
						<Table.Head>Ernährung</Table.Head>
						<Table.Head>Allergien / Hinweise</Table.Head>
						{#if showPayments}<Table.Head>Beitrag</Table.Head>{/if}
						<Table.Head>Quelle</Table.Head>
						{#if canEdit}<Table.Head class="text-right">Aktionen</Table.Head>{/if}
					</Table.Row>
				{/snippet}
				{#each participants as p (p.id)}
					{@const hint = [p.allergies, p.notes].filter(Boolean).join(' · ')}
					<Table.Row>
						<Table.Cell class="font-medium">{p.name}</Table.Cell>
						<Table.Cell>{p.groupLabel ?? '–'}</Table.Cell>
						<Table.Cell class="max-w-48 truncate text-xs" title={p.contactEmail ?? undefined}>
							{p.contactEmail ?? '–'}
						</Table.Cell>
						<Table.Cell>{fmtAge(p)}</Table.Cell>
						<Table.Cell>
							{PARTICIPANT_ROLE_LABELS[p.role]}{p.role === 'team' && p.juleica ? ' (Juleica)' : ''}
						</Table.Cell>
						<Table.Cell>{p.diet ? DIET_LABELS[p.diet] : '–'}</Table.Cell>
						<Table.Cell class="max-w-64" title={hint || undefined}>
							{hint ? truncate(hint) : '–'}
						</Table.Cell>
						{#if showPayments}
							<Table.Cell>
								<PaymentCell payment={p.payment} linkToInvoice={canOpenInvoices} />
							</Table.Cell>
						{/if}
						<Table.Cell>
							<Badge variant="outline">{p.source === 'link' ? 'Anmeldelink' : 'Manuell'}</Badge>
						</Table.Cell>
						{#if canEdit}
							<Table.Cell class="text-right">
								<div class="flex justify-end gap-2">
									<Button
										size="icon"
										variant="outline"
										aria-label={`${p.name} bearbeiten`}
										onclick={() => openEditParticipant(p)}><Pencil /></Button
									>
									<Button
										size="icon"
										variant="destructive"
										aria-label={`${p.name} entfernen`}
										onclick={() => openDeleteParticipant(p)}><Trash2 /></Button
									>
								</div>
							</Table.Cell>
						{/if}
					</Table.Row>
				{/each}
			</DataTable>
		</Tabs.Content>

		<Tabs.Content value="accounting">
			{#if tab === 'accounting'}
				<AccountingTab actionId={action.id} {canEdit} isPast={action.isPast} />
			{/if}
		</Tabs.Content>

		<Tabs.Content value="registration">
			{#if tab === 'registration'}
				<RegistrationTab
					actionId={action.id}
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
					actionId={action.id}
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
