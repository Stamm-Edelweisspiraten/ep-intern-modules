<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import ImagePlus from '@lucide/svelte/icons/image-plus';
	import Send from '@lucide/svelte/icons/send';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import type { PrincipalInfo } from '$lib/sdk/types/sharing';
	import { slugify } from '$lib/sdk/slug';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { SelectField } from '$lib/components/ui/select-field';
	import { TagInput } from '$lib/components/ui/tag-input';
	import { ConfirmDialog, EmptyState, ErrorState, FormField, LoadingState, PageHeader, PageTitle, ShareMenu, type ShareCandidate, type ShareEntry, AssistInput, AssistRichTextEditor, AssistTextarea } from '$lib/components/layout';
	import { BUSY_SAVE, BUSY_UPLOAD } from '$lib/components/layout/busy';
	import { shareKey } from '$lib/components/layout/share-types';
	import {
		MAX_POST_TEASER,
		MAX_POST_TITLE,
		MAX_SLUG,
		MAX_TAG,
		MAX_TAGS,
		postUpdateInput,
		type PostDetail,
		type PostImage,
		type RefOption
	} from '../schemas';
	import {
		BASE,
		detailsToErrors,
		errorText,
		formatDateTime,
		fromLocalInput,
		issuesToErrors,
		postImageSrc,
		postStatusLabel,
		postStatusVariant
	} from './helpers';

	let { params }: ModulePageProps = $props();
	const id = $derived(params.id ?? '');
	const url = $derived(`${BASE}/posts/${id}`);

	let post = $state<PostDetail | null>(null);
	let loading = $state(true);
	let notFound = $state(false);
	let loadError = $state('');

	// Formular
	let title = $state('');
	let slug = $state('');
	let teaser = $state('');
	let bodyHtml = $state('');
	let coverImageId = $state<string | null>(null);
	let authorNameOverride = $state('');
	let tags = $state<string[]>([]);
	let groupIds = $state<string[]>([]);
	let eventId = $state<string | null>(null);
	let galleryId = $state<string | null>(null);
	/** Bilder des Beitrags (auch frisch hochgeladene, noch nicht gespeicherte) */
	let images = $state<PostImage[]>([]);
	let saved = $state('');
	let saving = $state(false);
	let errors = $state<Record<string, string>>({});
	let coverUploading = $state(false);
	let coverInput = $state<HTMLInputElement | null>(null);

	// Auswahllisten
	let groups = $state<RefOption[]>([]);
	let events = $state<RefOption[]>([]);
	let galleries = $state<RefOption[]>([]);

	// Veröffentlichen
	let publishOpen = $state(false);
	let publishAt = $state('');
	let publishing = $state(false);
	let deleteOpen = $state(false);

	const canEdit = $derived(post?.access.level === 'edit');
	const canPublish = $derived(post?.access.canPublish ?? false);
	const canShare = $derived(!!post && canEdit && (post.access.isOwner || canPublish));
	const canDelete = $derived(
		!!post && (canPublish || (post.access.isOwner && post.status === 'draft'))
	);

	function formState() {
		return JSON.stringify({
			title,
			slug,
			teaser,
			bodyHtml,
			coverImageId,
			authorNameOverride,
			tags,
			groupIds,
			eventId,
			galleryId
		});
	}
	const dirty = $derived(!!post && formState() !== saved);

	function fill(p: PostDetail) {
		post = p;
		title = p.title;
		slug = p.slug;
		teaser = p.teaser ?? '';
		bodyHtml = p.bodyHtml;
		coverImageId = p.coverImageId;
		authorNameOverride = p.authorNameOverride ?? '';
		tags = [...p.tags];
		groupIds = [...p.groupIds];
		eventId = p.eventId;
		galleryId = p.galleryId;
		images = [...p.images];
		saved = formState();
		errors = {};
	}

	async function load() {
		try {
			fill(await apiFetch<PostDetail>(url));
			notFound = false;
			loadError = '';
		} catch (e) {
			if (e instanceof ApiClientError && e.status === 404) notFound = true;
			else loadError = errorText(e, 'Laden fehlgeschlagen');
		} finally {
			loading = false;
		}
	}

	async function loadRefs() {
		const [g, ev, ga] = await Promise.all([
			apiFetch<RefOption[]>(`${BASE}/refs/groups`).catch(() => []),
			apiFetch<RefOption[]>(`${BASE}/refs/events?limit=50`).catch(() => []),
			apiFetch<RefOption[]>(`${BASE}/refs/galleries?limit=50`).catch(() => [])
		]);
		groups = g;
		events = ev;
		galleries = ga;
	}

	$effect(() => {
		void id;
		loading = true;
		void load();
		void loadRefs();
	});

	beforeNavigate(({ cancel, willUnload }) => {
		if (!dirty) return;
		if (willUnload) {
			cancel();
			return;
		}
		if (!confirm('Du hast ungespeicherte Änderungen. Seite trotzdem verlassen?')) cancel();
	});

	/** Optionen mit der aktuellen Auswahl (auch wenn sie nicht unter den neuesten 50 ist) */
	function withCurrent(list: RefOption[], current: RefOption | null | undefined) {
		const opts = list.map((o) => ({
			value: o.id,
			label: o.detail ? `${o.label} (${o.detail})` : o.label
		}));
		if (current && !list.some((o) => o.id === current.id)) {
			opts.unshift({ value: current.id, label: current.label });
		}
		return opts;
	}

	async function uploadFile(file: File, alt?: string): Promise<PostImage> {
		const fd = new FormData();
		fd.set('file', file);
		if (alt) fd.set('alt', alt);
		const img = await apiFetch<PostImage>(`${url}/images`, { method: 'POST', body: fd });
		images = [...images, img];
		return img;
	}

	async function uploadForEditor(file: File) {
		const img = await uploadFile(file).catch((e) => {
			throw new Error(errorText(e, 'Bild konnte nicht hochgeladen werden'), { cause: e });
		});
		return { id: img.id, src: postImageSrc(id, img.id), alt: '' };
	}

	async function onCoverSelected(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		coverUploading = true;
		try {
			const img = await uploadFile(file, title);
			coverImageId = img.id;
		} catch (err) {
			toast.error(errorText(err, 'Titelbild konnte nicht hochgeladen werden'));
		} finally {
			coverUploading = false;
		}
	}

	async function save(): Promise<boolean> {
		const input = {
			title,
			slug,
			teaser,
			bodyHtml,
			coverImageId,
			authorNameOverride,
			tags,
			groupIds,
			eventId,
			galleryId
		};
		const parsed = postUpdateInput.safeParse(input);
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			toast.error('Bitte prüfe die markierten Felder');
			return false;
		}
		saving = true;
		try {
			fill(await apiFetch<PostDetail>(url, { method: 'PATCH', body: JSON.stringify(parsed.data) }));
			toast.success('Gespeichert');
			return true;
		} catch (e) {
			if (e instanceof ApiClientError) errors = detailsToErrors(e.details);
			toast.error(errorText(e, 'Speichern fehlgeschlagen'));
			return false;
		} finally {
			saving = false;
		}
	}

	async function publish() {
		if (dirty && !(await save())) return;
		publishing = true;
		try {
			fill(
				await apiFetch<PostDetail>(`${url}/publish`, {
					method: 'POST',
					body: JSON.stringify({ publishedAt: fromLocalInput(publishAt) })
				})
			);
			publishOpen = false;
			toast.success(post?.live ? 'Veröffentlicht' : 'Veröffentlichung geplant');
		} catch (e) {
			toast.error(errorText(e, 'Veröffentlichen fehlgeschlagen'));
		} finally {
			publishing = false;
		}
	}

	async function unpublish() {
		try {
			fill(await apiFetch<PostDetail>(`${url}/unpublish`, { method: 'POST' }));
			toast.success('Zurückgezogen – der Beitrag ist wieder ein Entwurf');
		} catch (e) {
			toast.error(errorText(e, 'Zurückziehen fehlgeschlagen'));
		}
	}

	async function confirmDelete() {
		try {
			await apiFetch(url, { method: 'DELETE' });
			saved = formState();
			toast.success('Beitrag gelöscht');
			await goto(BASE);
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		}
	}

	// --- Mitschreiben ---------------------------------------------------------------
	const shareEntries = $derived<ShareEntry[]>(
		(post?.shares ?? []).map((s) => ({
			userId: s.id,
			type: s.type,
			name: s.name,
			detail: s.detail,
			color: s.color,
			image: s.image,
			level: s.level
		}))
	);

	async function saveShares(next: ShareEntry[]) {
		try {
			const p = await apiFetch<PostDetail>(`${url}/shares`, {
				method: 'PUT',
				body: JSON.stringify({
					shares: next.map((s) => ({ type: s.type ?? 'user', id: s.userId, level: 'edit' }))
				})
			});
			if (post) post = { ...post, shares: p.shares };
		} catch (e) {
			throw new Error(errorText(e, 'Freigabe fehlgeschlagen'), { cause: e });
		}
	}

	async function searchPrincipals(q: string): Promise<ShareCandidate[]> {
		const found = await apiFetch<PrincipalInfo[]>(`${BASE}/principals?search=${encodeURIComponent(q)}`);
		return found
			.filter((p) => !(p.type === 'user' && p.id === post?.authorId))
			.map((p) => ({
				id: p.id,
				type: p.type,
				name: p.name,
				detail: p.detail ?? null,
				color: p.color ?? null,
				image: p.image ?? null
			}));
	}

	async function addShare(c: ShareCandidate) {
		const entry: ShareEntry = {
			userId: c.id,
			type: c.type ?? 'user',
			name: c.name,
			detail: c.detail ?? null,
			color: c.color ?? null,
			level: 'edit'
		};
		if (shareEntries.some((s) => shareKey(s) === shareKey(entry))) return;
		await saveShares([...shareEntries, entry]);
	}

	async function removeShare(key: string) {
		await saveShares(shareEntries.filter((s) => shareKey(s) !== key));
	}

	const cover = $derived(images.find((i) => i.id === coverImageId) ?? null);
	const teaserCount = $derived(`${teaser.length} / ${MAX_POST_TEASER} Zeichen`);
</script>

<PageTitle title={post?.title ?? 'Beitrag'} />

{#if loading}
	<LoadingState label="Beitrag wird geladen" rows={6} />
{:else if notFound}
	<EmptyState
		title="Beitrag nicht gefunden"
		description="Der Beitrag existiert nicht oder du hast keinen Zugriff darauf."
	>
		<Button href={BASE} variant="outline"><ArrowLeft /> Zurück zum Blog</Button>
	</EmptyState>
{:else if loadError || !post}
	<ErrorState message={loadError || 'Laden fehlgeschlagen'} onretry={load} />
{:else}
	<div class="space-y-6 pb-20">
		<div>
			<nav aria-label="Navigation" class="mb-2">
				<a
					href={BASE}
					class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft class="size-4" aria-hidden="true" /> Blog
				</a>
			</nav>
			<PageHeader title={post.title}>
				{#snippet actions()}
					{#if post}
						<Badge variant={postStatusVariant(post)}>{postStatusLabel(post)}</Badge>
						{#if canShare}
							<ShareMenu
								shares={shareEntries}
								owner={{ name: post.access.isOwner ? `${post.authorName} (du)` : post.authorName }}
								levels={[{ value: 'edit', label: 'Darf mitschreiben' }]}
								defaultLevel="edit"
								canManage={canShare}
								search={searchPrincipals}
								onadd={addShare}
								onchange={async () => {}}
								onremove={removeShare}
								title="Mitschreiben"
								description="Wer an diesem Beitrag mitschreiben darf. Veröffentlichen dürfen nur Personen mit dem Recht dazu."
								placeholder="Person, Rolle oder Gruppe suchen …"
								searchLabel="Mitschreibende hinzufügen"
								emptyResultText="Niemand gefunden"
							/>
						{/if}
						{#if canPublish}
							{#if post.status === 'draft'}
								<Button
									onclick={() => {
										publishAt = '';
										publishOpen = true;
									}}><Send /> Veröffentlichen</Button
								>
							{:else}
								<Button variant="outline" onclick={unpublish}><Undo2 /> Zurückziehen</Button>
							{/if}
						{/if}
						{#if canDelete}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button {...props} variant="outline" aria-label="Mehr Aktionen">
											<Ellipsis /> Mehr
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end" class="w-48">
									<DropdownMenu.Item variant="destructive" onclick={() => (deleteOpen = true)}>
										<Trash2 /> Löschen
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					{/if}
				{/snippet}
			</PageHeader>
			<p class="mt-1 text-sm text-muted-foreground">
				{#if post.status === 'published' && post.publishedAt}
					{post.live ? 'Veröffentlicht am' : 'Erscheint am'}
					{formatDateTime(post.publishedAt)} ·
				{/if}
				von {post.authorName} · zuletzt geändert {formatDateTime(post.updatedAt)}
				{#if !canPublish && post.status === 'draft'}
					· Veröffentlichen kann eine Person mit dem Recht „Beiträge veröffentlichen“.
				{/if}
			</p>
		</div>

		<fieldset disabled={!canEdit} class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
			<legend class="sr-only">Beitrag bearbeiten</legend>
			<div class="min-w-0 space-y-4">
				<FormField label="Titel" id="post-title" required error={errors.title}>
					<AssistInput
						id="post-title"
						bind:value={title}
						maxlength={MAX_POST_TITLE}
						assist={{ module: 'website', purpose: 'blog-title' }}
						source={() => bodyHtml || title}
					/>
				</FormField>
				<FormField
					label="Kurzbeschreibung"
					id="post-teaser"
					error={errors.teaser}
					hint={`Erscheint in der Übersicht und als Vorschau beim Teilen · ${teaserCount}`}
				>
					<AssistTextarea
						id="post-teaser"
						bind:value={teaser}
						rows={2}
						maxlength={MAX_POST_TEASER}
						assist={{ module: 'website', purpose: 'blog-teaser' }}
						source={() => bodyHtml}
					/>
				</FormField>
				<div class="space-y-1.5">
					<Label for="post-body">Text</Label>
					<AssistRichTextEditor
						id="post-body"
						label="Text des Beitrags"
						bind:value={bodyHtml}
						assist={{ module: 'website', purpose: 'blog-body', extra: () => ({ title }) }}
						minHeight="22rem"
						disabled={!canEdit}
						uploadImage={uploadForEditor}
						imageSrc={(imageId) => postImageSrc(id, imageId)}
						invalid={!!errors.bodyHtml}
					/>
					<p class="text-xs text-muted-foreground">
						Bilder per Knopf, Einfügen oder Ziehen. Klick auf ein Bild, um die Bildbeschreibung zu ändern.
					</p>
				</div>
			</div>

			<div class="space-y-4">
				<Card.Root>
					<Card.Header><Card.Title level={2} class="text-section">Titelbild</Card.Title></Card.Header>
					<Card.Content class="space-y-3">
						{#if cover}
							<img
								src={postImageSrc(id, cover.id, 'thumb')}
								alt={cover.alt ?? ''}
								width={cover.width}
								height={cover.height}
								class="aspect-video w-full rounded-md border object-cover"
							/>
						{:else}
							<p class="text-sm text-muted-foreground">Noch kein Titelbild.</p>
						{/if}
						<div class="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={coverUploading || !canEdit}
								onclick={() => coverInput?.click()}
							>
								<ImagePlus />
								{coverUploading ? BUSY_UPLOAD : cover ? 'Ersetzen' : 'Hochladen'}
							</Button>
							{#if cover}
								<Button size="sm" variant="ghost" onclick={() => (coverImageId = null)}>Entfernen</Button>
							{/if}
						</div>
						<input
							bind:this={coverInput}
							type="file"
							accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
							class="hidden"
							onchange={onCoverSelected}
						/>
					</Card.Content>
				</Card.Root>

				<Card.Root class="overflow-visible">
					<Card.Header><Card.Title level={2} class="text-section">Angaben</Card.Title></Card.Header>
					<Card.Content class="space-y-4">
						<FormField
							label="Adresse"
							id="post-slug"
							required
							error={errors.slug}
							hint={`/blog/${slug || '…'}`}
						>
							<div class="flex gap-2">
								<Input id="post-slug" bind:value={slug} maxlength={MAX_SLUG} autocomplete="off" />
								<Button
									type="button"
									variant="outline"
									size="sm"
									class="shrink-0"
									onclick={() => (slug = slugify(title, MAX_SLUG) || slug)}>Aus Titel</Button
								>
							</div>
						</FormField>
						<FormField label="Themen" id="post-tags" error={errors.tags} hint={`Höchstens ${MAX_TAGS}`}>
							<TagInput
								id="post-tags"
								label="Themen"
								bind:value={tags}
								max={MAX_TAGS}
								maxLength={MAX_TAG}
								loadSuggestions={async (q) => {
									const all = await apiFetch<{ tag: string }[]>(`${BASE}/tags`).catch(() => []);
									const needle = q.toLocaleLowerCase('de');
									return all.map((t) => t.tag).filter((t) => t.toLocaleLowerCase('de').includes(needle));
								}}
							/>
						</FormField>
						<FormField
							label="Anzeige Autor*in"
							id="post-author"
							error={errors.authorNameOverride}
							hint="Leer = dein Vorname. Z. B. „Die Meute“."
						>
							<Input id="post-author" bind:value={authorNameOverride} maxlength={60} />
						</FormField>
						<FormField label="Gruppen" id="post-groups" error={errors.groupIds}>
							<MultiSelect
								id="post-groups"
								label="Gruppen"
								bind:value={groupIds}
								options={groups.map((g) => ({ value: g.id, label: g.label }))}
								placeholder="Keine"
							/>
						</FormField>
						<FormField label="Termin" id="post-event" error={errors.eventId}>
							<SelectField
								id="post-event"
								label="Termin"
								bind:value={eventId}
								emptyLabel="Kein Termin"
								options={withCurrent(events, post.eventRef)}
							/>
						</FormField>
						<FormField
							label="Galerie"
							id="post-gallery"
							error={errors.galleryId}
							hint="Nur öffentliche Galerien"
						>
							<SelectField
								id="post-gallery"
								label="Galerie"
								bind:value={galleryId}
								emptyLabel="Keine Galerie"
								options={withCurrent(galleries, post.galleryRef)}
							/>
						</FormField>
					</Card.Content>
				</Card.Root>
			</div>
		</fieldset>
	</div>

	{#if canEdit}
		<div
			class="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 px-4 py-3 backdrop-blur md:left-56"
			role="region"
			aria-label="Speichern"
		>
			<div class="flex items-center justify-end gap-3">
				<p class="text-sm text-muted-foreground" aria-live="polite">
					{dirty ? 'Ungespeicherte Änderungen' : 'Alles gespeichert'}
				</p>
				<Button onclick={save} disabled={saving || !dirty}>{saving ? BUSY_SAVE : 'Speichern'}</Button>
			</div>
		</div>
	{/if}
{/if}

<Dialog.Root bind:open={publishOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Beitrag veröffentlichen</Dialog.Title>
			<Dialog.Description>
				Ohne Zeitpunkt erscheint der Beitrag sofort auf der Stammeswebsite (nach höchstens einer Minute).
			</Dialog.Description>
		</Dialog.Header>
		<FormField label="Erst ab" id="post-publish-at" hint="Leer = sofort">
			<Input id="post-publish-at" type="datetime-local" bind:value={publishAt} />
		</FormField>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (publishOpen = false)}>Abbrechen</Button>
			<Button onclick={publish} disabled={publishing}>
				{publishing ? BUSY_SAVE : publishAt ? 'Planen' : 'Jetzt veröffentlichen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Beitrag löschen?"
	description="Der Beitrag und seine Bilder werden endgültig gelöscht und verschwinden von der Website."
	confirmLabel="Löschen"
	destructive
	onconfirm={confirmDelete}
/>
