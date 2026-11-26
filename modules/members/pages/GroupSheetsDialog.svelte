<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { PdfExportDialog } from '$lib/components/layout';
	import type { ListCatalog, ListSelection } from '$lib/pdf-lists/types';
	import { apiFetch } from '$lib/sdk/client';
	import { downloadPdf } from './download';

	/** Mitgliederliste(n) als PDF (Seite je Gruppe) mit Spaltenauswahl */
	let {
		open = $bindable(false),
		groupIds,
		fileName,
		count
	}: { open?: boolean; groupIds: string[]; fileName: string; count: number } = $props();

	let catalog = $state<ListCatalog | null>(null);
	let busy = $state(false);

	// Der Katalog (inkl. Zusatzfelder) kommt beim ersten Öffnen vom Server
	$effect(() => {
		if (!open || untrack(() => catalog)) return;
		apiFetch<ListCatalog>('/modules/members/members/sheet-columns')
			.then((c) => (catalog = c))
			.catch((e) => {
				toast.error(e instanceof Error ? e.message : 'Spalten konnten nicht geladen werden');
				open = false;
			});
	});

	async function exportSheets(selection: ListSelection) {
		busy = true;
		try {
			await downloadPdf(
				'/api/v1/modules/members/groups/sheets.pdf',
				{ method: 'POST', body: JSON.stringify({ groupIds, selection }) },
				fileName
			);
			toast.success('Mitgliederliste erzeugt');
			open = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'PDF konnte nicht erzeugt werden');
		} finally {
			busy = false;
		}
	}
</script>

{#if catalog}
	<PdfExportDialog
		bind:open
		title="Mitgliederliste der Gruppe(n)"
		{catalog}
		{count}
		storageKey="pdf-list:groups"
		{busy}
		onexport={exportSheets}
	/>
{/if}
