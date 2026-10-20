<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Globe from '@lucide/svelte/icons/globe';
	import Lock from '@lucide/svelte/icons/lock';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import type { PrincipalInfo } from '$lib/sdk/types/sharing';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, SharePanel } from '$lib/components/layout';
	import type { ShareCandidate, ShareEntry } from '$lib/components/layout';
	import { shareKey } from '$lib/components/layout/share-types';
	import {
		MAX_DESCRIPTION,
		MAX_TITLE,
		SHARE_LEVELS,
		SHARE_LEVEL_LABELS,
		VISIBILITIES,
		VISIBILITY_DESCRIPTIONS,
		VISIBILITY_LABELS,
		galleryInput,
		type EventRef,
		type GalleryDetail,
		type Visibility
	} from '../schemas';
	import EventPicker from './EventPicker.svelte';

	let {
		open = $bindable(false),
		mode,
		gallery,
		onsaved
	}: {
		open?: boolean;
		mode: 'create' | 'edit';
		gallery?: GalleryDetail;
		onsaved: (detail: GalleryDetail) => void;
	} = $props();

	const BASE = '/modules/galleries';
	const LEVELS = SHARE_LEVELS.map((value) => ({ value, label: SHARE_LEVEL_LABELS[value] }));
	const VISIBILITY_ICONS = { private: Lock, public: Globe } as const;

	let title = $state('');
	let description = $state('');
	let visibility = $state<Visibility>('private');
	let shares = $state<ShareEntry[]>([]);
	let events = $state<EventRef[]>([]);
	let stammName = $state('Stamm');
	let busy = $state(false);
	let error = $state('');
	let fieldErrors = $state<Record<string, string>>({});

	const ids = {
		title: 'gal-title',
		description: 'gal-description',
		visibility: 'gal-visibility',
		eventIds: 'gal-events',
		shares: 'gal-shares'
	} as const;

	// Beim Öffnen Formular zurücksetzen bzw. mit der Galerie füllen
	$effect(() => {
		if (!open) return;
		const m = mode;
		const g = gallery;
		untrack(() => init(m, g));
	});

	function init(m: 'create' | 'edit', g: GalleryDetail | undefined) {
		error = '';
		fieldErrors = {};
		busy = false;
		if (m === 'edit' && g) {
			title = g.title;
			description = g.description ?? '';
			visibility = g.visibility;
			events = [...g.events];
		} else {
			title = '';
			description = '';
			visibility = 'private';
			events = [];
			shares = [];
			void loadStammName();
		}
	}

	async function loadStammName() {
		try {
			const r = await apiFetch<{ name: string }>(`${BASE}/settings/stamm`);
			if (r?.name) stammName = r.name;
		} catch {
			// Standardname bleibt
		}
	}

	async function searchPrincipals(q: string): Promise<ShareCandidate[]> {
		const found = await apiFetch<PrincipalInfo[]>(
			`${BASE}/principals?search=${encodeURIComponent(q)}`
		);
		return found.map((p) => ({
			id: p.id,
			type: p.type,
			name: p.name,
			detail: p.detail ?? null,
			color: p.color ?? null,
			image: p.image ?? null
		}));
	}

	// Freigaben lokal ändern – gespeichert wird erst mit dem Formular
	async function addShare(c: ShareCandidate, level: string) {
		const entry: ShareEntry = {
			userId: c.id,
			type: c.type,
			name: c.name,
			email: c.email ?? null,
			detail: c.detail ?? null,
			color: c.color ?? null,
			level
		};
		if (shares.some((s) => shareKey(s) === shareKey(entry))) return;
		shares = [...shares, entry];
	}

	async function changeShare(key: string, level: string) {
		shares = shares.map((s) => (shareKey(s) === key ? { ...s, level } : s));
	}

	async function removeShare(key: string) {
		shares = shares.filter((s) => shareKey(s) !== key);
	}

	type Issue = { path?: PropertyKey[]; message?: string };

	function issuesToErrors(issues: readonly Issue[]): Record<string, string> {
		const out: Record<string, string> = {};
		for (const i of issues) {
			const key = String((i.path ?? [])[0] ?? '');
			if (key && i.message && !out[key]) out[key] = i.message;
		}
		return out;
	}

	function detailsToErrors(details: unknown): Record<string, string> {
		if (Array.isArray(details)) return issuesToErrors(details as Issue[]);
		const issues = (details as { issues?: Issue[] } | null)?.issues;
		if (Array.isArray(issues)) return issuesToErrors(issues);
		const out: Record<string, string> = {};
		if (details && typeof details === 'object') {
			for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
				const msg = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '';
				const key = k.split('.')[0] ?? k;
				if (msg && !out[key]) out[key] = msg;
			}
		}
		return out;
	}

	async function focusFirstError() {
		await tick();
		for (const [k, id] of Object.entries(ids)) {
			if (!fieldErrors[k]) continue;
			const el =
				k === 'visibility'
					? document.querySelector<HTMLElement>(`#${id} input:checked, #${id} input`)
					: document.getElementById(id);
			if (el) {
				el.focus();
				return;
			}
		}
	}

	function showErrors(next: Record<string, string>, message: string) {
		fieldErrors = next;
		error = message;
		void focusFirstError();
	}

	const describe = (key: keyof typeof ids) => (fieldErrors[key] ? `${ids[key]}-error` : undefined);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		error = '';
		fieldErrors = {};
		const isEdit = mode === 'edit' && !!gallery;
		// PUT ersetzt alles: im Bearbeiten-Modus die vorhandenen Freigaben unverändert mitsenden
		const shareInputs = isEdit
			? (gallery?.shares ?? []).map((s) => ({ type: s.type, id: s.id, level: s.level }))
			: shares.map((s) => ({ type: s.type ?? 'user', id: s.userId, level: s.level }));
		const parsed = galleryInput.safeParse({
			title,
			description: description || null,
			visibility,
			shares: shareInputs,
			eventIds: events.map((ev) => ev.id)
		});
		if (!parsed.success) {
			showErrors(issuesToErrors(parsed.error.issues), 'Bitte die markierten Felder prüfen.');
			return;
		}
		busy = true;
		try {
			const saved = isEdit
				? await apiFetch<GalleryDetail>(`${BASE}/galleries/${encodeURIComponent(gallery!.id)}`, {
						method: 'PUT',
						body: JSON.stringify(parsed.data)
					})
				: await apiFetch<GalleryDetail>(`${BASE}/galleries`, {
						method: 'POST',
						body: JSON.stringify(parsed.data)
					});
			toast.success(isEdit ? 'Galerie gespeichert' : 'Galerie angelegt');
			open = false;
			onsaved(saved);
		} catch (err) {
			if (err instanceof ApiClientError) {
				showErrors(detailsToErrors(err.details), err.message);
			} else {
				error = 'Speichern fehlgeschlagen';
			}
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
		<Dialog.Header class="border-b p-4 pr-12">
			<Dialog.Title>{mode === 'edit' ? 'Galerie bearbeiten' : 'Neue Galerie'}</Dialog.Title>
			<Dialog.Description>Pflichtfelder sind mit * markiert.</Dialog.Description>
		</Dialog.Header>

		<form class="flex min-h-0 flex-1 flex-col" onsubmit={submit} novalidate>
			<div class="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4">
				<div class="space-y-4">
					<FormField label="Titel *" id={ids.title} error={fieldErrors.title}>
						<Input
							id={ids.title}
							bind:value={title}
							maxlength={MAX_TITLE}
							required
							autocomplete="off"
							aria-invalid={!!fieldErrors.title}
							aria-describedby={describe('title')}
						/>
					</FormField>
					<FormField label="Beschreibung" id={ids.description} error={fieldErrors.description}>
						<Textarea
							id={ids.description}
							bind:value={description}
							rows={4}
							maxlength={MAX_DESCRIPTION}
							aria-invalid={!!fieldErrors.description}
							aria-describedby={describe('description')}
						/>
					</FormField>
				</div>

				<fieldset class="min-w-0 space-y-2">
					<legend class="mb-2 text-sm font-medium">Sichtbarkeit *</legend>
					<div
						id={ids.visibility}
						class="grid gap-2 sm:grid-cols-2"
						aria-describedby={describe('visibility')}
					>
						{#each VISIBILITIES as v (v)}
							{@const Icon = VISIBILITY_ICONS[v]}
							<label
								class={[
									'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
									'hover:bg-muted/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
									visibility === v ? 'border-primary bg-primary/5' : 'border-border'
								]}
							>
								<input
									type="radio"
									name="gal-visibility"
									value={v}
									bind:group={visibility}
									class="sr-only"
								/>
								<Icon
									class={[
										'mt-0.5 size-4 shrink-0',
										visibility === v ? 'text-primary' : 'text-muted-foreground'
									]}
									aria-hidden="true"
								/>
								<span class="min-w-0">
									<span class="block font-medium">{VISIBILITY_LABELS[v]}</span>
									<span class="block text-xs text-muted-foreground">
										{VISIBILITY_DESCRIPTIONS[v]}
									</span>
								</span>
							</label>
						{/each}
					</div>
					{#if fieldErrors.visibility}
						<p id="{ids.visibility}-error" role="alert" class="text-xs text-destructive">
							{fieldErrors.visibility}
						</p>
					{/if}
				</fieldset>

				<FormField
					label="Termine"
					id={ids.eventIds}
					error={fieldErrors.eventIds}
					hint="Die ganze Galerie gehört zu diesen Terminen."
				>
					<EventPicker id={ids.eventIds} bind:value={events} disabled={busy} />
				</FormField>

				{#if mode === 'create'}
					<section class="space-y-3" aria-labelledby="gal-shares-heading">
						<div>
							<h3 id="gal-shares-heading" class="font-semibold">Freigaben</h3>
							<p class="text-xs text-muted-foreground">
								Du (Ersteller*in) kannst die Galerie immer bearbeiten. Freigaben lassen sich später
								im Seitenkopf ändern.
							</p>
						</div>
						<div
							id={ids.shares}
							tabindex="-1"
							class="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<SharePanel
								{shares}
								owner={{ name: 'Du' }}
								levels={LEVELS}
								defaultLevel="read"
								everyoneLabel={stammName}
								placeholder="Name, Gruppe, Rolle oder Mitglied suchen …"
								searchLabel="Freigabe suchen"
								emptyResultText="Keine passenden Einträge"
								search={searchPrincipals}
								onadd={addShare}
								onchange={changeShare}
								onremove={removeShare}
							/>
						</div>
						{#if fieldErrors.shares}
							<p id="{ids.shares}-error" role="alert" class="text-xs text-destructive">
								{fieldErrors.shares}
							</p>
						{/if}
					</section>
				{/if}

				{#if error}
					<p role="alert" class="text-sm text-destructive">{error}</p>
				{/if}
			</div>

			<Dialog.Footer class="mx-0 mb-0">
				<Button type="button" variant="outline" onclick={() => (open = false)} disabled={busy}>
					Abbrechen
				</Button>
				<Button type="submit" disabled={busy}>
					{busy ? 'Speichert …' : mode === 'edit' ? 'Speichern' : 'Anlegen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
