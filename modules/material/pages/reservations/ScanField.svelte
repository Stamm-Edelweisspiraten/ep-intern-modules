<script lang="ts">
	// Eingabe für Codes: Textfeld (Code oder Scan-URL), USB-Handscanner (global) und Kamera auf Knopfdruck.
	import { onMount } from 'svelte';
	import Camera from '@lucide/svelte/icons/camera';
	import CameraOff from '@lucide/svelte/icons/camera-off';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { BarcodeScanner, listenForScanner } from '$lib/components/layout';

	let {
		onscan,
		busy = false,
		id = 'scan-code',
		label = 'Code eingeben oder scannen',
		camera = $bindable(false),
		usb = true
	}: {
		/** Gelesener Inhalt (Code oder volle Scan-URL) */
		onscan: (raw: string) => void | Promise<void>;
		/** Während einer Buchung keine neuen Kamera-Scans annehmen */
		busy?: boolean;
		id?: string;
		label?: string;
		/** Kamera eingeschaltet */
		camera?: boolean;
		/** USB-Handscanner global abhören */
		usb?: boolean;
	} = $props();

	let value = $state('');

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const raw = value.trim();
		value = '';
		if (raw) void onscan(raw);
	}

	onMount(() => {
		if (!usb) return;
		return listenForScanner((code) => {
			// Tippt der Scanner in dieses Feld, landen die Zeichen dort – leeren
			value = '';
			void onscan(code);
		});
	});
</script>

<div class="space-y-2">
	<form class="flex gap-2" onsubmit={submit}>
		<Input
			{id}
			class="min-w-0 flex-1"
			placeholder="Code, z. B. M-000123"
			aria-label={label}
			autocomplete="off"
			autocapitalize="characters"
			spellcheck={false}
			data-scan-field
			bind:value
		/>
		<Button type="submit" variant="secondary" disabled={!value.trim()}>Suchen</Button>
		<Button
			type="button"
			variant="outline"
			size="icon"
			aria-pressed={camera}
			aria-label={camera ? 'Kamera ausschalten' : 'Mit Kamera scannen'}
			onclick={() => (camera = !camera)}
		>
			{#if camera}<CameraOff />{:else}<Camera />{/if}
		</Button>
	</form>
	{#if camera}
		<BarcodeScanner onscan={(c) => void onscan(c)} paused={busy} class="mx-auto max-w-md" />
	{/if}
	{#if usb}
		<p class="text-xs text-muted-foreground">
			USB-Handscanner funktionieren überall auf der Seite – einfach scannen.
		</p>
	{/if}
</div>
