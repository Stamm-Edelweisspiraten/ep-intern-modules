<script lang="ts">
	import { toast } from 'svelte-sonner';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import XIcon from '@lucide/svelte/icons/x';
	import StarIcon from '@lucide/svelte/icons/star';
	import StarOffIcon from '@lucide/svelte/icons/star-off';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Label } from '$lib/components/ui/label';
	import { ConfirmDialog } from '$lib/components/layout';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { imageUpdateInput, imageUrl, MAX_IMAGE_DESCRIPTION, type GalleryImage } from '../schemas';

	let {
		open = $bindable(false),
		index = $bindable(0),
		galleryId,
		images,
		coverImageId,
		coverIsDefault,
		canEdit,
		onchanged
	}: {
		open?: boolean;
		index?: number;
		galleryId: string;
		images: GalleryImage[];
		coverImageId: string | null;
		coverIsDefault: boolean;
		canEdit: boolean;
		onchanged: () => void;
	} = $props();

	const base = $derived(`/modules/galleries/galleries/${galleryId}`);
	const safeIndex = $derived(
		images.length === 0 ? 0 : Math.min(Math.max(Math.trunc(index) || 0, 0), images.length - 1)
	);
	const current = $derived<GalleryImage | undefined>(images[safeIndex]);

	/** Lokal gespeicherter Stand, bis die Seite neu geladen hat (gilt nur für genau dieses Objekt) */
	let saved = $state.raw<{
		img: GalleryImage;
		description: string | null;
	} | null>(null);
	const shown = $derived.by(() => {
		if (!current) return null;
		if (saved && saved.img === current) {
			return { description: saved.description };
		}
		return { description: current.description };
	});

	const isCover = $derived(!!current && current.id === coverImageId);

	let editing = $state(false);
	let draftDescription = $state('');
	let fieldErrors = $state<Record<string, string>>({});
	let formError = $state<string | null>(null);
	let busy = $state(false);
	let confirmDelete = $state(false);
	let editingId = $state<string | null>(null);

	// Wechsel des Bildes (oder Schließen) beendet den Bearbeiten-Modus
	$effect(() => {
		const id = open ? (current?.id ?? null) : null;
		if (editingId !== null && editingId !== id) {
			editing = false;
			editingId = null;
		}
	});

	// Ohne Bilder gibt es nichts anzuzeigen
	$effect(() => {
		if (open && images.length === 0) open = false;
	});

	// Nachbarbilder vorladen
	$effect(() => {
		if (!open || images.length < 2) return;
		for (const i of [safeIndex + 1, safeIndex - 1]) {
			const img = images[i];
			if (img) {
				const pre = new Image();
				pre.decoding = 'async';
				pre.src = imageUrl(galleryId, img.id, 'web');
			}
		}
	});

	function prev() {
		if (safeIndex > 0) index = safeIndex - 1;
	}
	function next() {
		if (safeIndex < images.length - 1) index = safeIndex + 1;
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable) return true;
		const tag = target.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
	}

	function onwindowkeydown(e: KeyboardEvent) {
		if (!open || confirmDelete || e.defaultPrevented) return;
		if (e.altKey || e.ctrlKey || e.metaKey) return;
		const active = typeof document !== 'undefined' ? document.activeElement : null;
		if (isTypingTarget(e.target) || isTypingTarget(active)) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			prev();
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			next();
		}
	}

	// Wischgesten (nur waagerecht, nicht beim Bearbeiten)
	let touchStart: { x: number; y: number } | null = null;
	function ontouchstart(e: TouchEvent) {
		const t = e.touches[0];
		touchStart = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
	}
	function ontouchend(e: TouchEvent) {
		const t = e.changedTouches[0];
		const start = touchStart;
		touchStart = null;
		if (!start || !t) return;
		const dx = t.clientX - start.x;
		const dy = t.clientY - start.y;
		if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
		if (dx < 0) next();
		else prev();
	}

	function startEdit() {
		if (!current || !shown) return;
		draftDescription = shown.description ?? '';
		fieldErrors = {};
		formError = null;
		editingId = current.id;
		editing = true;
	}

	function cancelEdit() {
		editing = false;
		editingId = null;
		fieldErrors = {};
		formError = null;
	}

	type Issue = { path?: (string | number)[]; message?: string };

	function detailsToErrors(details: unknown): Record<string, string> {
		const issues: Issue[] | undefined = Array.isArray(details)
			? (details as Issue[])
			: (details as { issues?: Issue[] } | null)?.issues;
		const out: Record<string, string> = {};
		if (Array.isArray(issues)) {
			for (const i of issues) {
				const key = String(i.path?.[0] ?? '');
				if (key && i.message && !out[key]) out[key] = i.message;
			}
		} else if (details && typeof details === 'object') {
			for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
				const msg = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '';
				if (msg) out[k] = msg;
			}
		}
		return out;
	}

	async function save() {
		const img = current;
		if (!img || busy) return;
		const body = { description: draftDescription };
		const parsed = imageUpdateInput.safeParse(body);
		if (!parsed.success) {
			fieldErrors = detailsToErrors(parsed.error.issues);
			formError = null;
			return;
		}
		busy = true;
		fieldErrors = {};
		formError = null;
		try {
			await apiFetch(`${base}/images/${img.id}`, {
				method: 'PUT',
				body: JSON.stringify(parsed.data)
			});
			saved = { img, description: parsed.data.description };
			editing = false;
			editingId = null;
			toast.success('Bild gespeichert');
			onchanged();
		} catch (err) {
			if (err instanceof ApiClientError) {
				fieldErrors = detailsToErrors(err.details);
				const known = fieldErrors.description;
				formError = known ? null : err.message;
			} else {
				formError = 'Speichern fehlgeschlagen';
			}
		} finally {
			busy = false;
		}
	}

	async function setCover(imageId: string | null) {
		if (busy) return;
		busy = true;
		try {
			await apiFetch(`${base}/cover`, { method: 'PUT', body: JSON.stringify({ imageId }) });
			toast.success(imageId ? 'Titelbild festgelegt' : 'Titelbild zurückgesetzt');
			onchanged();
		} catch (err) {
			toast.error(err instanceof Error && err.message ? err.message : 'Aktion fehlgeschlagen');
		} finally {
			busy = false;
		}
	}

	async function remove() {
		const img = current;
		if (!img || busy) return;
		busy = true;
		try {
			await apiFetch(`${base}/images/${img.id}`, { method: 'DELETE' });
			toast.success('Bild gelöscht');
			if (images.length <= 1) open = false;
			else if (safeIndex >= images.length - 1) index = safeIndex - 1;
			else index = safeIndex;
			onchanged();
		} catch (err) {
			toast.error(err instanceof Error && err.message ? err.message : 'Löschen fehlgeschlagen');
		} finally {
			busy = false;
		}
	}

	function formatUploaded(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString('de-DE', {
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function formatBytes(n: number): string {
		if (n >= 1024 * 1024)
			return `${(n / (1024 * 1024)).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
		return `${Math.max(1, Math.round(n / 1024)).toLocaleString('de-DE')} KB`;
	}
</script>

<svelte:window onkeydown={onwindowkeydown} />

<Dialog.Root bind:open>
	<Dialog.Content
		showCloseButton={false}
		class="top-0 left-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none p-0 ring-0 sm:max-w-none lg:flex-row lg:overflow-hidden"
	>
		{#if current && shown}
			<!-- Bildbereich (immer dunkel) -->
			<div
				class="relative flex h-[62dvh] shrink-0 items-center justify-center bg-zinc-950 text-zinc-50 select-none lg:h-full lg:min-w-0 lg:flex-1"
				role="group"
				aria-roledescription="Bildbetrachter"
				aria-label={`Bild ${safeIndex + 1} von ${images.length}`}
				{ontouchstart}
				{ontouchend}
			>
				{#key current.id}
					<img
						src={imageUrl(galleryId, current.id, 'web')}
						alt={shown.description ?? 'Bild'}
						decoding="async"
						class="max-h-full max-w-full object-contain"
						draggable="false"
					/>
				{/key}

				<div
					class="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/60 to-transparent p-2"
				>
					<span
						class="rounded-md bg-black/40 px-2 py-1 text-sm font-medium tabular-nums"
						aria-live="polite"
					>
						{safeIndex + 1} / {images.length}
					</span>
					<Button
						variant="ghost"
						size="icon-lg"
						class="text-zinc-50 hover:bg-white/15 hover:text-white dark:hover:bg-white/15"
						aria-label="Schließen"
						onclick={() => (open = false)}
					>
						<XIcon class="size-5" />
					</Button>
				</div>

				{#if safeIndex > 0}
					<Button
						variant="ghost"
						size="icon-lg"
						class="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-black/40 text-zinc-50 hover:bg-black/60 hover:text-white dark:hover:bg-black/60 sm:size-11"
						aria-label="Vorheriges Bild"
						onclick={prev}
					>
						<ChevronLeftIcon class="size-6" />
					</Button>
				{/if}
				{#if safeIndex < images.length - 1}
					<Button
						variant="ghost"
						size="icon-lg"
						class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-black/40 text-zinc-50 hover:bg-black/60 hover:text-white dark:hover:bg-black/60 sm:size-11"
						aria-label="Nächstes Bild"
						onclick={next}
					>
						<ChevronRightIcon class="size-6" />
					</Button>
				{/if}
			</div>

			<!-- Seitenleiste (mobil darunter) -->
			<aside
				class="bg-background text-foreground flex flex-1 flex-col gap-4 p-4 lg:w-96 lg:flex-none lg:shrink-0 lg:overflow-y-auto lg:border-l"
			>
				<div class="space-y-1">
					<Dialog.Title class="flex items-center gap-2 text-base font-semibold">
						Bild {safeIndex + 1}
						{#if isCover}
							<Badge variant="secondary" class="gap-1">
								<StarIcon class="size-3 fill-amber-400 text-amber-500" aria-hidden="true" />
								Titelbild
							</Badge>
						{/if}
					</Dialog.Title>
					<Dialog.Description class="text-muted-foreground text-xs">
						Hochgeladen am {formatUploaded(current.createdAt)} · {current.width} × {current.height} px
						·
						{formatBytes(current.sizeBytes)}
					</Dialog.Description>
				</div>

				{#if editing}
					<form
						class="space-y-4"
						onsubmit={(e) => {
							e.preventDefault();
							void save();
						}}
					>
						<div class="space-y-1.5">
							<Label for="image-description">Beschreibung</Label>
							<Textarea
								id="image-description"
								rows={4}
								maxlength={MAX_IMAGE_DESCRIPTION}
								bind:value={draftDescription}
								disabled={busy}
								aria-invalid={fieldErrors.description ? true : undefined}
								aria-describedby={fieldErrors.description ? 'image-description-error' : undefined}
							/>
							{#if fieldErrors.description}
								<p id="image-description-error" class="text-destructive text-xs" role="alert">
									{fieldErrors.description}
								</p>
							{/if}
						</div>
						{#if formError}
							<p class="text-destructive text-xs" role="alert">{formError}</p>
						{/if}
						<div class="flex flex-wrap justify-end gap-2">
							<Button variant="outline" onclick={cancelEdit} disabled={busy}>Abbrechen</Button>
							<Button type="submit" disabled={busy}>{busy ? 'Speichert …' : 'Speichern'}</Button>
						</div>
					</form>
				{:else}
					<section class="space-y-1">
						<h3 class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
							Beschreibung
						</h3>
						{#if shown.description}
							<p class="text-sm whitespace-pre-line break-words">{shown.description}</p>
						{:else}
							<p class="text-muted-foreground text-sm">Keine Beschreibung</p>
						{/if}
					</section>
				{/if}

				<div class="mt-auto flex flex-wrap gap-2 border-t pt-4">
					{#if canEdit && !editing}
						<Button variant="outline" size="sm" onclick={startEdit} disabled={busy}>
							<PencilIcon />
							Bearbeiten
						</Button>
						{#if !isCover}
							<Button
								variant="outline"
								size="sm"
								onclick={() => setCover(current.id)}
								disabled={busy}
							>
								<StarIcon />
								Als Titelbild festlegen
							</Button>
						{:else if !coverIsDefault}
							<Button variant="outline" size="sm" onclick={() => setCover(null)} disabled={busy}>
								<StarOffIcon />
								Titelbild zurücksetzen
							</Button>
						{/if}
					{/if}
					<Button
						variant="outline"
						size="sm"
						href={imageUrl(galleryId, current.id, 'full')}
						download={current.originalName || true}
					>
						<DownloadIcon />
						Herunterladen
					</Button>
					{#if canEdit && !editing}
						<Button
							variant="destructive"
							size="sm"
							onclick={() => (confirmDelete = true)}
							disabled={busy}
						>
							<Trash2Icon />
							Löschen
						</Button>
					{/if}
				</div>
				{#if canEdit && isCover && coverIsDefault && !editing}
					<p class="text-muted-foreground -mt-2 text-xs">
						Titelbild ist automatisch das zuerst hochgeladene Bild.
					</p>
				{/if}
			</aside>
		{:else}
			<Dialog.Title class="sr-only">Bild</Dialog.Title>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmDelete}
	title="Bild löschen?"
	description="Das Bild wird mit allen Varianten endgültig gelöscht. Das lässt sich nicht rückgängig machen."
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
