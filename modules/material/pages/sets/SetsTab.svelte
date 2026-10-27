<script lang="ts">
	// Reiter „Zelte & Sets“: Set-Typen (Vorlagen) mit Teileliste und die Sets je Typ mit
	// Vollständigkeits-Ampel. `?open=<setId>` öffnet ein Set.
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { tick } from 'svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Printer from '@lucide/svelte/icons/printer';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Tent from '@lucide/svelte/icons/tent';
	import { toast } from 'svelte-sonner';
	import { apiFetch, can } from '$lib/sdk/client';
	import * as Card from '$lib/components/ui/card';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { ConfirmDialog, EmptyState, ErrorState, LoadingState } from '$lib/components/layout';
	import { PERMISSIONS, type Article, type MaterialSet, type SetTemplate } from '../../schemas';
	import { API, errorText } from '../helpers';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';
	import SetDetailDialog from './SetDetailDialog.svelte';
	import SetDialog from './SetDialog.svelte';
	import SetTemplateDialog from './SetTemplateDialog.svelte';
	import { completenessView, partsText } from './set-helpers';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canManage = $derived(can(permissions, PERMISSIONS.manage));
	const canPrint = $derived(canManage || can(permissions, PERMISSIONS.labels));

	let templates = $state<SetTemplate[]>([]);
	let sets = $state<MaterialSet[]>([]);
	let articles = $state<Article[]>([]);
	let loading = $state(true);
	let error = $state('');
	let search = $state('');

	let templateDialog = $state(false);
	let editingTemplate = $state<SetTemplate | null>(null);
	let deleteTemplateOpen = $state(false);
	let templateToDelete = $state<SetTemplate | null>(null);

	let setDialog = $state(false);
	let editingSet = $state<MaterialSet | null>(null);
	let newSetTemplate = $state<string | null>(null);

	let detailOpen = $state(false);
	let detailId = $state<string | null>(null);

	let printOpen = $state(false);
	let printIds = $state<string[]>([]);

	async function load() {
		loading = true;
		error = '';
		try {
			[templates, sets] = await Promise.all([
				apiFetch<SetTemplate[]>(`${API}/set-templates`),
				apiFetch<MaterialSet[]>(`${API}/sets`)
			]);
		} catch (e) {
			error = errorText(e, 'Sets konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	async function loadArticles() {
		try {
			articles = await apiFetch<Article[]>(`${API}/articles?kind=unit`);
		} catch {
			articles = [];
		}
	}

	let started = false;
	$effect(() => {
		if (started) return;
		started = true;
		void (async () => {
			await load();
			const open = page.url.searchParams.get('open');
			if (open) {
				if (sets.some((s) => s.id === open)) openDetail(open);
				await tick();
				const url = new URL(page.url);
				url.searchParams.delete('open');
				replaceState(url, {});
			}
		})();
	});

	const fold = (s: string) =>
		s.toLocaleLowerCase('de').replace(/ß/g, 'ss').normalize('NFD').replace(/\p{M}/gu, '');
	const filtered = $derived.by(() => {
		const q = fold(search.trim());
		if (!q) return sets;
		return sets.filter((s) => fold(`${s.name} ${s.code} ${s.templateName}`).includes(q));
	});
	const groups = $derived(
		templates
			.map((t) => ({ template: t, sets: filtered.filter((s) => s.templateId === t.id) }))
			.filter((g) => !search.trim() || g.sets.length)
	);

	function openDetail(id: string) {
		detailId = id;
		detailOpen = true;
	}

	async function editTemplate(t: SetTemplate | null) {
		editingTemplate = t;
		if (!articles.length) await loadArticles();
		templateDialog = true;
	}

	async function removeTemplate() {
		const t = templateToDelete;
		if (!t) return;
		try {
			await apiFetch(`${API}/set-templates/${t.id}`, { method: 'DELETE' });
			toast.success('Set-Typ gelöscht');
			await load();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		}
	}

	function newSet(templateId: string | null) {
		editingSet = null;
		newSetTemplate = templateId;
		setDialog = true;
	}

	function editSet(s: MaterialSet) {
		detailOpen = false;
		editingSet = s;
		setDialog = true;
	}

	async function onSetSaved(s: MaterialSet) {
		await load();
		openDetail(s.id);
	}

	function print(ids: string[]) {
		printIds = ids;
		printOpen = true;
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center gap-2">
		<Input
			type="search"
			placeholder="Set suchen …"
			aria-label="Sets suchen"
			class="max-w-xs"
			bind:value={search}
		/>
		<div class="ml-auto flex flex-wrap gap-2">
			{#if canPrint && sets.length}
				<Button variant="outline" onclick={() => print(filtered.map((s) => s.id))}>
					<Printer aria-hidden="true" /> Etiketten
				</Button>
			{/if}
			{#if canManage}
				<Button variant="outline" onclick={() => editTemplate(null)}>
					<Plus aria-hidden="true" /> Set-Typ
				</Button>
				<Button onclick={() => newSet(null)} disabled={!templates.length}>
					<Plus aria-hidden="true" /> Neues Set
				</Button>
			{/if}
		</div>
	</div>

	{#if loading}
		<LoadingState label="Sets" rows={3} rowClass="h-32 w-full" />
	{:else if error}
		<ErrorState message={error} onretry={load} />
	{:else if !templates.length}
		<EmptyState
			title="Noch keine Set-Typen"
			description="Lege zuerst einen Set-Typ an, z. B. „Kohte“ aus 4 Kohtenbahnen und einem Kohtenkreuz. Danach stellst du daraus Sets aus konkreten Stücken zusammen."
		>
			{#if canManage}
				<Button onclick={() => editTemplate(null)}
					><Plus aria-hidden="true" /> Set-Typ anlegen</Button
				>
			{/if}
		</EmptyState>
	{:else if !groups.length}
		<p class="text-sm text-muted-foreground">Keine Sets gefunden.</p>
	{:else}
		{#each groups as g (g.template.id)}
			<section class="space-y-3" aria-labelledby={`tpl-${g.template.id}`}>
				<div class="flex flex-wrap items-start gap-2">
					<div class="min-w-0 flex-1">
						<h2 id={`tpl-${g.template.id}`} class="text-section flex items-center gap-2">
							<Tent class="size-4 text-muted-foreground" aria-hidden="true" />
							{g.template.name}
							<span class="text-sm font-normal text-muted-foreground tabular-nums">
								({g.template.setCount})
							</span>
						</h2>
						<p class="text-sm text-muted-foreground">{partsText(g.template)}</p>
						{#if g.template.description}
							<p class="text-xs text-muted-foreground">{g.template.description}</p>
						{/if}
					</div>
					<div class="flex items-center gap-1">
						{#if canPrint && g.sets.length}
							<Button
								variant="ghost"
								size="sm"
								onclick={() => print(g.sets.map((s) => s.id))}
								aria-label={`Etiketten für alle Sets „${g.template.name}“`}
							>
								<Printer aria-hidden="true" /> <span class="hidden sm:inline">Etiketten</span>
							</Button>
						{/if}
						{#if canManage}
							<Button variant="outline" size="sm" onclick={() => newSet(g.template.id)}>
								<Plus aria-hidden="true" /> Set
							</Button>
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon-sm"
											aria-label={`Aktionen für Set-Typ ${g.template.name}`}
										>
											<EllipsisVertical />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									<DropdownMenu.Item onSelect={() => editTemplate(g.template)}>
										<Pencil aria-hidden="true" /> Set-Typ bearbeiten
									</DropdownMenu.Item>
									<DropdownMenu.Item
										variant="destructive"
										disabled={g.template.setCount > 0}
										onSelect={() => {
											templateToDelete = g.template;
											deleteTemplateOpen = true;
										}}
									>
										<Trash2 aria-hidden="true" />
										{g.template.setCount > 0 ? 'Löschen (erst Sets auflösen)' : 'Set-Typ löschen'}
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					</div>
				</div>

				{#if g.sets.length}
					<ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{#each g.sets as s (s.id)}
							{@const view = completenessView(s.completeness)}
							<li>
								<Card.Root class="h-full py-0">
									<button
										type="button"
										class="flex h-full w-full flex-col gap-2 rounded-xl p-4 text-left transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
										onclick={() => openDetail(s.id)}
									>
										<span class="flex w-full items-start gap-2">
											<span class="min-w-0 flex-1">
												<span class="block truncate font-medium">{s.name}</span>
												<span class="block text-xs text-muted-foreground tabular-nums"
													>{s.code}</span
												>
											</span>
											<Badge variant={view.variant}>{view.label}</Badge>
										</span>
										{#if view.details.length}
											<span class="text-xs text-muted-foreground">{view.details.join(' · ')}</span>
										{/if}
										<span class="mt-auto flex flex-wrap gap-x-3 text-xs text-muted-foreground">
											<span class="tabular-nums">
												{s.units.length}
												{s.units.length === 1 ? 'Stück' : 'Stücke'}
											</span>
											{#if s.issuedUnits}
												<span class="text-warning tabular-nums">{s.issuedUnits} ausgegeben</span>
											{/if}
										</span>
									</button>
								</Card.Root>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">Noch keine Sets dieses Typs.</p>
				{/if}
			</section>
		{/each}
	{/if}
</div>

<SetTemplateDialog
	bind:open={templateDialog}
	template={editingTemplate}
	{articles}
	onsaved={() => load()}
/>
<SetDialog
	bind:open={setDialog}
	set={editingSet}
	{templates}
	templateId={newSetTemplate}
	onsaved={onSetSaved}
/>
<SetDetailDialog
	bind:open={detailOpen}
	setId={detailId}
	{canManage}
	{canPrint}
	onedit={editSet}
	onprint={(s) => print([s.id])}
	onchanged={load}
/>
<PrintLabelsDialog bind:open={printOpen} target="set" ids={printIds} />
<ConfirmDialog
	bind:open={deleteTemplateOpen}
	title="Set-Typ löschen?"
	description={templateToDelete ? `„${templateToDelete.name}“ wird gelöscht.` : undefined}
	confirmLabel="Löschen"
	destructive
	onconfirm={removeTemplate}
/>
