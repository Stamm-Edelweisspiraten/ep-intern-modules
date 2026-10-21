<script lang="ts">
	import { toast } from 'svelte-sonner';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Clock from '@lucide/svelte/icons/clock';
	import ImageUp from '@lucide/svelte/icons/image-up';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import X from '@lucide/svelte/icons/x';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import {
		IMAGE_ACCEPT,
		IMAGE_CONTENT_TYPES,
		MAX_IMAGE_BYTES,
		UPLOAD_CONCURRENCY,
		type GalleryImage
	} from '../schemas';

	let {
		galleryId,
		disabled = false,
		onuploaded
	}: { galleryId: string; disabled?: boolean; onuploaded: () => void } = $props();

	type Status = 'waiting' | 'uploading' | 'done' | 'error';
	interface Item {
		key: string;
		file: File;
		name: string;
		size: number;
		status: Status;
		message: string;
		/** Fehler der Vorprüfung: erneuter Versuch sinnlos */
		rejected: boolean;
	}

	const STATUS_LABELS: Record<Status, string> = {
		waiting: 'Wartet',
		uploading: 'Lädt hoch …',
		done: 'Fertig',
		error: 'Fehler'
	};
	/** Zwischendurch neu laden, damit Bilder schon während langer Uploads erscheinen */
	const REFRESH_EVERY = 5;

	let items = $state<Item[]>([]);
	let active = $state(0);
	let dragging = $state(false);
	let input = $state<HTMLInputElement | null>(null);
	let batch = { ok: 0, failed: 0, rejected: 0, sinceRefresh: 0 };

	const finished = $derived(items.filter((i) => i.status === 'done' || i.status === 'error'));
	const failed = $derived(items.filter((i) => i.status === 'error'));
	const retryable = $derived(failed.filter((i) => !i.rejected));
	const busy = $derived(items.some((i) => i.status === 'waiting' || i.status === 'uploading'));
	const percent = $derived(items.length ? Math.round((finished.length / items.length) * 100) : 0);

	function formatSize(bytes: number): string {
		if (bytes >= 1024 * 1024) {
			return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
		}
		return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('de-DE')} KB`;
	}

	/** Vorprüfung im Browser (der Server prüft den Inhalt zusätzlich) */
	function precheck(file: File): string | null {
		if (!(IMAGE_CONTENT_TYPES as readonly string[]).includes(file.type)) {
			return 'Dateityp nicht unterstützt (JPEG, PNG, WebP, AVIF oder GIF)';
		}
		if (file.size === 0) return 'Datei ist leer';
		if (file.size > MAX_IMAGE_BYTES) {
			return `Datei ist zu groß (höchstens ${formatSize(MAX_IMAGE_BYTES)})`;
		}
		return null;
	}

	function addFiles(list: FileList | File[] | null | undefined) {
		if (disabled || !list) return;
		const files = Array.from(list);
		if (!files.length) return;
		const added: Item[] = files.map((file) => {
			const problem = precheck(file);
			return {
				key: crypto.randomUUID(),
				file,
				name: file.name || 'Unbenannt',
				size: file.size,
				status: problem ? 'error' : 'waiting',
				message: problem ?? '',
				rejected: !!problem
			};
		});
		if (!busy) batch = { ok: 0, failed: 0, rejected: 0, sinceRefresh: 0 };
		batch.rejected += added.filter((i) => i.rejected).length;
		items = [...items, ...added];
		pump();
		// Nur abgelehnte Dateien: es läuft nichts, Ergebnis sofort melden
		if (!busy) finishBatch();
	}

	function errorMessage(e: unknown): string {
		if (e instanceof ApiClientError) {
			if (e.status === 503) return 'Dateispeicher nicht eingerichtet';
			if (e.status === 413) return 'Datei ist zu groß';
			return e.message || 'Hochladen fehlgeschlagen';
		}
		return 'Netzwerkfehler – Hochladen fehlgeschlagen';
	}

	function pump() {
		while (active < UPLOAD_CONCURRENCY) {
			const next = items.find((i) => i.status === 'waiting');
			if (!next) break;
			next.status = 'uploading';
			active++;
			void upload(next);
		}
	}

	async function upload(item: Item) {
		const body = new FormData();
		body.append('file', item.file, item.name);
		try {
			await apiFetch<GalleryImage>(`/modules/galleries/galleries/${galleryId}/images`, {
				method: 'POST',
				body
			});
			item.status = 'done';
			item.message = '';
			batch.ok++;
			batch.sinceRefresh++;
		} catch (e) {
			item.status = 'error';
			item.message = errorMessage(e);
			batch.failed++;
		} finally {
			active--;
		}
		if (batch.sinceRefresh >= REFRESH_EVERY && busyAfter()) {
			batch.sinceRefresh = 0;
			onuploaded();
		}
		pump();
		if (active === 0 && !items.some((i) => i.status === 'waiting')) finishBatch();
	}

	function busyAfter() {
		return items.some((i) => i.status === 'waiting' || i.status === 'uploading');
	}

	function finishBatch() {
		const { ok, failed, rejected } = batch;
		batch = { ok: 0, failed: 0, rejected: 0, sinceRefresh: 0 };
		if (ok > 0) onuploaded();
		const bad = failed + rejected;
		// Vorprüfung (Typ/Größe) getrennt nennen: „fehlgeschlagen“ nur für Serverfehler
		const parts = [
			failed > 0 && `${failed} fehlgeschlagen`,
			rejected > 0 && (rejected === 1 ? '1 Datei abgelehnt' : `${rejected} Dateien abgelehnt`)
		].filter(Boolean);
		if (ok > 0 && bad === 0) {
			toast.success(ok === 1 ? '1 Bild hochgeladen' : `${ok} Bilder hochgeladen`);
		} else if (ok > 0) {
			toast.warning(`${ok} hochgeladen, ${parts.join(', ')}`);
		} else if (failed === 1 && rejected === 0) {
			toast.error('Bild konnte nicht hochgeladen werden');
		} else if (bad > 0) {
			toast.error(parts.join(', '));
		}
	}

	function retryFailed() {
		if (!retryable.length) return;
		if (!busy) batch = { ok: 0, failed: 0, rejected: 0, sinceRefresh: 0 };
		for (const i of retryable) {
			i.status = 'waiting';
			i.message = '';
		}
		pump();
	}

	function clearFinished() {
		items = items.filter((i) => i.status === 'waiting' || i.status === 'uploading');
	}

	function removeItem(key: string) {
		items = items.filter((i) => i.key !== key || i.status === 'uploading');
	}

	function onDragOver(e: DragEvent) {
		if (disabled || !e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
		dragging = true;
	}
	function onDragLeave(e: DragEvent) {
		const next = e.relatedTarget as Node | null;
		if (next && (e.currentTarget as HTMLElement).contains(next)) return;
		dragging = false;
	}
	function onDrop(e: DragEvent) {
		if (disabled) return;
		e.preventDefault();
		dragging = false;
		addFiles(e.dataTransfer?.files);
	}
	function onPick(e: Event) {
		const el = e.currentTarget as HTMLInputElement;
		addFiles(el.files);
		el.value = '';
	}
</script>

<div class="space-y-3">
	<div
		role="group"
		aria-label="Bilder hochladen"
		aria-disabled={disabled}
		class={[
			'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors',
			dragging ? 'border-primary bg-primary/5' : 'border-border',
			disabled && 'opacity-60'
		]}
		ondragenter={onDragOver}
		ondragover={onDragOver}
		ondragleave={onDragLeave}
		ondrop={onDrop}
	>
		<ImageUp class="size-8 text-muted-foreground" aria-hidden="true" />
		<p class="text-sm">
			<span class="hidden sm:inline">Bilder hierher ziehen oder</span>
			<span class="sm:hidden">Bilder vom Gerät hinzufügen</span>
		</p>
		<Button type="button" variant="outline" {disabled} onclick={() => input?.click()}>
			<ImageUp /> Bilder auswählen
		</Button>
		<p class="text-xs text-muted-foreground">
			JPEG, PNG, WebP, AVIF oder GIF, je Datei höchstens {formatSize(MAX_IMAGE_BYTES)}
		</p>
		<input
			bind:this={input}
			type="file"
			multiple
			accept={IMAGE_ACCEPT}
			class="sr-only"
			tabindex="-1"
			aria-hidden="true"
			{disabled}
			onchange={onPick}
		/>
	</div>

	{#if items.length > 0}
		<div class="space-y-2 rounded-lg border p-3">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<p class="text-sm font-medium" aria-live="polite">
					{#if busy}
						Lädt hoch … {finished.length} von {items.length}
					{:else if failed.length}
						{items.length - failed.length} von {items.length} hochgeladen, {failed.length} mit Fehler
					{:else}
						{items.length === 1 ? '1 Bild hochgeladen' : `${items.length} Bilder hochgeladen`}
					{/if}
				</p>
				<div class="flex flex-wrap gap-2">
					{#if retryable.length > 0}
						<Button type="button" size="sm" variant="outline" onclick={retryFailed}>
							<RotateCcw /> Erneut versuchen
						</Button>
					{/if}
					{#if finished.length > 0}
						<Button type="button" size="sm" variant="ghost" onclick={clearFinished}>
							Liste leeren
						</Button>
					{/if}
				</div>
			</div>
			<div
				class="h-2 w-full overflow-hidden rounded-full bg-muted"
				role="progressbar"
				aria-label="Gesamtfortschritt"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent}
			>
				<div
					class={['h-full transition-all', retryable.length ? 'bg-warning' : 'bg-primary']}
					style="width: {percent}%"
				></div>
			</div>
			<ul class="max-h-64 space-y-1 overflow-y-auto" aria-label="Hochgeladene Dateien">
				{#each items as item (item.key)}
					<li class="flex min-h-9 items-center gap-2 rounded-md px-1 text-sm">
						{#if item.status === 'waiting'}
							<Clock class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						{:else if item.status === 'uploading'}
							<LoaderCircle class="size-4 shrink-0 animate-spin text-link" aria-hidden="true" />
						{:else if item.status === 'done'}
							<CircleCheck class="size-4 shrink-0 text-success" aria-hidden="true" />
						{:else}
							<CircleAlert class="size-4 shrink-0 text-destructive" aria-hidden="true" />
						{/if}
						<div class="min-w-0 flex-1">
							<p class="truncate" title={item.name}>{item.name}</p>
							{#if item.status === 'error'}
								<p class="text-xs text-destructive">{item.message}</p>
							{/if}
						</div>
						<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
							<span class="hidden sm:inline">{formatSize(item.size)} · </span>
							{STATUS_LABELS[item.status]}
						</span>
						{#if item.status === 'uploading'}
							<span class="size-7 shrink-0" aria-hidden="true"></span>
						{:else}
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label="{item.name} aus der Liste entfernen"
								onclick={() => removeItem(item.key)}
							>
								<X />
							</Button>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
