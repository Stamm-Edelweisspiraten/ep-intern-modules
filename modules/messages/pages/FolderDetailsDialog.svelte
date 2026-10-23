<script lang="ts">
	import { untrack } from 'svelte';
	import { apiFetch } from '$lib/sdk/client';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ErrorState, LoadingState } from '$lib/components/layout';
	import type { FolderDetails } from '../schemas';
	import { BASE, errorText, formatDateTime, formatSize } from './helpers';

	let {
		open = $bindable(false),
		mailbox,
		folderId = null
	}: {
		open?: boolean;
		/** Postfach-Schlüssel */
		mailbox: string | null;
		/** Ordner-ID; `null` = ganzes Postfach */
		folderId?: string | null;
	} = $props();

	let details = $state<FolderDetails | null>(null);
	let error = $state('');
	let loading = $state(false);

	async function load(key: string, folder: string | null) {
		loading = true;
		error = '';
		details = null;
		try {
			const params = new URLSearchParams({ mailbox: key });
			if (folder) params.set('folder', folder);
			details = await apiFetch<FolderDetails>(`${BASE}/mailboxes/details?${params}`);
		} catch (e) {
			error = errorText(e, 'Die Details konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (!open || !mailbox) return;
		const key = mailbox;
		const folder = folderId;
		untrack(() => void load(key, folder));
	});

	const size = (bytes: number) => (bytes > 0 ? formatSize(bytes) : '0 KB');
	const count = (n: number) => n.toLocaleString('de-DE');
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Details{details ? `: ${details.name}` : ''}</Dialog.Title>
			<Dialog.Description>
				{#if details?.kind === 'folder'}
					Ordner in {[details.mailboxName, ...details.path.slice(0, -1)].join(' › ')}
				{:else if details}
					Postfach{details.address ? ` ${details.address}` : ''}
				{:else}
					Postfach oder Ordner
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		{#if loading}
			<LoadingState label="Lädt …" rows={5} />
		{:else if error || !details}
			<ErrorState
				message={error || 'Nicht gefunden.'}
				onretry={() => {
					if (mailbox) void load(mailbox, folderId);
				}}
				compact
			/>
		{:else}
			<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
				<dt class="text-muted-foreground">Nachrichten</dt>
				<dd class="tabular-nums">
					{count(details.messages)}
					{#if details.folders && details.direct !== details.messages}
						<span class="text-muted-foreground">
							({count(details.direct)}
							{details.kind === 'folder' ? 'direkt im Ordner' : 'im Posteingang'})
						</span>
					{/if}
				</dd>
				<dt class="text-muted-foreground">Ungelesen</dt>
				<dd class="tabular-nums">{count(details.unread)}</dd>
				<dt class="text-muted-foreground">Größe</dt>
				<dd class="tabular-nums">{size(details.size)}</dd>
				<dt class="text-muted-foreground">Anhänge</dt>
				<dd class="tabular-nums">{count(details.attachments)}</dd>
				<dt class="text-muted-foreground">
					{details.kind === 'folder' ? 'Unterordner' : 'Ordner'}
				</dt>
				<dd class="tabular-nums">{count(details.folders)}</dd>
				{#if details.spam !== null}
					<dt class="text-muted-foreground">Spam</dt>
					<dd class="tabular-nums">{count(details.spam)}</dd>
				{/if}
				{#if details.trash !== null}
					<dt class="text-muted-foreground">Papierkorb</dt>
					<dd class="tabular-nums">{count(details.trash)}</dd>
				{/if}
				{#if details.oldest}
					<dt class="text-muted-foreground">Zeitraum</dt>
					<dd class="tabular-nums">
						{formatDateTime(details.oldest)} – {formatDateTime(details.newest)}
					</dd>
				{/if}
				{#if details.createdAt}
					<dt class="text-muted-foreground">Angelegt</dt>
					<dd>
						{formatDateTime(details.createdAt)}{details.createdByName
							? ` von ${details.createdByName}`
							: ''}
					</dd>
				{/if}
				{#if details.access.length}
					<dt class="text-muted-foreground">Zugriff</dt>
					<dd>{details.access.join(', ')}</dd>
				{/if}
			</dl>
			<p class="text-xs text-muted-foreground">
				Ohne Spam und Papierkorb. Größe = Nachrichten samt Anhängen.
			</p>
		{/if}
	</Dialog.Content>
</Dialog.Root>
