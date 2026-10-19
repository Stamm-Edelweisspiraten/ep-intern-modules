<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import ImageOff from '@lucide/svelte/icons/image-off';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Table from '$lib/components/ui/table';
	import { ConfirmDialog, DataTable } from '$lib/components/layout';
	import type { Article } from '../schemas';
	import ArticleDialog from './ArticleDialog.svelte';
	import { BASE, errorText, formatPriceRange, moveItem } from './helpers';

	let articles = $state<Article[]>([]);
	let loading = $state(true);
	let error = $state('');
	let showArchived = $state(false);
	let search = $state('');

	async function load() {
		loading = !articles.length;
		error = '';
		try {
			articles = await apiFetch<Article[]>(`${BASE}/articles?scope=all`);
		} catch (e) {
			error = errorText(e, 'Artikel konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	onMount(() => void load());

	const archivedCount = $derived(articles.filter((a) => a.archived).length);
	/** Sortierbare Liste: nicht archivierte Artikel in Katalog-Reihenfolge */
	const ordered = $derived(articles.filter((a) => !a.archived));
	const q = $derived(search.trim().toLowerCase());
	const rows = $derived(
		[...ordered, ...(showArchived ? articles.filter((a) => a.archived) : [])].filter(
			(a) => !q || a.title.toLowerCase().includes(q)
		)
	);
	const canSort = $derived(!q);

	function sizes(a: Article): string {
		const list = a.variants.filter((v) => !v.archived);
		return a.hasSizes ? list.map((v) => v.label).join(', ') : '–';
	}

	function stockTotal(a: Article): number | null {
		const list = a.variants.filter((v) => !v.archived && v.stock !== null);
		return list.length ? list.reduce((s, v) => s + (v.stock ?? 0), 0) : null;
	}

	// --- Reihenfolge -----------------------------------------------------------
	let sorting = $state(false);

	async function move(from: number, to: number) {
		const before = articles;
		const next = moveItem(ordered, from, to);
		articles = [...next, ...articles.filter((a) => a.archived)];
		sorting = true;
		try {
			await apiFetch(`${BASE}/articles/order`, {
				method: 'PUT',
				body: JSON.stringify({ ids: next.map((a) => a.id) })
			});
		} catch (e) {
			articles = before;
			toast.error(errorText(e, 'Reihenfolge konnte nicht gespeichert werden'));
		} finally {
			sorting = false;
		}
	}

	// --- Anlegen/Bearbeiten --------------------------------------------------------
	let dialogOpen = $state(false);
	let dialogKey = $state(0);
	let editing = $state<Article | null>(null);
	let dirty = false;

	function openDialog(a: Article | null) {
		editing = a;
		dialogKey++;
		dialogOpen = true;
	}

	function saved(a: Article) {
		dirty = true;
		const i = articles.findIndex((x) => x.id === a.id);
		if (i >= 0) articles[i] = a;
		else articles = [...articles, a];
	}

	function dialogOpenChange(open: boolean) {
		if (!open && dirty) {
			dirty = false;
			void load();
		}
	}

	// --- Aktiv schalten, löschen -----------------------------------------------------
	async function toggleActive(a: Article) {
		try {
			await apiFetch<Article>(`${BASE}/articles/${a.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ active: !a.active })
			});
			toast.success(
				a.active ? `„${a.title}“ ist nicht mehr bestellbar` : `„${a.title}“ ist wieder bestellbar`
			);
			await load();
		} catch (e) {
			toast.error(errorText(e, 'Änderung fehlgeschlagen'));
		}
	}

	let deleteTarget = $state<Article | null>(null);
	let deleteOpen = $state(false);

	async function remove() {
		const a = deleteTarget;
		if (!a) return;
		try {
			const r = await apiFetch<{ deleted: boolean; archived?: boolean }>(
				`${BASE}/articles/${a.id}`,
				{ method: 'DELETE' }
			);
			toast.success(
				r.archived
					? `„${a.title}“ wurde schon bestellt und ist jetzt archiviert`
					: `„${a.title}“ gelöscht`
			);
			await load();
		} catch (e) {
			toast.error(errorText(e, 'Artikel konnte nicht gelöscht werden'));
		}
	}
</script>

<DataTable
	mobile="cards"
	caption="Artikel"
	{loading}
	{error}
	empty={!rows.length}
	emptyTitle={articles.length ? 'Nichts gefunden' : 'Noch keine Artikel'}
	emptyDescription={articles.length
		? 'Kein Artikel passt zur Suche.'
		: 'Lege den ersten Artikel an, z. B. Halstuch oder Liederbuch.'}
>
	{#snippet toolbar()}
		<Input
			class="h-8 w-full sm:max-w-60"
			placeholder="Artikel suchen …"
			aria-label="Artikel durchsuchen"
			bind:value={search}
		/>
		{#if archivedCount}
			<div class="flex items-center gap-2">
				<Checkbox
					id="articles-archived"
					checked={showArchived}
					onCheckedChange={(v) => (showArchived = v === true)}
				/>
				<Label for="articles-archived" class="font-normal">
					Archivierte anzeigen ({archivedCount})
				</Label>
			</div>
		{/if}
		{#if error}
			<Button variant="outline" size="sm" onclick={load}>Erneut versuchen</Button>
		{/if}
		<Button class="sm:ml-auto" size="sm" onclick={() => openDialog(null)}>
			<Plus /> Artikel anlegen
		</Button>
	{/snippet}
	{#snippet emptyAction()}
		{#if !articles.length}
			<Button onclick={() => openDialog(null)}><Plus /> Artikel anlegen</Button>
		{/if}
	{/snippet}
	{#snippet head()}
		<Table.Row>
			<Table.Head class="w-16"><span class="sr-only">Bild</span></Table.Head>
			<Table.Head>Titel</Table.Head>
			<Table.Head>Größen</Table.Head>
			<Table.Head class="text-right">Preis</Table.Head>
			<Table.Head class="text-right">Bestand</Table.Head>
			<Table.Head>Status</Table.Head>
			<Table.Head><span class="sr-only">Aktionen</span></Table.Head>
		</Table.Row>
	{/snippet}
	{#each rows as a (a.id)}
		{@const index = ordered.indexOf(a)}
		{@const stock = stockTotal(a)}
		<Table.Row class="cursor-pointer" onclick={() => openDialog(a)}>
			<Table.Cell>
				<div class="size-10 overflow-hidden rounded-md bg-muted">
					{#if a.cover}
						<img src={a.cover.thumbUrl} alt="" loading="lazy" class="size-full object-cover" />
					{:else}
						<span class="flex size-full items-center justify-center text-muted-foreground">
							<ImageOff class="size-4" aria-hidden="true" />
						</span>
					{/if}
				</div>
			</Table.Cell>
			<Table.Cell class="max-w-72">
				<button
					type="button"
					class="truncate text-left font-medium underline-offset-4 hover:underline"
					onclick={(e) => {
						e.stopPropagation();
						openDialog(a);
					}}
				>
					{a.title}
				</button>
				{#if a.notes}
					<div class="truncate text-xs text-muted-foreground" title={a.notes}>{a.notes}</div>
				{/if}
			</Table.Cell>
			<Table.Cell class="max-w-48">
				<div class="truncate" title={sizes(a)}>{sizes(a)}</div>
			</Table.Cell>
			<Table.Cell class="text-right whitespace-nowrap tabular-nums">
				{formatPriceRange(a.priceMinCents, a.priceMaxCents)}
			</Table.Cell>
			<Table.Cell class="text-right tabular-nums">{stock ?? '–'}</Table.Cell>
			<Table.Cell>
				{#if a.archived}
					<Badge variant="outline">Archiviert</Badge>
				{:else if a.active}
					<Badge variant="secondary">Bestellbar</Badge>
				{:else}
					<Badge variant="outline">Nicht bestellbar</Badge>
				{/if}
			</Table.Cell>
			<Table.Cell class="text-right" onclick={(e: MouseEvent) => e.stopPropagation()}>
				<div class="flex items-center justify-end gap-1">
					{#if !a.archived && canSort}
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`${a.title} nach oben`}
							disabled={sorting || index <= 0}
							onclick={() => move(index, index - 1)}
						>
							<ArrowUp />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`${a.title} nach unten`}
							disabled={sorting || index < 0 || index >= ordered.length - 1}
							onclick={() => move(index, index + 1)}
						>
							<ArrowDown />
						</Button>
					{/if}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon-sm"
									aria-label={`Aktionen für ${a.title}`}
								>
									<Ellipsis />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" class="w-52">
							<DropdownMenu.Item onclick={() => openDialog(a)}>
								<Pencil /> Bearbeiten
							</DropdownMenu.Item>
							{#if !a.archived}
								<DropdownMenu.Item onclick={() => toggleActive(a)}>
									{#if a.active}
										<EyeOff /> Nicht mehr bestellbar
									{:else}
										<Eye /> Wieder bestellbar
									{/if}
								</DropdownMenu.Item>
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									variant="destructive"
									onclick={() => {
										deleteTarget = a;
										deleteOpen = true;
									}}
								>
									<Trash2 /> Löschen
								</DropdownMenu.Item>
							{/if}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</div>
			</Table.Cell>
		</Table.Row>
	{/each}
	{#snippet footer()}
		{#if ordered.length > 1}
			<p class="text-xs text-muted-foreground">
				{canSort
					? 'Mit den Pfeilen legst du die Reihenfolge im Katalog fest.'
					: 'Zum Sortieren die Suche leeren.'}
			</p>
		{/if}
	{/snippet}
</DataTable>

{#key dialogKey}
	<ArticleDialog
		bind:open={
			() => dialogOpen,
			(v) => {
				dialogOpen = v;
				dialogOpenChange(v);
			}
		}
		article={editing}
		onsaved={saved}
	/>
{/key}

<ConfirmDialog
	bind:open={deleteOpen}
	title={`„${deleteTarget?.title ?? ''}“ löschen?`}
	description="Wurde der Artikel schon bestellt, wird er stattdessen archiviert: Er verschwindet aus Katalog und Liste, bestehende Bestellungen und Rechnungen bleiben unverändert."
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
