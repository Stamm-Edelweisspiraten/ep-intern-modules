<script lang="ts">
	// Artikel anlegen/bearbeiten (Allgemein + Bilder), archivieren, löschen.
	// Der Aufrufer rendert per `{#key}` neu, damit das Formular bei jedem Öffnen frisch startet.
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Archive from '@lucide/svelte/icons/archive';
	import ArchiveRestore from '@lucide/svelte/icons/archive-restore';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Textarea } from '$lib/components/ui/textarea';
	import { BUSY_SAVE, ConfirmDialog, FormField, NumberStepper } from '$lib/components/layout';
	import {
		ARTICLE_KIND_LABELS,
		MAX_NAME,
		MAX_TEXT,
		articleInput,
		type Article,
		type ArticleImage,
		type ArticleKind,
		type Category
	} from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import ImageManager from './ImageManager.svelte';
	import ModeSwitch from './ModeSwitch.svelte';

	let {
		open = $bindable(false),
		article = null,
		categories,
		onsaved,
		ondeleted
	}: {
		open?: boolean;
		/** `null` = neuer Artikel */
		article?: Article | null;
		categories: Category[];
		/** Nach jedem Speichern (auch Bilder, Archivieren) */
		onsaved: (article: Article) => void;
		ondeleted?: (id: string) => void;
	} = $props();

	type Tab = 'general' | 'images';
	const initial = untrack(() => article);
	let current = $state<Article | null>(initial);
	let tab = $state<Tab>('general');

	let name = $state(initial?.name ?? '');
	let categoryId = $state<string | null>(initial?.categoryId ?? null);
	let kind = $state<ArticleKind>(initial?.kind ?? 'unit');
	let unitLabel = $state(initial?.unitLabel ?? 'Stück');
	let minQuantity = $state(initial?.minQuantity ?? 0);
	let description = $state(initial?.description ?? '');
	let notes = $state(initial?.notes ?? '');

	let errors = $state<Record<string, string>>({});
	let busy = $state(false);
	let deleteOpen = $state(false);

	const isNew = $derived(!current);
	const categoryOptions = $derived(categories.map((c) => ({ value: c.id, label: c.name })));
	const kindOptions = (['unit', 'bulk'] as const).map((k) => ({
		value: k,
		label: ARTICLE_KIND_LABELS[k]
	}));

	function body() {
		return {
			name,
			categoryId,
			kind,
			unitLabel,
			description,
			notes,
			minQuantity: kind === 'bulk' ? minQuantity : 0
		};
	}

	async function focusFirstError() {
		const key = Object.keys(errors)[0];
		if (!key) return;
		tab = 'general';
		await tick();
		document.getElementById(`article-${key}`)?.focus();
	}

	async function save() {
		const data = body();
		const parsed = articleInput.safeParse(data);
		if (!parsed.success) {
			errors = fieldErrors(parsed.error.issues);
			await focusFirstError();
			return;
		}
		errors = {};
		busy = true;
		try {
			const { kind: _kind, ...update } = data;
			void _kind;
			const saved = current
				? await apiFetch<Article>(`${API}/articles/${current.id}`, {
						method: 'PATCH',
						body: JSON.stringify(update)
					})
				: await apiFetch<Article>(`${API}/articles`, {
						method: 'POST',
						body: JSON.stringify(data)
					});
			const created = !current;
			current = saved;
			onsaved(saved);
			if (created) {
				toast.success('Artikel angelegt – jetzt kannst du Bilder hinzufügen');
				tab = 'images';
			} else {
				toast.success('Artikel gespeichert');
				open = false;
			}
		} catch (e) {
			errors = apiFieldErrors(e);
			if (Object.keys(errors).length) await focusFirstError();
			toast.error(errorText(e, 'Artikel konnte nicht gespeichert werden'));
		} finally {
			busy = false;
		}
	}

	async function setArchived(archived: boolean) {
		if (!current) return;
		busy = true;
		try {
			const saved = await apiFetch<Article>(`${API}/articles/${current.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ archived })
			});
			current = saved;
			onsaved(saved);
			toast.success(archived ? 'Artikel archiviert' : 'Artikel wieder aktiv');
			if (archived) open = false;
		} catch (e) {
			toast.error(errorText(e, 'Änderung fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!current) return;
		const id = current.id;
		try {
			const res = await apiFetch<{ deleted: boolean; archived: boolean }>(`${API}/articles/${id}`, {
				method: 'DELETE'
			});
			if (res.deleted) {
				toast.success('Artikel gelöscht');
				ondeleted?.(id);
			} else {
				toast.info('Der Artikel wird noch verwendet und wurde deshalb archiviert.');
				onsaved({ ...current, archived: true });
			}
			open = false;
		} catch (e) {
			toast.error(errorText(e, 'Artikel konnte nicht gelöscht werden'));
		}
	}

	function imagesChanged(images: ArticleImage[]) {
		if (!current) return;
		current = { ...current, images };
		onsaved(current);
	}

	const err = (k: string) => errors[k] ?? null;
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{isNew ? 'Artikel anlegen' : 'Artikel bearbeiten'}</Dialog.Title>
			<Dialog.Description>
				{isNew
					? 'Ein Artikel beschreibt eine Art Material, z. B. „Kohtenbahn“ oder „Tasse“.'
					: current?.name}
			</Dialog.Description>
		</Dialog.Header>

		<Tabs.Root value={tab} onValueChange={(v) => (tab = v as Tab)}>
			<Tabs.List variant="line" class="mb-2" aria-label="Bereiche des Artikels">
				<Tabs.Trigger value="general">Allgemein</Tabs.Trigger>
				<Tabs.Trigger value="images">
					Bilder{#if current?.images.length}<span class="ml-1 text-muted-foreground tabular-nums"
							>({current.images.length})</span
						>{/if}
				</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="general" class="space-y-4">
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<FormField label="Name" id="article-name" error={err('name')} required>
						<Input
							id="article-name"
							bind:value={name}
							maxlength={MAX_NAME}
							placeholder="z. B. Kohtenbahn"
						/>
					</FormField>
					<FormField label="Kategorie" id="article-categoryId" error={err('categoryId')}>
						<SelectField
							id="article-categoryId"
							options={categoryOptions}
							bind:value={categoryId}
							label="Kategorie"
							emptyLabel="Ohne Kategorie"
							placeholder="Ohne Kategorie"
						/>
					</FormField>
				</div>

				<fieldset class="space-y-2">
					<legend class="text-sm font-medium">Art</legend>
					{#if isNew}
						<ModeSwitch
							value={kind}
							options={kindOptions}
							label="Art des Artikels"
							onchange={(v) => (kind = v)}
						/>
						<p class="text-xs text-muted-foreground">
							{kind === 'unit'
								? 'Jedes Stück bekommt einen eigenen Code und Zustand (Zeltbahn, Kiste, Kocher).'
								: 'Nur die Anzahl je Ort zählt (Tassen, Heringe). Die Art lässt sich später nicht ändern.'}
						</p>
					{:else}
						<p class="text-sm">{ARTICLE_KIND_LABELS[kind]}</p>
						<p class="text-xs text-muted-foreground">Die Art ist nach dem Anlegen fest.</p>
					{/if}
				</fieldset>

				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<FormField
						label="Einheit"
						id="article-unitLabel"
						error={err('unitLabel')}
						hint="z. B. Stück, Paar, Rolle"
					>
						<Input id="article-unitLabel" bind:value={unitLabel} maxlength={30} />
					</FormField>
					{#if kind === 'bulk'}
						<FormField
							label="Mindestbestand"
							id="article-minQuantity"
							error={err('minQuantity')}
							hint="Darunter erscheint ein Hinweis in der Übersicht. 0 = kein Hinweis."
						>
							<NumberStepper
								id="article-minQuantity"
								bind:value={minQuantity}
								min={0}
								max={100000}
								label="Mindestbestand"
							/>
						</FormField>
					{/if}
				</div>

				<FormField label="Beschreibung" id="article-description" error={err('description')}>
					<Textarea
						id="article-description"
						bind:value={description}
						rows={3}
						maxlength={MAX_TEXT}
					/>
				</FormField>
				<FormField
					label="Interne Notiz"
					id="article-notes"
					error={err('notes')}
					hint="Nur für die Materialverwaltung, z. B. Bezugsquelle oder Pflegehinweise."
				>
					<Textarea id="article-notes" bind:value={notes} rows={2} maxlength={MAX_TEXT} />
				</FormField>

				{#if current}
					<div class="flex flex-wrap gap-2 border-t pt-4">
						{#if current.archived}
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onclick={() => setArchived(false)}
							>
								<ArchiveRestore /> Wieder aktivieren
							</Button>
						{:else}
							<Button variant="outline" size="sm" disabled={busy} onclick={() => setArchived(true)}>
								<Archive /> Archivieren
							</Button>
						{/if}
						<Button
							variant="destructive"
							size="sm"
							disabled={busy}
							onclick={() => (deleteOpen = true)}
						>
							<Trash2 /> Löschen
						</Button>
					</div>
				{/if}
			</Tabs.Content>

			<Tabs.Content value="images">
				{#if current}
					<ImageManager articleId={current.id} images={current.images} onchange={imagesChanged} />
				{:else}
					<p class="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
						Bilder kannst du hinzufügen, sobald der Artikel einmal gespeichert ist.
					</p>
				{/if}
			</Tabs.Content>
		</Tabs.Root>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>
				{isNew || tab !== 'images' ? 'Abbrechen' : 'Schließen'}
			</Button>
			{#if tab !== 'images' || isNew}
				<Button onclick={save} disabled={busy}>
					{busy ? BUSY_SAVE : isNew ? 'Anlegen' : 'Speichern'}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Artikel löschen?"
	description="Wird der Artikel noch verwendet (Stücke, Bestand, Sets oder Reservierungen), wird er stattdessen archiviert."
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
