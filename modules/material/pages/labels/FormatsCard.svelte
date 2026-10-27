<script lang="ts">
	// Etikettenformate: eigene (bearbeiten/löschen) und Vorgaben (nur ansehen).
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { labelsPerPage, type LabelFormat } from '$lib/sdk/labels';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { ConfirmDialog } from '$lib/components/layout';
	import type { LabelFormatEntry } from '../../schemas';
	import { API, errorText } from '../helpers';
	import SheetPreview from '../shared/SheetPreview.svelte';
	import FormatDialog from './FormatDialog.svelte';

	let {
		formats,
		canEdit,
		onchanged
	}: {
		formats: LabelFormatEntry[];
		canEdit: boolean;
		onchanged: () => void | Promise<void>;
	} = $props();

	let dialogOpen = $state(false);
	let editing = $state<LabelFormatEntry | null>(null);
	let confirmOpen = $state(false);
	let toDelete = $state<LabelFormatEntry | null>(null);
	let showPresets = $state(false);

	const custom = $derived(formats.filter((f) => !f.preset));
	const presets = $derived(formats.filter((f) => f.preset));

	function describe(f: LabelFormat): string {
		const size = `${fmt(f.labelWidthMm)} × ${fmt(f.labelHeightMm)} mm`;
		return f.kind === 'roll'
			? `Rolle · ${size}`
			: `Bogen ${fmt(f.pageWidthMm)} × ${fmt(f.pageHeightMm)} mm · ${f.cols} × ${f.rows} = ${labelsPerPage(f)} je Seite · ${size}`;
	}
	const fmt = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 2 });

	function edit(f: LabelFormatEntry | null) {
		editing = f;
		dialogOpen = true;
	}

	async function remove() {
		const f = toDelete;
		if (!f?.id) return;
		try {
			await apiFetch(`${API}/label-formats/${f.id}`, { method: 'DELETE' });
			toast.success('Format gelöscht');
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
			<p class="text-xs text-muted-foreground">{describe(f.format)}</p>
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

<Card.Root>
	<Card.Header>
		<Card.Title>Formate</Card.Title>
		<Card.Description>
			Etikettenbögen und -rollen. Fehlt deines, lege es mit den Maßen von der Packung an.
		</Card.Description>
		{#if canEdit}
			<Card.Action>
				<Button variant="outline" size="sm" onclick={() => edit(null)}>
					<Plus aria-hidden="true" /> Eigenes Format
				</Button>
			</Card.Action>
		{/if}
	</Card.Header>
	<Card.Content class="space-y-3">
		{#if custom.length}
			<ul class="divide-y" aria-label="Eigene Formate">
				{#each custom as f (f.key)}{@render row(f)}{/each}
			</ul>
		{:else}
			<p class="text-sm text-muted-foreground">Noch keine eigenen Formate.</p>
		{/if}
		<div>
			<Button
				variant="ghost"
				size="sm"
				aria-expanded={showPresets}
				onclick={() => (showPresets = !showPresets)}
			>
				<ChevronDown class={showPresets ? 'rotate-180' : ''} aria-hidden="true" />
				Vorgaben ({presets.length})
				<Badge variant="secondary" class="ml-1">nur ansehen</Badge>
			</Button>
			{#if showPresets}
				<ul class="divide-y" aria-label="Vorgaben">
					{#each presets as f (f.key)}{@render row(f)}{/each}
				</ul>
			{/if}
		</div>
	</Card.Content>
</Card.Root>

<FormatDialog bind:open={dialogOpen} entry={editing} onsaved={() => onchanged()} />
<ConfirmDialog
	bind:open={confirmOpen}
	title="Format löschen?"
	description={toDelete
		? `„${toDelete.name}“ wird gelöscht. Nutzt ein Layout dieses Format, geht das nicht.`
		: undefined}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
