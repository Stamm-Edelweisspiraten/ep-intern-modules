<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { goto, replaceState } from '$app/navigation';
	import Briefcase from '@lucide/svelte/icons/briefcase';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Landmark from '@lucide/svelte/icons/landmark';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Reply from '@lucide/svelte/icons/reply';
	import Search from '@lucide/svelte/icons/search';
	import Send from '@lucide/svelte/icons/send';
	import User from '@lucide/svelte/icons/user';
	import Users from '@lucide/svelte/icons/users';
	import { toast } from 'svelte-sonner';
	import { apiFetch, can } from '$lib/sdk/client';
	import { refreshNavBadges } from '$lib/sdk/client/nav-badges.svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		CountBadge,
		DataTable,
		ErrorState,
		formatCount,
		LoadingState,
		PageHeader,
		PageTitle
	} from '$lib/components/layout';
	import { cn } from '$lib/utils';
	import type { MailboxKind } from '../mailbox';
	import {
		INBOX_VIEWS,
		MESSAGE_STATUS_LABELS,
		type InboxListResponse,
		type InboxSummary,
		type InboxView,
		type MailboxesResponse,
		type MailboxSentItem,
		type MailboxSentResponse,
		type MessageStatus,
		type PollResult
	} from '../schemas';
	import MessagesTabs from './MessagesTabs.svelte';
	import { BASE, errorText, formatDateTime } from './helpers';

	const PAGE_SIZE = 50;
	const FILTER_LABELS: Record<InboxView, string> = {
		all: 'Alle',
		unread: 'Ungelesen',
		spam: 'Spam',
		trash: 'Papierkorb',
		sent: 'Gesendet'
	};
	const statusVariant = (s: MessageStatus) =>
		s === 'done'
			? 'success'
			: s === 'sending'
				? 'info'
				: s === 'partial'
					? 'warning'
					: 'destructive';
	const KIND_ICONS: Record<MailboxKind, typeof User> = {
		personal: User,
		office: Briefcase,
		group: Users,
		stamm: Landmark,
		unassigned: Inbox
	};

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canSettings = $derived(can(permissions, 'messages.settings.manage'));

	let boxes = $state<MailboxesResponse | null>(null);
	let boxesError = $state('');
	let mailbox = $state<string | null>(null);
	let filter = $state<InboxView>('all');
	let searchText = $state('');
	let query = $state('');
	let offset = $state(0);

	let items = $state<InboxSummary[]>([]);
	/** Ansicht „Gesendet“: von der Adresse des Postfachs gesendete Nachrichten */
	let sentItems = $state<MailboxSentItem[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let listError = $state('');
	let polling = $state(false);

	const current = $derived(boxes?.mailboxes.find((b) => b.key === mailbox) ?? null);
	/** „Gesendet“ gibt es nicht für „Nicht zugeordnet“ */
	const views = $derived(INBOX_VIEWS.filter((v) => v !== 'sent' || current?.kind !== 'unassigned'));
	const showSent = $derived(filter === 'sent');

	/** Postfächer laden; wählt beim ersten Mal das Postfach aus der URL bzw. das erste */
	async function loadBoxes() {
		try {
			const res = await apiFetch<MailboxesResponse>(`${BASE}/mailboxes`);
			boxes = res;
			boxesError = '';
			const keys = res.mailboxes.map((b) => b.key);
			const wanted = untrack(() => mailbox) ?? new URLSearchParams(location.search).get('mailbox');
			const next = wanted && keys.includes(wanted) ? wanted : (keys[0] ?? null);
			if (next !== untrack(() => mailbox)) mailbox = next;
			if (!next) loading = false;
		} catch (e) {
			boxesError = errorText(e, 'Die Postfächer konnten nicht geladen werden.');
			loading = false;
		}
	}

	let inFlight = false;
	/** Liste laden; liest selbst keinen reaktiven Zustand (Aufruf aus `$effect` mit `untrack`) */
	async function loadList(
		key: string,
		f: InboxView,
		q: string,
		at: number,
		silent = false
	): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		if (!silent) loading = true;
		try {
			const params = new URLSearchParams({
				mailbox: key,
				limit: String(PAGE_SIZE),
				offset: String(at)
			});
			if (q) params.set('search', q);
			if (f === 'sent') {
				const res = await apiFetch<MailboxSentResponse>(`${BASE}/mailboxes/sent?${params}`);
				sentItems = res.items;
				items = [];
				total = res.total;
			} else {
				params.set('filter', f);
				const res = await apiFetch<InboxListResponse>(`${BASE}/inbox?${params}`);
				items = res.items;
				sentItems = [];
				total = res.total;
			}
			listError = '';
		} catch (e) {
			listError = errorText(e, 'Die Nachrichten konnten nicht geladen werden.');
		} finally {
			inFlight = false;
			loading = false;
		}
	}

	void loadBoxes();

	// Postfach, Filter, Suche oder Seite geändert → Liste neu laden und Postfach in der URL merken
	$effect(() => {
		const key = mailbox;
		const f = filter;
		const q = query;
		const at = offset;
		if (!key) return;
		untrack(() => {
			const url = new URL(location.href);
			if (url.searchParams.get('mailbox') !== key) {
				url.searchParams.set('mailbox', key);
				replaceState(url, page.state);
			}
			void loadList(key, f, q, at);
		});
	});

	// Suche mit kurzer Verzögerung
	$effect(() => {
		const q = searchText.trim();
		const t = setTimeout(() => {
			if (q !== untrack(() => query)) {
				query = q;
				offset = 0;
			}
		}, 300);
		return () => clearTimeout(t);
	});

	// Neue Mails: jede Minute still aktualisieren (nur im sichtbaren Tab)
	$effect(() => {
		const t = setInterval(() => {
			if (document.hidden) return;
			untrack(() => {
				void loadBoxes();
				if (mailbox) void loadList(mailbox, filter, query, offset, true);
			});
		}, 60_000);
		return () => clearInterval(t);
	});

	function selectMailbox(key: string | null) {
		if (!key || key === mailbox) return;
		if (key === 'unassigned' && filter === 'sent') filter = 'all';
		mailbox = key;
		offset = 0;
	}
	function selectFilter(v: string) {
		filter = (INBOX_VIEWS as readonly string[]).includes(v) ? (v as InboxView) : 'all';
		offset = 0;
	}

	async function pollNow() {
		polling = true;
		try {
			const res = await apiFetch<PollResult>(`${BASE}/inbox/poll`, { method: 'POST' });
			toast.success(res.message);
			await loadBoxes();
			void refreshNavBadges();
			if (mailbox) await loadList(mailbox, filter, query, offset, true);
		} catch (e) {
			toast.error(errorText(e, 'Der Abruf ist fehlgeschlagen.'));
		} finally {
			polling = false;
		}
	}

	const mailboxOptions = $derived(
		(boxes?.mailboxes ?? []).map((b) => ({
			value: b.key,
			label: `${b.name}${b.address ? ` (${b.address})` : ''}${b.unread ? ` · ${formatCount(b.unread)} neu` : ''}`
		}))
	);
	const open = (id: string) => goto(`${BASE}/inbox/${id}`);
</script>

<PageTitle title="Posteingang" />

<div class="space-y-6">
	<PageHeader
		title="Nachrichten"
		description="Antworten auf deine Mails und Post an deine Adressen."
	>
		{#snippet actions()}
			{#if boxes?.canManage && boxes.enabled}
				<Button variant="outline" onclick={pollNow} disabled={polling}>
					<RefreshCw class={cn('size-4', polling && 'animate-spin')} />
					{polling ? 'Ruft ab …' : 'Jetzt abrufen'}
				</Button>
			{/if}
			<Button href={`${BASE}/new`}><Plus class="size-4" /> Neue Nachricht</Button>
		{/snippet}
	</PageHeader>
	<MessagesTabs />

	{#if !boxes && !boxesError}
		<LoadingState label="Lädt …" rows={4} />
	{:else if boxesError || !boxes}
		<ErrorState message={boxesError} onretry={loadBoxes} />
	{:else}
		{#if !boxes.enabled}
			<Alert variant="info">
				<AlertDescription>
					Der Posteingang ist noch nicht eingerichtet: Antworten auf gesendete Nachrichten
					erscheinen erst hier, wenn das Catch-all-Postfach unter Administration → Einstellungen →
					Module hinterlegt ist.
					{#if canSettings}
						<a class="text-link underline" href="/admin/settings/modules">Zu den Einstellungen</a>
					{/if}
				</AlertDescription>
			</Alert>
		{:else if boxes.lastPoll?.status === 'error'}
			<Alert variant="warning">
				<AlertDescription>
					Letzter Abruf fehlgeschlagen{boxes.lastPoll.at
						? ` (${formatDateTime(boxes.lastPoll.at)})`
						: ''}: {boxes.lastPoll.message}
				</AlertDescription>
			</Alert>
		{/if}

		{#if boxes.mailboxes.length === 0}
			<Card.Root>
				<Card.Content class="py-10 text-center text-sm text-muted-foreground">
					Du hast noch kein Postfach. Postfächer entstehen aus deinen Absenderadressen: der
					persönlichen Adresse, deinen Ämtern und den Gruppen, die du leitest.
				</Card.Content>
			</Card.Root>
		{:else}
			<div class="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
				<!-- Postfächer: links als Liste, mobil als Auswahl -->
				<div class="lg:hidden">
					<SelectField
						id="inbox-mailbox"
						label="Postfach"
						options={mailboxOptions}
						value={mailbox}
						onchange={selectMailbox}
					/>
				</div>
				<nav aria-label="Postfächer" class="hidden lg:block">
					<ul class="space-y-1">
						{#each boxes.mailboxes as b (b.key)}
							{@const Icon = KIND_ICONS[b.kind]}
							<li>
								<button
									type="button"
									class={cn(
										'focus-ring flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted',
										b.key === mailbox && 'bg-muted font-medium'
									)}
									aria-current={b.key === mailbox ? 'true' : undefined}
									onclick={() => selectMailbox(b.key)}
								>
									<Icon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
									<span class="min-w-0 flex-1">
										<span class="block truncate">{b.name}</span>
										{#if b.address}
											<span class="block truncate text-xs font-normal text-muted-foreground">
												{b.address}
											</span>
										{/if}
									</span>
									<CountBadge count={b.unread} variant="info" class="mt-0.5" />
								</button>
							</li>
						{/each}
					</ul>
				</nav>

				<div class="min-w-0 space-y-3">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<Tabs.Root value={filter} onValueChange={selectFilter}>
							<Tabs.List aria-label="Filter">
								{#each views as f (f)}
									<Tabs.Trigger value={f}>
										{#if f === 'sent'}<Send class="size-3.5" aria-hidden="true" />{/if}
										{FILTER_LABELS[f]}
									</Tabs.Trigger>
								{/each}
							</Tabs.List>
						</Tabs.Root>
						<div class="relative w-full sm:w-64">
							<Search
								class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
								aria-hidden="true"
							/>
							<Input
								type="search"
								class="pl-8"
								placeholder={showSent ? 'Betreff oder Empfänger …' : 'Betreff oder Absender …'}
								aria-label="Nachrichten durchsuchen"
								bind:value={searchText}
							/>
						</div>
					</div>

					<DataTable
						mobile="cards"
						caption={current
							? `${showSent ? 'Gesendet von' : 'Nachrichten in'} ${current.name}`
							: 'Nachrichten'}
						{loading}
						error={listError}
						onretry={() => void (mailbox && loadList(mailbox, filter, query, offset))}
						empty={showSent ? sentItems.length === 0 : items.length === 0}
						emptyTitle={filter === 'unread'
							? 'Keine ungelesenen Nachrichten.'
							: filter === 'trash'
								? 'Der Papierkorb ist leer.'
								: filter === 'spam'
									? 'Kein Spam.'
									: filter === 'sent'
										? 'Von dieser Adresse wurde noch nichts gesendet.'
										: 'Noch keine Nachrichten in diesem Postfach.'}
					>
						{#snippet head()}
							{#if showSent}
								<Table.Row>
									<Table.Head>An</Table.Head>
									<Table.Head>Betreff</Table.Head>
									<Table.Head>Von</Table.Head>
									<Table.Head class="text-right">Gesendet</Table.Head>
									<Table.Head>Status</Table.Head>
								</Table.Row>
							{:else}
								<Table.Row>
									<Table.Head>Von</Table.Head>
									<Table.Head>Betreff</Table.Head>
									<Table.Head class="text-right">Eingang</Table.Head>
								</Table.Row>
							{/if}
						{/snippet}
						{#each sentItems as s (s.id)}
							{@const href = `${BASE}/${s.id}?mailbox=${encodeURIComponent(mailbox ?? '')}`}
							<Table.Row class="cursor-pointer" onclick={() => goto(href)}>
								<Table.Cell class="max-w-56">
									<span class="block truncate" title={s.to}>{s.to || '–'}</span>
									{#if s.recipients > 1}
										<span class="text-xs text-muted-foreground">
											und {s.recipients - 1} weitere
										</span>
									{/if}
								</Table.Cell>
								<Table.Cell class="max-w-[28rem]">
									<div class="min-w-0 text-left">
										<a
											class="block truncate hover:underline"
											{href}
											onclick={(e) => e.stopPropagation()}
										>
											{s.subject}
										</a>
										{#if s.attachmentCount}
											<Paperclip
												class="inline size-3 text-muted-foreground"
												aria-label={`${s.attachmentCount} Anhänge`}
											/>
										{/if}
									</div>
								</Table.Cell>
								<Table.Cell class="max-w-40"
									><span class="block truncate">{s.createdByName}</span></Table.Cell
								>
								<Table.Cell class="text-right whitespace-nowrap tabular-nums">
									{formatDateTime(s.createdAt)}
								</Table.Cell>
								<Table.Cell>
									<Badge variant={statusVariant(s.status)}>{MESSAGE_STATUS_LABELS[s.status]}</Badge>
								</Table.Cell>
							</Table.Row>
						{/each}
						{#each items as m (m.id)}
							<Table.Row
								class={cn('cursor-pointer', !m.read && 'bg-info-muted/40')}
								onclick={() => open(m.id)}
							>
								<Table.Cell class={cn('max-w-56', !m.read && 'font-semibold')}>
									<span class="block truncate" title={m.from.address}>
										{m.from.name ?? m.from.address}
									</span>
								</Table.Cell>
								<Table.Cell class="max-w-[32rem]">
									<!-- ein Element: in der mobilen Kartenansicht bleibt Betreff über dem Auszug -->
									<div class="min-w-0 text-left">
										<a
											class={cn('block truncate hover:underline', !m.read && 'font-semibold')}
											href={`${BASE}/inbox/${m.id}`}
											onclick={(e) => e.stopPropagation()}
										>
											{#if !m.read}<span class="sr-only">Ungelesen: </span>{/if}
											{m.subject || '(kein Betreff)'}
										</a>
										<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
											{#if m.answered}
												<Reply class="size-3 shrink-0" aria-label="Beantwortet" />
											{/if}
											{#if m.attachmentCount}
												<Paperclip
													class="size-3 shrink-0"
													aria-label={`${m.attachmentCount} Anhänge`}
												/>
											{/if}
											{#if m.spam}<Badge variant="warning">Spam</Badge>{/if}
											<span class="truncate">{m.snippet}</span>
										</span>
									</div>
								</Table.Cell>
								<Table.Cell class="text-right whitespace-nowrap tabular-nums">
									{formatDateTime(m.receivedAt)}
								</Table.Cell>
							</Table.Row>
						{/each}
						{#snippet footer()}
							{#if total > PAGE_SIZE}
								<div class="flex items-center justify-between gap-2 text-sm">
									<span class="text-muted-foreground tabular-nums">
										{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} von {total}
									</span>
									<span class="flex gap-2">
										<Button
											size="sm"
											variant="outline"
											disabled={offset === 0}
											onclick={() => (offset = Math.max(0, offset - PAGE_SIZE))}>Zurück</Button
										>
										<Button
											size="sm"
											variant="outline"
											disabled={offset + PAGE_SIZE >= total}
											onclick={() => (offset += PAGE_SIZE)}>Weiter</Button
										>
									</span>
								</div>
							{/if}
						{/snippet}
					</DataTable>
					{#if boxes.canManage && boxes.lastPoll?.at && boxes.lastPoll.status === 'ok'}
						<p class="text-xs text-muted-foreground">
							Letzter Abruf {formatDateTime(boxes.lastPoll.at)}: {boxes.lastPoll.message}
						</p>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</div>
