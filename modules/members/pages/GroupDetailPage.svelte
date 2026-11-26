<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Cake from '@lucide/svelte/icons/cake';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import FileDown from '@lucide/svelte/icons/file-down';
	import Globe from '@lucide/svelte/icons/globe';
	import Mail from '@lucide/svelte/icons/mail';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import UserRound from '@lucide/svelte/icons/user-round';
	import Users from '@lucide/svelte/icons/users';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		ConfirmDialog,
		DataTable,
		EmptyState,
		EntityAvatar,
		ErrorState
	} from '$lib/components/layout';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Table from '$lib/components/ui/table';
	import * as Tabs from '$lib/components/ui/tabs';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import {
		ageFromBirthDate,
		GROUP_TYPE_LABELS,
		type Group,
		type GroupOverview,
		type LedGroupBirthday,
		type Member,
		type MemberList,
		STAGE_LABELS,
		STAGES
	} from '../schemas';
	import GroupDialog from './GroupDialog.svelte';
	import GroupSheetsDialog from './GroupSheetsDialog.svelte';
	import {
		composeFor,
		GROUPS_PATH,
		imageUrl,
		meetingText,
		memberCountText,
		memberHref,
		personName
	} from './group-actions';

	let { params }: ModulePageProps = $props();
	const id = $derived(params.id ?? '');

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canEdit = $derived(can(permissions, 'members.group.edit'));
	const canDelete = $derived(can(permissions, 'members.group.delete'));
	const canViewMembers = $derived(can(permissions, 'members.member.view'));
	const canExport = $derived(can(permissions, 'members.data.export') && canViewMembers);
	const canMail = $derived(can(permissions, 'messages.message.send') && canViewMembers);
	const hasMore = $derived(canMail || canExport || canDelete);

	/** Start-Reiter aus `?tab=` */
	const TAB_IDS = ['overview', 'members', 'website'];
	const initialTab = page.url.searchParams.get('tab') ?? '';
	let tab = $state(TAB_IDS.includes(initialTab) ? initialTab : 'overview');

	let group = $state<Group | null>(null);
	let overview = $state<GroupOverview | null>(null);
	let loading = $state(true);
	let notFound = $state(false);
	let loadError = $state('');

	const MEMBERS_LIMIT = 200;
	let members = $state<Member[]>([]);
	let membersTotal = $state(0);
	let membersLoading = $state(false);
	let membersError = $state('');

	async function load(groupId: string) {
		loading = true;
		notFound = false;
		loadError = '';
		try {
			const [g, o] = await Promise.all([
				apiFetch<Group>(`/modules/members/groups/${encodeURIComponent(groupId)}`),
				apiFetch<GroupOverview>(`/modules/members/groups/${encodeURIComponent(groupId)}/overview`)
			]);
			group = g;
			overview = o;
		} catch (e) {
			if (e instanceof ApiClientError && e.status === 404) notFound = true;
			else
				loadError = e instanceof ApiClientError ? e.message : 'Gruppe konnte nicht geladen werden.';
		} finally {
			loading = false;
		}
		if (group && canViewMembers) await loadMembers(groupId);
	}

	async function loadMembers(groupId: string) {
		membersLoading = true;
		membersError = '';
		try {
			const res = await apiFetch<MemberList>(
				`/modules/members/members?${new URLSearchParams({ groupId, limit: String(MEMBERS_LIMIT) })}`
			);
			members = res.items;
			membersTotal = res.total;
		} catch (e) {
			membersError =
				e instanceof ApiClientError ? e.message : 'Mitglieder konnten nicht geladen werden.';
		} finally {
			membersLoading = false;
		}
	}

	$effect(() => {
		void load(id);
	});

	// --- Kennzahlen aus der Mitgliederliste -------------------------------------------
	const ages = $derived(
		members.map((m) => ageFromBirthDate(m.birthDate)).filter((a): a is number => a != null)
	);
	const ageStats = $derived(
		ages.length
			? {
					min: Math.min(...ages),
					max: Math.max(...ages),
					avg: ages.reduce((s, a) => s + a, 0) / ages.length
				}
			: null
	);
	const stageCounts = $derived(
		STAGES.map((s) => ({ stage: s, n: members.filter((m) => m.stage === s).length })).filter(
			(x) => x.n > 0
		)
	);

	// --- Datumstexte -------------------------------------------------------------------
	const dayFmt = new Intl.DateTimeFormat('de-DE', {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		timeZone: 'UTC'
	});
	const fmtDay = (iso: string) => dayFmt.format(new Date(`${iso}T12:00:00Z`));

	function nextMeetingText(o: GroupOverview): string | null {
		if (!o.nextMeeting) return null;
		return o.nextMeeting === o.today ? 'Heute' : fmtDay(o.nextMeeting);
	}
	function birthdayWhen(b: LedGroupBirthday): string {
		if (b.days === 0) return 'heute';
		if (b.days === 1) return 'morgen';
		return `${fmtDay(b.date)} (in ${b.days} Tagen)`;
	}
	const fmtAvg = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });

	// --- Aktionen ------------------------------------------------------------------------
	let formOpen = $state(false);
	let dialogTab = $state<'general' | 'website'>('general');
	function openEdit(t: 'general' | 'website' = 'general') {
		dialogTab = t;
		formOpen = true;
	}
	let sheetsOpen = $state(false);

	let deleteOpen = $state(false);
	async function confirmDelete() {
		if (!group) return;
		try {
			await apiFetch(`/modules/members/groups/${group.id}`, { method: 'DELETE' });
			toast.success('Gruppe gelöscht');
			await goto(GROUPS_PATH);
		} catch (err) {
			toast.error(err instanceof ApiClientError ? err.message : 'Löschen fehlgeschlagen.');
		}
	}
</script>

<svelte:head><title>{group?.name ?? 'Gruppe'}</title></svelte:head>

{#if loading && !group}
	<div class="space-y-4" aria-busy="true" aria-label="Gruppe wird geladen">
		<Skeleton class="h-20 w-full max-w-md" />
		<Skeleton class="h-10 w-72" />
		<Skeleton class="h-64 w-full" />
	</div>
{:else if notFound}
	<EmptyState
		title="Gruppe nicht gefunden"
		description="Die Gruppe existiert nicht (mehr) oder du hast keinen Zugriff darauf."
	>
		<Button href={GROUPS_PATH} variant="outline"><ArrowLeft /> Zurück zu den Gruppen</Button>
	</EmptyState>
{:else if loadError || !group}
	<div class="space-y-4">
		<ErrorState
			message={loadError || 'Laden fehlgeschlagen'}
			onretry={() => load(id)}
			busy={loading}
		/>
		<Button href={GROUPS_PATH} variant="outline"><ArrowLeft /> Zurück zu den Gruppen</Button>
	</div>
{:else}
	{@const g = group}
	{@const meeting = meetingText(g)}
	<nav aria-label="Navigation" class="mb-2">
		<a
			href={GROUPS_PATH}
			class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
		>
			<ArrowLeft class="size-4" aria-hidden="true" /> Alle Gruppen
		</a>
	</nav>

	<header class="mb-6 flex flex-wrap items-start gap-4">
		<EntityAvatar name={g.name} src={g.hasImage ? imageUrl(g) : null} color={g.color} size={72} />
		<div class="min-w-0 flex-1 space-y-2">
			<h1 class="text-title break-words">{g.name}</h1>
			<div class="flex flex-wrap gap-1">
				<Badge variant={g.type === 'sippe' ? 'default' : 'secondary'}>
					{GROUP_TYPE_LABELS[g.type]}
				</Badge>
				{#if g.website.ageRange}
					<Badge variant="outline" class="font-normal">{g.website.ageRange}</Badge>
				{/if}
				{#if g.website.onWebsite && g.website.slug}
					<Badge variant="outline" class="font-normal text-muted-foreground">Website</Badge>
				{/if}
				<Badge variant="outline" class="font-normal tabular-nums">
					{memberCountText(g.memberCount)}
				</Badge>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			{#if canEdit}
				<Button variant="outline" onclick={() => openEdit()}><Pencil /> Bearbeiten</Button>
			{/if}
			{#if hasMore}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="outline" size="icon" aria-label="Weitere Aktionen">
								<Ellipsis />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end">
						{#if canMail}
							<DropdownMenu.Item onclick={() => composeFor([g.id])}>
								<Mail /> E-Mail an die Gruppe
							</DropdownMenu.Item>
						{/if}
						{#if canExport}
							<DropdownMenu.Item onclick={() => (sheetsOpen = true)}>
								<FileDown /> Mitgliederliste (PDF)
							</DropdownMenu.Item>
						{/if}
						{#if canDelete}
							{#if canMail || canExport}
								<DropdownMenu.Separator />
							{/if}
							<DropdownMenu.Item variant="destructive" onclick={() => (deleteOpen = true)}>
								<Trash2 /> Löschen
							</DropdownMenu.Item>
						{/if}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		</div>
	</header>

	<Tabs.Root bind:value={tab} class="gap-4">
		<Tabs.List variant="line" class="w-full justify-start">
			<Tabs.Trigger value="overview" class="flex-none">Übersicht</Tabs.Trigger>
			{#if canViewMembers}
				<Tabs.Trigger value="members" class="flex-none">
					Mitglieder <span class="text-muted-foreground tabular-nums">({g.memberCount})</span>
				</Tabs.Trigger>
			{/if}
			<Tabs.Trigger value="website" class="flex-none">Website</Tabs.Trigger>
		</Tabs.List>

		<!-- Übersicht ---------------------------------------------------------------------->
		<Tabs.Content value="overview">
			<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
				<Card.Root>
					<Card.Header>
						<Card.Title level={2} class="flex items-center gap-2">
							<CalendarClock class="size-4 text-muted-foreground" aria-hidden="true" />
							Gruppenstunde
						</Card.Title>
					</Card.Header>
					<Card.Content>
						<dl class="grid gap-2 text-sm">
							<div class="grid grid-cols-[7rem_1fr] gap-2">
								<dt class="text-muted-foreground">Wann</dt>
								<dd class="break-words">{meeting ?? 'Keine feste Gruppenstunde'}</dd>
							</div>
							{#if overview && nextMeetingText(overview)}
								<div class="grid grid-cols-[7rem_1fr] gap-2">
									<dt class="text-muted-foreground">Nächster Termin</dt>
									<dd>{nextMeetingText(overview)}</dd>
								</div>
							{/if}
							<div class="grid grid-cols-[7rem_1fr] gap-2">
								<dt class="text-muted-foreground">Treffpunkt</dt>
								<dd class="flex items-start gap-1.5 break-words">
									{#if g.meetingPlace}
										<MapPin
											class="mt-0.5 size-4 shrink-0 text-muted-foreground"
											aria-hidden="true"
										/>
										{g.meetingPlace}
									{:else}
										–
									{/if}
								</dd>
							</div>
						</dl>
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title level={2} class="flex items-center gap-2">
							<UserRound class="size-4 text-muted-foreground" aria-hidden="true" /> Leitung
						</Card.Title>
					</Card.Header>
					<Card.Content>
						{#if g.leaders.length || g.leaderUsers.length}
							<ul class="space-y-1.5 text-sm">
								{#each g.leaders as l (l.id)}
									<li class="break-words">
										{#if canViewMembers}
											<a href={memberHref(l.id)} class="hover:underline">{personName(l)}</a>
										{:else}
											{personName(l)}
										{/if}
									</li>
								{/each}
								{#each g.leaderUsers as u (u.id)}
									<li class="flex flex-wrap items-center gap-2 break-words">
										{u.name}
										<Badge variant="outline" class="font-normal text-muted-foreground">
											{u.active ? 'Benutzerkonto' : 'Konto deaktiviert'}
										</Badge>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="text-sm text-muted-foreground">Keine Leitung eingetragen.</p>
						{/if}
					</Card.Content>
				</Card.Root>

				{#if canViewMembers}
					<Card.Root>
						<Card.Header>
							<Card.Title level={2} class="flex items-center gap-2">
								<Users class="size-4 text-muted-foreground" aria-hidden="true" /> Mitglieder
							</Card.Title>
						</Card.Header>
						<Card.Content class="space-y-3 text-sm">
							{#if membersError}
								<ErrorState compact message={membersError} onretry={() => loadMembers(g.id)} />
							{:else if membersLoading && members.length === 0}
								<Skeleton class="h-16 w-full" />
							{:else if g.memberCount === 0}
								<p class="text-muted-foreground">Noch keine Mitglieder in dieser Gruppe.</p>
							{:else}
								<dl class="grid grid-cols-3 gap-2 text-center">
									<div class="rounded-md bg-muted/50 p-2">
										<dt class="text-xs text-muted-foreground">Mitglieder</dt>
										<dd class="text-lg font-medium tabular-nums">{g.memberCount}</dd>
									</div>
									<div class="rounded-md bg-muted/50 p-2">
										<dt class="text-xs text-muted-foreground">Alter</dt>
										<dd class="text-lg font-medium tabular-nums">
											{ageStats
												? ageStats.min === ageStats.max
													? ageStats.min
													: `${ageStats.min}–${ageStats.max}`
												: '–'}
										</dd>
									</div>
									<div class="rounded-md bg-muted/50 p-2">
										<dt class="text-xs text-muted-foreground">Ø Alter</dt>
										<dd class="text-lg font-medium tabular-nums">
											{ageStats ? fmtAvg(ageStats.avg) : '–'}
										</dd>
									</div>
								</dl>
								{#if stageCounts.length}
									<div class="flex flex-wrap gap-1">
										{#each stageCounts as s (s.stage)}
											<Badge variant="secondary" class="font-normal">
												{STAGE_LABELS[s.stage]}: <span class="tabular-nums">{s.n}</span>
											</Badge>
										{/each}
									</div>
								{/if}
								<Button variant="link" class="h-auto px-0" onclick={() => (tab = 'members')}>
									Alle Mitglieder anzeigen
								</Button>
							{/if}
						</Card.Content>
					</Card.Root>

					<Card.Root>
						<Card.Header>
							<Card.Title level={2} class="flex items-center gap-2">
								<Cake class="size-4 text-muted-foreground" aria-hidden="true" /> Geburtstage
							</Card.Title>
							<Card.Description>In den nächsten 14 Tagen</Card.Description>
						</Card.Header>
						<Card.Content>
							{#if overview?.birthdays.length}
								<ul class="space-y-1.5 text-sm">
									{#each overview.birthdays as b (b.memberId)}
										<li class="flex flex-wrap justify-between gap-x-3">
											<a href={memberHref(b.memberId)} class="break-words hover:underline">
												{personName(b)} <span class="text-muted-foreground">wird {b.age}</span>
											</a>
											<span class="text-muted-foreground">{birthdayWhen(b)}</span>
										</li>
									{/each}
								</ul>
							{:else}
								<p class="text-sm text-muted-foreground">
									Keine Geburtstage in den nächsten 14 Tagen.
								</p>
							{/if}
						</Card.Content>
					</Card.Root>
				{/if}

				{#if g.description}
					<Card.Root class="lg:col-span-2">
						<Card.Header>
							<Card.Title level={2}>Beschreibung</Card.Title>
						</Card.Header>
						<Card.Content>
							<p class="text-sm break-words whitespace-pre-line">{g.description}</p>
						</Card.Content>
					</Card.Root>
				{/if}
			</div>
		</Tabs.Content>

		<!-- Mitglieder --------------------------------------------------------------------->
		{#if canViewMembers}
			<Tabs.Content value="members" class="space-y-3">
				<DataTable
					caption={`Mitglieder der Gruppe ${g.name}`}
					mobile="cards"
					loading={membersLoading}
					error={membersError}
					onretry={() => loadMembers(g.id)}
					empty={members.length === 0}
					emptyTitle="Keine Mitglieder"
					emptyDescription="Dieser Gruppe ist noch niemand zugeordnet."
				>
					{#snippet toolbar()}
						<p class="text-sm text-muted-foreground">
							{membersTotal > members.length
								? `Erste ${members.length} von ${membersTotal} aktiven Mitgliedern`
								: `${memberCountText(membersTotal)} (ohne Ausgetretene)`}
						</p>
						<Button
							variant="outline"
							size="sm"
							class="ml-auto"
							href={`/modules/members?${new URLSearchParams({ groupId: g.id })}`}
						>
							<ExternalLink /> In der Mitgliederliste öffnen
						</Button>
					{/snippet}
					{#snippet head()}
						<Table.Row>
							<Table.Head>Name</Table.Head>
							<Table.Head>Stand</Table.Head>
							<Table.Head class="text-right">Alter</Table.Head>
						</Table.Row>
					{/snippet}
					{#each members as m (m.id)}
						<Table.Row
							class="cursor-pointer"
							tabindex={0}
							onclick={() => goto(memberHref(m.id))}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									void goto(memberHref(m.id));
								}
							}}
						>
							<Table.Cell class="font-medium whitespace-normal">
								<span class="break-words">{personName(m)}</span>
								{#if g.leaders.some((l) => l.id === m.id)}
									<Badge variant="outline" class="ml-1 font-normal">Leitung</Badge>
								{/if}
							</Table.Cell>
							<Table.Cell>{STAGE_LABELS[m.stage]}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">
								{ageFromBirthDate(m.birthDate) ?? '–'}
							</Table.Cell>
						</Table.Row>
					{/each}
				</DataTable>
			</Tabs.Content>
		{/if}

		<!-- Website ------------------------------------------------------------------------>
		<Tabs.Content value="website">
			<Card.Root>
				<Card.Header>
					<Card.Title level={2} class="flex items-center gap-2">
						<Globe class="size-4 text-muted-foreground" aria-hidden="true" /> Steckbrief auf der
						Website
					</Card.Title>
					<Card.Description>
						{g.website.onWebsite && g.website.slug
							? 'Die Gruppe wird auf der Stammeswebsite gezeigt.'
							: 'Die Gruppe wird nicht auf der Stammeswebsite gezeigt.'}
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<dl class="grid gap-2 text-sm">
						<div class="grid grid-cols-1 gap-1 sm:grid-cols-[10rem_1fr] sm:gap-2">
							<dt class="text-muted-foreground">Adresse</dt>
							<dd class="break-words">{g.website.slug ? `/gruppen/${g.website.slug}` : '–'}</dd>
						</div>
						<div class="grid grid-cols-1 gap-1 sm:grid-cols-[10rem_1fr] sm:gap-2">
							<dt class="text-muted-foreground">Alter</dt>
							<dd>{g.website.ageRange ?? '–'}</dd>
						</div>
						<div class="grid grid-cols-1 gap-1 sm:grid-cols-[10rem_1fr] sm:gap-2">
							<dt class="text-muted-foreground">E-Mail der Gruppe</dt>
							<dd class="break-words">{g.website.contactEmail ?? '–'}</dd>
						</div>
						<div class="grid grid-cols-1 gap-1 sm:grid-cols-[10rem_1fr] sm:gap-2">
							<dt class="text-muted-foreground">Text</dt>
							<dd class="break-words whitespace-pre-line">
								{#if g.website.description}
									{g.website.description}
								{:else if g.description}
									<span class="text-muted-foreground">(interne Beschreibung)</span>
									{g.description}
								{:else}
									–
								{/if}
							</dd>
						</div>
					</dl>
					{#if canEdit}
						<Button variant="outline" onclick={() => openEdit('website')}>
							<Pencil /> Steckbrief bearbeiten
						</Button>
					{/if}
				</Card.Content>
			</Card.Root>
		</Tabs.Content>
	</Tabs.Root>

	<GroupDialog bind:open={formOpen} group={g} initialTab={dialogTab} onsaved={() => load(g.id)} />

	<ConfirmDialog
		bind:open={deleteOpen}
		title="Gruppe löschen?"
		description={`Die Gruppe „${g.name}“ wird gelöscht. Das geht nur, wenn ihr keine Mitglieder mehr zugeordnet sind.`}
		confirmLabel="Löschen"
		destructive
		onconfirm={confirmDelete}
	/>

	<GroupSheetsDialog
		bind:open={sheetsOpen}
		groupIds={[g.id]}
		fileName={`Gruppe-${g.name}.pdf`}
		count={g.memberCount}
	/>
{/if}
