<script lang="ts">
	// Dialog „Etikettgrößen“: eigene Größen (bearbeiten/löschen) und Vorgaben (schreibgeschützt).
	// Anlegen/Bearbeiten über `FormatDialog`.
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Lock from '@lucide/svelte/icons/lock';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { labelsPerPage, type LabelFormat } from '$lib/sdk/labels';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { ConfirmDialog } from '$lib/components/layout';
	import type { LabelFormatEntry } from '../../schemas';
	import { API, errorText } from '../helpers';
	import SheetPreview from '../shared/SheetPreview.svelte';
	import FormatDialog from './FormatDialog.svelte';
	import { formatMm, formatSize } from './designer';

	let {
		open = $bindable(false),
		formats,
		canEdit,
		onchanged
	}: {
		open?: boolean;
		formats: LabelFormatEntry[];
		/** Eigene Größen anlegen/bearbeiten/löschen (`material.labels.manage`) */
		canEdit: boolean;
		onchanged: () => void | Promise<void>;
	} = $props();

	let editOpen = $state(false);
	let editing = $state<LabelFormatEntry | null>(null);
	let confirmOpen = $state(false);
	let toDelete = $state<LabelFormatEntry | null>(null);

	const custom = $derived(formats.filter((f) => !f.preset));
	const presets = $derived(formats.filter((f) => f.preset));

	const fmt = formatMm;

	function describe(f: LabelFormat): string {
		return f.kind === 'roll'
			? 'Rolle (Etikettendrucker)'
			: `Bogen ${fmt(f.pageWidthMm)} × ${fmt(f.pageHeightMm)} mm · ${f.cols} × ${f.rows} = ${labelsPerPage(f)} je Seite`;
	}

	function edit(f: LabelFormatEntry | null) {
		editing = f;
		editOpen = true;
	}

	async function remove() {
		const f = toDelete;
		if (!f?.id) return;
		try {
			await apiFetch(`${API}/label-formats/${f.id}`, { method: 'DELETE' });
			toast.success('Etikettgröße gelöscht');
			await onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		}
	}
</script>

{#snippet row(f: LabelFormatEntry)}
	<li class="flex items-center gap-3 py-2">
		<SheetPreview format={f.format} width={40} label={`Skizze ${f.name}`} />
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm font-medium">{f.name}</p>
			<p class="text-xs text-muted-foreground">
				<span class="font-medium text-foreground tabular-nums">{formatSize(f.format)}</span>
				· {describe(f.format)}
			</p>
		</div>
		{#if !f.preset && canEdit}
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={`${f.name} bearbeiten`}
				onclick={() => edit(f)}
			>
				<Pencil />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={`${f.name} löschen`}
				onclick={() => {
					toDelete = f;
					confirmOpen = true;
				}}
			>
				<Trash2 />
			</Button>
		{/if}
	</li>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Etikettgrößen</Dialog.Title>
			<Dialog.Description>
				Etikettenbögen und -rollen. Fehlt deine Größe, lege sie mit den Maßen von der Packung an.
			</Dialog.Description>
		</Dialog.Header>

		<section class="space-y-1" aria-labelledby="formats-own-heading">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h3 id="formats-own-heading" class="text-sm font-semibold">Eigene Größen</h3>
				{#if canEdit}
					<Button variant="outline" size="sm" onclick={() => edit(null)}>
						<Plus aria-hidden="true" /> Neue Etikettgröße
					</Button>
				{/if}
			</div>
			{#if custom.length}
				<ul class="divide-y" aria-labelledby="formats-own-heading">
					{#each custom as f (f.key)}{@render row(f)}{/each}
				</ul>
			{:else}
				<p class="py-2 text-sm text-muted-foreground">Noch keine eigenen Größen.</p>
			{/if}
		</section>

		<section class="space-y-1" aria-labelledby="formats-presets-heading">
			<h3 id="formats-presets-heading" class="flex items-center gap-2 text-sm font-semibold">
				Vorgaben
				<Badge variant="secondary"><Lock aria-hidden="true" class="size-3" /> nur ansehen</Badge>
			</h3>
			<ul class="divide-y" aria-labelledby="formats-presets-heading">
				{#each presets as f (f.key)}{@render row(f)}{/each}
			</ul>
		</section>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Schließen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<FormatDialog bind:open={editOpen} entry={editing} onsaved={() => onchanged()} />
<ConfirmDialog
	bind:open={confirmOpen}
	title="Etikettgröße löschen?"
	description={toDelete
		? `„${toDelete.name}“ wird gelöscht. Nutzt ein Etikett diese Größe, geht das nicht.`
		: undefined}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
