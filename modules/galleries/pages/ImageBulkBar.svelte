<script lang="ts">
	import LockIcon from '@lucide/svelte/icons/lock';
	import LockOpenIcon from '@lucide/svelte/icons/lock-open';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import { toast } from 'svelte-sonner';
	import { ConfirmDialog, MobileActionBar } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import type { BulkResult } from '../schemas';

	/**
	 * Sammelleiste für ausgewählte Bilder einer Galerie: „Nur intern“ setzen/aufheben, Löschen
	 * (Termine hängen an der Galerie).
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

	async function setPrivate(isPrivate: boolean) {
		busy = true;
		try {
			const r = await apiFetch<BulkResult>(
				`/modules/galleries/galleries/${encodeURIComponent(galleryId)}/images/bulk`,
				{
					method: 'POST',
					body: JSON.stringify({
						action: isPrivate ? 'make-private' : 'make-public',
						ids: selected
					})
				}
			);
			toast.success(
				isPrivate
					? `${imagesLabel(r.affected)} nur intern – nicht auf der Website`
					: `${imagesLabel(r.affected)} wieder mit der Galerie sichtbar`
			);
			ondone();
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Aktion fehlgeschlagen');
		} finally {
			busy = false;
		}
	}

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
	<Button size="sm" variant="outline" disabled={busy} onclick={() => setPrivate(true)}>
		<LockIcon /> Nur intern
	</Button>
	<Button size="sm" variant="outline" disabled={busy} onclick={() => setPrivate(false)}>
		<LockOpenIcon /> Für Website freigeben
	</Button>
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
