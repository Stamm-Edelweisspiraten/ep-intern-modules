<script lang="ts">
	// Scannen: Knopf öffnet einen Dialog mit Kamera (QR, Code 128, DataMatrix – auch von einem Bildschirm)
	// und Eingabefeld; ein USB-Handscanner wird, solange die Komponente angezeigt wird, überall abgehört.
	import { onMount } from 'svelte';
	import ScanLine from '@lucide/svelte/icons/scan-line';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Dialog from '$lib/components/ui/dialog';
	import { BarcodeScanner, listenForScanner } from '$lib/components/layout';

	let {
		onscan,
		label = 'Scannen',
		title = 'Code scannen',
		description = 'Halte den QR-Code oder Strichcode vor die Kamera – auch auf einem Bildschirm. Ein USB-Handscanner funktioniert überall auf der Seite.',
		usb = true,
		closeOnScan = true,
		busy = false,
		variant = 'outline',
		compact = false
	}: {
		/** Gelesener Inhalt (Code oder volle Scan-URL) */
		onscan: (raw: string) => void | Promise<void>;
		label?: string;
		title?: string;
		description?: string;
		/** USB-Handscanner global abhören */
		usb?: boolean;
		/** Dialog nach einem Treffer schließen (sonst weiter scannen) */
		closeOnScan?: boolean;
		/** Während einer Verarbeitung keine neuen Kamera-Scans annehmen */
		busy?: boolean;
		variant?: 'outline' | 'secondary' | 'default' | 'ghost';
		/** Nur das Symbol zeigen (Handy); `label` bleibt der zugängliche Name */
		compact?: boolean;
	} = $props();

	let open = $state(false);
	let value = $state('');

	function handle(raw: string) {
		if (closeOnScan) open = false;
		void onscan(raw);
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const raw = value.trim();
		value = '';
		if (raw) handle(raw);
	}

	onMount(() => {
		if (!usb) return;
		return listenForScanner((code) => {
			value = '';
			handle(code);
		});
	});
</script>

{#if compact}
	<Button
		{variant}
		size="icon"
		class="size-10 shrink-0"
		aria-label={label}
		onclick={() => (open = true)}
	>
		<ScanLine />
	</Button>
{:else}
	<Button {variant} onclick={() => (open = true)}>
		<ScanLine />
		{label}
	</Button>
{/if}

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>{description}</Dialog.Description>
		</Dialog.Header>
		{#if open}
			<BarcodeScanner onscan={handle} paused={busy} class="mx-auto w-full max-w-md" />
		{/if}
		<form class="flex gap-2" onsubmit={submit}>
			<Input
				class="min-w-0 flex-1"
				placeholder="Code eingeben, z. B. M-000123"
				aria-label="Code eingeben"
				autocomplete="off"
				autocapitalize="characters"
				spellcheck={false}
				data-scan-field
				bind:value
			/>
			<Button type="submit" variant="secondary" disabled={!value.trim()}>Übernehmen</Button>
		</form>
	</Dialog.Content>
</Dialog.Root>
