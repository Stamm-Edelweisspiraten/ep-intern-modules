<script lang="ts">
	// Mengenbestand eines Artikels zählen/setzen oder umlagern (Halter = Lagerort oder Kiste).
	// Der Aufrufer rendert per `{#key}` neu.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { BUSY_SAVE, FormField, NumberStepper } from '$lib/components/layout';
	import {
		MAX_NOTE,
		MAX_QUANTITY,
		stockMoveInput,
		stockSetInput,
		type Article,
		type Location,
		type StockEntry
	} from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import HolderField from './HolderField.svelte';
	import ModeSwitch from './ModeSwitch.svelte';

	type Mode = 'set' | 'move';

	let {
		open = $bindable(false),
		article,
		entries,
		locations,
		mode: initialMode = 'set',
		entry = null,
		onsaved
	}: {
		open?: boolean;
		article: Article;
		/** Bestand dieses Artikels je Ort/Kiste */
		entries: StockEntry[];
		locations: Location[];
		mode?: Mode;
		/** Vorbelegung (Ort beim Zählen bzw. Quelle beim Umlagern) */
		entry?: StockEntry | null;
		onsaved: () => void | Promise<void>;
	} = $props();

	const preset = untrack(() => entry);
	let mode = $state<Mode>(untrack(() => initialMode));

	// Zählen
	let locationId = $state<string | null>(preset?.locationId ?? null);
	let containerId = $state<string | null>(preset?.containerId ?? null);
	let containerName = $state(preset?.containerId ? preset.holderName : '');
	let quantity = $state(preset?.quantity ?? 0);
	// Umlagern
	let fromId = $state<string | null>(preset?.id ?? null);
	let toLocationId = $state<string | null>(null);
	let toContainerId = $state<string | null>(null);
	let toContainerName = $state('');
	let moveQty = $state(1);
	let note = $state('');

	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	const unit = $derived(article.unitLabel);
	const currentAtHolder = $derived(
		entries.find(
			(e) =>
				(locationId && e.locationId === locationId) ||
				(containerId && e.containerId === containerId)
		)?.quantity ?? 0
	);
	const fromEntry = $derived(entries.find((e) => e.id === fromId) ?? null);
	const fromOptions = $derived(
		entries
			.filter((e) => e.quantity > 0)
			.map((e) => ({ value: e.id, label: `${e.holderName} (${e.quantity} ${unit})` }))
	);

	const modes = [
		{ value: 'set' as Mode, label: 'Zählen' },
		{ value: 'move' as Mode, label: 'Umlagern' }
	];

	async function save() {
		const data =
			mode === 'set'
				? { articleId: article.id, holder: { locationId, containerId }, quantity, note }
				: {
						articleId: article.id,
						from: {
							locationId: fromEntry?.locationId ?? null,
							containerId: fromEntry?.containerId ?? null
						},
						to: { locationId: toLocationId, containerId: toContainerId },
						quantity: moveQty,
						note
					};
		const parsed = (mode === 'set' ? stockSetInput : stockMoveInput).safeParse(data);
		if (!parsed.success) {
			errors = fieldErrors(parsed.error.issues);
			return;
		}
		if (mode === 'move' && fromEntry && moveQty > fromEntry.quantity) {
			errors = { quantity: `Dort sind nur ${fromEntry.quantity} vorhanden` };
			return;
		}
		errors = {};
		busy = true;
		try {
			await apiFetch(`${API}/stock/${mode}`, { method: 'POST', body: JSON.stringify(data) });
			toast.success(mode === 'set' ? 'Bestand gespeichert' : 'Umgelagert');
			open = false;
			await onsaved();
		} catch (e) {
			errors = apiFieldErrors(e);
			toast.error(errorText(e, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	const err = (...keys: string[]) => keys.map((k) => errors[k]).find(Boolean) ?? null;
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Bestand: {article.name}</Dialog.Title>
			<Dialog.Description>
				Gesamt {article.stockTotal}
				{unit}{article.issuedCount ? `, davon ${article.issuedCount} ausgegeben` : ''}
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			<ModeSwitch
				value={mode}
				options={modes}
				label="Was möchtest du tun?"
				onchange={(m) => {
					mode = m;
					errors = {};
				}}
			/>

			{#if mode === 'set'}
				<FormField label="Wo?" id="stock-location" error={err('holder')}>
					<HolderField
						id="stock-location"
						bind:locationId
						bind:containerId
						bind:containerName
						{locations}
						label="Wo"
						locationError={err('holder.locationId')}
						containerError={err('holder.containerId')}
					/>
				</FormField>
				<FormField
					label="Gezählter Bestand"
					id="stock-quantity"
					error={err('quantity')}
					hint={`Bisher dort: ${currentAtHolder} ${unit}. 0 entfernt den Eintrag.`}
				>
					<NumberStepper
						id="stock-quantity"
						bind:value={quantity}
						min={0}
						max={MAX_QUANTITY}
						label="Gezählter Bestand"
						{unit}
					/>
				</FormField>
			{:else}
				<FormField label="Von" id="stock-from" error={err('from', 'from.locationId')} required>
					<SelectField
						id="stock-from"
						options={fromOptions}
						bind:value={fromId}
						label="Von"
						placeholder={fromOptions.length ? 'Ort wählen …' : 'Kein Bestand vorhanden'}
						disabled={!fromOptions.length}
					/>
				</FormField>
				<FormField label="Nach" id="stock-to" error={err('to')}>
					<HolderField
						id="stock-to"
						bind:locationId={toLocationId}
						bind:containerId={toContainerId}
						bind:containerName={toContainerName}
						{locations}
						label="Nach"
						locationError={err('to.locationId')}
						containerError={err('to.containerId')}
					/>
				</FormField>
				<FormField
					label="Menge"
					id="stock-move-qty"
					error={err('quantity')}
					hint={fromEntry ? `Höchstens ${fromEntry.quantity} ${unit}` : undefined}
				>
					<NumberStepper
						id="stock-move-qty"
						bind:value={moveQty}
						min={1}
						max={fromEntry?.quantity ?? MAX_QUANTITY}
						label="Menge"
						{unit}
					/>
				</FormField>
			{/if}

			<FormField label="Notiz" id="stock-note" error={err('note')} hint="Optional, für den Verlauf">
				<Input id="stock-note" bind:value={note} maxlength={MAX_NOTE} />
			</FormField>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button onclick={save} disabled={busy}>
				{busy ? BUSY_SAVE : mode === 'set' ? 'Bestand speichern' : 'Umlagern'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
