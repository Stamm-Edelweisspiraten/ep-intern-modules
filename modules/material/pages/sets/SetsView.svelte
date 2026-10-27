<script lang="ts">
	// Ansicht „Zelte & Sets“ im Lager: Set-Typen mit Teileliste und je Typ die Sets als Liste mit
	// Vollständigkeit. `openId` (aus `?view=sets&open=`) öffnet ein Set, sobald die Liste geladen ist.
	import { toast } from 'svelte-sonner';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Printer from '@lucide/svelte/icons/printer';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { ConfirmDialog, ErrorState, LoadingState } from '$lib/components/layout';
	import type { Article, MaterialSet, SetTemplate } from '../../schemas';
	import { API, errorText } from '../helpers';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';
	import SetDetailDialog from './SetDetailDialog.svelte';
	import SetDialog from './SetDialog.svelte';
	import SetTemplateDialog from './SetTemplateDialog.svelte';
	import { completenessView, partsText } from './set-helpers';

	let {
		canManage,
		canPrint,
		openId = $bindable(null)
	}: {
		canManage: boolean;
		canPrint: boolean;
		/** Set öffnen (Deep-Link); wird nach dem Öffnen zurückgesetzt */
		openId?: string | null;
	} = $props();

	let templates = $state<SetTemplate[]>([]);
	let sets = $state<MaterialSet[]>([]);
	let articles = $state<Article[]>([]);
	let loading = $state(true);
	let loaded = $state(false);
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
			loaded = true;
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
		void load();
	});

	// Deep-Link: Set öffnen, sobald geladen (auch bei unbekannter ID – das Detail meldet dann den Fehler)
	$effect(() => {
		if (!openId || !loaded) return;
		openDetail(openId);
		openId = null;
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

<div class="space-y-6">
	<div class="flex flex-wrap items-center gap-2">
		<Input
			type="search"
			placeholder="Set filtern"
			aria-label="Sets filtern"
			class="w-full sm:max-w-xs"
			bind:value={search}
		/>
		<div class="flex flex-wrap gap-2 sm:ml-auto">
			{#if canPrint && sets.length}
				<Button variant="ghost" onclick={() => print(filtered.map((s) => s.id))}>
					<Printer aria-hidden="true" /> Etiketten
				</Button>
			{/if}
			{#if canManage}
				<Button variant="ghost" onclick={() => editTemplate(null)}>
					<Plus aria-hidden="true" /> Set-Typ
				</Button>
				<Button variant="outline" onclick={() => newSet(null)} disabled={!templates.length}>
					<Plus aria-hidden="true" /> Neues Set
				</Button>
			{/if}
		</div>
	</div>

	{#if loading && !loaded}
		<LoadingState label="Sets" rows={4} rowClass="h-12 w-full" />
	{:else if error}
		<ErrorState message={error} onretry={load} />
	{:else if !templates.length}
		<div class="border-y py-10 text-center">
			<p class="font-medium">Noch keine Set-Typen</p>
			<p class="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
				Lege zuerst einen Set-Typ an, z. B. „Kohte“ aus 4 Kohtenbahnen und einem Kohtenkreuz. Danach
				stellst du daraus Sets aus konkreten Stücken zusammen.
			</p>
			{#if canManage}
				<Button class="mt-4" variant="outline" onclick={() => editTemplate(null)}>
					<Plus aria-hidden="true" /> Set-Typ anlegen
				</Button>
			{/if}
		</div>
	{:else if !groups.length}
		<p class="py-6 text-sm text-muted-foreground" role="status">Keine Sets gefunden.</p>
	{:else}
		{#each groups as g (g.template.id)}
			<section class="space-y-2" aria-labelledby={`tpl-${g.template.id}`}>
				<div class="flex flex-wrap items-start gap-2">
					<div class="min-w-0 flex-1">
						<h2 id={`tpl-${g.template.id}`} class="text-section">
							{g.template.name}
							<span class="text-sm font-normal text-muted-foreground tabular-nums">
								· {g.template.setCount}
								{g.template.setCount === 1 ? 'Set' : 'Sets'}
							</span>
						</h2>
						<p class="text-sm text-muted-foreground">{partsText(g.template)}</p>
						{#if g.template.description}
							<p class="text-xs text-muted-foreground">{g.template.description}</p>
						{/if}
					</div>
					{#if canManage || (canPrint && g.sets.length)}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="icon"
										aria-label={`Aktionen für Set-Typ ${g.template.name}`}
									>
										<EllipsisVertical />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end">
								{#if canManage}
									<DropdownMenu.Item onSelect={() => newSet(g.template.id)}>
										<Plus aria-hidden="true" /> Set anlegen
									</DropdownMenu.Item>
								{/if}
								{#if canPrint && g.sets.length}
									<DropdownMenu.Item onSelect={() => print(g.sets.map((s) => s.id))}>
										<Printer aria-hidden="true" /> Etiketten für alle
									</DropdownMenu.Item>
								{/if}
								{#if canManage}
									<DropdownMenu.Item onSelect={() => editTemplate(g.template)}>
										<Pencil aria-hidden="true" /> Set-Typ bearbeiten
									</DropdownMenu.Item>
									<DropdownMenu.Separator />
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
								{/if}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/if}
				</div>

				{#if g.sets.length}
					<ul class="divide-y border-y">
						{#each g.sets as s (s.id)}
							{@const view = completenessView(s.completeness)}
							<li>
								<button
									type="button"
									class="focus-ring grid min-h-14 w-full grid-cols-[1fr_auto] items-center gap-x-3 px-1 py-2 text-left hover:bg-muted/50 sm:grid-cols-[minmax(0,1fr)_7rem_6rem_auto]"
									onclick={() => openDetail(s.id)}
								>
									<span class="min-w-0">
										<span class="block truncate font-medium">{s.name}</span>
										<span class="block truncate text-xs text-muted-foreground">
											<span class="font-mono">{s.code}</span>{view.details.length
												? ` · ${view.details.join(' · ')}`
												: ''}{#if s.issuedUnits}<span class="text-warning sm:hidden">
													· {s.issuedUnits} unterwegs</span
												>{/if}
										</span>
									</span>
									<span class="hidden text-right text-sm tabular-nums sm:block">
										{s.units.length}
										{s.units.length === 1 ? 'Stück' : 'Stücke'}
									</span>
									<span class="hidden text-right text-sm text-warning tabular-nums sm:block">
										{s.issuedUnits ? `${s.issuedUnits} unterwegs` : ''}
									</span>
									<Badge variant={view.variant}>{view.label}</Badge>
								</button>
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
