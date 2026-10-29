<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, AssistTextarea } from '$lib/components/layout';
	import {
		MAX_DESCRIPTION,
		MAX_NOTES,
		MAX_TITLE,
		MAX_URL,
		articleInput,
		type Article,
		type ArticleImage
	} from '../schemas';
	import ImageManager from './ImageManager.svelte';
	import VariantEditor from './VariantEditor.svelte';
	import {
		BASE,
		detailsToErrors,
		errorText,
		issuesToErrors,
		newVariantRow,
		type VariantRow
	} from './helpers';

	/**
	 * Artikel anlegen/bearbeiten. Der Aufrufer rendert den Dialog per `{#key}` neu, damit das
	 * Formular bei jedem Öffnen aus `article` startet.
	 */
	let {
		open = $bindable(false),
		article = null,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neuer Artikel */
		article?: Article | null;
		/** Nach jedem Speichern (auch Bilder) – Liste neu laden */
		onsaved: (article: Article) => void;
	} = $props();

	type Tab = 'general' | 'variants' | 'images';

	const initial = untrack(() => article);
	let current = $state<Article | null>(initial);
	let tab = $state<Tab>('general');

	let title = $state(initial?.title ?? '');
	let description = $state(initial?.description ?? '');
	let notes = $state(initial?.notes ?? '');
	let reorderUrl = $state(initial?.reorderUrl ?? '');
	let active = $state(initial?.active ?? true);
	let hasSizes = $state(initial?.hasSizes ?? false);
	const initialRows: VariantRow[] = (initial?.variants ?? [])
		.filter((v) => !v.archived)
		.map((v) =>
			newVariantRow({
				id: v.id,
				label: v.label,
				priceCents: v.priceCents,
				reorderUrl: v.reorderUrl ?? '',
				minStock: v.minStock ?? 0,
				stock: v.stock
			})
		);
	let rows = $state<VariantRow[]>(initialRows.length ? initialRows : [newVariantRow()]);

	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	const isNew = $derived(!current);
	const variantErrorCount = $derived(
		Object.keys(errors).filter((k) => k.startsWith('variants')).length
	);
	const generalErrorCount = $derived(
		Object.keys(errors).filter((k) => !k.startsWith('variants')).length
	);

	function payload() {
		return {
			title,
			description,
			notes,
			reorderUrl,
			active,
			variants: (hasSizes ? rows : rows.slice(0, 1)).map((r) => ({
				...(r.id ? { id: r.id } : {}),
				label: hasSizes ? r.label : '',
				priceCents: r.priceCents,
				reorderUrl: hasSizes ? r.reorderUrl : '',
				minStock: r.minStock
			}))
		};
	}

	/** Erstes fehlerhaftes Feld zeigen und fokussieren */
	async function focusFirstError() {
		const keys = Object.keys(errors);
		if (!keys.length) return;
		const general = keys.find((k) => !k.startsWith('variants'));
		tab = general ? 'general' : 'variants';
		await tick();
		const key = general ?? keys[0]!;
		const m = /^variants\.(\d+)\.(\w+)$/.exec(key);
		const id = m
			? `variant-${m[2] === 'label' ? 'label' : m[2] === 'priceCents' ? 'price' : m[2] === 'reorderUrl' ? 'url' : 'min'}-${m[1]}`
			: `article-${key}`;
		document.getElementById(id)?.focus();
	}

	async function save() {
		const body = payload();
		const parsed = articleInput.safeParse(body);
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			await focusFirstError();
			return;
		}
		errors = {};
		busy = true;
		try {
			const saved = current
				? await apiFetch<Article>(`${BASE}/articles/${current.id}`, {
						method: 'PATCH',
						body: JSON.stringify(body)
					})
				: await apiFetch<Article>(`${BASE}/articles`, {
						method: 'POST',
						body: JSON.stringify(body)
					});
			const created = !current;
			current = saved;
			// Neue Varianten-IDs übernehmen, damit erneutes Speichern nichts doppelt anlegt
			rows = rows.map((r, i) => {
				const v = saved.variants.filter((x) => !x.archived)[i];
				return v && !r.id ? { ...r, id: v.id } : r;
			});
			onsaved(saved);
			if (created) {
				toast.success('Artikel angelegt – jetzt kannst du Bilder hinzufügen');
				tab = 'images';
			} else {
				toast.success('Artikel gespeichert');
				open = false;
			}
		} catch (e) {
			if (e instanceof ApiClientError && e.details) {
				errors = detailsToErrors(e.details);
				if (Object.keys(errors).length) await focusFirstError();
			}
			toast.error(errorText(e, 'Artikel konnte nicht gespeichert werden'));
		} finally {
			busy = false;
		}
	}

	function imagesChanged(images: ArticleImage[]) {
		if (!current) return;
		current = { ...current, images, cover: images[0] ?? null };
		onsaved(current);
	}

	const fieldError = (key: string) => errors[key] ?? null;
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>{isNew ? 'Artikel anlegen' : 'Artikel bearbeiten'}</Dialog.Title>
			<Dialog.Description>
				{isNew
					? 'Titel, Größen und Preise festlegen. Bilder kannst du nach dem ersten Speichern hinzufügen.'
					: current?.title}
			</Dialog.Description>
		</Dialog.Header>

		<Tabs.Root value={tab} onValueChange={(v) => (tab = v as Tab)}>
			<Tabs.List variant="line" class="mb-2" aria-label="Bereiche des Artikels">
				<Tabs.Trigger value="general">
					Allgemein{#if generalErrorCount}<span class="ml-1 text-destructive" aria-hidden="true"
							>•</span
						>{/if}
				</Tabs.Trigger>
				<Tabs.Trigger value="variants">
					Größen & Preise{#if variantErrorCount}<span
							class="ml-1 text-destructive"
							aria-hidden="true">•</span
						>{/if}
				</Tabs.Trigger>
				<Tabs.Trigger value="images">
					Bilder{#if current?.images.length}<span class="ml-1 text-muted-foreground tabular-nums"
							>({current.images.length})</span
						>{/if}
				</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="general" class="space-y-4">
				<FormField label="Titel *" id="article-title" error={fieldError('title')}>
					<Input
						id="article-title"
						bind:value={title}
						maxlength={MAX_TITLE}
						placeholder="z. B. Halstuch"
						aria-invalid={fieldError('title') ? 'true' : undefined}
					/>
				</FormField>
				<FormField
					label="Beschreibung"
					id="article-description"
					error={fieldError('description')}
					hint="Für alle sichtbar. Zeilenumbrüche bleiben erhalten."
				>
					<AssistTextarea
						id="article-description"
						bind:value={description}
						assist={{
							module: 'orders',
							purpose: 'article-description',
							extra: () => ({ name: title })
						}}
						rows={4}
						maxlength={MAX_DESCRIPTION}
						aria-invalid={fieldError('description') ? 'true' : undefined}
					/>
				</FormField>
				<FormField
					label="Interne Notizen"
					id="article-notes"
					error={fieldError('notes')}
					hint="Nur für Kämmerer*in sichtbar, z. B. Lieferant, Einkaufspreis, Besonderheiten."
				>
					<Textarea
						id="article-notes"
						bind:value={notes}
						rows={3}
						maxlength={MAX_NOTES}
						aria-invalid={fieldError('notes') ? 'true' : undefined}
					/>
				</FormField>
				<FormField
					label="Nachbestelllink"
					id="article-reorderUrl"
					error={fieldError('reorderUrl')}
					hint="Shop-Seite für Nachbestellungen. Größen können eigene Links haben."
				>
					<Input
						id="article-reorderUrl"
						type="url"
						bind:value={reorderUrl}
						maxlength={MAX_URL}
						placeholder="https://…"
						aria-invalid={fieldError('reorderUrl') ? 'true' : undefined}
					/>
				</FormField>
				<div class="flex items-start gap-3">
					<Switch id="article-active" bind:checked={active} class="mt-0.5" />
					<div class="space-y-0.5">
						<Label for="article-active" class="font-normal">Im Katalog bestellbar</Label>
						<p class="text-xs text-muted-foreground">
							Ausgeschaltet bleibt der Artikel in der Verwaltung, erscheint aber nicht im Katalog.
						</p>
					</div>
				</div>
			</Tabs.Content>

			<Tabs.Content value="variants">
				<VariantEditor bind:hasSizes bind:rows {errors} disabled={busy} />
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
					{busy ? 'Speichert …' : isNew ? 'Anlegen' : 'Speichern'}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
