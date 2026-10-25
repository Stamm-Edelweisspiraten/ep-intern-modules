<script lang="ts">
	import { tick } from 'svelte';
	import Check from '@lucide/svelte/icons/check';
	import Folder from '@lucide/svelte/icons/folder';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Search from '@lucide/svelte/icons/search';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { cn } from '$lib/utils';
	import {
		buildFolderTree,
		descendantIds,
		flattenFolderTree,
		folderDepth,
		subtreeHeight
	} from '../folders';
	import { MAX_FOLDER_DEPTH, type MailboxInfo } from '../schemas';

	let {
		open = $bindable(false),
		mailbox,
		title = 'Verschieben nach',
		description,
		current = null,
		movingFolderId = null,
		onpick
	}: {
		open?: boolean;
		mailbox: MailboxInfo | null;
		title?: string;
		description?: string;
		/** Aktueller Ort (Ordner-ID, `null` = Posteingang bzw. oberste Ebene) – als „aktuell“ markiert */
		current?: string | null;
		/** Beim Verschieben eines Ordners: der Ordner selbst (er und seine Unterordner sind kein Ziel) */
		movingFolderId?: string | null;
		/** Gewähltes Ziel: Ordner-ID oder `null` (Posteingang bzw. oberste Ebene) */
		onpick: (folderId: string | null) => void;
	} = $props();

	let search = $state('');
	let searchEl = $state<HTMLInputElement | null>(null);

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			search = '';
			void tick().then(() => searchEl?.focus());
		}
		wasOpen = open;
	});

	const folders = $derived(mailbox?.folders ?? []);
	const excluded = $derived(
		movingFolderId ? new Set([movingFolderId, ...descendantIds(folders, movingFolderId)]) : null
	);
	const height = $derived(movingFolderId ? subtreeHeight(folders, movingFolderId) : 0);
	const entries = $derived(
		flattenFolderTree(buildFolderTree(folders)).filter(({ folder }) => {
			if (excluded?.has(folder.id)) return false;
			// Ordner verschieben: Ziel-Ebene + Höhe des Unterbaums ≤ 3
			if (movingFolderId && folderDepth(folders, folder.id) + height > MAX_FOLDER_DEPTH)
				return false;
			return true;
		})
	);
	const needle = $derived(search.trim().toLowerCase());
	const visible = $derived(
		needle ? entries.filter((e) => e.folder.name.toLowerCase().includes(needle)) : entries
	);
	const rootLabel = $derived(movingFolderId ? 'Oberste Ebene' : 'Posteingang');

	function pick(id: string | null) {
		if (id === current) return;
		open = false;
		onpick(id);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>
				{description ?? `Ordner in „${mailbox?.name ?? ''}“ wählen.`}
			</Dialog.Description>
		</Dialog.Header>
		<div class="relative">
			<Search
				class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
				aria-hidden="true"
			/>
			<Input
				bind:ref={searchEl}
				bind:value={search}
				type="search"
				class="pl-8"
				placeholder="Ordner suchen …"
				aria-label="Ordner suchen"
			/>
		</div>
		<ul class="-mx-2 max-h-80 space-y-0.5 overflow-y-auto" aria-label="Ziele">
			{#if !needle}
				<li>
					<button
						type="button"
						class={cn(
							'focus-ring flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted',
							current === null && 'text-muted-foreground'
						)}
						onclick={() => pick(null)}
						aria-current={current === null ? 'true' : undefined}
					>
						<Inbox class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span class="flex-1">{rootLabel}</span>
						{#if current === null}<Check class="size-4" aria-label="aktuell" />{/if}
					</button>
				</li>
			{/if}
			{#each visible as { folder, depth } (folder.id)}
				<li>
					<button
						type="button"
						class={cn(
							'focus-ring flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted',
							current === folder.id && 'text-muted-foreground'
						)}
						style:padding-left={needle ? undefined : `${0.5 + (depth - 1) * 1.25}rem`}
						onclick={() => pick(folder.id)}
						aria-current={current === folder.id ? 'true' : undefined}
					>
						<Folder class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span class="min-w-0 flex-1 truncate">{folder.name}</span>
						{#if current === folder.id}<Check class="size-4" aria-label="aktuell" />{/if}
					</button>
				</li>
			{:else}
				{#if needle}
					<li class="px-2 py-3 text-sm text-muted-foreground">Kein Ordner gefunden.</li>
				{/if}
			{/each}
		</ul>
		{#if !folders.length && !needle}
			<p class="text-xs text-muted-foreground">
				Noch keine Ordner. Lege links im Postfach mit „Ordner anlegen“ einen an.
			</p>
		{/if}
	</Dialog.Content>
</Dialog.Root>
