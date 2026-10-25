<script lang="ts">
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField } from '$lib/components/layout';
	import { buildFolderTree, flattenFolderTree } from '../folders';
	import {
		MAX_FOLDER_DEPTH,
		MAX_FOLDER_NAME,
		folderName,
		type InboxFolder,
		type MailboxInfo
	} from '../schemas';
	import { BASE, errorText } from './helpers';

	let {
		open = $bindable(false),
		mode,
		mailbox,
		parentId = null,
		folder = null,
		onsaved
	}: {
		open?: boolean;
		/** `create` = neuer Ordner (Ziel wählbar, vorbelegt mit `parentId`), `rename` = `folder` umbenennen */
		mode: 'create' | 'rename';
		mailbox: MailboxInfo | null;
		parentId?: string | null;
		folder?: InboxFolder | null;
		onsaved: (folder: InboxFolder) => void;
	} = $props();

	const fieldId = 'inbox-folder-name';
	const ROOT = '__root__';

	let name = $state('');
	let parent = $state<string>(ROOT);
	let fieldError = $state<string | null>(null);
	let formError = $state<string | null>(null);
	let busy = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);

	const isRename = $derived(mode === 'rename');
	/** Ziele: oberste Ebene + Ordner, unter denen noch eine Ebene Platz hat */
	const parentOptions = $derived([
		{ value: ROOT, label: 'Oberste Ebene' },
		...flattenFolderTree(buildFolderTree(mailbox?.folders ?? []))
			.filter((f) => f.depth < MAX_FOLDER_DEPTH)
			.map((f) => ({ value: f.folder.id, label: `${'– '.repeat(f.depth - 1)}${f.folder.name}` }))
	]);

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			name = isRename ? (folder?.name ?? '') : '';
			parent = parentId ?? ROOT;
			fieldError = null;
			formError = null;
			busy = false;
			void tick().then(() => {
				inputEl?.focus();
				inputEl?.select();
			});
		}
		wasOpen = open;
	});

	function firstIssue(details: unknown): { path: string; message: string } | null {
		const issues = Array.isArray(details)
			? details
			: (details as { issues?: unknown[] } | null)?.issues;
		const first = Array.isArray(issues)
			? (issues[0] as { message?: unknown; path?: unknown } | undefined)
			: undefined;
		if (typeof first?.message !== 'string') return null;
		return { path: Array.isArray(first.path) ? String(first.path[0]) : '', message: first.message };
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy || !mailbox) return;
		fieldError = null;
		formError = null;
		const parsed = folderName.safeParse(name);
		if (!parsed.success) {
			fieldError = parsed.error.issues[0]?.message ?? 'Ungültiger Name';
			inputEl?.focus();
			return;
		}
		if (isRename && folder && parsed.data === folder.name) {
			open = false;
			return;
		}
		busy = true;
		try {
			const saved = isRename
				? await apiFetch<InboxFolder>(`${BASE}/folders/${folder?.id}`, {
						method: 'PATCH',
						body: JSON.stringify({ name: parsed.data })
					})
				: await apiFetch<InboxFolder>(`${BASE}/folders`, {
						method: 'POST',
						body: JSON.stringify({
							mailbox: mailbox.key,
							parentId: parent === ROOT ? null : parent,
							name: parsed.data
						})
					});
			toast.success(isRename ? 'Ordner umbenannt' : 'Ordner angelegt');
			open = false;
			onsaved(saved);
		} catch (err) {
			const issue = err instanceof ApiClientError ? firstIssue(err.details) : null;
			if (err instanceof ApiClientError && err.status === 409) {
				fieldError = err.message;
				inputEl?.focus();
			} else if (issue && issue.path === 'name') {
				fieldError = issue.message;
				inputEl?.focus();
			} else {
				formError = issue?.message ?? errorText(err, 'Speichern fehlgeschlagen');
			}
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>
				{isRename ? 'Ordner umbenennen' : parentId ? 'Unterordner anlegen' : 'Ordner anlegen'}
			</Dialog.Title>
			<Dialog.Description>
				{#if mailbox?.shared}
					Sichtbar für alle mit Zugriff auf „{mailbox.name}“ – ihr sortiert gemeinsam.
				{:else}
					Nur für dich sichtbar.
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<form class="grid gap-4" onsubmit={submit} novalidate>
			<FormField label="Name *" id={fieldId} error={fieldError}>
				<Input
					id={fieldId}
					bind:ref={inputEl}
					bind:value={name}
					maxlength={MAX_FOLDER_NAME}
					autocomplete="off"
					required
					oninput={() => (fieldError = null)}
				/>
			</FormField>
			{#if !isRename}
				<SelectField
					id="inbox-folder-parent"
					label="Ablegen in"
					options={parentOptions}
					value={parent}
					onchange={(v) => (parent = v ?? ROOT)}
				/>
			{/if}
			{#if formError}
				<p role="alert" class="text-sm text-destructive">{formError}</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)} disabled={busy}>
					Abbrechen
				</Button>
				<Button type="submit" disabled={busy}>
					{busy ? 'Speichert …' : isRename ? 'Umbenennen' : 'Anlegen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
