<script lang="ts">
	// VERTRAG (Welle 0) – Props nicht ändern; Implementierung: Welle 4.1.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import FolderTree from '@lucide/svelte/icons/folder-tree';
	import Info from '@lucide/svelte/icons/info';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { PRINCIPAL_TYPE_LABELS, type PrincipalInfo } from '$lib/sdk/types/sharing';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { SharePanel } from '$lib/components/layout';
	import type { ShareCandidate, ShareEntry } from '$lib/components/layout';
	import { shareKey } from '$lib/components/layout/share-types';
	import {
		SHARE_LEVELS,
		SHARE_LEVEL_LABELS,
		type FileNode,
		type NodeShare,
		type NodeShares,
		type ShareLevel
	} from '../schemas';
	import { API, errorText } from './helpers';

	let {
		open = $bindable(false),
		node,
		onchanged
	}: {
		open?: boolean;
		node: FileNode | null;
		onchanged: () => void;
	} = $props();

	const EVERYONE_LABEL = 'Stamm';
	const LEVELS = SHARE_LEVELS.map((value) => ({ value, label: SHARE_LEVEL_LABELS[value] }));

	let data = $state<NodeShares | null>(null);
	let loading = $state(false);
	let loadError = $state('');
	let seq = 0;

	const canManage = $derived(!!node?.canShare);
	const isFolder = $derived(node?.kind === 'folder');
	const sharesUrl = $derived(node ? `${API}/nodes/${encodeURIComponent(node.id)}/shares` : '');
	const entries = $derived<ShareEntry[]>((data?.shares ?? []).map(toEntry));
	const owner = $derived(
		node && node.space === 'personal' && node.createdBy && node.createdBy.id === node.ownerId
			? { name: node.createdBy.name }
			: undefined
	);

	// Beim Öffnen (bzw. Wechsel des Knotens) Freigaben laden
	$effect(() => {
		if (!open || !node) return;
		const id = node.id;
		untrack(() => void load(id));
	});

	function toEntry(s: NodeShare): ShareEntry {
		return {
			userId: s.id,
			type: s.type,
			name: s.name,
			detail: s.detail ?? null,
			color: s.color ?? null,
			image: s.image ?? null,
			level: s.level
		};
	}

	async function load(id: string) {
		const mine = ++seq;
		loading = true;
		loadError = '';
		data = null;
		try {
			const r = await apiFetch<NodeShares>(`${API}/nodes/${encodeURIComponent(id)}/shares`);
			if (mine === seq) data = r;
		} catch (e) {
			if (mine === seq) loadError = errorText(e, 'Freigaben konnten nicht geladen werden.');
		} finally {
			if (mine === seq) loading = false;
		}
	}

	async function searchPrincipals(q: string): Promise<ShareCandidate[]> {
		const found = await apiFetch<PrincipalInfo[]>(`${API}/principals?q=${encodeURIComponent(q)}`);
		return found.map((p) => ({
			id: p.id,
			type: p.type,
			name: p.name,
			detail: p.detail ?? null,
			color: p.color ?? null,
			image: p.image ?? null
		}));
	}

	type Issue = { path?: PropertyKey[]; message?: string };

	/** Erste Feldmeldung aus den 422-Details (Pfad `shares.<i>.id`) mit Namen des Ziels */
	function validationText(details: unknown, list: ShareEntry[]): string | null {
		let issues: Issue[] = [];
		if (Array.isArray(details)) issues = details as Issue[];
		else if (Array.isArray((details as { issues?: Issue[] } | null)?.issues)) {
			issues = (details as { issues: Issue[] }).issues;
		} else if (details && typeof details === 'object') {
			issues = Object.entries(details as Record<string, unknown>).map(([k, v]) => ({
				path: k.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
				message: Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : ''
			}));
		}
		for (const i of issues) {
			if (!i.message) continue;
			const index = i.path?.[1];
			const target = typeof index === 'number' ? list[index] : undefined;
			return target ? `„${target.name}“: ${i.message}` : i.message;
		}
		return null;
	}

	async function save(next: ShareEntry[]) {
		if (!node) return;
		const body = {
			shares: next.map((s) => ({
				type: s.type ?? 'user',
				id: s.userId,
				level: s.level as ShareLevel
			}))
		};
		try {
			data = await apiFetch<NodeShares>(sharesUrl, { method: 'PUT', body: JSON.stringify(body) });
		} catch (e) {
			if (e instanceof ApiClientError && e.status === 404) {
				// Zugriff verloren (z. B. eigene Freigabe entfernt) oder Eintrag gelöscht
				toast.error(errorText(e, 'Eintrag nicht gefunden'));
				open = false;
				onchanged();
				return;
			}
			const msg =
				e instanceof ApiClientError && e.status === 422
					? (validationText(e.details, next) ?? errorText(e, 'Ungültige Freigabe'))
					: errorText(e, 'Freigabe konnte nicht gespeichert werden.');
			toast.error(msg);
			// SharePanel zeigt die Meldung zusätzlich direkt im Dialog an
			throw new Error(msg, { cause: e });
		}
		toast.success('Freigabe gespeichert');
		onchanged();
	}

	async function addShare(c: ShareCandidate, level: string) {
		const entry: ShareEntry = {
			userId: c.id,
			type: c.type ?? 'user',
			name: c.name,
			detail: c.detail ?? null,
			color: c.color ?? null,
			image: c.image ?? null,
			level
		};
		if (entries.some((s) => shareKey(s) === shareKey(entry))) return;
		await save([...entries, entry]);
	}

	async function changeShare(key: string, level: string) {
		await save(entries.map((s) => (shareKey(s) === key ? { ...s, level } : s)));
	}

	async function removeShare(key: string) {
		await save(entries.filter((s) => shareKey(s) !== key));
	}

	const levelLabel = (l: ShareLevel) => SHARE_LEVEL_LABELS[l] ?? l;
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
		<Dialog.Header class="border-b p-4 pr-12">
			<Dialog.Title class="break-words">„{node?.name ?? ''}“ freigeben</Dialog.Title>
			<Dialog.Description>
				{isFolder
					? 'Wer diesen Ordner und alle Inhalte sehen oder bearbeiten darf.'
					: 'Wer diese Datei sehen oder bearbeiten darf.'}
			</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4">
			{#if loading}
				<div class="space-y-3" aria-busy="true" aria-label="Freigaben werden geladen">
					<Skeleton class="h-9 w-full" />
					<Skeleton class="h-12 w-full" />
					<Skeleton class="h-12 w-full" />
				</div>
			{:else if loadError}
				<div class="space-y-3 rounded-lg border border-destructive/40 p-4" role="alert">
					<p class="text-sm text-destructive">{loadError}</p>
					<Button variant="outline" size="sm" onclick={() => node && load(node.id)}>
						Erneut versuchen
					</Button>
				</div>
			{:else if data}
				<section class="space-y-3" aria-labelledby="files-share-own">
					<h3 id="files-share-own" class="sr-only">Freigaben</h3>
					{#if !canManage}
						<p class="text-xs text-muted-foreground">
							Nur Ansicht – du darfst die Freigaben dieses Eintrags nicht ändern.
						</p>
					{/if}
					<SharePanel
						shares={entries}
						{owner}
						levels={LEVELS}
						defaultLevel="read"
						{canManage}
						everyoneLabel={EVERYONE_LABEL}
						placeholder="Name, Gruppe, Rolle oder Mitglied suchen …"
						searchLabel="Freigabe hinzufügen"
						emptyResultText="Niemand gefunden"
						search={searchPrincipals}
						onadd={addShare}
						onchange={changeShare}
						onremove={removeShare}
					/>
					<p class="flex gap-2 text-xs text-muted-foreground">
						<Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						<span>
							„{EVERYONE_LABEL}“ heißt: alle angemeldeten Mitglieder des Stammes mit eigenem Konto.
							{#if isFolder}
								Freigaben an Ordnern gelten für alle enthaltenen Ordner und Dateien.
							{/if}
						</span>
					</p>
				</section>

				{#if data.inherited.length > 0}
					<section class="space-y-2" aria-labelledby="files-share-inherited">
						<div>
							<h3 id="files-share-inherited" class="text-sm font-semibold">Geerbte Freigaben</h3>
							<p class="text-xs text-muted-foreground">
								Freigaben an übergeordneten Ordnern gelten für alle Inhalte. Ändern lassen sie sich
								nur am jeweiligen Ordner.
							</p>
						</div>
						<ul class="divide-y rounded-lg border">
							{#each data.inherited as s (`${s.fromId}:${s.type}:${s.id}`)}
								<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-center gap-2">
											<span class="truncate font-medium">{s.name}</span>
											<Badge variant="outline" class="text-xs font-normal">
												{PRINCIPAL_TYPE_LABELS[s.type] ?? s.type}
											</Badge>
										</div>
										<p class="flex items-center gap-1 text-xs text-muted-foreground">
											<FolderTree class="size-3 shrink-0" aria-hidden="true" />
											<span class="truncate">Geerbt von „{s.fromName}“</span>
										</p>
									</div>
									<Badge variant="secondary">{levelLabel(s.level)}</Badge>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			{/if}
		</div>

		<Dialog.Footer class="mx-0 mb-0">
			<Button type="button" variant="outline" onclick={() => (open = false)}>Schließen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
