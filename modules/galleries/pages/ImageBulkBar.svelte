<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { ConfirmDialog, MobileActionBar } from '$lib/components/layout';
	import type { BulkResult } from '../schemas';

	/**
	 * Sammelleiste für ausgewählte Bilder einer Galerie: Löschen (Termine hängen an der Galerie).
	 * Mobil unten fixiert (`MobileActionBar`, Seite braucht Platz unten), ab `sm` unten sticky.
	 */
	let {
		galleryId,
		selected,
		onclear,
		ondone
	}: {
		galleryId: string;
		selected: string[];
		onclear: () => void;
		ondone: () => void;
	} = $props();

	let deleteOpen = $state(false);
	let busy = $state(false);

	const count = $derived(selected.length);
	const imagesLabel = (n: number) => (n === 1 ? '1 Bild' : `${n} Bilder`);

	async function remove() {
		busy = true;
		try {
			// Router antwortet auf POST mit 201 – apiFetch prüft nur `ok`
			const r = await apiFetch<BulkResult>(
				`/modules/galleries/galleries/${encodeURIComponent(galleryId)}/images/bulk`,
				{ method: 'POST', body: JSON.stringify({ action: 'delete', ids: selected }) }
			);
			toast.success(`${imagesLabel(r.affected)} gelöscht`);
			ondone();
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Löschen fehlgeschlagen');
		} finally {
			busy = false;
		}
	}
</script>

<MobileActionBar
	show={count > 0}
	label="Sammelaktionen für Bilder"
	class="sm:bg-background/95 sm:sticky sm:bottom-4 sm:z-30 sm:w-full sm:rounded-md sm:border sm:px-3 sm:py-2 sm:shadow-sm sm:backdrop-blur"
>
	<span class="text-sm font-medium" aria-live="polite">{count} ausgewählt</span>
	<Button size="sm" variant="destructive" disabled={busy} onclick={() => (deleteOpen = true)}>
		<Trash2 /> Löschen
	</Button>
	<Button size="sm" variant="ghost" class="ml-auto" disabled={busy} onclick={onclear}>
		<X /> Auswahl aufheben
	</Button>
</MobileActionBar>

<ConfirmDialog
	bind:open={deleteOpen}
	title={`${imagesLabel(count)} löschen?`}
	description={`${count === 1 ? 'Das ausgewählte Bild wird' : `Die ${count} ausgewählten Bilder werden`} unwiderruflich gelöscht.`}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
