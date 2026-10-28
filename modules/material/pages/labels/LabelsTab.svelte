<script lang="ts">
	// Reiter „Etiketten“ (`/modules/material?tab=etiketten`): Kopfzeile mit „Etikettgrößen“ und dem Menü
	// „Erstellen“ (Neues Etikett, Neue Etikettgröße, Leere Codes drucken), darunter alle Etiketten als Kacheln
	// mit Live-Vorschau. Gestaltet wird im Designer `labels/:id`.
	// Rechte: gestalten mit `material.labels.manage`, ansehen/drucken auch mit `material.inventory.manage`.
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import Plus from '@lucide/svelte/icons/plus';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Copy from '@lucide/svelte/icons/copy';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Eye from '@lucide/svelte/icons/eye';
	import Printer from '@lucide/svelte/icons/printer';
	import Ruler from '@lucide/svelte/icons/ruler';
	import Tag from '@lucide/svelte/icons/tag';
	import QrCode from '@lucide/svelte/icons/qr-code';
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
	import BlankCodesDialog from './BlankCodesDialog.svelte';
	import FormatDialog from './FormatDialog.svelte';
	import FormatsDialog from './FormatsDialog.svelte';
	import NewLayoutDialog from './NewLayoutDialog.svelte';
	import { formatSize, sampleValues } from './designer';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canDesign = $derived(can(permissions, PERMISSIONS.labels));
	const canPrint = $derived(canDesign || can(permissions, PERMISSIONS.manage));

	let templates = $state<LabelTemplate[]>([]);
	let formats = $state<LabelFormatEntry[]>([]);
	let loading = $state(true);
	let error = $state('');

	let newOpen = $state(false);
	let newFormatOpen = $state(false);
	let formatsOpen = $state(false);
	let blankOpen = $state(false);
	let confirmOpen = $state(false);
	let toDelete = $state<LabelTemplate | null>(null);
	let printOpen = $state(false);
	let printTarget = $state<LabelTarget>('item');
	let printTemplate = $state<string | undefined>(undefined);
	let printTitle = $state<string | undefined>(undefined);

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
			toast.error(errorText(e, 'Etikettgrößen konnten nicht geladen werden'));
		}
	}

	$effect(() => {
		void load();
	});

	const formatOf = (key: string) => formats.find((f) => f.key === key) ?? null;
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
			toast.success('Etikett dupliziert');
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
			toast.success('Etikett gelöscht');
			await load();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		}
	}

	function testPrint(t: LabelTemplate) {
		printTarget = t.target;
		printTemplate = t.id;
		printTitle = t.name;
		printOpen = true;
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h2 class="text-section">Etiketten</h2>
			<p class="text-sm text-muted-foreground">
				Wie ein Etikett aussieht. Gedruckt wird im Lager je Artikel oder Lagerort – oder hier als
				Testdruck.
			</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<Button variant="outline" onclick={() => (formatsOpen = true)}>
				<Ruler aria-hidden="true" /> Etikettgrößen
			</Button>
			{#if canDesign}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props}>
								<Plus aria-hidden="true" /> Erstellen
								<ChevronDown aria-hidden="true" class="size-3.5" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end">
						<DropdownMenu.Item onSelect={() => (newOpen = true)}>
							<Tag aria-hidden="true" /> Neues Etikett
						</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => (newFormatOpen = true)}>
							<Ruler aria-hidden="true" /> Neue Etikettgröße
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item onSelect={() => (blankOpen = true)}>
							<QrCode aria-hidden="true" /> Leere Codes drucken
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{:else if canPrint}
				<Button variant="outline" onclick={() => (blankOpen = true)}>
					<QrCode aria-hidden="true" /> Leere Codes drucken
				</Button>
			{/if}
		</div>
	</div>

	{#if loading}
		<LoadingState label="Etiketten" rows={3} rowClass="h-40 w-full" />
	{:else if error}
		<ErrorState message={error} onretry={load} />
	{:else if !templates.length}
		<EmptyState
			title="Noch keine Etiketten"
			description="Lege ein Etikett an – zum Beispiel für Kisten, Zeltbahnen, Regalfächer oder Lagerorte. Startvorlagen gibt es für gängige Avery-Zweckform-Bögen und Etikettendrucker."
		>
			{#if canDesign}
				<Button onclick={() => (newOpen = true)}><Plus aria-hidden="true" /> Neues Etikett</Button>
			{/if}
		</EmptyState>
	{:else}
		<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-label="Etiketten">
			{#each templates as t (t.id)}
				{@const fmt = formatOf(t.formatKey)}
				<li>
					<Card.Root class="h-full gap-3 py-3">
						<a
							href={designerHref(t.id)}
							class="mx-3 flex h-36 items-center justify-center rounded-md bg-muted/60 p-2 focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
							aria-label={`${t.name} ${canDesign ? 'bearbeiten' : 'ansehen'}`}
						>
							<LabelPreview
								layout={t.layout}
								values={sampleValues(t.target)}
								maxWidth={240}
								maxHeight={124}
								class="ring-1 ring-border"
							/>
						</a>
						<div class="flex items-start gap-2 px-3">
							<div class="min-w-0 flex-1">
								<h3 class="truncate font-medium">
									<a href={designerHref(t.id)} class="hover:underline">{t.name}</a>
								</h3>
								<p class="truncate text-xs text-muted-foreground">
									{#if fmt}
										<span class="tabular-nums">{formatSize(fmt.format)}</span> · {fmt.name}
									{:else}
										Unbekannte Etikettgröße
									{/if}
								</p>
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
										{#if canDesign}<Pencil aria-hidden="true" /> Öffnen{:else}<Eye
												aria-hidden="true"
											/> Ansehen{/if}
									</DropdownMenu.Item>
									{#if canPrint}
										<DropdownMenu.Item onSelect={() => testPrint(t)}>
											<Printer aria-hidden="true" /> Testdruck
										</DropdownMenu.Item>
									{/if}
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
</div>

<NewLayoutDialog bind:open={newOpen} />
<FormatDialog bind:open={newFormatOpen} entry={null} onsaved={reloadFormats} />
<FormatsDialog bind:open={formatsOpen} {formats} canEdit={canDesign} onchanged={reloadFormats} />
<BlankCodesDialog
	bind:open={blankOpen}
	{templates}
	canReserve={canPrint}
	oncreate={canDesign ? () => (newOpen = true) : undefined}
/>
<PrintLabelsDialog
	bind:open={printOpen}
	target={printTarget}
	templateId={printTemplate}
	title={printTitle}
/>
<ConfirmDialog
	bind:open={confirmOpen}
	title="Etikett löschen?"
	description={toDelete ? `„${toDelete.name}“ wird gelöscht.` : undefined}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
