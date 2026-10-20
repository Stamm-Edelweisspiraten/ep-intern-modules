<script lang="ts">
	import Camera from '@lucide/svelte/icons/camera';
	import FileText from '@lucide/svelte/icons/file-text';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Trash from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import { MAX_RECEIPT_BYTES, RECEIPT_CONTENT_TYPES } from '../schemas';

	let {
		file = $bindable(null),
		id,
		invalid = false,
		describedBy,
		disabled = false,
		maxBytes = MAX_RECEIPT_BYTES,
		label = 'Beleg'
	}: {
		file?: File | null;
		/** ID des (versteckten) Datei-Eingabefelds – Ziel für `<label for>` und Fokus */
		id: string;
		invalid?: boolean;
		describedBy?: string;
		disabled?: boolean;
		maxBytes?: number;
		/** Zugängliche Bezeichnung für Buttons („Beleg ändern“ …) */
		label?: string;
	} = $props();

	/**
	 * Konkrete Typen statt `image/*`: iOS wandelt HEIC-Fotos dann in JPEG um. Kein `capture`,
	 * damit auf dem Handy Kamera, Galerie und Dateien wählbar bleiben.
	 */
	const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp';

	let input = $state<HTMLInputElement>();
	let localError = $state('');
	let dragging = $state(false);
	let previewUrl = $state<string | null>(null);

	const maxMb = $derived(Math.round(maxBytes / 1024 / 1024));
	const isImage = $derived(!!file && file.type.startsWith('image/'));

	// Vorschau-URL je Bild erzeugen und beim Wechsel/Entfernen/Unmount freigeben
	$effect(() => {
		const f = file;
		if (!f || !f.type.startsWith('image/')) {
			previewUrl = null;
			return;
		}
		const url = URL.createObjectURL(f);
		previewUrl = url;
		return () => URL.revokeObjectURL(url);
	});

	// Von außen geleert (z. B. „Weitere Auslagen einreichen“) → Eingabefeld zurücksetzen
	$effect(() => {
		if (!file && input) input.value = '';
	});

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
	}

	function typeOk(f: File): boolean {
		if ((RECEIPT_CONTENT_TYPES as readonly string[]).includes(f.type)) return true;
		// Manche Systeme liefern keinen MIME-Typ – dann nach Endung (Server prüft Magic-Bytes)
		return !f.type && /\.(pdf|jpe?g|png|webp)$/i.test(f.name);
	}

	function take(f: File | undefined | null) {
		if (!f) return;
		if (!typeOk(f)) {
			localError = 'Bitte ein PDF oder ein Foto (JPEG, PNG oder WebP) wählen.';
			if (input) input.value = '';
			return;
		}
		if (f.size === 0) {
			localError = 'Die Datei ist leer.';
			if (input) input.value = '';
			return;
		}
		if (f.size > maxBytes) {
			localError = `Die Datei ist zu groß (${formatSize(f.size)}, höchstens ${maxMb} MB).`;
			if (input) input.value = '';
			return;
		}
		localError = '';
		file = f;
	}

	function onchange(e: Event & { currentTarget: HTMLInputElement }) {
		take(e.currentTarget.files?.[0]);
	}

	function remove() {
		file = null;
		localError = '';
		if (input) input.value = '';
		input?.focus();
	}

	function ondrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (disabled) return;
		take(e.dataTransfer?.files?.[0]);
	}

	function ondragover(e: DragEvent) {
		e.preventDefault();
		if (!disabled) dragging = true;
	}

	const errorId = $derived(`${id}-pick-error`);
	const hintId = $derived(`${id}-pick-hint`);
	const ariaDescribedBy = $derived(
		[localError ? errorId : hintId, describedBy].filter(Boolean).join(' ') || undefined
	);
</script>

<div class="grid gap-1.5">
	<input
		bind:this={input}
		{id}
		type="file"
		accept={ACCEPT}
		class="peer sr-only"
		{disabled}
		aria-invalid={invalid || !!localError}
		aria-describedby={ariaDescribedBy}
		{onchange}
	/>

	{#if file}
		<div
			class={cn(
				'flex items-center gap-3 rounded-lg border p-2 peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50',
				(invalid || localError) && 'border-destructive'
			)}
		>
			{#if isImage && previewUrl}
				<img
					src={previewUrl}
					alt="Vorschau des Belegs"
					class="bg-muted size-16 shrink-0 rounded-md border object-cover"
				/>
			{:else}
				<div
					class="bg-muted text-muted-foreground flex size-16 shrink-0 items-center justify-center rounded-md border"
					aria-hidden="true"
				>
					<FileText class="size-7" />
				</div>
			{/if}
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-medium" title={file.name}>{file.name}</p>
				<p class="text-muted-foreground text-xs tabular-nums">
					{isImage ? 'Foto' : 'PDF'} · {formatSize(file.size)}
				</p>
				<div class="mt-1 flex flex-wrap gap-1">
					<Button
						type="button"
						size="sm"
						variant="outline"
						{disabled}
						aria-label="{label} ändern"
						onclick={() => input?.click()}
					>
						<RefreshCw /> Ändern
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						{disabled}
						aria-label="{label} entfernen"
						onclick={remove}
					>
						<Trash /> Entfernen
					</Button>
				</div>
			</div>
		</div>
	{:else}
		<label
			for={id}
			class={cn(
				'border-input hover:bg-accent/50 flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors peer-focus-visible:border-ring peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50',
				dragging && 'border-primary bg-primary/5',
				(invalid || localError) && 'border-destructive',
				disabled && 'pointer-events-none opacity-50'
			)}
			{ondragover}
			ondragleave={() => (dragging = false)}
			{ondrop}
		>
			<Camera class="text-muted-foreground size-6" aria-hidden="true" />
			<span class="text-sm font-medium">Beleg auswählen oder Foto aufnehmen</span>
			<span class="text-muted-foreground hidden text-xs sm:inline">
				oder Datei hierher ziehen
			</span>
		</label>
	{/if}

	{#if localError}
		<p id={errorId} role="alert" class="text-destructive text-xs">{localError}</p>
	{:else}
		<p id={hintId} class="text-muted-foreground text-xs">
			PDF, JPEG, PNG oder WebP, höchstens {maxMb} MB.
		</p>
	{/if}
</div>
