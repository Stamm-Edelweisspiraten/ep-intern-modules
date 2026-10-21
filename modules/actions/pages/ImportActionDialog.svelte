<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import Loader from '@lucide/svelte/icons/loader-circle';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { FileField } from '$lib/components/layout';

	type ImportResult = {
		id: string;
		name: string;
		counts: {
			participants: number;
			entries: number;
			receipts: number;
			payees: number;
			formFields: number;
		};
		warnings: string[];
	};

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const MAX_BYTES = 100 * 1024 * 1024;

	let file = $state<File | null>(null);
	let busy = $state(false);
	let error = $state('');
	let result = $state<ImportResult | null>(null);
	let fieldKey = $state(0);

	$effect(() => {
		// `reset()` liest und schreibt `fieldKey` – ohne `untrack` löst sich der Effekt endlos selbst aus
		// (`effect_update_depth_exceeded`, Aktionsliste blieb im Ladezustand)
		if (!open && !busy) untrack(reset);
	});

	function reset() {
		file = null;
		error = '';
		result = null;
		fieldKey++;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!file || busy) return;
		busy = true;
		error = '';
		try {
			const fd = new FormData();
			fd.append('file', file);
			result = await apiFetch<ImportResult>('/modules/actions/actions/import', {
				method: 'POST',
				body: fd
			});
		} catch (err) {
			error = err instanceof ApiClientError ? err.message : 'Import fehlgeschlagen';
		} finally {
			busy = false;
		}
	}

	function openAction() {
		if (!result) return;
		const id = result.id;
		open = false;
		goto(`/modules/actions/${id}`);
	}

	const countRows = $derived(
		result
			? [
					['Teilnehmende', result.counts.participants],
					['Buchungen', result.counts.entries],
					['Belege', result.counts.receipts],
					['Empfänger*innen', result.counts.payees],
					['Formularfelder', result.counts.formFields]
				]
			: []
	);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Aktion importieren</Dialog.Title>
			<Dialog.Description>
				ZIP-Datei einer exportierten Aktion. Es wird immer eine neue Aktion angelegt – mit neuem
				Anmeldelink (deaktiviert) und dir als Besitzer*in.
			</Dialog.Description>
		</Dialog.Header>

		{#if result}
			<div class="grid gap-3" aria-live="polite">
				<p class="text-sm">
					<strong>{result.name}</strong> wurde importiert.
				</p>
				<ul class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
					{#each countRows as [label, n] (label)}
						<li class="flex justify-between gap-2 border-b py-1">
							<span class="text-muted-foreground">{label}</span><span>{n}</span>
						</li>
					{/each}
				</ul>
				{#if result.warnings.length}
					<div class="rounded-md border border-warning-border bg-warning-muted p-3 text-sm">
						<p class="font-medium">Hinweise</p>
						<ul class="mt-1 list-disc pl-5">
							{#each result.warnings as w (w)}<li>{w}</li>{/each}
						</ul>
					</div>
				{/if}
			</div>
			<Dialog.Footer>
				<Button variant="outline" onclick={reset}>Weitere importieren</Button>
				<Button onclick={openAction}>Aktion öffnen</Button>
			</Dialog.Footer>
		{:else}
			<form class="grid gap-4" onsubmit={submit}>
				{#key fieldKey}
					<FileField
						id="import-action-file"
						bind:file
						accept=".zip,application/zip"
						maxBytes={MAX_BYTES}
						disabled={busy}
					/>
				{/key}
				{#if error}
					<p role="alert" class="text-sm text-destructive">{error}</p>
				{/if}
				<Dialog.Footer>
					<Button type="button" variant="outline" disabled={busy} onclick={() => (open = false)}>
						Abbrechen
					</Button>
					<Button type="submit" disabled={!file || busy}>
						{#if busy}<Loader class="animate-spin" /> Importiert …{:else}Importieren{/if}
					</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
