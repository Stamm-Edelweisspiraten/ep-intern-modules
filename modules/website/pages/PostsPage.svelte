<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import Plus from '@lucide/svelte/icons/plus';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import {
		DataTable,
		FormField,
		PageHeader,
		Pagination,
		SearchInput
	} from '$lib/components/layout';
	import { BUSY_SAVE } from '$lib/components/layout/busy';
	import { MAX_POST_TITLE, PERM, type PostDetail, type PostListPage } from '../schemas';
	import WebsiteTabs from './WebsiteTabs.svelte';
	import { BASE, errorText, formatDateTime, postStatusLabel, postStatusVariant } from './helpers';

	const PAGE_SIZE = 25;
	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canWrite = $derived(can(permissions, PERM.postWrite));

	const search = $derived(page.url.searchParams.get('search') ?? '');
	const status = $derived(page.url.searchParams.get('status') ?? 'all');
	const offset = $derived(Math.max(0, Number(page.url.searchParams.get('offset')) || 0));

	let data = $state<PostListPage>({ items: [], total: 0 });
	let loading = $state(true);
	let loadError = $state('');
	let createOpen = $state(false);
	let newTitle = $state('');
	let creating = $state(false);
	let reloadKey = $state(0);

	// Nur Banner/FAQ-Recht → direkt zu den Bannern
	$effect(() => {
		if (!canWrite && can(permissions, PERM.contentManage)) void goto(`${BASE}/banners`, { replaceState: true });
	});

	$effect(() => {
		void reloadKey;
		if (!canWrite) return;
		const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), status });
		if (search) q.set('search', search);
		let stale = false;
		loading = true;
		apiFetch<PostListPage>(`${BASE}/posts?${q}`)
			.then((r) => {
				if (stale) return;
				data = r;
				loadError = '';
			})
			.catch((e) => {
				if (!stale) loadError = errorText(e, 'Laden fehlgeschlagen');
			})
			.finally(() => {
				if (!stale) loading = false;
			});
		return () => {
			stale = true;
		};
	});

	function setStatus(value: string | null) {
		const url = new URL(page.url);
		if (!value || value === 'all') url.searchParams.delete('status');
		else url.searchParams.set('status', value);
		url.searchParams.delete('offset');
		void goto(url, { keepFocus: true, noScroll: true, replaceState: true });
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		if (!newTitle.trim()) return;
		creating = true;
		try {
			const post = await apiFetch<PostDetail>(`${BASE}/posts`, {
				method: 'POST',
				body: JSON.stringify({ title: newTitle.trim() })
			});
			createOpen = false;
			newTitle = '';
			await goto(`${BASE}/posts/${post.id}`);
		} catch (err) {
			toast.error(errorText(err, 'Anlegen fehlgeschlagen'));
		} finally {
			creating = false;
		}
	}
</script>

<div class="space-y-6">
	<PageHeader title="Website" description="Blog-Beiträge für die Stammeswebsite schreiben und veröffentlichen.">
		{#snippet actions()}
			{#if canWrite}
				<Button onclick={() => (createOpen = true)}><Plus /> Beitrag schreiben</Button>
			{/if}
		{/snippet}
	</PageHeader>
	<WebsiteTabs />

	{#if canWrite}
		<DataTable
			caption="Blog-Beiträge"
			mobile="cards"
			{loading}
			error={loadError}
			onretry={() => void reloadKey++}
			empty={!data.items.length}
			emptyTitle="Keine Beiträge gefunden"
			emptyDescription={search || status !== 'all'
				? 'Passe Suche oder Filter an.'
				: 'Schreib den ersten Beitrag – er bleibt Entwurf, bis jemand ihn veröffentlicht.'}
		>
			{#snippet toolbar()}
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
					<SearchInput placeholder="Beitrag suchen …" label="Beiträge suchen" resetParams={['offset']} />
					<SelectField
						label="Status"
						class="sm:w-48"
						value={status}
						onchange={setStatus}
						options={[
							{ value: 'all', label: 'Alle' },
							{ value: 'draft', label: 'Entwürfe' },
							{ value: 'scheduled', label: 'Geplant' },
							{ value: 'published', label: 'Veröffentlicht' }
						]}
					/>
				</div>
			{/snippet}
			{#snippet head()}
				<Table.Row>
					<Table.Head>Titel</Table.Head>
					<Table.Head>Status</Table.Head>
					<Table.Head>Datum</Table.Head>
					<Table.Head>Autor*in</Table.Head>
					<Table.Head>Themen</Table.Head>
				</Table.Row>
			{/snippet}
			{#each data.items as p (p.id)}
				<Table.Row>
					<Table.Cell class="font-medium">
						<a href={`${BASE}/posts/${p.id}`} class="text-link hover:underline">{p.title}</a>
						{#if !p.access.isOwner && p.access.level === 'edit' && !p.access.canPublish}
							<Badge variant="outline" class="ml-1">Mitschreiben</Badge>
						{/if}
					</Table.Cell>
					<Table.Cell>
						<Badge variant={postStatusVariant(p)}>{postStatusLabel(p)}</Badge>
					</Table.Cell>
					<Table.Cell class="whitespace-nowrap tabular-nums">
						{formatDateTime(p.publishedAt ?? p.updatedAt)}
					</Table.Cell>
					<Table.Cell>{p.authorName}</Table.Cell>
					<Table.Cell>
						<div class="flex flex-wrap gap-1">
							{#each p.tags as t (t)}<Badge variant="secondary">{t}</Badge>{/each}
						</div>
					</Table.Cell>
				</Table.Row>
			{/each}
			{#snippet footer()}
				<Pagination total={data.total} limit={PAGE_SIZE} {offset} />
			{/snippet}
		</DataTable>
	{/if}
</div>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Beitrag schreiben</Dialog.Title>
			<Dialog.Description>Der Beitrag startet als Entwurf und ist erst nach dem Veröffentlichen sichtbar.</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={create}>
			<FormField label="Titel" id="post-new-title" required>
				<Input id="post-new-title" bind:value={newTitle} maxlength={MAX_POST_TITLE} />
			</FormField>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (createOpen = false)}>Abbrechen</Button>
				<Button type="submit" disabled={creating || !newTitle.trim()}>
					{creating ? BUSY_SAVE : 'Anlegen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
