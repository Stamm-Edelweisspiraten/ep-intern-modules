<script lang="ts">
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ImageUp from '@lucide/svelte/icons/image-up';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { ConfirmDialog } from '$lib/components/layout';
	import { cn } from '$lib/utils';
	import {
		IMAGE_ACCEPT,
		IMAGE_CONTENT_TYPES,
		MAX_IMAGE_BYTES,
		MAX_IMAGES_PER_ARTICLE,
		type ArticleImage
	} from '../../schemas';
	import { API as BASE, errorText } from '../helpers';

	function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
		if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
			return [...list];
		}
		const next = [...list];
		const [item] = next.splice(from, 1);
		next.splice(to, 0, item as T);
		return next;
	}

	// Muster: orders/pages/ImageManager.svelte (Modulgrenze: kopiert, nicht importiert)
	/** Bilder eines gespeicherten Artikels: hochladen (nacheinander), sortieren, löschen. Erstes = Titelbild. */
	let {
		articleId,
		images,
		onchange
	}: {
		articleId: string;
		images: ArticleImage[];
		/** Neue Bildliste (nach Upload, Löschen, Sortieren) */
		onchange: (images: ArticleImage[]) => void;
	} = $props();

	let input = $state<HTMLInputElement | null>(null);
	let dragging = $state(false);
	let uploading = $state(false);
	let progress = $state({ done: 0, total: 0 });
	let storageMissing = $state(false);
	let busy = $state(false);

	const full = $derived(images.length >= MAX_IMAGES_PER_ARTICLE);
	const mb = Math.round(MAX_IMAGE_BYTES / 1024 / 1024);

	function precheck(file: File): string | null {
		if (!(IMAGE_CONTENT_TYPES as readonly string[]).includes(file.type))
			return `${file.name}: Dateityp nicht unterstützt (JPEG, PNG, WebP, AVIF oder GIF)`;
		if (file.size === 0) return `${file.name}: Datei ist leer`;
		if (file.size > MAX_IMAGE_BYTES) return `${file.name}: zu groß (höchstens ${mb} MB)`;
		return null;
	}

	async function addFiles(list: FileList | File[] | null | undefined) {
		if (!list || uploading) return;
		const files = Array.from(list);
		if (!files.length) return;
		const room = MAX_IMAGES_PER_ARTICLE - images.length;
		if (room <= 0) {
			toast.error(`Höchstens ${MAX_IMAGES_PER_ARTICLE} Bilder je Artikel`);
			return;
		}
		const ok: File[] = [];
		for (const f of files) {
			const problem = precheck(f);
			if (problem) toast.error(problem);
			else ok.push(f);
		}
		if (ok.length > room) {
			toast.error(`Nur noch ${room} Bild(er) möglich – der Rest wird übersprungen.`);
			ok.length = room;
		}
		if (!ok.length) return;

		uploading = true;
		progress = { done: 0, total: ok.length };
		let current = [...images];
		let failed = 0;
		for (const file of ok) {
			const body = new FormData();
			body.append('file', file, file.name);
			try {
				const img = await apiFetch<ArticleImage>(`${BASE}/articles/${articleId}/images`, {
					method: 'POST',
					body
				});
				current = [...current, img];
				onchange(current);
				storageMissing = false;
			} catch (e) {
				failed++;
				if (e instanceof ApiClientError && e.status === 503) {
					storageMissing = true;
					break;
				}
				toast.error(`${file.name}: ${errorText(e, 'Hochladen fehlgeschlagen')}`);
			} finally {
				progress = { ...progress, done: progress.done + 1 };
			}
		}
		uploading = false;
		const uploaded = ok.length - failed;
		if (uploaded > 0)
			toast.success(uploaded === 1 ? 'Bild hochgeladen' : `${uploaded} Bilder hochgeladen`);
		if (input) input.value = '';
	}

	function ondrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		void addFiles(e.dataTransfer?.files);
	}

	async function move(from: number, to: number) {
		const before = images;
		const next = moveItem(images, from, to);
		onchange(next);
		busy = true;
		try {
			await apiFetch(`${BASE}/articles/${articleId}/images/order`, {
				method: 'PUT',
				body: JSON.stringify({ ids: next.map((i) => i.id) })
			});
		} catch (e) {
			onchange(before);
			toast.error(errorText(e, 'Reihenfolge konnte nicht gespeichert werden'));
		} finally {
			busy = false;
		}
	}

	let deleteTarget = $state<ArticleImage | null>(null);
	let deleteOpen = $state(false);

	async function remove() {
		const img = deleteTarget;
		if (!img) return;
		busy = true;
		try {
			await apiFetch(`${BASE}/articles/${articleId}/images/${img.id}`, { method: 'DELETE' });
			onchange(images.filter((i) => i.id !== img.id));
			toast.success('Bild gelöscht');
		} catch (e) {
			toast.error(errorText(e, 'Bild konnte nicht gelöscht werden'));
		} finally {
			busy = false;
		}
	}
</script>

<div class="space-y-4">
	{#if storageMissing}
		<Alert.Root variant="destructive">
			<Alert.Description>
				Die Dateiablage (S3) ist nicht eingerichtet – Bilder kannst du erst hochladen, wenn eine
				Administrator*in die Dateiablage in den Systemeinstellungen hinterlegt hat.
			</Alert.Description>
		</Alert.Root>
	{/if}

	<div
		role="region"
		aria-label="Bilder hochladen"
		class={cn(
			'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
			dragging ? 'border-link bg-link/5' : 'border-border',
			(full || uploading) && 'opacity-60'
		)}
		ondragover={(e) => {
			e.preventDefault();
			if (!full && !uploading) dragging = true;
		}}
		ondragleave={() => (dragging = false)}
		{ondrop}
	>
		{#if uploading}
			<LoaderCircle class="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
			<p class="text-sm" aria-live="polite">
				Lädt hoch … {progress.done} von {progress.total}
			</p>
		{:else}
			<ImageUp class="size-6 text-muted-foreground" aria-hidden="true" />
			<p class="text-sm">Bilder hierher ziehen oder</p>
			<Button variant="outline" size="sm" disabled={full} onclick={() => input?.click()}>
				Dateien auswählen
			</Button>
			<p class="text-xs text-muted-foreground">
				JPEG, PNG, WebP, AVIF oder GIF, je höchstens {mb} MB · {images.length} von
				{MAX_IMAGES_PER_ARTICLE} Bildern
			</p>
		{/if}
		<input
			bind:this={input}
			type="file"
			class="sr-only"
			tabindex="-1"
			aria-hidden="true"
			multiple
			accept={IMAGE_ACCEPT}
			onchange={(e) => void addFiles(e.currentTarget.files)}
		/>
	</div>

	{#if images.length}
		<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3">
			{#each images as img, i (img.id)}
				<li class="overflow-hidden rounded-lg border bg-card">
					<div class="relative aspect-[4/3] bg-muted">
						<img
							src={img.thumbUrl}
							alt={`Bild ${i + 1}`}
							loading="lazy"
							class="size-full object-cover"
						/>
						{#if i === 0}
							<Badge class="absolute top-2 left-2">Titelbild</Badge>
						{/if}
					</div>
					<div class="flex items-center justify-between gap-1 p-1.5">
						<div class="flex gap-1">
							<Button
								variant="ghost"
								size="icon"
								aria-label={`Bild ${i + 1} nach vorn`}
								disabled={busy || i === 0}
								onclick={() => move(i, i - 1)}
							>
								<ArrowLeft />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								aria-label={`Bild ${i + 1} nach hinten`}
								disabled={busy || i === images.length - 1}
								onclick={() => move(i, i + 1)}
							>
								<ArrowRight />
							</Button>
						</div>
						<Button
							variant="ghost"
							size="icon"
							class="text-destructive hover:text-destructive"
							aria-label={`Bild ${i + 1} löschen`}
							disabled={busy}
							onclick={() => {
								deleteTarget = img;
								deleteOpen = true;
							}}
						>
							<Trash2 />
						</Button>
					</div>
				</li>
			{/each}
		</ul>
		<p class="text-xs text-muted-foreground">
			Das erste Bild ist das Titelbild. Mit den Pfeilen änderst du die Reihenfolge.
		</p>
	{:else if !uploading}
		<p class="text-sm text-muted-foreground">Noch keine Bilder.</p>
	{/if}
</div>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Bild löschen?"
	description="Das Bild wird endgültig entfernt."
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
