<script lang="ts">
	// Reservierungen eines Zeitraums als PDF oder CSV (`POST /exports/reservations`).
	// Mit Verwaltungsrecht alle, sonst nur die eigenen (entscheidet der Server).
	import { toast } from 'svelte-sonner';
	import FileDown from '@lucide/svelte/icons/file-down';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField } from '$lib/components/layout';
	import { downloadPdf } from '$lib/components/layout/download';
	import { localToday } from '$lib/components/layout/month-calendar';
	import {
		EXPORT_FORMATS,
		PURPOSE_LABELS,
		PURPOSES,
		isRealDate,
		type ExportFormat,
		type Purpose
	} from '../../schemas';
	import { API } from '../helpers';
	import { shiftDate } from '../reserve/cart';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const today = localToday();
	let from = $state(`${today.slice(0, 7)}-01`);
	let to = $state(shiftDate(today, 90));
	let purpose = $state<string | null>(null);
	let includeCancelled = $state(false);
	let withLines = $state(true);
	let format = $state<ExportFormat>('pdf');
	let busy = $state(false);

	const FORMAT_LABELS: Record<ExportFormat, string> = { pdf: 'PDF', csv: 'CSV (Tabelle)' };
	const formatOptions = EXPORT_FORMATS.map((f) => ({ value: f, label: FORMAT_LABELS[f] }));
	const purposeOptions = PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABELS[p] }));

	const dateError = $derived(
		!isRealDate(from) || !isRealDate(to)
			? 'Bitte einen gültigen Zeitraum eingeben.'
			: to < from
				? 'Ende liegt vor dem Beginn.'
				: ''
	);

	async function run() {
		if (dateError) return;
		busy = true;
		try {
			await downloadPdf(
				`/api/v1${API}/exports/reservations`,
				{
					method: 'POST',
					body: JSON.stringify({
						format,
						from,
						to,
						purpose: (purpose as Purpose | null) ?? null,
						includeCancelled,
						withLines
					})
				},
				`materialreservierungen.${format}`
			);
			open = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Export fehlgeschlagen');
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Reservierungen exportieren</Dialog.Title>
			<Dialog.Description>
				Liste aller Reservierungen, die den Zeitraum berühren – zum Ausdrucken oder als Tabelle.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div class="space-y-1">
					<Label for="material-export-from">Von *</Label>
					<Input id="material-export-from" type="date" bind:value={from} />
				</div>
				<div class="space-y-1">
					<Label for="material-export-to">Bis *</Label>
					<Input
						id="material-export-to"
						type="date"
						bind:value={to}
						aria-invalid={dateError ? 'true' : undefined}
						aria-describedby={dateError ? 'material-export-date-error' : undefined}
					/>
				</div>
			</div>
			{#if dateError}
				<p id="material-export-date-error" class="text-xs text-destructive" role="alert">
					{dateError}
				</p>
			{/if}

			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<FormField label="Zweck" id="material-export-purpose">
					<SelectField
						id="material-export-purpose"
						label="Zweck"
						options={purposeOptions}
						bind:value={purpose}
						emptyLabel="Alle Zwecke"
					/>
				</FormField>
				<FormField label="Format" id="material-export-format">
					<SelectField
						id="material-export-format"
						label="Format"
						options={formatOptions}
						value={format}
						onchange={(v) => (format = (v ?? 'pdf') as ExportFormat)}
					/>
				</FormField>
			</div>

			<div class="space-y-2">
				<Label class="flex items-center gap-2 font-normal">
					<Checkbox bind:checked={withLines} />
					Positionen je Reservierung mit ausgeben
				</Label>
				<Label class="flex items-center gap-2 font-normal">
					<Checkbox bind:checked={includeCancelled} />
					Stornierte einschließen
				</Label>
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" disabled={busy} onclick={() => (open = false)}>Abbrechen</Button>
			<Button disabled={busy || !!dateError} onclick={run}>
				<FileDown />
				{busy ? 'Erstellt …' : 'Exportieren'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
