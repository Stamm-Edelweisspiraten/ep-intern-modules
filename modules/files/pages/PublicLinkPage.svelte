<script lang="ts">
	// VERTRAG (Welle 0) – Props nicht ändern; Implementierung: Welle 4.3.
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import LinkIcon from '@lucide/svelte/icons/link-2-off';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import LockIcon from '@lucide/svelte/icons/lock';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import type { PublicLinkInfo, PublicListing, PublicNode } from '../schemas';
	import FilePreview from './FilePreview.svelte';
	import {
		API,
		RAW_API,
		formatBytes,
		iconFor,
		previewKind,
		type ContentUrlFn,
		type PreviewNode
	} from './helpers';

	let { params }: { params: Record<string, string> } = $props();

	const token = $derived(params.token ?? '');
	const enc = (s: string) => encodeURIComponent(s);
	const apiBase = $derived(`${API}/public/links/${enc(token)}`);
	const rawBase = $derived(`${RAW_API}/public/links/${enc(token)}`);
	const systemName = $derived((page.data as { systemName?: string }).systemName || 'EP Intern');

	const BUSY_TEXT = 'Gerade sehr viele Zugriffe – bitte kurz warten und erneut versuchen.';
	const RELOCK_TEXT = 'Die Freischaltung ist abgelaufen. Bitte gib das Passwort erneut ein.';

	// ---------- Zugriffstoken (nach Passwort) je Link in sessionStorage ----------
	/** Sicherheitsabstand, damit das Token nicht mitten im Abruf abläuft */
	const EXPIRY_MARGIN_MS = 20_000;
	const storageKey = (t: string) => `ep-files-link:${t}`;

	let accessToken = $state<string | null>(null);
	let accessExp = 0;

	function readStoredToken(t: string): string | null {
		try {
			const raw = sessionStorage.getItem(storageKey(t));
			if (!raw) return null;
			const v = JSON.parse(raw) as { t?: unknown; exp?: unknown };
			if (typeof v.t !== 'string' || typeof v.exp !== 'number') return null;
			if (v.exp - EXPIRY_MARGIN_MS <= Date.now()) {
				sessionStorage.removeItem(storageKey(t));
				return null;
			}
			accessExp = v.exp;
			return v.t;
		} catch {
			return null;
		}
	}

	function storeToken(t: string, value: string, expiresInSec: number) {
		accessExp = Date.now() + expiresInSec * 1000;
		accessToken = value;
		try {
			sessionStorage.setItem(storageKey(t), JSON.stringify({ t: value, exp: accessExp }));
		} catch {
			// Ohne Speicher gilt die Freischaltung nur für diese Ansicht
		}
	}

	function clearToken(t: string) {
		accessToken = null;
		accessExp = 0;
		try {
			sessionStorage.removeItem(storageKey(t));
		} catch {
			// ignorieren
		}
	}

	/** Passwort erneut abfragen (Token abgelaufen oder vom Server abgelehnt) */
	function relock(message = RELOCK_TEXT) {
		clearToken(token);
		password = '';
		unlockError = message;
		listing = null;
		if (info) info = { ...info, node: null };
	}

	/** Vor Download/Vorschau: abgelaufenes Token erkennen, statt eine Fehlerseite zu öffnen */
	function tokenStillValid(): boolean {
		if (!info?.needsPassword) return true;
		if (accessToken && accessExp - EXPIRY_MARGIN_MS > Date.now()) return true;
		relock();
		return false;
	}

	// ---------- Link-Info ----------
	let info = $state<PublicLinkInfo | null>(null);
	let infoState = $state<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
	let infoError = $state('');

	const locked = $derived(!!info?.needsPassword && !accessToken);

	async function loadInfo() {
		infoState = 'loading';
		infoError = '';
		const t = token;
		const stored = readStoredToken(t);
		accessToken = stored;
		try {
			// `t` wird mitgeschickt, damit Datei-Links nach dem Freischalten die Datei liefern können
			const q = stored ? `?t=${enc(stored)}` : '';
			const data = await apiFetch<PublicLinkInfo>(`${apiBase}${q}`);
			if (t !== token) return;
			info = data;
			if (!data.needsPassword) clearToken(t);
			infoState = 'ready';
		} catch (e) {
			if (t !== token) return;
			if (e instanceof ApiClientError && (e.status === 404 || e.status === 422)) {
				infoState = 'unavailable';
			} else if (e instanceof ApiClientError && e.status === 429) {
				infoState = 'error';
				infoError = BUSY_TEXT;
			} else {
				infoState = 'error';
				infoError = 'Die Seite konnte nicht geladen werden. Bitte prüfe deine Verbindung.';
			}
		}
	}

	$effect(() => {
		void token;
		untrack(() => void loadInfo());
	});

	// ---------- Passwort ----------
	let password = $state('');
	let unlocking = $state(false);
	let unlockError = $state('');

	async function unlock(e: SubmitEvent) {
		e.preventDefault();
		if (unlocking) return;
		if (!password) {
			unlockError = 'Bitte gib das Passwort ein.';
			return;
		}
		unlocking = true;
		unlockError = '';
		const t = token;
		try {
			const res = await apiFetch<{ accessToken: string; expiresInSec: number }>(
				`${apiBase}/unlock`,
				{ method: 'POST', body: JSON.stringify({ password }) }
			);
			storeToken(t, res.accessToken, res.expiresInSec);
			password = '';
			// Datei-Links: Datei-Angaben mit dem Token nachladen
			if (info?.kind === 'file') await loadInfo();
		} catch (err) {
			if (err instanceof ApiClientError && err.status === 403) {
				unlockError = 'Das Passwort ist falsch.';
			} else if (err instanceof ApiClientError && err.status === 429) {
				unlockError = 'Zu viele Versuche – bitte später erneut versuchen.';
			} else if (err instanceof ApiClientError && err.status === 404) {
				infoState = 'unavailable';
			} else {
				unlockError = 'Das hat nicht geklappt. Bitte versuche es erneut.';
			}
		} finally {
			unlocking = false;
		}
	}

	// ---------- Ordner-Links ----------
	const folderId = $derived(page.url.searchParams.get('folder'));

	let listing = $state<PublicListing | null>(null);
	let listState = $state<'loading' | 'ready' | 'busy' | 'missing' | 'error'>('loading');
	let listError = $state('');
	let listSeq = 0;

	async function loadListing(folder: string | null, t: string | null) {
		const seq = ++listSeq;
		listState = 'loading';
		listError = '';
		const q = new URLSearchParams();
		if (folder) q.set('parent', folder);
		if (t) q.set('t', t);
		const qs = q.toString();
		try {
			const data = await apiFetch<PublicListing>(`${apiBase}/nodes${qs ? `?${qs}` : ''}`);
			if (seq !== listSeq) return;
			listing = data;
			listState = 'ready';
		} catch (e) {
			if (seq !== listSeq) return;
			const status = e instanceof ApiClientError ? e.status : 0;
			if (status === 403) {
				relock();
			} else if (status === 429) {
				listState = 'busy';
			} else if ((status === 404 || status === 422) && folder) {
				listState = 'missing';
			} else if (status === 404) {
				infoState = 'unavailable';
			} else {
				listState = 'error';
				listError = 'Der Ordner konnte nicht geladen werden. Bitte prüfe deine Verbindung.';
			}
		}
	}

	$effect(() => {
		const f = folderId;
		const t = accessToken;
		if (infoState !== 'ready' || info?.kind !== 'folder' || locked) return;
		untrack(() => void loadListing(f, t));
	});

	function openFolder(id: string | null) {
		const url = new URL(page.url);
		if (id) url.searchParams.set('folder', id);
		else url.searchParams.delete('folder');
		void goto(url, { keepFocus: true, noScroll: false });
	}

	const crumbs = $derived(listing?.breadcrumbs ?? []);
	const currentName = $derived(crumbs[crumbs.length - 1]?.name ?? info?.name ?? '');
	const parentCrumb = $derived(crumbs.length > 1 ? crumbs[crumbs.length - 2]! : null);
	const fileItems = $derived((listing?.items ?? []).filter((n) => n.kind === 'file'));
	const folderCount = $derived((listing?.items.length ?? 0) - fileItems.length);

	// ---------- Inhalte / Vorschau ----------
	const urlFor: ContentUrlFn = (node, opts) => {
		const q = new URLSearchParams();
		if (accessToken) q.set('t', accessToken);
		if (opts.download) q.set('download', '1');
		if (opts.thumb) q.set('thumb', '1');
		const qs = q.toString();
		return `${rawBase}/content/${enc(node.id)}${qs ? `?${qs}` : ''}`;
	};

	let previewOpen = $state(false);
	let previewCurrent = $state<PreviewNode | null>(null);
	let previewNodes = $state<PreviewNode[]>([]);

	function openPreview(node: PublicNode, all: PublicNode[]) {
		if (!tokenStillValid()) return;
		previewNodes = all;
		previewCurrent = node;
		previewOpen = true;
	}

	function guardDownload(e: MouseEvent) {
		if (!tokenStillValid()) e.preventDefault();
	}

	/** Vorschaubilder, die nicht geladen werden konnten → Icon */
	const failedImages = new SvelteSet<string>();

	/** Fehler-Listener per Action statt `onerror`-Attribut (CSP blockiert Inline-Handler aus dem SSR) */
	function watchImage(img: HTMLImageElement) {
		const fail = () => {
			const src = img.getAttribute('src');
			if (src) failedImages.add(src);
		};
		img.addEventListener('error', fail);
		if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) fail();
		return { destroy: () => img.removeEventListener('error', fail) };
	}

	function thumbOf(node: PublicNode): string | null {
		if (node.kind !== 'file' || !node.hasThumb) return null;
		const url = urlFor(node, { thumb: true });
		return failedImages.has(url) ? null : url;
	}

	/** Bild für die Karte eines Datei-Links: Thumbnail, sonst das Bild selbst */
	function heroImageOf(node: PublicNode): string | null {
		if (previewKind(node.contentType) !== 'image') return null;
		const url = node.hasThumb ? urlFor(node, { thumb: true }) : urlFor(node, {});
		return failedImages.has(url) ? null : url;
	}

	/** „PDF“, „JPG“ … aus der Endung, sonst der MIME-Typ */
	function typeLabel(node: Pick<PublicNode, 'name' | 'contentType'>): string {
		const m = /\.([a-z0-9]{1,8})$/i.exec(node.name);
		if (m) return m[1]!.toUpperCase();
		return node.contentType?.split(';')[0]?.trim() || 'Datei';
	}

	function formatDateDe(iso: string | null): string {
		if (!iso) return '';
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
		return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
	}

	const title = $derived(
		infoState === 'unavailable'
			? 'Link nicht verfügbar'
			: info
				? info.kind === 'folder' && !locked
					? currentName || info.name
					: info.name
				: 'Geteilte Datei'
	);

	const countLabel = (folders: number, files: number) => {
		const parts: string[] = [];
		if (folders) parts.push(folders === 1 ? '1 Ordner' : `${folders} Ordner`);
		if (files) parts.push(files === 1 ? '1 Datei' : `${files} Dateien`);
		return parts.join(' · ');
	};
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="robots" content="noindex,nofollow" />
</svelte:head>

<main class="flex flex-col gap-6">
	{#if infoState === 'loading'}
		<div class="flex flex-col gap-4" aria-busy="true" aria-label="Seite wird geladen">
			<Skeleton class="h-8 w-2/3" />
			<Skeleton class="h-4 w-1/3" />
			<Skeleton class="h-56 w-full" />
		</div>
	{:else if infoState === 'unavailable'}
		<Card.Root>
			<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
				<LinkIcon class="size-10 text-muted-foreground" aria-hidden="true" />
				<h1 class="text-lg font-semibold">Dieser Link ist nicht (mehr) verfügbar.</h1>
				<p class="max-w-sm text-sm text-muted-foreground">
					Vielleicht ist er abgelaufen oder wurde zurückgezogen. Bitte wende dich an die Person, die
					ihn dir geschickt hat.
				</p>
			</Card.Content>
		</Card.Root>
	{:else if infoState === 'error' || !info}
		<Card.Root>
			<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
				<CircleAlertIcon class="size-10 text-muted-foreground" aria-hidden="true" />
				<p class="max-w-sm text-sm text-muted-foreground" role="alert">
					{infoError || 'Die Seite konnte nicht geladen werden.'}
				</p>
				<Button variant="outline" onclick={() => void loadInfo()}>
					<RefreshCwIcon class="size-4" aria-hidden="true" /> Erneut versuchen
				</Button>
			</Card.Content>
		</Card.Root>
	{:else if locked}
		<!-- Passwort -->
		<Card.Root>
			<Card.Header>
				<div class="flex items-center gap-3">
					<span
						class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
					>
						<LockIcon class="size-5" aria-hidden="true" />
					</span>
					<div class="min-w-0">
						<Card.Title class="text-lg break-words">{info.name}</Card.Title>
						<Card.Description>
							{info.kind === 'folder' ? 'Dieser Ordner' : 'Diese Datei'} ist mit einem Passwort geschützt.
						</Card.Description>
					</div>
				</div>
			</Card.Header>
			<Card.Content>
				<form class="flex flex-col gap-3" onsubmit={unlock} novalidate>
					<div class="flex flex-col gap-1.5">
						<Label for="link-password">Passwort</Label>
						<Input
							id="link-password"
							type="password"
							autocomplete="off"
							bind:value={password}
							aria-invalid={unlockError ? 'true' : undefined}
							aria-describedby={unlockError ? 'link-password-error' : undefined}
							disabled={unlocking}
						/>
						{#if unlockError}
							<p id="link-password-error" class="text-xs text-destructive" role="alert">
								{unlockError}
							</p>
						{/if}
					</div>
					<Button
						type="submit"
						size="lg"
						class="h-10 w-full sm:w-auto sm:self-start"
						disabled={unlocking}
					>
						{#if unlocking}
							<LoaderCircleIcon class="size-4 animate-spin" aria-hidden="true" /> Prüft …
						{:else}
							Öffnen
						{/if}
					</Button>
				</form>
			</Card.Content>
		</Card.Root>
	{:else if info.kind === 'file'}
		<!-- Datei-Link -->
		{#if info.node}
			{@const node = info.node}
			{@const Icon = iconFor('file', node.contentType)}
			{@const hero = heroImageOf(node)}
			{@const canPreview = previewKind(node.contentType) !== null}
			<Card.Root class="overflow-hidden pt-0">
				{#if hero}
					<button
						type="button"
						class="block w-full bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						onclick={() => openPreview(node, [node])}
						aria-label="{node.name} ansehen"
					>
						<img
							src={hero}
							alt=""
							class="mx-auto max-h-[60vh] w-auto object-contain"
							use:watchImage
						/>
					</button>
				{:else}
					<div class="flex items-center justify-center bg-muted/50 py-10">
						<Icon class="size-16 text-muted-foreground" aria-hidden="true" />
					</div>
				{/if}
				<Card.Header>
					<h1 class="text-lg font-semibold break-words">{node.name}</h1>
					<p class="text-sm text-muted-foreground tabular-nums">
						{typeLabel(node)} · {formatBytes(node.sizeBytes)}
					</p>
				</Card.Header>
				<Card.Content class="flex flex-col gap-2 sm:flex-row">
					<Button
						href={urlFor(node, { download: true })}
						download={node.name}
						size="lg"
						class="h-11 px-5 text-base"
						onclick={guardDownload}
					>
						<DownloadIcon class="size-5" aria-hidden="true" /> Herunterladen
					</Button>
					{#if canPreview}
						<Button
							variant="outline"
							size="lg"
							class="h-11 px-5 text-base"
							onclick={() => openPreview(node, [node])}
						>
							<EyeIcon class="size-5" aria-hidden="true" /> Ansehen
						</Button>
					{/if}
				</Card.Content>
			</Card.Root>
		{:else}
			<Card.Root>
				<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
					<CircleAlertIcon class="size-10 text-muted-foreground" aria-hidden="true" />
					<p class="max-w-sm text-sm text-muted-foreground" role="alert">
						Die Datei kann gerade nicht angezeigt werden.
					</p>
					<Button variant="outline" onclick={() => void loadInfo()}>
						<RefreshCwIcon class="size-4" aria-hidden="true" /> Erneut versuchen
					</Button>
				</Card.Content>
			</Card.Root>
		{/if}
	{:else}
		<!-- Ordner-Link -->
		<section class="flex flex-col gap-4" aria-labelledby="folder-title">
			<header class="flex flex-col gap-2">
				{#if crumbs.length > 1}
					<nav aria-label="Ordnerpfad" class="-mx-1 overflow-x-auto">
						<ol class="flex items-center gap-0.5 text-sm whitespace-nowrap">
							{#each crumbs as crumb, i (crumb.id ?? 'root')}
								<li class="flex min-w-0 items-center gap-0.5">
									{#if i > 0}
										<ChevronRightIcon
											class="size-3.5 shrink-0 text-muted-foreground"
											aria-hidden="true"
										/>
									{/if}
									{#if i === crumbs.length - 1}
										<span class="max-w-[12rem] truncate px-1 font-medium" aria-current="page">
											{crumb.name}
										</span>
									{:else}
										<button
											type="button"
											class="max-w-[10rem] truncate rounded px-1 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
											onclick={() => openFolder(crumb.id)}
										>
											{crumb.name}
										</button>
									{/if}
								</li>
							{/each}
						</ol>
					</nav>
				{/if}
				<div class="flex items-start gap-2">
					{#if parentCrumb}
						<Button
							variant="ghost"
							size="icon"
							class="mt-0.5 shrink-0"
							aria-label="Zurück zu {parentCrumb.name}"
							onclick={() => openFolder(parentCrumb.id)}
						>
							<ArrowLeftIcon class="size-4" aria-hidden="true" />
						</Button>
					{/if}
					<div class="min-w-0">
						<h1 id="folder-title" class="text-2xl font-semibold tracking-tight break-words">
							{currentName}
						</h1>
						{#if listState === 'ready' && listing && listing.items.length > 0}
							<p class="text-sm text-muted-foreground">
								{countLabel(folderCount, fileItems.length)}
							</p>
						{/if}
					</div>
				</div>
			</header>

			{#if listState === 'loading'}
				<div
					class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
					aria-busy="true"
					aria-label="Ordner wird geladen"
				>
					{#each [0, 1, 2, 3, 4, 5] as i (i)}
						<Skeleton class="aspect-[4/5] w-full" />
					{/each}
				</div>
			{:else if listState === 'busy' || listState === 'error'}
				<Card.Root>
					<Card.Content class="flex flex-col items-center gap-3 py-8 text-center">
						<CircleAlertIcon class="size-8 text-muted-foreground" aria-hidden="true" />
						<p class="max-w-sm text-sm text-muted-foreground" role="alert">
							{listState === 'busy' ? BUSY_TEXT : listError}
						</p>
						<Button variant="outline" onclick={() => void loadListing(folderId, accessToken)}>
							<RefreshCwIcon class="size-4" aria-hidden="true" /> Erneut versuchen
						</Button>
					</Card.Content>
				</Card.Root>
			{:else if listState === 'missing'}
				<Card.Root>
					<Card.Content class="flex flex-col items-center gap-3 py-8 text-center">
						<CircleAlertIcon class="size-8 text-muted-foreground" aria-hidden="true" />
						<p class="max-w-sm text-sm text-muted-foreground" role="alert">
							Dieser Ordner wurde nicht gefunden.
						</p>
						<Button variant="outline" onclick={() => openFolder(null)}>Zum geteilten Ordner</Button>
					</Card.Content>
				</Card.Root>
			{:else if listing && listing.items.length === 0}
				<Card.Root>
					<Card.Content class="flex flex-col items-center gap-2 py-10 text-center">
						<FolderOpenIcon class="size-10 text-muted-foreground" aria-hidden="true" />
						<p class="text-sm text-muted-foreground">Dieser Ordner ist leer.</p>
					</Card.Content>
				</Card.Root>
			{:else if listing}
				<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
					{#each listing.items as node (node.id)}
						{@const Icon = iconFor(node.kind, node.contentType)}
						{@const thumb = thumbOf(node)}
						<li class="min-w-0">
							<button
								type="button"
								class="group flex w-full flex-col overflow-hidden rounded-lg border bg-card text-left text-card-foreground transition-colors hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
								onclick={() =>
									node.kind === 'folder' ? openFolder(node.id) : openPreview(node, fileItems)}
								aria-label={node.kind === 'folder'
									? `Ordner ${node.name} öffnen`
									: `${node.name} ansehen`}
							>
								<span
									class="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-muted/50"
								>
									{#if thumb}
										<img
											src={thumb}
											alt=""
											loading="lazy"
											decoding="async"
											draggable="false"
											class="size-full object-cover"
											use:watchImage
										/>
									{:else if node.kind === 'folder'}
										<Icon class="size-12 text-primary/80" aria-hidden="true" />
									{:else}
										<Icon class="size-10 text-muted-foreground" aria-hidden="true" />
									{/if}
								</span>
								<span class="flex flex-col gap-0.5 p-2.5">
									<span class="line-clamp-2 text-sm font-medium break-words">{node.name}</span>
									<span class="text-xs text-muted-foreground tabular-nums">
										{node.kind === 'folder'
											? 'Ordner'
											: `${typeLabel(node)} · ${formatBytes(node.sizeBytes)}`}
									</span>
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	{#if infoState === 'ready' && info}
		<footer
			class="flex flex-col items-center gap-0.5 pt-2 text-center text-xs text-muted-foreground"
		>
			<span>Geteilt über {systemName}</span>
			{#if info.expiresOn}
				<span>Link gültig bis {formatDateDe(info.expiresOn)}</span>
			{/if}
		</footer>
	{/if}
</main>

<FilePreview bind:open={previewOpen} nodes={previewNodes} bind:current={previewCurrent} {urlFor} />
