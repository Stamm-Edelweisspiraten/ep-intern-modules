<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Download from '@lucide/svelte/icons/download';
	import FileText from '@lucide/svelte/icons/file-text';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Table from '$lib/components/ui/table';
	import { Badge } from '$lib/components/ui/badge';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { FormField } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { PeriodReport } from '../schemas';
	import { BASE, errorMessage, fmtDate, openApiFile, type SharedData } from './helpers';

	let { version }: SharedData = $props();

	const year = new Date().getFullYear();
	let from = $state(`${year}-01-01`);
	let to = $state(`${year}-12-31`);
	let report = $state<PeriodReport | null>(null);
	let loading = $state(false);
	let error = $state('');
	let pdfBusy = $state(false);

	const query = $derived(`from=${from}&to=${to}`);
	const valid = $derived(
		/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to
	);

	// Abhängigkeiten: `version`, `valid`, `query` – `load` selbst wird nicht verfolgt (sonst Schleife)
	$effect(() => {
		void version;
		const q = query;
		if (valid) untrack(() => void load(q));
	});

	async function load(q: string) {
		loading = !report;
		error = '';
		try {
			report = await apiFetch<PeriodReport>(`${BASE}/report?${q}`);
		} catch (e) {
			error = errorMessage(e, 'Bericht konnte nicht erstellt werden');
		} finally {
			loading = false;
		}
	}

	function setYear(y: number) {
		from = `${y}-01-01`;
		to = `${y}-12-31`;
	}

	async function pdf() {
		pdfBusy = true;
		try {
			await openApiFile(`${BASE}/report.pdf?${query}`);
		} catch (e) {
			toast.error(errorMessage(e, 'PDF konnte nicht erstellt werden'));
		} finally {
			pdfBusy = false;
		}
	}

	// Abgeschlossene Abrechnungen der Aktionen (Ablage)
	type Closed = {
		actionId: string;
		name: string;
		startsOn: string;
		endsOn: string | null;
		closedAt: string;
		incomeCents: number;
		expenseCents: number;
		balanceCents: number;
		filedAt: string | null;
		filedBy: string | null;
	};
	let closed = $state<Closed[] | null>(null);
	let closedError = $state('');
	let showFiled = $state(false);
	let closedBusy = $state<string | null>(null);

	async function loadClosed() {
		closedError = '';
		try {
			closed = await apiFetch<Closed[]>(`${BASE}/closed-accountings`);
		} catch (e) {
			closedError = errorMessage(e, 'Abrechnungen konnten nicht geladen werden');
		}
	}

	$effect(() => {
		void version;
		untrack(() => void loadClosed());
	});

	const visibleClosed = $derived((closed ?? []).filter((c) => showFiled || !c.filedAt));

	async function closedPdf(c: Closed) {
		closedBusy = c.actionId;
		try {
			await openApiFile(`${BASE}/closed-accountings/${c.actionId}/pdf`);
		} catch (e) {
			toast.error(errorMessage(e, 'PDF konnte nicht erstellt werden'));
		} finally {
			closedBusy = null;
		}
	}

	async function setFiled(c: Closed, filed: boolean) {
		try {
			await apiFetch(`${BASE}/closed-accountings/${c.actionId}/filed`, {
				method: 'PUT',
				body: JSON.stringify({ filed })
			});
			toast.success(filed ? `${c.name} als abgelegt markiert` : 'Markierung entfernt');
			await loadClosed();
		} catch (e) {
			toast.error(errorMessage(e, 'Speichern fehlgeschlagen'));
		}
	}

	async function csv() {
		try {
			await openApiFile(`${BASE}/report.csv?${query}`, true);
		} catch (e) {
			toast.error(errorMessage(e, 'Export fehlgeschlagen'));
		}
	}
</script>

<div class="space-y-6">
	<Card.Root>
		<Card.Content class="flex flex-wrap items-end gap-3">
			<div class="flex flex-wrap gap-1" role="group" aria-label="Kalenderjahr">
				{#each [year, year - 1, year - 2] as y (y)}
					<Button
						size="sm"
						variant={from === `${y}-01-01` && to === `${y}-12-31` ? 'default' : 'outline'}
						onclick={() => setYear(y)}
					>
						{y}
					</Button>
				{/each}
			</div>
			<FormField label="Von" id="rp-from">
				<Input id="rp-from" type="date" bind:value={from} class="w-40" />
			</FormField>
			<FormField label="Bis" id="rp-to" error={!valid ? 'Ende vor Beginn' : null}>
				<Input id="rp-to" type="date" bind:value={to} class="w-40" aria-invalid={!valid} />
			</FormField>
			<div class="ml-auto flex gap-2">
				<Button variant="outline" onclick={csv} disabled={!valid}
					><Download /> Buchungen (CSV)</Button
				>
				<Button onclick={pdf} disabled={!valid || pdfBusy}>
					<FileText />
					{pdfBusy ? 'Erstellt …' : 'Bericht (PDF)'}
				</Button>
			</div>
		</Card.Content>
	</Card.Root>

	{#if loading}
		<Skeleton class="h-48 w-full" />
	{:else if error}
		<p class="text-sm text-destructive" role="alert">{error}</p>
	{:else if report}
		<div class="grid gap-4 sm:grid-cols-3">
			<Card.Root>
				<Card.Content>
					<div class="text-xs text-muted-foreground">Einnahmen</div>
					<div class="text-xl font-semibold tabular-nums sm:text-2xl">
						{formatEuro(report.totals.incomeCents)}
					</div>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Content>
					<div class="text-xs text-muted-foreground">Ausgaben</div>
					<div class="text-xl font-semibold tabular-nums sm:text-2xl">
						{formatEuro(report.totals.expenseCents)}
					</div>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Content>
					<div class="text-xs text-muted-foreground">Ergebnis</div>
					<div
						class="text-xl font-semibold tabular-nums sm:text-2xl {report.totals.resultCents < 0
							? 'text-destructive'
							: ''}"
					>
						{formatEuro(report.totals.resultCents)}
					</div>
				</Card.Content>
			</Card.Root>
		</div>

		<Card.Root>
			<Card.Header>
				<Card.Title>Konten</Card.Title>
				<Card.Description>{fmtDate(report.from)} bis {fmtDate(report.to)}</Card.Description>
			</Card.Header>
			<Card.Content class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Konto</Table.Head>
							<Table.Head class="text-right">Anfang</Table.Head>
							<Table.Head class="text-right">Einnahmen</Table.Head>
							<Table.Head class="text-right">Ausgaben</Table.Head>
							<Table.Head class="text-right">Umbuchungen</Table.Head>
							<Table.Head class="text-right">Ende</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each report.accounts as a (a.id)}
							<Table.Row>
								<Table.Cell class="font-medium">{a.name}</Table.Cell>
								<Table.Cell class="text-right tabular-nums">{formatEuro(a.openingCents)}</Table.Cell
								>
								<Table.Cell class="text-right tabular-nums">{formatEuro(a.incomeCents)}</Table.Cell>
								<Table.Cell class="text-right tabular-nums">{formatEuro(a.expenseCents)}</Table.Cell
								>
								<Table.Cell class="text-right tabular-nums"
									>{formatEuro(a.transfersCents)}</Table.Cell
								>
								<Table.Cell class="text-right font-semibold tabular-nums"
									>{formatEuro(a.closingCents)}</Table.Cell
								>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>

		<div class="grid gap-6 lg:grid-cols-2">
			{#each [{ title: 'Nach Kategorie', rows: report.byCategory }, { title: 'Nach Aktion', rows: report.byAction }] as block (block.title)}
				<Card.Root>
					<Card.Header><Card.Title>{block.title}</Card.Title></Card.Header>
					<Card.Content class="overflow-x-auto">
						{#if !block.rows.length}
							<p class="text-sm text-muted-foreground">Keine Buchungen im Zeitraum.</p>
						{:else}
							<Table.Root>
								<Table.Header>
									<Table.Row>
										<Table.Head></Table.Head>
										<Table.Head class="text-right">Einnahmen</Table.Head>
										<Table.Head class="text-right">Ausgaben</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each block.rows as r (r.key)}
										<Table.Row>
											<Table.Cell>{r.label}</Table.Cell>
											<Table.Cell class="text-right tabular-nums"
												>{formatEuro(r.incomeCents)}</Table.Cell
											>
											<Table.Cell class="text-right tabular-nums"
												>{formatEuro(r.expenseCents)}</Table.Cell
											>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						{/if}
					</Card.Content>
				</Card.Root>
			{/each}
		</div>

		<Card.Root>
			<Card.Header><Card.Title>Offene Forderungen (Stand heute)</Card.Title></Card.Header>
			<Card.Content class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
				<span
					>Offen <strong class="tabular-nums">{formatEuro(report.open.openCents)}</strong> ({report
						.open.invoiceCount} Rechnungen)</span
				>
				<span class="text-destructive"
					>Überfällig <strong class="tabular-nums">{formatEuro(report.open.overdueCents)}</strong
					></span
				>
				<span
					>Guthaben <strong class="tabular-nums">{formatEuro(report.open.creditCents)}</strong
					></span
				>
				{#if report.unassignedCount}
					<span class="text-amber-700 dark:text-amber-400">
						{report.unassignedCount} Buchung(en) ohne Kategorie, Aktion oder Rechnung
					</span>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
	<Card.Root>
		<Card.Header class="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
			<div>
				<Card.Title>Abgeschlossene Abrechnungen</Card.Title>
				<Card.Description>
					Abrechnungen der Aktionen zum Ablegen – als PDF inklusive aller Belege.
				</Card.Description>
			</div>
			<div class="flex items-center gap-2">
				<Switch id="rp-filed" bind:checked={showFiled} />
				<Label for="rp-filed">Auch abgelegte zeigen</Label>
			</div>
		</Card.Header>
		<Card.Content class="overflow-x-auto">
			{#if closedError}
				<p class="text-sm text-destructive" role="alert">{closedError}</p>
			{:else if closed === null}
				<Skeleton class="h-20 w-full" />
			{:else if !visibleClosed.length}
				<p class="text-sm text-muted-foreground">
					{closed.length
						? 'Alle abgeschlossenen Abrechnungen sind abgelegt.'
						: 'Noch keine Aktion hat ihre Abrechnung abgeschlossen.'}
				</p>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Aktion</Table.Head>
							<Table.Head>Abgeschlossen</Table.Head>
							<Table.Head class="text-right">Einnahmen</Table.Head>
							<Table.Head class="text-right">Ausgaben</Table.Head>
							<Table.Head class="text-right">Ergebnis</Table.Head>
							<Table.Head>Ablage</Table.Head>
							<Table.Head class="text-right"><span class="sr-only">Aktionen</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each visibleClosed as c (c.actionId)}
							<Table.Row>
								<Table.Cell>
									<div class="font-medium">{c.name}</div>
									<div class="text-xs text-muted-foreground">
										{fmtDate(c.startsOn)}{c.endsOn ? ` – ${fmtDate(c.endsOn)}` : ''}
									</div>
								</Table.Cell>
								<Table.Cell class="whitespace-nowrap tabular-nums">{fmtDate(c.closedAt)}</Table.Cell
								>
								<Table.Cell class="text-right tabular-nums">{formatEuro(c.incomeCents)}</Table.Cell>
								<Table.Cell class="text-right tabular-nums">{formatEuro(c.expenseCents)}</Table.Cell
								>
								<Table.Cell
									class="text-right font-medium tabular-nums {c.balanceCents < 0
										? 'text-destructive'
										: ''}"
								>
									{formatEuro(c.balanceCents)}
								</Table.Cell>
								<Table.Cell>
									{#if c.filedAt}
										<Badge variant="secondary">abgelegt {fmtDate(c.filedAt)}</Badge>
										{#if c.filedBy}<div class="text-xs text-muted-foreground">
												von {c.filedBy}
											</div>{/if}
									{:else}
										<Badge variant="outline">offen</Badge>
									{/if}
								</Table.Cell>
								<Table.Cell class="text-right whitespace-nowrap">
									<Button
										size="sm"
										variant="outline"
										onclick={() => closedPdf(c)}
										disabled={closedBusy === c.actionId}
									>
										<FileText />
										{closedBusy === c.actionId ? 'Erstellt …' : 'PDF'}
									</Button>
									<Button size="sm" variant="ghost" onclick={() => setFiled(c, !c.filedAt)}>
										{c.filedAt ? 'Zurücknehmen' : 'Als abgelegt markieren'}
									</Button>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
