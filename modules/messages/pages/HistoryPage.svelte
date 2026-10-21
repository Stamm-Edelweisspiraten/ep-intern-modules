<script lang="ts">
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Plus from '@lucide/svelte/icons/plus';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Table from '$lib/components/ui/table';
	import { DataTable, PageHeader, PageTitle } from '$lib/components/layout';
	import { MESSAGE_STATUS_LABELS, type MessageStatus, type MessageSummary } from '../schemas';
	import { BASE, errorText, formatDateTime } from './helpers';

	const PAGE_SIZE = 30;
	let items = $state<MessageSummary[]>([]);
	let total = $state(0);
	let offset = $state(0);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = items.length === 0;
		try {
			const res = await apiFetch<{ items: MessageSummary[]; total: number }>(
				`${BASE}/messages?limit=${PAGE_SIZE}&offset=${offset}`
			);
			items = res.items;
			total = res.total;
			error = '';
		} catch (e) {
			error = errorText(e, 'Der Verlauf konnte nicht geladen werden.');
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void offset;
		void load();
	});

	// Laufende Versände aktualisieren sich selbst
	$effect(() => {
		if (!items.some((m) => m.status === 'sending')) return;
		const t = setInterval(() => void load(), 4000);
		return () => clearInterval(t);
	});

	const variant = (s: MessageStatus) =>
		s === 'done'
			? 'success'
			: s === 'sending'
				? 'info'
				: s === 'partial'
					? 'warning'
					: 'destructive';
</script>

<PageTitle title="Nachrichten" />

<div class="space-y-6">
	<PageHeader title="Nachrichten" description="Gesendete E-Mails an Mitglieder und Gruppen.">
		{#snippet actions()}
			<Button href={`${BASE}/new`}><Plus class="size-4" /> Neue Nachricht</Button>
		{/snippet}
	</PageHeader>

	<DataTable
		mobile="cards"
		caption="Gesendete Nachrichten"
		{loading}
		{error}
		onretry={load}
		empty={items.length === 0}
		emptyTitle="Noch keine Nachrichten gesendet."
	>
		{#snippet head()}
			<Table.Row>
				<Table.Head>Betreff</Table.Head>
				<Table.Head>Absender</Table.Head>
				<Table.Head>Von</Table.Head>
				<Table.Head>Gesendet</Table.Head>
				<Table.Head class="text-right">Empfänger</Table.Head>
				<Table.Head>Status</Table.Head>
			</Table.Row>
		{/snippet}
		{#each items as m (m.id)}
			<Table.Row>
				<Table.Cell class="font-medium">
					<a class="text-link hover:underline" href={`${BASE}/${m.id}`}>{m.subject}</a>
					{#if m.attachmentCount}
						<Paperclip
							class="ml-1 inline size-3.5 text-muted-foreground"
							aria-label={`${m.attachmentCount} Anhänge`}
						/>
					{/if}
				</Table.Cell>
				<Table.Cell>{m.senderName ?? m.senderAddress}</Table.Cell>
				<Table.Cell>{m.createdByName}</Table.Cell>
				<Table.Cell class="tabular-nums">{formatDateTime(m.createdAt)}</Table.Cell>
				<Table.Cell class="text-right tabular-nums">
					{m.sent}/{m.total}{#if m.failed}
						<span class="text-destructive"> · {m.failed} Fehler</span>{/if}
				</Table.Cell>
				<Table.Cell>
					<Badge variant={variant(m.status)}>{MESSAGE_STATUS_LABELS[m.status]}</Badge>
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
</div>
