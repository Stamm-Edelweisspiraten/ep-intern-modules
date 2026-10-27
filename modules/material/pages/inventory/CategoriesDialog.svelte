<script lang="ts">
	// Kategorien verwalten: anlegen, bearbeiten (Name, Farbe, Icon), löschen.
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Tag from '@lucide/svelte/icons/tag';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { ColorPicker } from '$lib/components/ui/color-picker';
	import * as Dialog from '$lib/components/ui/dialog';
	import { DynamicIcon, IconPicker } from '$lib/components/ui/icon-picker';
	import { Input } from '$lib/components/ui/input';
	import { BUSY_SAVE, ConfirmDialog, FormField } from '$lib/components/layout';
	import { MAX_NAME, categoryInput, type Category } from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';

	let {
		open = $bindable(false),
		categories,
		onchanged
	}: {
		open?: boolean;
		categories: Category[];
		/** Nach jeder Änderung (Liste neu laden) */
		onchanged: () => void | Promise<void>;
	} = $props();

	let editing = $state<Category | null>(null);
	let name = $state('');
	let color = $state<string | null>(null);
	let icon = $state<string | null>(null);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);
	let deleteTarget = $state<Category | null>(null);
	let deleteOpen = $state(false);

	function reset() {
		editing = null;
		name = '';
		color = null;
		icon = null;
		errors = {};
	}

	async function edit(c: Category) {
		editing = c;
		name = c.name;
		color = c.color;
		icon = c.icon;
		errors = {};
		await tick();
		document.getElementById('category-name')?.focus();
	}

	async function save() {
		const data = { name, color, icon };
		const parsed = categoryInput.safeParse(data);
		if (!parsed.success) {
			errors = fieldErrors(parsed.error.issues);
			document.getElementById('category-name')?.focus();
			return;
		}
		errors = {};
		busy = true;
		try {
			if (editing) {
				await apiFetch(`${API}/categories/${editing.id}`, {
					method: 'PATCH',
					body: JSON.stringify(data)
				});
				toast.success('Kategorie gespeichert');
			} else {
				await apiFetch(`${API}/categories`, { method: 'POST', body: JSON.stringify(data) });
				toast.success('Kategorie angelegt');
			}
			reset();
			await onchanged();
		} catch (e) {
			errors = apiFieldErrors(e);
			toast.error(errorText(e, 'Kategorie konnte nicht gespeichert werden'));
		} finally {
			busy = false;
		}
	}

	async function remove() {
		const c = deleteTarget;
		if (!c) return;
		try {
			await apiFetch(`${API}/categories/${c.id}`, { method: 'DELETE' });
			toast.success('Kategorie gelöscht');
			if (editing?.id === c.id) reset();
			await onchanged();
		} catch (e) {
			toast.error(errorText(e, 'Kategorie konnte nicht gelöscht werden'));
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(v) => !v && reset()}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Kategorien</Dialog.Title>
			<Dialog.Description>
				Kategorien ordnen Artikel, z. B. Zelte, Küche, Werkzeug.
			</Dialog.Description>
		</Dialog.Header>

		<form
			class="space-y-3 rounded-lg border p-3"
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<p class="text-sm font-medium">{editing ? 'Kategorie bearbeiten' : 'Neue Kategorie'}</p>
			<FormField label="Name" id="category-name" error={errors.name ?? null} required>
				<Input
					id="category-name"
					bind:value={name}
					maxlength={MAX_NAME}
					placeholder="z. B. Zelte"
				/>
			</FormField>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<FormField label="Farbe" id="category-color" error={errors.color ?? null}>
					<ColorPicker id="category-color" bind:value={color} label="Farbe" allowClear />
				</FormField>
				<div class="space-y-1.5">
					<p class="text-sm font-medium">Icon</p>
					<IconPicker bind:value={icon} label="Icon der Kategorie" />
				</div>
			</div>
			<div class="flex flex-wrap justify-end gap-2">
				{#if editing}
					<Button variant="outline" type="button" onclick={reset}>Abbrechen</Button>
				{/if}
				<Button type="submit" disabled={busy}>
					{#if busy}{BUSY_SAVE}{:else if editing}Speichern{:else}<Plus /> Anlegen{/if}
				</Button>
			</div>
		</form>

		{#if categories.length}
			<ul class="divide-y rounded-lg border">
				{#each categories as c (c.id)}
					<li class="flex items-center gap-3 px-3 py-2 text-sm">
						<span
							class="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted"
							style:color={c.color ?? undefined}
							aria-hidden="true"
						>
							<DynamicIcon name={c.icon} class="size-4">
								{#snippet fallback()}<Tag class="size-4" />{/snippet}
							</DynamicIcon>
						</span>
						<span class="min-w-0 flex-1">
							<span class="block truncate font-medium">{c.name}</span>
							<span class="block text-xs text-muted-foreground">
								{c.articleCount === 1 ? '1 Artikel' : `${c.articleCount} Artikel`}
							</span>
						</span>
						<Button
							variant="ghost"
							size="icon"
							aria-label={`${c.name} bearbeiten`}
							onclick={() => edit(c)}
						>
							<Pencil />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							class="text-destructive hover:text-destructive"
							aria-label={`${c.name} löschen`}
							onclick={() => {
								deleteTarget = c;
								deleteOpen = true;
							}}
						>
							<Trash2 />
						</Button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-muted-foreground">Noch keine Kategorien.</p>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Schließen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Kategorie löschen?"
	description={deleteTarget?.articleCount
		? `${deleteTarget.articleCount} Artikel verlieren diese Kategorie.`
		: 'Die Kategorie wird entfernt.'}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
