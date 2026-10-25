<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch, ApiClientError } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { ColorPicker } from '$lib/components/ui/color-picker';
	import { SelectField } from '$lib/components/ui/select-field';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import {
		BOARD_COLORS,
		MAX_BOARD_DESCRIPTION,
		MAX_BOARD_NAME,
		boardInput,
		type Board,
		type BoardDetail
	} from '../schemas';
	import { BASE, errMsg } from './helpers';

	/** Anlegen bzw. Bearbeiten (Name, Beschreibung, Farbe; Aktion nur beim Anlegen) */
	let {
		open = $bindable(false),
		board = null,
		presetActionId = null,
		onsaved
	}: {
		open?: boolean;
		board?: Board | null;
		/** Aktion vorbelegen (Aufruf aus einer Aktion) */
		presetActionId?: string | null;
		onsaved: (board: BoardDetail) => void;
	} = $props();

	interface ActionOption {
		id: string;
		name: string;
		access: { level: 'read' | 'edit' };
	}

	let name = $state('');
	let description = $state('');
	let color = $state<string | null>(null);
	let actionId = $state<string | null>(null);
	let actions = $state<ActionOption[]>([]);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	const editing = $derived(!!board);
	const actionOptions = $derived(
		actions.filter((a) => a.access.level === 'edit').map((a) => ({ value: a.id, label: a.name }))
	);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			name = board?.name ?? '';
			description = board?.description ?? '';
			color = board?.color ?? BOARD_COLORS[0];
			actionId = board?.action?.id ?? presetActionId;
			errors = {};
			if (!board) void loadActions();
		});
		void tick().then(() => document.getElementById('board-name')?.focus());
	});

	async function loadActions() {
		try {
			const res = await apiFetch<{ items: ActionOption[] }>('/modules/actions/actions?limit=200');
			actions = res.items;
		} catch {
			actions = []; // Modul „Aktionen“ nicht aktiv oder kein Recht → keine Auswahl
		}
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		const parsed = boardInput.safeParse({
			name,
			description,
			color,
			actionId: editing ? null : actionId
		});
		if (!parsed.success) {
			errors = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
			return;
		}
		busy = true;
		try {
			const body = editing
				? { name: parsed.data.name, description: parsed.data.description, color: parsed.data.color }
				: parsed.data;
			const saved = await apiFetch<BoardDetail>(
				editing ? `${BASE}/boards/${board!.id}` : `${BASE}/boards`,
				{ method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) }
			);
			toast.success(editing ? 'Board gespeichert' : 'Board angelegt');
			open = false;
			onsaved(saved);
		} catch (err) {
			if (err instanceof ApiClientError && Array.isArray(err.details)) {
				errors = Object.fromEntries(
					(err.details as { path?: (string | number)[]; message: string }[]).map((d) => [
						String(d.path?.[0] ?? ''),
						d.message
					])
				);
			}
			toast.error(errMsg(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{editing ? 'Board bearbeiten' : 'Neues Board'}</Dialog.Title>
			<Dialog.Description>
				{editing
					? 'Name, Beschreibung und Farbe des Boards.'
					: 'Ein Board startet mit den Spalten Offen · In Arbeit · Erledigt.'}
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={save} novalidate>
			<FormField label="Name" id="board-name" required error={errors.name}>
				<Input id="board-name" bind:value={name} maxlength={MAX_BOARD_NAME} autocomplete="off" />
			</FormField>
			<FormField label="Beschreibung" id="board-description" error={errors.description}>
				<Textarea
					id="board-description"
					bind:value={description}
					rows={3}
					maxlength={MAX_BOARD_DESCRIPTION}
				/>
			</FormField>
			<FormField label="Farbe" id="board-color" error={errors.color}>
				<ColorPicker
					id="board-color"
					label="Farbe"
					bind:value={color}
					presets={[...BOARD_COLORS]}
				/>
			</FormField>
			{#if !editing && (actionOptions.length || presetActionId)}
				<FormField
					label="Aktion"
					id="board-action"
					error={errors.actionId}
					hint="Wer die Aktion sehen oder bearbeiten darf, darf das auch beim Board."
				>
					<SelectField
						id="board-action"
						label="Aktion"
						options={actionOptions}
						bind:value={actionId}
						emptyLabel="Keine Aktion"
						placeholder="Keine Aktion"
					/>
				</FormField>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>
					{busy ? BUSY_SAVE : editing ? 'Speichern' : 'Anlegen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
