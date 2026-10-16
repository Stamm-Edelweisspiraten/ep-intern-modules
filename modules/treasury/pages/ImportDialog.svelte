<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Table from '$lib/components/ui/table';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FileField, FormField } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		MAX_IMPORT_BYTES,
		type Account,
		type ImportMapping,
		type ImportPreview,
		type ImportResult
	} from '../schemas';
	import { BASE, defaultAccountId, fmtDate } from './helpers';

	let {
		open = $bindable(false),
		accounts,
		onimported
	}: {
		open?: boolean;
		accounts: Account[];
		onimported: (r: ImportResult) => void | Promise<void>;
	} = $props();

	let accountId = $state<string | null>(null);
	let file = $state<File | null>(null);
	let preview = $state<ImportPreview | null>(null);
	let headers = $state<string[]>([]);
	let mapping = $state<ImportMapping | null>(null);
	let busy = $state(false);
	let error = $state('');

	$effect(() => {
		if (!open) return;
		accountId = defaultAccountId(accounts);
		file = null;
		preview = null;
		headers = [];
		mapping = null;
		error = '';
	});

	const accountOptions = $derived(
		accounts.filter((a) => !a.archived).map((a) => ({ value: a.id, label: a.name }))
	);
	const headerOptions = $derived(headers.map((h) => ({ value: h, label: h })));
	const dateFormats = ['DD.MM.YYYY', 'DD.MM.YY', 'YYYY-MM-DD'].map((v) => ({ value: v, label: v }));
	const decimals = [
		{ value: ',', label: 'Komma (1.234,56)' },
		{ value: '.', label: 'Punkt (1,234.56)' }
	];

	function form(): FormData | null {
		if (!file || !accountId) {
			error = 'Bitte Konto und Datei wählen.';
			return null;
		}
		const fd = new FormData();
		fd.append('file', file);
		fd.append('accountId', accountId);
		if (mapping) fd.append('mapping', JSON.stringify(mapping));
		return fd;
	}

	async function check() {
		error = '';
		const fd = form();
		if (!fd) return;
		busy = true;
		try {
			preview = await apiFetch<ImportPreview>(`${BASE}/import/preview`, {
				method: 'POST',
				body: fd
			});
			headers = preview.headers;
			mapping = preview.mapping;
		} catch (e) {
			preview = null;
			if (e instanceof ApiClientError) {
				error = e.message;
				const h = (e.details as { headers?: string[] } | null)?.headers;
				if (Array.isArray(h) && h.length) {
					headers = h;
					mapping ??= {
						delimiter: ';',
						date: h[0]!,
						amount: h[1] ?? h[0]!,
						counterparty: null,
						purpose: null,
						dateFormat: 'DD.MM.YYYY',
						decimal: ','
					};
				}
			} else error = 'Datei konnte nicht gelesen werden';
		} finally {
			busy = false;
		}
	}

	async function run() {
		error = '';
		const fd = form();
		if (!fd) return;
		busy = true;
		try {
			const r = await apiFetch<ImportResult>(`${BASE}/import`, { method: 'POST', body: fd });
			toast.success(
				`${r.imported} Buchung(en) importiert${r.duplicates ? `, ${r.duplicates} bereits vorhanden` : ''}`
			);
			open = false;
			await onimported(r);
		} catch (e) {
			error = e instanceof ApiClientError ? e.message : 'Import fehlgeschlagen';
		} finally {
			busy = false;
		}
	}

	function setMap<K extends keyof ImportMapping>(key: K, v: ImportMapping[K]) {
		if (!mapping) return;
		mapping = { ...mapping, [key]: v };
		preview = null;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>Kontoauszug importieren</Dialog.Title>
			<Dialog.Description>
				CSV-Export aus dem Online-Banking (z. B. Sparkasse „CSV-CAMT“). Bereits importierte Umsätze
				werden erkannt und übersprungen.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-4">
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Konto *" id="im-account">
					<SelectField
						id="im-account"
						label="Konto"
						options={accountOptions}
						bind:value={accountId}
						onchange={() => (preview = null)}
					/>
				</FormField>
				<div class="grid gap-1.5">
					<span class="text-sm font-medium">Datei *</span>
					<FileField
						id="im-file"
						bind:file
						accept=".csv,text/csv,text/plain"
						maxBytes={MAX_IMPORT_BYTES}
						disabled={busy}
					/>
				</div>
			</div>

			{#if mapping && headers.length}
				<fieldset class="grid gap-3 rounded-md border p-3 sm:grid-cols-3">
					<legend class="px-1 text-sm font-medium">Spalten</legend>
					<FormField label="Datum" id="im-date">
						<SelectField
							id="im-date"
							label="Spalte Datum"
							options={headerOptions}
							value={mapping.date}
							onchange={(v) => v && setMap('date', v)}
						/>
					</FormField>
					<FormField label="Betrag" id="im-amount">
						<SelectField
							id="im-amount"
							label="Spalte Betrag"
							options={headerOptions}
							value={mapping.amount}
							onchange={(v) => v && setMap('amount', v)}
						/>
					</FormField>
					<FormField label="Gegenpartei" id="im-counter">
						<SelectField
							id="im-counter"
							label="Spalte Gegenpartei"
							options={headerOptions}
							value={mapping.counterparty ?? null}
							emptyLabel="Keine"
							onchange={(v) => setMap('counterparty', v)}
						/>
					</FormField>
					<FormField label="Verwendungszweck" id="im-purpose">
						<SelectField
							id="im-purpose"
							label="Spalte Verwendungszweck"
							options={headerOptions}
							value={mapping.purpose ?? null}
							emptyLabel="Keine"
							onchange={(v) => setMap('purpose', v)}
						/>
					</FormField>
					<FormField label="Datumsformat" id="im-df">
						<SelectField
							id="im-df"
							label="Datumsformat"
							options={dateFormats}
							value={mapping.dateFormat}
							onchange={(v) => v && setMap('dateFormat', v as ImportMapping['dateFormat'])}
						/>
					</FormField>
					<FormField label="Dezimaltrenner" id="im-dec">
						<SelectField
							id="im-dec"
							label="Dezimaltrenner"
							options={decimals}
							value={mapping.decimal}
							onchange={(v) => v && setMap('decimal', v as ImportMapping['decimal'])}
						/>
					</FormField>
				</fieldset>
			{/if}

			{#if preview}
				<div class="flex flex-wrap gap-2 text-sm" aria-live="polite">
					<Badge>{preview.valid} neu</Badge>
					{#if preview.duplicates}<Badge variant="secondary"
							>{preview.duplicates} bereits vorhanden</Badge
						>{/if}
					{#if preview.errors}<Badge variant="destructive">{preview.errors} nicht lesbar</Badge
						>{/if}
				</div>
				<div class="max-h-72 overflow-auto rounded-md border">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Zeile</Table.Head>
								<Table.Head>Datum</Table.Head>
								<Table.Head>Gegenpartei / Zweck</Table.Head>
								<Table.Head class="text-right">Betrag</Table.Head>
								<Table.Head>Status</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each preview.rows.slice(0, 100) as r (r.line)}
								<Table.Row class={r.duplicate || r.error ? 'text-muted-foreground' : ''}>
									<Table.Cell class="tabular-nums">{r.line}</Table.Cell>
									<Table.Cell>{fmtDate(r.bookedOn)}</Table.Cell>
									<Table.Cell class="max-w-72">
										<div class="truncate font-medium">{r.counterparty ?? '–'}</div>
										<div class="truncate text-xs">{r.purpose ?? ''}</div>
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums">
										{r.amountCents == null ? '–' : formatEuro(r.amountCents)}
									</Table.Cell>
									<Table.Cell>
										{#if r.error}<Badge variant="destructive">{r.error}</Badge>
										{:else if r.duplicate}<Badge variant="secondary">vorhanden</Badge>
										{:else}<Badge variant="outline">neu</Badge>{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
				{#if preview.rows.length > 100}
					<p class="text-xs text-muted-foreground">
						Vorschau zeigt 100 von {preview.rows.length} Zeilen.
					</p>
				{/if}
			{/if}
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			{#if preview && preview.valid > 0}
				<Button onclick={run} disabled={busy}>
					{busy ? 'Importiert …' : `${preview.valid} Buchung(en) importieren`}
				</Button>
			{:else}
				<Button onclick={check} disabled={busy || !file || !accountId}>
					{busy ? 'Prüft …' : 'Datei prüfen'}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
