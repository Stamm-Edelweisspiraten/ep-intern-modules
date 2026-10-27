<script lang="ts">
	// Artikelliste im Lager: Code, Kategorie, Bestand, unterwegs. Klick öffnet das Artikel-Blatt
	// (Bestand je Ort bzw. Stückliste). Mehrfachauswahl → Etiketten (Ziel `article`, auch für Mengen).
	import { SvelteSet } from 'svelte/reactivity';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Printer from '@lucide/svelte/icons/printer';
	import Tags from '@lucide/svelte/icons/tags';
	import X from '@lucide/svelte/icons/x';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import * as Table from '$lib/components/ui/table';
	import { DataTable, MobileActionBar } from '$lib/components/layout';
	import {
		ARTICLE_KIND_LABELS,
		MAX_LABELS,
		type Article,
		type ArticleKind,
		type Category
	} from '../../schemas';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';

	let {
		articles,
		categories,
		loading,
		error,
		canManage,
		canLabels,
		onretry,
		onopen,
		onedit,
		oncreate,
		oncategories,
		oncreateunits
	}: {
		articles: Article[];
		categories: Category[];
		loading: boolean;
		error: string;
		canManage: boolean;
		canLabels: boolean;
		onretry: () => void | Promise<void>;
		/** Artikel-Blatt öffnen */
		onopen: (article: Article) => void;
		onedit: (article: Article) => void;
		oncreate: () => void;
		oncategories: () => void;
		oncreateunits: (articleId: string) => void;
	} = $props();

	let search = $state('');
	let categoryId = $state<string | null>(null);
	let kind = $state<string | null>(null);
	let showArchived = $state(false);

	const categoryOptions = $derived(categories.map((c) => ({ value: c.id, label: c.name })));
	const kindOptions = (['unit', 'bulk'] as ArticleKind[]).map((k) => ({
		value: k,
		label: ARTICLE_KIND_LABELS[k]
	}));

	const fold = (s: string) =>
		s.toLocaleLowerCase('de').replace(/ß/g, 'ss').normalize('NFD').replace(/\p{M}/gu, '');
	const visible = $derived.by(() => {
		const q = fold(search.trim());
		return articles.filter(
			(a) =>
				(showArchived || !a.archived) &&
				(!categoryId || a.categoryId === categoryId) &&
				(!kind || a.kind === kind) &&
				(!q || fold(`${a.name} ${a.code} ${a.categoryName ?? ''}`).includes(q))
		);
	});
	const filtered = $derived(!!search.trim() || !!categoryId || !!kind);

	function resetFilters() {
		search = '';
		categoryId = null;
		kind = null;
	}

	// --- Auswahl → Etiketten ---
	const selected = new SvelteSet<string>();
	const selectedIds = $derived(visible.filter((a) => selected.has(a.id)).map((a) => a.id));
	const allSelected = $derived(visible.length > 0 && visible.every((a) => selected.has(a.id)));
	function toggleAll(on: boolean) {
		if (on) for (const a of visible.slice(0, MAX_LABELS)) selected.add(a.id);
		else selected.clear();
	}
	function toggle(id: string, on: boolean) {
		if (on) selected.add(id);
		else selected.delete(id);
	}

	let printOpen = $state(false);
	let printIds = $state<string[]>([]);
	function print(ids: string[]) {
		printIds = ids;
		printOpen = true;
	}

	function stockText(a: Article): string {
		return a.kind === 'unit'
			? `${a.usableCount.toLocaleString('de-DE')}`
			: `${a.stockTotal.toLocaleString('de-DE')}`;
	}
</script>

<div class="space-y-3 {selectedIds.length ? 'pb-20 sm:pb-0' : ''}">
	{#if canLabels}
		<MobileActionBar
			show={selectedIds.length > 0}
			label="Sammelaktionen"
			class="sm:w-full sm:rounded-md sm:border sm:px-3 sm:py-2"
		>
			<span class="text-sm font-medium" aria-live="polite">{selectedIds.length} ausgewählt</span>
			<Button size="sm" variant="outline" onclick={() => print(selectedIds)}>
				<Printer /> Etiketten
			</Button>
			<Button size="sm" variant="ghost" onclick={() => selected.clear()}>
				<X /> Auswahl aufheben
			</Button>
		</MobileActionBar>
	{/if}

	<DataTable
		caption="Artikel"
		mobile="cards"
		{loading}
		{error}
		{onretry}
		empty={!visible.length}
		emptyTitle={filtered ? 'Keine passenden Artikel' : 'Noch keine Artikel'}
		emptyDescription={filtered
			? 'Passe Suche oder Filter an.'
			: 'Ein Artikel beschreibt eine Art Material – z. B. „Kohtenbahn“ (Einzelstücke) oder „Tasse“ (Menge).'}
	>
		{#snippet toolbar()}
			<Input
				type="search"
				class="w-full sm:w-56"
				placeholder="Name oder Code"
				aria-label="Artikel filtern"
				bind:value={search}
			/>
			<SelectField
				options={categoryOptions}
				bind:value={categoryId}
				label="Kategorie"
				emptyLabel="Alle Kategorien"
				placeholder="Alle Kategorien"
				class="w-full sm:w-44"
			/>
			<SelectField
				options={kindOptions}
				bind:value={kind}
				label="Art"
				emptyLabel="Alle Arten"
				placeholder="Alle Arten"
				class="w-full sm:w-40"
			/>
			<div class="flex min-h-9 items-center gap-2">
				<Switch id="articles-archived" bind:checked={showArchived} />
				<Label for="articles-archived" class="font-normal">Archivierte</Label>
			</div>
			{#if canManage}
				<div class="flex gap-2 sm:ml-auto">
					<Button variant="ghost" onclick={oncategories}><Tags /> Kategorien</Button>
					<Button variant="outline" onclick={oncreate}><Plus /> Artikel</Button>
				</div>
			{/if}
		{/snippet}
		{#snippet emptyAction()}
			{#if filtered}
				<Button variant="outline" onclick={resetFilters}><X /> Filter zurücksetzen</Button>
			{:else if canManage}
				<Button variant="outline" onclick={oncreate}><Plus /> Artikel anlegen</Button>
			{/if}
		{/snippet}
		{#snippet head()}
			<Table.Row class="hover:bg-transparent">
				{#if canLabels}
					<Table.Head class="w-10">
						<Checkbox
							checked={allSelected}
							onCheckedChange={(v) => toggleAll(v === true)}
							aria-label="Alle sichtbaren Artikel auswählen"
						/>
					</Table.Head>
				{/if}
				<Table.Head class="text-xs font-normal text-muted-foreground">Artikel</Table.Head>
				<Table.Head class="text-xs font-normal text-muted-foreground">Code</Table.Head>
				<Table.Head class="text-xs font-normal text-muted-foreground">Kategorie</Table.Head>
				<Table.Head class="text-right text-xs font-normal text-muted-foreground">Bestand</Table.Head
				>
				<Table.Head class="text-right text-xs font-normal text-muted-foreground"
					>Unterwegs</Table.Head
				>
				<Table.Head class="w-12"><span class="sr-only">Aktionen</span></Table.Head>
			</Table.Row>
		{/snippet}
		{#each visible as a (a.id)}
			{@const low = a.kind === 'bulk' && a.minQuantity > 0 && a.stockTotal < a.minQuantity}
			<Table.Row
				class="sm:h-14 cursor-pointer"
				data-state={selected.has(a.id) ? 'selected' : undefined}
				onclick={() => onopen(a)}
			>
				{#if canLabels}
					<Table.Cell onclick={(e) => e.stopPropagation()}>
						<Checkbox
							checked={selected.has(a.id)}
							onCheckedChange={(v) => toggle(a.id, v === true)}
							aria-label={`${a.name} auswählen`}
						/>
					</Table.Cell>
				{/if}
				<Table.Cell>
					<span class="font-medium">{a.name}</span>
					<span class="block text-xs text-muted-foreground">
						{ARTICLE_KIND_LABELS[a.kind]}{a.archived ? ' · archiviert' : ''}
					</span>
				</Table.Cell>
				<Table.Cell class="font-mono text-xs">{a.code}</Table.Cell>
				<Table.Cell>
					{#if a.categoryName}
						<span class="inline-flex items-center gap-1.5">
							<span
								class="size-2 rounded-full"
								style:background-color={a.categoryColor ?? 'var(--muted-foreground)'}
								aria-hidden="true"
							></span>
							{a.categoryName}
						</span>
					{:else}
						<span class="text-muted-foreground">–</span>
					{/if}
				</Table.Cell>
				<Table.Cell class="text-right tabular-nums">
					{stockText(a)}
					<span class="text-muted-foreground">{a.unitLabel}</span>
					{#if a.kind === 'unit' && a.usableCount !== a.unitCount}
						<span class="block text-xs text-muted-foreground">von {a.unitCount} nutzbar</span>
					{:else if low}
						<Badge variant="warning" class="ml-1">unter {a.minQuantity}</Badge>
					{/if}
				</Table.Cell>
				<Table.Cell class="text-right tabular-nums">
					{#if a.issuedCount}{a.issuedCount}{:else}<span class="text-muted-foreground">–</span>{/if}
				</Table.Cell>
				<Table.Cell class="text-right" onclick={(e) => e.stopPropagation()}>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon"
									aria-label={`Aktionen für ${a.name}`}
								>
									<EllipsisVertical />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end">
							<DropdownMenu.Item onclick={() => onopen(a)}>
								{a.kind === 'bulk' ? 'Bestand je Ort' : 'Stücke zeigen'}
							</DropdownMenu.Item>
							{#if canManage && a.kind === 'unit' && !a.archived}
								<DropdownMenu.Item onclick={() => oncreateunits(a.id)}>
									<Plus /> Stücke erfassen
								</DropdownMenu.Item>
							{/if}
							{#if canLabels}
								<DropdownMenu.Item onclick={() => print([a.id])}>
									<Printer /> Etikett drucken
								</DropdownMenu.Item>
							{/if}
							{#if canManage}
								<DropdownMenu.Item onclick={() => onedit(a)}>
									<Pencil /> Bearbeiten
								</DropdownMenu.Item>
							{/if}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</Table.Cell>
			</Table.Row>
		{/each}
	</DataTable>
</div>

<PrintLabelsDialog bind:open={printOpen} target="article" ids={printIds} />
