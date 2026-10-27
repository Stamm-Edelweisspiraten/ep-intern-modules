<script lang="ts">
	// Inhalt der Seite „Etiketten“ (`/modules/material/etiketten`): Layouts (Mini-Vorschau,
	// neu/bearbeiten/duplizieren/löschen, Probedruck), Formate und Leer-Etiketten.
	// Gestaltet wird im Designer `labels/:id`.
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Copy from '@lucide/svelte/icons/copy';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Eye from '@lucide/svelte/icons/eye';
	import Printer from '@lucide/svelte/icons/printer';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import { toast } from 'svelte-sonner';
	import { apiFetch, can } from '$lib/sdk/client';
	import * as Card from '$lib/components/ui/card';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { ConfirmDialog, EmptyState, ErrorState, LoadingState } from '$lib/components/layout';
	import {
		BASE_PATH,
		LABEL_TARGET_LABELS,
		PERMISSIONS,
		type LabelFormatEntry,
		type LabelTarget,
		type LabelTemplate
	} from '../../schemas';
	import { API, errorText, formatDate } from '../helpers';
	import LabelPreview from '../shared/LabelPreview.svelte';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';
	import BlankCodesCard from './BlankCodesCard.svelte';
	import FormatsCard from './FormatsCard.svelte';
	import NewLayoutDialog from './NewLayoutDialog.svelte';
	import { sampleValues } from './designer';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canDesign = $derived(can(permissions, PERMISSIONS.labels));
	const canManage = $derived(can(permissions, PERMISSIONS.manage));

	let templates = $state<LabelTemplate[]>([]);
	let formats = $state<LabelFormatEntry[]>([]);
	let loading = $state(true);
	let error = $state('');
	let newOpen = $state(false);
	let confirmOpen = $state(false);
	let toDelete = $state<LabelTemplate | null>(null);
	let printOpen = $state(false);
	let printTarget = $state<LabelTarget>('unit');
	let printTemplate = $state<string | undefined>(undefined);

	async function load() {
		loading = true;
		error = '';
		try {
			[templates, formats] = await Promise.all([
				apiFetch<LabelTemplate[]>(`${API}/label-templates`),
				apiFetch<LabelFormatEntry[]>(`${API}/label-formats`)
			]);
		} catch (e) {
			error = errorText(e, 'Etiketten konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	async function reloadFormats() {
		try {
			formats = await apiFetch<LabelFormatEntry[]>(`${API}/label-formats`);
		} catch (e) {
			toast.error(errorText(e, 'Formate konnten nicht geladen werden'));
		}
	}

	$effect(() => {
		void load();
	});

	const formatName = (key: string) =>
		formats.find((f) => f.key === key)?.name ?? 'Unbekanntes Format';
	const designerHref = (id: string) => `${BASE_PATH}/labels/${id}`;

	async function duplicate(t: LabelTemplate) {
		try {
			const copy = await apiFetch<LabelTemplate>(`${API}/label-templates`, {
				method: 'POST',
				body: JSON.stringify({
					name: `${t.name} (Kopie)`.slice(0, 150),
					target: t.target,
					layout: t.layout,
					formatKey: t.formatKey
				})
			});
			toast.success('Layout dupliziert');
			await load();
			await goto(designerHref(copy.id));
		} catch (e) {
			toast.error(errorText(e, 'Duplizieren fehlgeschlagen'));
		}
	}

	async function remove() {
		const t = toDelete;
		if (!t) return;
		try {
			await apiFetch(`${API}/label-templates/${t.id}`, { method: 'DELETE' });
			toast.success('Layout gelöscht');
			await load();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		}
	}

	function testPrint(t: LabelTemplate) {
		printTarget = t.target;
		printTemplate = t.id;
		printOpen = true;
	}
</script>

<div class="space-y-6">
	<section class="space-y-3" aria-labelledby="label-layouts-heading">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div>
				<h2 id="label-layouts-heading" class="text-section">Layouts</h2>
				<p class="text-sm text-muted-foreground">
					Wie ein Etikett aussieht. Gedruckt wird im
					<a class="text-link underline-offset-4 hover:underline" href={`${BASE_PATH}/lager`}
						>Lager</a
					>
					bei Stücken, Kisten, Artikeln, Sets und Lagerorten – oder hier als Probedruck.
				</p>
			</div>
			{#if canDesign}
				<Button onclick={() => (newOpen = true)}><Plus aria-hidden="true" /> Neues Layout</Button>
			{/if}
		</div>

		{#if loading}
			<LoadingState label="Layouts" rows={3} rowClass="h-24 w-full" />
		{:else if error}
			<ErrorState message={error} onretry={load} />
		{:else if !templates.length}
			<EmptyState
				title="Noch keine Etikett-Layouts"
				description="Lege ein Layout an – zum Beispiel für Kisten, Zeltbahnen, Regalfächer oder Lagerorte. Startvorlagen gibt es für gängige Avery-Zweckform-Bögen."
			>
				{#if canDesign}
					<Button onclick={() => (newOpen = true)}><Plus aria-hidden="true" /> Neues Layout</Button>
				{/if}
			</EmptyState>
		{:else}
			<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each templates as t (t.id)}
					<li>
						<Card.Root class="h-full gap-3 py-3">
							<a
								href={designerHref(t.id)}
								class="mx-3 flex h-32 items-center justify-center rounded-md bg-muted/60 p-2 focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
								aria-label={`${t.name} ${canDesign ? 'bearbeiten' : 'ansehen'}`}
							>
								<LabelPreview
									layout={t.layout}
									values={sampleValues(t.target)}
									maxWidth={240}
									maxHeight={112}
									class="ring-1 ring-border"
								/>
							</a>
							<div class="flex items-start gap-2 px-3">
								<div class="min-w-0 flex-1">
									<h3 class="truncate font-medium">
										<a href={designerHref(t.id)} class="hover:underline">{t.name}</a>
									</h3>
									<p class="truncate text-xs text-muted-foreground">{formatName(t.formatKey)}</p>
									<div class="mt-1 flex flex-wrap items-center gap-1">
										<Badge variant="secondary">{LABEL_TARGET_LABELS[t.target]}</Badge>
										<span class="text-xs text-muted-foreground">
											geändert {formatDate(t.updatedAt)}
										</span>
									</div>
								</div>
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button
												{...props}
												variant="ghost"
												size="icon-sm"
												aria-label={`Aktionen für ${t.name}`}
											>
												<EllipsisVertical />
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end">
										<DropdownMenu.Item onSelect={() => goto(designerHref(t.id))}>
											{#if canDesign}<Pencil aria-hidden="true" /> Bearbeiten{:else}<Eye
													aria-hidden="true"
												/> Ansehen{/if}
										</DropdownMenu.Item>
										<DropdownMenu.Item onSelect={() => testPrint(t)}>
											<Printer aria-hidden="true" /> Probedruck
										</DropdownMenu.Item>
										{#if canDesign}
											<DropdownMenu.Item onSelect={() => duplicate(t)}>
												<Copy aria-hidden="true" /> Duplizieren
											</DropdownMenu.Item>
											<DropdownMenu.Separator />
											<DropdownMenu.Item
												variant="destructive"
												onSelect={() => {
													toDelete = t;
													confirmOpen = true;
												}}
											>
												<Trash2 aria-hidden="true" /> Löschen
											</DropdownMenu.Item>
										{/if}
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</div>
						</Card.Root>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if !loading && !error}
		<div class="grid gap-4 lg:grid-cols-2">
			<FormatsCard {formats} canEdit={canDesign} onchanged={reloadFormats} />
			<BlankCodesCard {templates} canReserve={canManage} />
		</div>
	{/if}
</div>

<NewLayoutDialog bind:open={newOpen} />
<PrintLabelsDialog bind:open={printOpen} target={printTarget} templateId={printTemplate} />
<ConfirmDialog
	bind:open={confirmOpen}
	title="Layout löschen?"
	description={toDelete ? `„${toDelete.name}“ wird gelöscht.` : undefined}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
