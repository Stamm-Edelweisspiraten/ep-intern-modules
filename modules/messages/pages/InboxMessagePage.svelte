<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Download from '@lucide/svelte/icons/download';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Eye from '@lucide/svelte/icons/eye';
	import Forward from '@lucide/svelte/icons/forward';
	import Mail from '@lucide/svelte/icons/mail';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Reply from '@lucide/svelte/icons/reply';
	import ReplyAll from '@lucide/svelte/icons/reply-all';
	import Send from '@lucide/svelte/icons/send';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { SelectField } from '$lib/components/ui/select-field';
	import {
		ConfirmDialog,
		ErrorState,
		FormField,
		LoadingState,
		PageHeader,
		PageTitle
	} from '$lib/components/layout';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import { cn } from '$lib/utils';
	import type { InboxAddress, InboxDetail } from '../schemas';
	import { BASE, errorText, formatDateTime, formatSize } from './helpers';

	let { params }: ModulePageProps = $props();

	let mail = $state<InboxDetail | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let busy = $state(false);
	let confirmDelete = $state(false);

	let inFlight = false;
	async function load() {
		if (inFlight) return;
		inFlight = true;
		try {
			mail = await apiFetch<InboxDetail>(`${BASE}/inbox/${params.id}`);
			loadError = '';
		} catch (e) {
			loadError = errorText(e, 'Die Nachricht konnte nicht geladen werden.');
		} finally {
			inFlight = false;
			loading = false;
		}
	}
	$effect(() => {
		void params.id;
		untrack(() => void load());
	});

	const backHref = $derived(mail ? `${BASE}?mailbox=${encodeURIComponent(mail.mailboxKey)}` : BASE);
	const label = (a: InboxAddress) => (a.name ? `${a.name} <${a.address}>` : a.address);
	const recipientCount = $derived(mail ? mail.to.length + mail.cc.length : 0);
	const fileUrl = (attachmentId: string, inline = false) =>
		`/api/v1/modules/messages/inbox/${params.id}/attachments/${attachmentId}${inline ? '?inline=1' : ''}`;
	const viewable = (type: string) =>
		/^image\/(png|jpe?g|gif|webp)$/.test(type) ||
		type === 'application/pdf' ||
		type === 'text/plain';

	async function action(path: string, method: 'POST' | 'DELETE', done: string) {
		busy = true;
		try {
			await apiFetch(`${BASE}/inbox/${params.id}${path}`, { method });
			toast.success(done);
			return true;
		} catch (e) {
			toast.error(errorText(e, 'Das hat nicht geklappt.'));
			return false;
		} finally {
			busy = false;
		}
	}
	async function markUnread() {
		if (await action('/unread', 'POST', 'Als ungelesen markiert')) await goto(backHref);
	}
	async function remove() {
		if (await action('', 'DELETE', 'In den Papierkorb verschoben')) await goto(backHref);
	}
	async function restore() {
		if (await action('/restore', 'POST', 'Wiederhergestellt')) await load();
	}

	// --- Zuordnen (nur „Nicht zugeordnet“, Verwaltung) ------------------------------------------
	let targets = $state<{ value: string; label: string }[]>([]);
	let target = $state<string | null>(null);
	$effect(() => {
		if (mail?.mailboxKey !== 'unassigned') return;
		untrack(async () => {
			try {
				const list = await apiFetch<{ key: string; name: string; address: string }[]>(
					`${BASE}/mailboxes/all`
				);
				targets = list.map((t) => ({ value: t.key, label: `${t.name} (${t.address})` }));
			} catch {
				targets = [];
			}
		});
	});
	async function assign() {
		if (!target) return;
		busy = true;
		try {
			const res = await apiFetch<{ visible: boolean }>(`${BASE}/inbox/${params.id}/assign`, {
				method: 'POST',
				body: JSON.stringify({ mailbox: target })
			});
			toast.success('Zugeordnet – die Empfänger*innen werden benachrichtigt');
			if (res.visible) await load();
			else await goto(`${BASE}?mailbox=unassigned`);
		} catch (e) {
			toast.error(errorText(e, 'Zuordnen nicht möglich.'));
		} finally {
			busy = false;
		}
	}
</script>

<PageTitle title={mail?.subject || 'Nachricht'} />

<div class="space-y-6">
	<a
		href={backHref}
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" /> Zum Posteingang
	</a>

	{#if loading}
		<LoadingState label="Lädt …" rows={5} />
	{:else if loadError || !mail}
		<ErrorState message={loadError || 'Nachricht nicht gefunden.'} onretry={load} />
	{:else}
		<PageHeader title={mail.subject || '(kein Betreff)'}>
			{#snippet actions()}
				{#if mail}
					{#if mail.canReply && !mail.deleted}
						<Button href={`${BASE}/new?reply=${mail.id}`}>
							<Reply class="size-4" /> Antworten
						</Button>
						{#if recipientCount > 1}
							<Button variant="outline" href={`${BASE}/new?reply=${mail.id}&mode=reply-all`}>
								<ReplyAll class="size-4" /> Allen antworten
							</Button>
						{/if}
						<Button variant="outline" href={`${BASE}/new?forward=${mail.id}`}>
							<Forward class="size-4" /> Weiterleiten
						</Button>
					{/if}
					{#if mail.deleted}
						<Button variant="outline" onclick={restore} disabled={busy}>
							<Undo2 class="size-4" /> Wiederherstellen
						</Button>
					{:else}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button {...props} variant="outline" size="icon" aria-label="Weitere Aktionen">
										<Ellipsis class="size-4" />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end">
								<DropdownMenu.Item onSelect={markUnread} disabled={busy}>
									<Mail class="size-4" /> Als ungelesen markieren
								</DropdownMenu.Item>
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									class="text-destructive"
									onSelect={() => (confirmDelete = true)}
									disabled={busy}
								>
									<Trash2 class="size-4" /> In den Papierkorb
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/if}
				{/if}
			{/snippet}
		</PageHeader>

		{#if mail.mailboxKey === 'unassigned'}
			<Card.Root class="overflow-visible">
				<Card.Header>
					<Card.Title level={2}>Nicht zugeordnet</Card.Title>
					<Card.Description>
						{mail.unassignedReason === 'ambiguous'
							? `Die Adresse ${mail.mailboxAddress} passt zu mehreren Personen (gleicher Name).`
							: `Zu ${mail.mailboxAddress || 'dieser Adresse'} gibt es kein Postfach.`}
						Ordne die Nachricht einem Postfach zu – die Berechtigten werden dann benachrichtigt.
					</Card.Description>
				</Card.Header>
				<Card.Content class="flex flex-wrap items-end gap-3">
					<div class="min-w-64 flex-1">
						<FormField label="Postfach" id="assign-target">
							<SelectField
								id="assign-target"
								label="Postfach"
								options={targets}
								bind:value={target}
								placeholder="Postfach wählen …"
							/>
						</FormField>
					</div>
					<Button onclick={assign} disabled={!target || busy}>
						<Send class="size-4" /> Zuordnen
					</Button>
				</Card.Content>
			</Card.Root>
		{/if}

		{#if mail.spam}
			<Alert variant="warning">
				<AlertDescription>
					Der Mailserver hat diese Nachricht als Spam markiert. Links und Anhänge nur öffnen, wenn
					du den Absender kennst.
				</AlertDescription>
			</Alert>
		{/if}
		{#if mail.deleted}
			<Alert variant="info">
				<AlertDescription>
					Diese Nachricht liegt im Papierkorb und wird nach 30 Tagen gelöscht.
				</AlertDescription>
			</Alert>
		{/if}
		{#if mail.replies.length}
			<Alert variant="success">
				<AlertDescription>
					{#each mail.replies as r, i (r.messageId)}
						{i ? ' · ' : ''}
						<a class="underline" href={`${BASE}/${r.messageId}`}>
							{r.kind === 'reply' ? 'Beantwortet' : 'Weitergeleitet'} von {r.byName} am
							{formatDateTime(r.at)}
						</a>
					{/each}
				</AlertDescription>
			</Alert>
		{/if}

		<Card.Root>
			<Card.Content class="space-y-4 pt-6 text-sm">
				<dl class="grid gap-x-6 gap-y-1.5 sm:grid-cols-[8rem_minmax(0,1fr)]">
					<dt class="text-muted-foreground">Von</dt>
					<dd class="break-words">
						{label(mail.from)}
						{#if mail.authResult === 'fail'}
							<Badge variant="warning" class="ml-1 gap-1">
								<ShieldAlert class="size-3" /> Absender nicht bestätigt
							</Badge>
						{/if}
					</dd>
					<dt class="text-muted-foreground">An</dt>
					<dd class="break-words">{mail.to.map(label).join(', ') || '–'}</dd>
					{#if mail.cc.length}
						<dt class="text-muted-foreground">Cc</dt>
						<dd class="break-words">{mail.cc.map(label).join(', ')}</dd>
					{/if}
					{#if mail.replyTo && mail.replyTo !== mail.from.address}
						<dt class="text-muted-foreground">Antwort an</dt>
						<dd class="break-words">{mail.replyTo}</dd>
					{/if}
					<dt class="text-muted-foreground">Eingang</dt>
					<dd class="tabular-nums">{formatDateTime(mail.receivedAt)}</dd>
					<dt class="text-muted-foreground">Postfach</dt>
					<dd class="break-words">
						{mail.mailboxName}{mail.mailboxAddress ? ` (${mail.mailboxAddress})` : ''}
					</dd>
				</dl>

				{#if mail.authResult === 'fail'}
					<p class="text-xs text-warning" role="note">
						Der Mailserver konnte nicht bestätigen, dass die Nachricht wirklich von dieser Adresse
						stammt. Vorsicht bei Bitten um Geld, Passwörter oder Bankdaten.
					</p>
				{/if}
				{#if mail.truncated}
					<Alert variant="warning">
						<AlertDescription>
							Die Nachricht war zu groß und wurde nur teilweise übernommen. Die vollständige Mail
							liegt im Ablageordner des Mailservers.
						</AlertDescription>
					</Alert>
				{/if}
				{#if mail.blockedImages}
					<p class="text-xs text-muted-foreground">
						{mail.blockedImages === 1
							? 'Ein externes Bild wurde'
							: `${mail.blockedImages} externe Bilder wurden`}
						aus Datenschutzgründen nicht geladen.
					</p>
				{/if}

				<!-- Mail-HTML (serverseitig bereinigt) ohne Skripte und ohne Nachladen; Links öffnen in einem neuen Tab -->
				<iframe
					title="Inhalt der Nachricht"
					srcdoc={mail.document}
					sandbox="allow-popups allow-popups-to-escape-sandbox"
					class="h-[60vh] min-h-80 w-full resize-y rounded-md border bg-white"
				></iframe>

				{#if mail.attachments.length || mail.skippedAttachments.length}
					<div class="space-y-2">
						<h3 class="flex items-center gap-1.5 font-medium">
							<Paperclip class="size-4" /> Anhänge
						</h3>
						<ul class="divide-y rounded-md border">
							{#each mail.attachments as a (a.id)}
								<li class="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
									<span class="min-w-0 truncate">{a.filename}</span>
									<span class="flex shrink-0 items-center gap-2">
										<span class="text-xs text-muted-foreground tabular-nums">
											{formatSize(a.size)}
										</span>
										{#if viewable(a.contentType)}
											<Button
												variant="ghost"
												size="sm"
												href={fileUrl(a.id, true)}
												target="_blank"
												rel="noopener"
												aria-label={`${a.filename} ansehen`}
											>
												<Eye class="size-4" />
											</Button>
										{/if}
										<Button
											variant="ghost"
											size="sm"
											href={fileUrl(a.id)}
											download
											aria-label={`${a.filename} herunterladen`}
										>
											<Download class="size-4" />
										</Button>
									</span>
								</li>
							{/each}
							{#each mail.skippedAttachments as s, i (s.filename + i)}
								<li class="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
									<span class="min-w-0 truncate text-muted-foreground">{s.filename}</span>
									<span class="text-xs text-muted-foreground">
										nicht übernommen (Dateityp nicht erlaubt)
									</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		{#if mail.thread.length}
			<Card.Root>
				<Card.Header><Card.Title level={2}>Verlauf</Card.Title></Card.Header>
				<Card.Content>
					<ol class="space-y-2">
						{#each mail.thread as t (t.direction + t.id)}
							<li>
								<a
									href={t.href}
									class={cn(
										'block rounded-md border px-3 py-2 text-sm hover:bg-muted',
										t.current && 'border-primary bg-muted',
										t.direction === 'out' && 'sm:ml-8'
									)}
									aria-current={t.current ? 'true' : undefined}
								>
									<span class="flex flex-wrap items-center justify-between gap-2">
										<span class="min-w-0 truncate font-medium">
											{#if t.direction === 'out'}
												<Send class="mr-1 inline size-3.5" aria-label="Gesendet" />
											{/if}
											{t.from}
										</span>
										<span class="text-xs text-muted-foreground tabular-nums">
											{formatDateTime(t.at)}
										</span>
									</span>
									<span class="block truncate text-xs text-muted-foreground">{t.snippet}</span>
								</a>
							</li>
						{/each}
					</ol>
				</Card.Content>
			</Card.Root>
		{/if}
	{/if}
</div>

<ConfirmDialog
	bind:open={confirmDelete}
	title="In den Papierkorb?"
	description={mail && mail.mailboxKey !== 'unassigned' && !mail.mailboxKey.startsWith('personal:')
		? 'Das Postfach wird gemeinsam genutzt – die Nachricht verschwindet für alle. Sie lässt sich 30 Tage lang aus dem Papierkorb wiederherstellen.'
		: 'Die Nachricht lässt sich 30 Tage lang aus dem Papierkorb wiederherstellen.'}
	confirmLabel="In den Papierkorb"
	destructive
	onconfirm={remove}
/>
