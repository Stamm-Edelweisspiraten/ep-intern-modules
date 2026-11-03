<script lang="ts">
	// Ziel der QR-Codes (`/modules/material/scan/<code>`): Code auflösen und ins Lager springen
	// (Artikel → Artikel-Dialog, Lagerort → Filter). Unbekannte Codes zeigen einen Hinweis.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import { EmptyState, LoadingState } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { BASE_PATH } from '../schemas';
	import { errorText } from './helpers';
	import { resolveScan } from './shared/scan';

	let { params }: ModulePageProps = $props();
	let message = $state<string | null>(null);

	onMount(async () => {
		try {
			const target = await resolveScan(decodeURIComponent(params.code ?? ''));
			if (target?.type === 'item') {
				await goto(`${BASE_PATH}?tab=lager&open=${target.id}`, { replaceState: true });
			} else if (target?.type === 'location') {
				await goto(`${BASE_PATH}?tab=lager&location=${target.id}`, { replaceState: true });
			} else if (target?.type === 'food') {
				await goto(`${BASE_PATH}?tab=vorrat&open=${target.id}`, { replaceState: true });
			} else if (target?.type === 'reserved') {
				message = `Der Code ${target.code} ist vergeben, aber noch keinem Artikel zugeordnet. Lege einen Artikel mit diesem Code an.`;
			} else {
				message = 'Diesen Code kennt die Materialverwaltung nicht.';
			}
		} catch (e) {
			message = errorText(e, 'Der Code konnte nicht geprüft werden.');
		}
	});
</script>

{#if message}
	<EmptyState title="Code nicht gefunden" description={message}>
		<Button href={`${BASE_PATH}?tab=lager`}>Zum Lager</Button>
	</EmptyState>
{:else}
	<LoadingState label="Code wird geprüft …" />
{/if}
