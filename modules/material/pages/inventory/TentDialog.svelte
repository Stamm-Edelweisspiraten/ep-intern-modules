<script lang="ts">
	// Zelt (Bauplan) anlegen oder bearbeiten: Name, Beschreibung, Kategorie und Teile je Zelt – Typen
	// („Dach: 6 × Kohtenbahn, möglichst aus einem Set“) oder einzelne Artikel ohne Typ („1 × Abspannseil“).
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { BUSY_SAVE, FormField, NumberStepper } from '$lib/components/layout';
	import {
		MAX_PART_LABEL,
		MAX_QUANTITY,
		MAX_TENT_PARTS,
		tentInput,
		type Category,
		type Inventory,
		type Tent,
		type TentPartInput
	} from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import { categoryOptions, type Option } from './options';

	let {
		open = $bindable(false),
		tent = null,
		categories,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neu anlegen */
		tent?: Tent | null;
		categories: Category[];
		onsaved: (tent: Tent) => void;
	} = $props();

	interface PartRow {
		key: number;
		/** `type:<id>` oder `item:<id>` */
		target: string | null;
		label: string;
		quantity: number;
		fromOneSet: boolean;
	}

	let name = $state('');
	let description = $state('');
	let categoryId = $state<string | null>(null);
	let parts = $state<PartRow[]>([]);
	let targets = $state<Option[]>([]);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);
	let nextKey = 0;

	const row = (p: Partial<PartRow> = {}): PartRow => ({
		key: nextKey++,
		target: null,
		label: '',
		quantity: 1,
		fromOneSet: false,
		...p
	});

	$effect(() => {
		if (!open) return;
		untrack(() => {
			name = tent?.name ?? '';
			description = tent?.description ?? '';
			categoryId = tent?.categoryId ?? null;
			parts = tent
				? tent.parts.map((p) =>
						row({
							target: p.typeId ? `type:${p.typeId}` : `item:${p.itemId}`,
							label: p.label,
							quantity: p.quantity,
							fromOneSet: p.fromOneSet
						})
					)
				: [row()];
			errors = {};
			void loadTargets();
		});
	});

	/** Wählbar: alle Typen und Artikel ohne Typ */
	async function loadTargets() {
		try {
			const inv = await apiFetch<Inventory>(`${API}/inventory`);
			targets = [
				...inv.types.map((t) => ({ value: `type:${t.id}`, label: `${t.name} (Typ)` })),
				...inv.items.map((i) => ({ value: `item:${i.id}`, label: `${i.name} · ${i.code}` }))
			];
		} catch (e) {
			toast.error(errorText(e, 'Typen und Artikel konnten nicht geladen werden'));
		}
	}

	function move(i: number, dir: -1 | 1) {
		const j = i + dir;
		if (j < 0 || j >= parts.length) return;
		const next = [...parts];
		[next[i], next[j]] = [next[j]!, next[i]!];
		parts = next;
	}

	function payload() {
		return {
			name,
			description,
			categoryId,
			parts: parts.map((p): TentPartInput | { kind: null } => {
				const [kind, id] = (p.target ?? ':').split(':');
				if (kind === 'type')
					return {
						kind: 'type',
						typeId: id!,
						label: p.label,
						quantity: p.quantity,
						fromOneSet: p.fromOneSet
					};
				if (kind === 'item')
					return { kind: 'item', itemId: id!, label: p.label, quantity: p.quantity };
				return { kind: null };
			})
		};
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		errors = {};
		const missing = parts.findIndex((p) => !p.target);
		if (missing >= 0) {
			errors = { [`parts.${missing}`]: 'Bitte Typ oder Artikel wählen' };
			document.getElementById(`tent-part-${parts[missing]!.key}`)?.focus();
			return;
		}
		const parsed = tentInput.safeParse(payload());
		if (!parsed.success) {
			errors = fieldErrors(parsed.error);
			if (errors.name) document.getElementById('tent-name')?.focus();
			return;
		}
		busy = true;
		try {
			const saved = await apiFetch<Tent>(tent ? `${API}/tents/${tent.id}` : `${API}/tents`, {
				method: tent ? 'PATCH' : 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success(tent ? 'Zelt gespeichert' : 'Zelt angelegt');
			onsaved(saved);
			open = false;
		} catch (err) {
			errors = apiFieldErrors(err);
			toast.error(errorText(err, 'Zelt konnte nicht gespeichert werden'));
		} finally {
			busy = false;
		}
	}

	const partError = (i: number) =>
		Object.entries(errors).find(([k]) => k === `parts.${i}` || k.startsWith(`parts.${i}.`))?.[1];
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{tent ? 'Zelt bearbeiten' : 'Zelt anlegen'}</Dialog.Title>
			<Dialog.Description>
				Ein Zelt ist ein Bauplan: Welche Teile braucht es je Zelt? Beim Reservieren teilt das System
				passende Bahnen zu – mit „aus einem Set“ möglichst zusammengehörige.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={save} novalidate>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Name" id="tent-name" required error={errors.name}>
					<Input id="tent-name" bind:value={name} maxlength={150} placeholder="z. B. Jurte" />
				</FormField>
				<FormField label="Kategorie" id="tent-category" error={errors.categoryId}>
					<SelectField
						id="tent-category"
						label="Kategorie"
						options={categoryOptions(categories)}
						emptyLabel="Ohne Kategorie"
						bind:value={categoryId}
					/>
				</FormField>
			</div>
			<FormField label="Beschreibung" id="tent-description" error={errors.description}>
				<Textarea id="tent-description" bind:value={description} rows={2} />
			</FormField>

			<fieldset class="space-y-2">
				<legend class="text-sm font-medium">Teile je Zelt</legend>
				{#if errors.parts}
					<p class="text-xs text-destructive" role="alert">{errors.parts}</p>
				{/if}
				<ul class="space-y-3">
					{#each parts as p, i (p.key)}
						{@const isType = p.target?.startsWith('type:') ?? false}
						{@const err = partError(i)}
						<li class="space-y-2 rounded-md border p-3">
							<div class="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_auto]">
								<div class="space-y-1">
									<Label for={`tent-label-${p.key}`} class="text-xs">Bezeichnung</Label>
									<Input
										id={`tent-label-${p.key}`}
										bind:value={p.label}
										maxlength={MAX_PART_LABEL}
										placeholder="z. B. Dach"
									/>
								</div>
								<div class="space-y-1">
									<Label for={`tent-part-${p.key}`} class="text-xs">Typ oder Artikel *</Label>
									<SelectField
										id={`tent-part-${p.key}`}
										label="Typ oder Artikel"
										options={targets}
										placeholder="Wählen …"
										bind:value={p.target}
									/>
								</div>
								<div class="space-y-1">
									<span class="text-xs font-medium">Anzahl</span>
									<NumberStepper
										label={`Anzahl Teil ${i + 1}`}
										bind:value={p.quantity}
										min={1}
										max={MAX_QUANTITY}
									/>
								</div>
							</div>
							<div class="flex flex-wrap items-center justify-between gap-2">
								{#if isType}
									<label class="flex items-center gap-2 text-sm">
										<Switch
											checked={p.fromOneSet}
											onCheckedChange={(v) => (p.fromOneSet = v)}
											aria-label="Möglichst aus einem Set"
										/>
										Möglichst aus einem Set
									</label>
								{:else}
									<span></span>
								{/if}
								<div class="flex gap-1">
									<Button
										type="button"
										size="icon-sm"
										variant="ghost"
										aria-label="Nach oben"
										disabled={i === 0}
										onclick={() => move(i, -1)}
									>
										<ArrowUp />
									</Button>
									<Button
										type="button"
										size="icon-sm"
										variant="ghost"
										aria-label="Nach unten"
										disabled={i === parts.length - 1}
										onclick={() => move(i, 1)}
									>
										<ArrowDown />
									</Button>
									<Button
										type="button"
										size="icon-sm"
										variant="ghost"
										aria-label={`Teil ${i + 1} entfernen`}
										disabled={parts.length === 1}
										onclick={() => (parts = parts.filter((x) => x.key !== p.key))}
									>
										<Trash2 />
									</Button>
								</div>
							</div>
							{#if err}<p class="text-xs text-destructive" role="alert">{err}</p>{/if}
						</li>
					{/each}
				</ul>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={parts.length >= MAX_TENT_PARTS}
					onclick={() => (parts = [...parts, row()])}
				>
					<Plus /> Teil hinzufügen
				</Button>
			</fieldset>

			<Dialog.Footer class="sticky bottom-0">
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
