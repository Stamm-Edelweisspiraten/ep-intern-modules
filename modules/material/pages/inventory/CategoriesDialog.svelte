<script lang="ts">
	// Kategorien verwalten: Liste mit Reihenfolge, Anlegen/Bearbeiten mit Name, Icon und Farbe, Löschen.
	// Vorbild für Icon/Farbe: files/pages/FolderStyleDialog.svelte.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Check from '@lucide/svelte/icons/check';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { iconLabel } from '$lib/sdk/icons';
	import { STYLE_COLORS } from '$lib/sdk/style-presets';
	import { Button } from '$lib/components/ui/button';
	import { ColorPicker, contrastTextColor } from '$lib/components/ui/color-picker';
	import * as Dialog from '$lib/components/ui/dialog';
	import { IconPicker } from '$lib/components/ui/icon-picker';
	import { Input } from '$lib/components/ui/input';
	import { BUSY_SAVE, ConfirmDialog, EmptyState, FormField } from '$lib/components/layout';
	import { cn } from '$lib/utils';
	import { categoryInput, type Category } from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import CategoryGlyph from '../shared/CategoryGlyph.svelte';

	let {
		open = $bindable(false),
		categories,
		onchanged
	}: {
		open?: boolean;
		categories: Category[];
		/** Nach jeder Änderung (Liste neu laden) */
		onchanged: () => void;
	} = $props();

	/** `null` = Liste, sonst Formular (Anlegen: `id` leer) */
	let editing = $state<{ id: string | null } | null>(null);
	let name = $state('');
	let icon = $state<string | null>(null);
	let color = $state<string | null>(null);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);
	let list = $state<Category[]>([]);

	$effect(() => {
		const source = categories;
		untrack(() => (list = [...source]));
	});

	$effect(() => {
		if (!open) return;
		untrack(() => (editing = null));
	});

	const presetValues = STYLE_COLORS.map((c) => c.value);

	function startEdit(c: Category | null) {
		editing = { id: c?.id ?? null };
		name = c?.name ?? '';
		icon = c?.icon ?? null;
		color = c?.color ?? null;
		errors = {};
	}

	async function save(e?: SubmitEvent) {
		e?.preventDefault();
		if (!editing) return;
		const parsed = categoryInput.safeParse({ name, icon, color });
		if (!parsed.success) {
			errors = fieldErrors(parsed.error);
			return;
		}
		busy = true;
		try {
			const id = editing.id;
			await apiFetch<Category>(id ? `${API}/categories/${id}` : `${API}/categories`, {
				method: id ? 'PATCH' : 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success(id ? 'Kategorie gespeichert' : 'Kategorie angelegt');
			editing = null;
			onchanged();
		} catch (err) {
			errors = apiFieldErrors(err);
			if (!Object.keys(errors).length) toast.error(errorText(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function move(from: number, to: number) {
		if (to < 0 || to >= list.length) return;
		const before = list;
		const next = [...list];
		const [c] = next.splice(from, 1);
		next.splice(to, 0, c!);
		list = next;
		busy = true;
		try {
			await apiFetch(`${API}/categories/order`, {
				method: 'PUT',
				body: JSON.stringify({ ids: next.map((x) => x.id) })
			});
			onchanged();
		} catch (err) {
			list = before;
			toast.error(errorText(err, 'Reihenfolge konnte nicht gespeichert werden'));
		} finally {
			busy = false;
		}
	}

	let deleteTarget = $state<Category | null>(null);
	let deleteOpen = $state(false);

	async function remove() {
		const c = deleteTarget;
		if (!c) return;
		try {
			await apiFetch(`${API}/categories/${c.id}`, { method: 'DELETE' });
			toast.success(`Kategorie „${c.name}“ gelöscht`);
			onchanged();
		} catch (err) {
			toast.error(errorText(err, 'Kategorie konnte nicht gelöscht werden'));
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		{#if !editing}
			<Dialog.Header>
				<Dialog.Title>Kategorien</Dialog.Title>
				<Dialog.Description>
					Sortiere Typen und Lagerartikel in Kategorien mit Icon und Farbe. Die Reihenfolge gilt
					auch für Listen und Exporte.
				</Dialog.Description>
			</Dialog.Header>
			{#if list.length}
				<ul class="divide-y rounded-lg border">
					{#each list as c, i (c.id)}
						<li class="flex items-center gap-3 px-3 py-2">
							<CategoryGlyph category={c} />
							<div class="min-w-0 flex-1">
								<div class="truncate font-medium">{c.name}</div>
								<div class="text-xs text-muted-foreground">
									{c.count === 1 ? '1 Eintrag' : `${c.count} Einträge`}
								</div>
							</div>
							<div class="flex shrink-0 items-center">
								<Button
									variant="ghost"
									size="icon"
									aria-label={`${c.name} nach oben`}
									disabled={busy || i === 0}
									onclick={() => move(i, i - 1)}
								>
									<ArrowUp />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									aria-label={`${c.name} nach unten`}
									disabled={busy || i === list.length - 1}
									onclick={() => move(i, i + 1)}
								>
									<ArrowDown />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									aria-label={`${c.name} bearbeiten`}
									onclick={() => startEdit(c)}
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
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<EmptyState
					title="Noch keine Kategorien"
					description="Lege Kategorien wie „Zelte“, „Küche“ oder „Werkzeug“ an."
				/>
			{/if}
			<Dialog.Footer class="sm:justify-between">
				<Button variant="outline" onclick={() => startEdit(null)}><Plus /> Kategorie anlegen</Button
				>
				<Button variant="ghost" onclick={() => (open = false)}>Schließen</Button>
			</Dialog.Footer>
		{:else}
			<Dialog.Header>
				<Dialog.Title>{editing.id ? 'Kategorie bearbeiten' : 'Kategorie anlegen'}</Dialog.Title>
				<Dialog.Description
					>Name, Icon und Farbe sehen alle mit Zugriff auf das Lager.</Dialog.Description
				>
			</Dialog.Header>
			<form id="category-form" class="grid gap-5" onsubmit={save}>
				<div class="flex items-end gap-3">
					<CategoryGlyph category={{ name: name || 'Vorschau', icon, color }} size="lg" />
					<div class="min-w-0 flex-1">
						<FormField label="Name" id="category-name" required error={errors.name}>
							<Input id="category-name" bind:value={name} maxlength={150} autocomplete="off" />
						</FormField>
					</div>
				</div>

				<fieldset class="grid gap-2">
					<legend class="mb-1 text-sm font-medium">Farbe</legend>
					<div
						class="flex flex-wrap items-center gap-2"
						role="radiogroup"
						aria-label="Vorschlagsfarben"
					>
						{#each STYLE_COLORS as c (c.value)}
							{@const active = color === c.value}
							<button
								type="button"
								role="radio"
								aria-checked={active}
								aria-label={c.label}
								title={c.label}
								class={cn(
									'flex size-8 items-center justify-center rounded-full border-2 border-background ring-1 ring-border transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring',
									active && 'ring-2 ring-foreground'
								)}
								style:background-color={c.value}
								onclick={() => (color = c.value)}
							>
								{#if active}
									<Check
										class="size-4"
										style="color: {contrastTextColor(c.value)}"
										aria-hidden="true"
									/>
								{/if}
							</button>
						{/each}
						<span class="mx-1 h-6 w-px bg-border" aria-hidden="true"></span>
						<ColorPicker
							label="Eigene Farbe"
							value={color}
							onchange={(v) => (color = v ? v.toLowerCase() : null)}
							presets={presetValues}
							class="w-40"
						/>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-pressed={color === null}
							onclick={() => (color = null)}
						>
							Keine
						</Button>
					</div>
					{#if errors.color}<p class="text-xs text-destructive" role="alert">{errors.color}</p>{/if}
				</fieldset>

				<fieldset class="grid gap-2">
					<div class="flex items-center justify-between gap-2">
						<legend class="text-sm font-medium">
							Icon <span class="font-normal text-muted-foreground"
								>· {icon ? iconLabel(icon) : 'keins'}</span
							>
						</legend>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={icon === null}
							onclick={() => (icon = null)}
						>
							Kein Icon
						</Button>
					</div>
					<div class="max-h-[min(22rem,45dvh)] overflow-y-auto rounded-md border p-2">
						<IconPicker bind:value={icon} />
					</div>
					{#if errors.icon}<p class="text-xs text-destructive" role="alert">{errors.icon}</p>{/if}
				</fieldset>
			</form>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (editing = null)}>Zurück</Button>
				<Button type="submit" form="category-form" disabled={busy}>
					{busy ? BUSY_SAVE : 'Speichern'}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Kategorie löschen?"
	description={deleteTarget
		? `„${deleteTarget.name}“ wird gelöscht. Typen und Lagerartikel darin bleiben erhalten und sind danach ohne Kategorie.`
		: ''}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
