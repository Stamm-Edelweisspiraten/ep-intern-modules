<script lang="ts">
	import { untrack } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import {
		DataTable,
		ErrorState,
		LoadingState,
		PageHeader,
		PageTitle
	} from '$lib/components/layout';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import {
		MESSAGE_STATUS_LABELS,
		type MessageDetail,
		type MessageStatus,
		type RecipientStatus
	} from '../schemas';
	import { BASE, errorText, formatDateTime, formatSize } from './helpers';

	let { params }: ModulePageProps = $props();

	let message = $state<MessageDetail | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let retrying = $state(false);

	let inFlight = false;
	async function load() {
		if (inFlight) return;
		inFlight = true;
		try {
			message = await apiFetch<MessageDetail>(`${BASE}/messages/${params.id}`);
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

	// Solange gesendet wird, regelmäßig neu laden (sichtbarer Tab, ohne Überlappung)
	const sending = $derived(message?.status === 'sending');
	$effect(() => {
		if (!sending) return;
		const t = setInterval(() => {
			if (!document.hidden) untrack(() => void load());
		}, 3000);
		return () => clearInterval(t);
	});

	async function retry() {
		retrying = true;
		try {
			message = await apiFetch<MessageDetail>(`${BASE}/messages/${params.id}/retry`, {
				method: 'POST'
			});
			toast.success('Fehlgeschlagene Empfänger werden erneut versucht');
		} catch (e) {
			toast.error(errorText(e, 'Erneutes Senden nicht möglich.'));
		} finally {
			retrying = false;
		}
	}

	const statusVariant = (s: MessageStatus) =>
		s === 'done'
			? 'success'
			: s === 'sending'
				? 'info'
				: s === 'partial'
					? 'warning'
					: 'destructive';
	const RECIPIENT_LABELS: Record<RecipientStatus, string> = {
		pending: 'Wartet',
		sending: 'Wird gesendet',
		sent: 'Gesendet',
		failed: 'Fehlgeschlagen'
	};
	const recipientVariant = (s: RecipientStatus) =>
		s === 'sent' ? 'success' : s === 'failed' ? 'destructive' : 'info';
</script>

<PageTitle title={message?.subject ?? 'Nachricht'} />

<div class="space-y-6">
	<a
		href={BASE}
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" /> Zum Verlauf
	</a>

	{#if loading}
		<LoadingState label="Lädt …" rows={4} />
	{:else if loadError || !message}
		<ErrorState message={loadError || 'Nachricht nicht gefunden.'} onretry={load} />
	{:else}
		<PageHeader title={message.subject}>
			{#snippet actions()}
				{#if message && message.failed > 0 && message.status !== 'sending'}
					<Button variant="outline" onclick={retry} disabled={retrying}>
						<RotateCw class="size-4" />
						{retrying ? 'Sendet …' : `${message.failed} Fehlgeschlagene erneut senden`}
					</Button>
				{/if}
			{/snippet}
		</PageHeader>

		<Card.Root>
			<Card.Content class="space-y-3 pt-6 text-sm">
				<dl class="grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr]">
					<dt class="text-muted-foreground">Status</dt>
					<dd>
						<Badge variant={statusVariant(message.status)}>
							{MESSAGE_STATUS_LABELS[message.status]}
						</Badge>
						<span class="ml-2 tabular-nums">
							{message.sent} von {message.total} gesendet{message.failed
								? `, ${message.failed} fehlgeschlagen`
								: ''}
						</span>
					</dd>
					<dt class="text-muted-foreground">Von</dt>
					<dd>
						{message.senderName ? `${message.senderName} ` : ''}&lt;{message.senderAddress}&gt;
					</dd>
					<dt class="text-muted-foreground">Antworten an</dt>
					<dd>{message.replyTo ?? message.senderAddress}</dd>
					<dt class="text-muted-foreground">Gesendet</dt>
					<dd class="tabular-nums">
						{formatDateTime(message.createdAt)} · {message.createdByName}
					</dd>
					{#if message.attachments.length}
						<dt class="text-muted-foreground">Anhänge</dt>
						<dd>
							<ul class="space-y-0.5">
								{#each message.attachments as a (a.id)}
									<li class="flex items-center gap-1.5">
										<Paperclip class="size-3.5 text-muted-foreground" />
										{a.filename}
										<span class="text-xs text-muted-foreground tabular-nums">
											{formatSize(a.size)}{a.removed ? ' · nach 30 Tagen entfernt' : ''}
										</span>
									</li>
								{/each}
							</ul>
						</dd>
					{/if}
				</dl>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header><Card.Title level={2}>Text</Card.Title></Card.Header>
			<Card.Content>
				<!-- Der Text wurde beim Senden serverseitig bereinigt; hier nur als Klartext-Vorschau -->
				<div class="prose-sm max-w-none whitespace-pre-wrap text-sm">
					{message.bodyHtml
						.replace(/<\/(p|h2|h3|li|blockquote)>/g, '\n')
						.replace(/<br\s*\/?>/g, '\n')
						.replace(/<[^>]*>/g, '')
						.replace(/&amp;/g, '&')
						.replace(/&lt;/g, '<')
						.replace(/&gt;/g, '>')
						.replace(/&quot;/g, '"')
						.replace(/&#39;/g, "'")
						.replace(/\n{3,}/g, '\n\n')
						.trim()}
				</div>
			</Card.Content>
		</Card.Root>

		{#if message.status === 'sending'}
			<Alert variant="info">
				<AlertDescription
					>Die Nachricht wird gerade gesendet – diese Seite aktualisiert sich.</AlertDescription
				>
			</Alert>
		{/if}

		<DataTable
			mobile="cards"
			caption="Empfänger"
			empty={message.recipients.length === 0}
			emptyTitle="Keine Empfänger."
		>
			{#snippet head()}
				<Table.Row>
					<Table.Head>Name</Table.Head>
					<Table.Head>Adresse</Table.Head>
					<Table.Head>Status</Table.Head>
					<Table.Head>Hinweis</Table.Head>
				</Table.Row>
			{/snippet}
			{#each message.recipients as r (r.id)}
				<Table.Row>
					<Table.Cell>{r.name ?? '–'}</Table.Cell>
					<Table.Cell class="break-all">{r.address}</Table.Cell>
					<Table.Cell>
						<Badge variant={recipientVariant(r.status)}>{RECIPIENT_LABELS[r.status]}</Badge>
					</Table.Cell>
					<Table.Cell class="text-xs text-muted-foreground">
						{r.error ?? (r.sentAt ? formatDateTime(r.sentAt) : '')}
					</Table.Cell>
				</Table.Row>
			{/each}
		</DataTable>
	{/if}
</div>
