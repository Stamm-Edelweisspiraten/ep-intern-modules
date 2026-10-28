<script lang="ts">
	// Lagerorte verwalten (flache Liste, z. B. „Kiste 1“): Reihenfolge, Anlegen/Bearbeiten/Löschen, Etiketten.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Printer from '@lucide/svelte/icons/printer';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { BUSY_SAVE, ConfirmDialog, EmptyState, FormField } from '$lib/components/layout';
	import { locationInput, type Location } from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';

	let {
		open = $bindable(false),
		locations,
		canManage,
		canPrint,
		onchanged,
		onprint,
		onfilter
	}: {
		open?: boolean;
		locations: Location[];
		canManage: boolean;
		canPrint: boolean;
		onchanged: () => void;
		/** Etiketten für diese Orte drucken */
		onprint: (ids: string[]) => void;
		/** Lagertabelle auf diesen Ort filtern */
		onfilter: (id: string) => void;
	} = $props();

	let list = $state<Location[]>([]);
	let selected = $state<string[]>([]);
	let editing = $state<{ id: string | null } | null>(null);
	let name = $state('');
	let description = $state('');
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	$effect(() => {
		const source = locations;
		untrack(() => {
			list = [...source];
			selected = selected.filter((id) => source.some((l) => l.id === id));
		});
	});

	$effect(() => {
		if (!open) return;
		untrack(() => {
			editing = null;
			selected = [];
		});
	});

	const allSelected = $derived(list.length > 0 && selected.length === list.length);

	function startEdit(l: Location | null) {
		editing = { id: l?.id ?? null };
		name = l?.name ?? '';
		description = l?.description ?? '';
		errors = {};
	}

	async function save(e?: SubmitEvent) {
		e?.preventDefault();
		if (!editing) return;
		const parsed = locationInput.safeParse({ name, description });
		if (!parsed.success) {
			errors = fieldErrors(parsed.error);
			return;
		}
		busy = true;
		try {
			const id = editing.id;
			const saved = await apiFetch<Location>(id ? `${API}/locations/${id}` : `${API}/locations`, {
				method: id ? 'PATCH' : 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success(id ? 'Lagerort gespeichert' : `Lagerort angelegt (Code ${saved.code})`);
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
		const [l] = next.splice(from, 1);
		next.splice(to, 0, l!);
		list = next;
		busy = true;
		try {
			await apiFetch(`${API}/locations/order`, {
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

	let deleteTarget = $state<Location | null>(null);
	let deleteOpen = $state(false);

	async function remove() {
		const l = deleteTarget;
		if (!l) return;
		try {
			const res = await apiFetch<{ itemsWithoutPlace: number }>(`${API}/locations/${l.id}`, {
				method: 'DELETE'
			});
			toast.success(
				res.itemsWithoutPlace
					? `„${l.name}“ gelöscht – ${res.itemsWithoutPlace} Artikel sind jetzt ohne Lagerort`
					: `„${l.name}“ gelöscht`
			);
			onchanged();
		} catch (err) {
			toast.error(errorText(err, 'Lagerort konnte nicht gelöscht werden'));
		}
	}

	function toggle(id: string, on: boolean) {
		selected = on ? [...new Set([...selected, id])] : selected.filter((x) => x !== id);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		{#if !editing}
			<Dialog.Header>
				<Dialog.Title>Lagerorte</Dialog.Title>
				<Dialog.Description>
					Orte wie „Kiste 1“ oder „Regal Keller“. Jeder Ort hat einen Code (L-…) für Etiketten – ein
					Scan zeigt, was dort liegt.
				</Dialog.Description>
			</Dialog.Header>
			{#if list.length}
				{#if canPrint}
					<label class="flex items-center gap-2 px-3 text-sm">
						<Checkbox
							checked={allSelected}
							indeterminate={selected.length > 0 && !allSelected}
							onCheckedChange={(v) => (selected = v === true ? list.map((l) => l.id) : [])}
						/>
						Alle auswählen
					</label>
				{/if}
				<ul class="divide-y rounded-lg border">
					{#each list as l, i (l.id)}
						<li class="flex items-center gap-3 px-3 py-2">
							{#if canPrint}
								<Checkbox
									aria-label={`${l.name} auswählen`}
									checked={selected.includes(l.id)}
									onCheckedChange={(v) => toggle(l.id, v === true)}
								/>
							{/if}
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-baseline gap-x-2">
									<span class="truncate font-medium">{l.name}</span>
									<span class="font-mono text-xs text-muted-foreground">{l.code}</span>
								</div>
								{#if l.description}
									<div class="line-clamp-2 text-xs text-muted-foreground">{l.description}</div>
								{/if}
								<button
									type="button"
									class="text-xs text-link hover:underline"
									onclick={() => onfilter(l.id)}
								>
									{l.itemCount === 1 ? '1 Artikel' : `${l.itemCount} Artikel`} zeigen
								</button>
							</div>
							{#if canManage}
								<div class="flex shrink-0 flex-wrap items-center justify-end">
									<Button
										variant="ghost"
										size="icon"
										aria-label={`${l.name} nach oben`}
										disabled={busy || i === 0}
										onclick={() => move(i, i - 1)}
									>
										<ArrowUp />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										aria-label={`${l.name} nach unten`}
										disabled={busy || i === list.length - 1}
										onclick={() => move(i, i + 1)}
									>
										<ArrowDown />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										aria-label={`${l.name} bearbeiten`}
										onclick={() => startEdit(l)}
									>
										<Pencil />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										class="text-destructive hover:text-destructive"
										aria-label={`${l.name} löschen`}
										onclick={() => {
											deleteTarget = l;
											deleteOpen = true;
										}}
									>
										<Trash2 />
									</Button>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<EmptyState
					title="Noch keine Lagerorte"
					description="Lege Orte wie „Kiste 1“, „Zeltregal“ oder „Küchenschrank“ an."
				/>
			{/if}
			<Dialog.Footer class="sm:justify-between">
				<div class="flex flex-col gap-2 sm:flex-row">
					{#if canManage}
						<Button variant="outline" onclick={() => startEdit(null)}>
							<Plus /> Lagerort anlegen
						</Button>
					{/if}
					{#if canPrint}
						<Button variant="outline" disabled={!selected.length} onclick={() => onprint(selected)}>
							<Printer />
							Etiketten drucken{selected.length ? ` (${selected.length})` : ''}
						</Button>
					{/if}
				</div>
				<Button variant="ghost" onclick={() => (open = false)}>Schließen</Button>
			</Dialog.Footer>
		{:else}
			<Dialog.Header>
				<Dialog.Title>{editing.id ? 'Lagerort bearbeiten' : 'Lagerort anlegen'}</Dialog.Title>
				<Dialog.Description>
					{editing.id
						? 'Der Code bleibt gleich, gedruckte Etiketten gelten weiter.'
						: 'Der Code (L-…) wird automatisch vergeben.'}
				</Dialog.Description>
			</Dialog.Header>
			<form id="location-form" class="grid gap-4" onsubmit={save}>
				<FormField label="Name" id="location-name" required error={errors.name}>
					<Input
						id="location-name"
						bind:value={name}
						maxlength={150}
						placeholder="z. B. Kiste 1"
						autocomplete="off"
					/>
				</FormField>
				<FormField
					label="Beschreibung"
					id="location-description"
					hint="z. B. „Küchenmaterial, im Keller links“"
					error={errors.description}
				>
					<Textarea id="location-description" bind:value={description} rows={3} />
				</FormField>
			</form>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (editing = null)}>Zurück</Button>
				<Button type="submit" form="location-form" disabled={busy}>
					{busy ? BUSY_SAVE : 'Speichern'}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Lagerort löschen?"
	description={deleteTarget
		? deleteTarget.itemCount
			? `„${deleteTarget.name}“ wird gelöscht. ${deleteTarget.itemCount === 1 ? 'Der Artikel dort ist' : `Die ${deleteTarget.itemCount} Artikel dort sind`} danach ohne Lagerort. Gedruckte Etiketten des Orts gelten nicht mehr.`
			: `„${deleteTarget.name}“ wird gelöscht. Gedruckte Etiketten des Orts gelten nicht mehr.`
		: ''}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
