<script lang="ts">
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Download from '@lucide/svelte/icons/download';
	import FileText from '@lucide/svelte/icons/file-text';
	import { apiFetch, can } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Table from '$lib/components/ui/table';
	import {
		EmptyState,
		PageHeader,
		SummaryList,
		type SummaryRow,
		BUSY_LOAD
	} from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { AccountingInterimItem, ClosedAccountingDetailItem } from '../closed-accountings';
	import { PAYABLE_SOURCE_LABELS } from '../schemas';
	import { BASE, errorMessage, fmtDate, openApiFile } from './helpers';

	let { params }: ModulePageProps = $props();
	const id = $derived(params.id ?? '');
	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canReceipts = $derived(can(permissions, 'treasury.storage.read'));

	type AccountingEntry = ClosedAccountingDetailItem['entries'][number];
	let acc = $state<ClosedAccountingDetailItem | null>(null);
	/** Kategorie-Bezeichnung aus dem DTO (Server löst über den Vertrag von `actions` auf) */
	const categoryLabel = (key: string) => acc?.categoryLabels?.[key] ?? key;
	let loading = $state(true);
	let notFound = $state(false);
	let error = $state('');
	let busy = $state(false);
	let interimBusy = $state<string | null>(null);

	async function load() {
		error = '';
		try {
			acc = await apiFetch<ClosedAccountingDetailItem>(`${BASE}/closed-accountings/${id}`);
		} catch (e) {
			if ((e as { status?: number }).status === 404) notFound = true;
			else error = errorMessage(e, 'Abrechnung konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void id;
		loading = true;
		void load();
	});

	async function pdf() {
		busy = true;
		try {
			await openApiFile(`${BASE}/closed-accountings/${id}/pdf`);
		} catch (e) {
			toast.error(errorMessage(e, 'PDF konnte nicht erstellt werden'));
		} finally {
			busy = false;
		}
	}

	async function interimPdf(it: AccountingInterimItem, download = false) {
		interimBusy = download ? `${it.id}:dl` : it.id;
		try {
			await openApiFile(`${BASE}/closed-accountings/${id}/interims/${it.id}/pdf`, download);
		} catch (e) {
			toast.error(errorMessage(e, 'PDF konnte nicht erstellt werden'));
		} finally {
			interimBusy = null;
		}
	}

	async function setFiled(filed: boolean) {
		busy = true;
		try {
			await apiFetch(`${BASE}/closed-accountings/${id}/filed`, {
				method: 'PUT',
				body: JSON.stringify({ filed })
			});
			toast.success(filed ? 'Als abgelegt markiert' : 'Markierung entfernt');
			await load();
		} catch (e) {
			toast.error(errorMessage(e, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	const auto = $derived(acc?.autoIncome);
	const totals = $derived.by((): SummaryRow[] => {
		if (!acc) return [];
		const s = acc.summary;
		const rows: SummaryRow[] = [
			{ label: 'Einnahmen', value: formatEuro(s.incomeCents) },
			{ label: 'Ausgaben', value: formatEuro(s.expenseCents), negative: true },
			{ label: 'Ergebnis', value: formatEuro(s.balanceCents), emphasis: 'strong' }
		];
		if (s.openClubPayments.count > 0) {
			rows.push({
				label: `Offene Überweisungen (${s.openClubPayments.count})`,
				value: formatEuro(s.openClubPayments.cents),
				emphasis: 'muted'
			});
		}
		if (s.openReimbursementCents > 0) {
			rows.push({
				label: 'Offene Auslagen',
				value: formatEuro(s.openReimbursementCents),
				emphasis: 'muted'
			});
		}
		if (s.missingReceipts > 0) {
			rows.push({
				label: 'Ausgaben ohne Beleg',
				value: String(s.missingReceipts),
				emphasis: 'muted'
			});
		}
		return rows;
	});

	/** Automatische Einnahmen (aus Anmeldungen bzw. Kasse), sofern nicht manuell ersetzt */
	const autoRows = $derived.by(() => {
		const out: { label: string; cents: number }[] = [];
		if (!auto) return out;
		if (auto.contributions && !auto.overridden.includes('contributions')) {
			out.push({
				label:
					auto.contributions.source === 'treasury'
						? 'Teilnehmerbeiträge (Zahlungseingang laut Kasse)'
						: 'Teilnehmerbeiträge (aus Anmeldungen)',
				cents: auto.contributions.cents
			});
		}
		if (auto.subsidy && !auto.overridden.includes('subsidy')) {
			out.push({ label: 'Zuschuss laut Kalkulation', cents: auto.subsidy.cents });
		}
		return out;
	});

	const entries = $derived(
		[...(acc?.entries ?? [])].sort(
			(a, b) => a.entryDate.localeCompare(b.entryDate) || a.createdAt.localeCompare(b.createdAt)
		)
	);

	function payerText(e: AccountingEntry): string {
		if (e.type === 'income') return '';
		if (e.paidBy === 'person') return e.payee ? `Auslage von ${e.payee.name}` : 'Auslage';
		if (e.category === 'refund') return 'Rückzahlung an Teilnehmende';
		return e.recipient ? `Stamm an ${e.recipient.name}` : 'Stamm';
	}

	function statusOf(e: AccountingEntry): { text: string; tone: 'ok' | 'open' | 'none' } {
		if (e.type === 'income' || e.category === 'refund') return { text: '', tone: 'none' };
		if (e.paidBy === 'person') {
			return e.reimbursedAt
				? { text: `erstattet ${fmtDate(e.reimbursedAt)}`, tone: 'ok' }
				: { text: 'Erstattung offen', tone: 'open' };
		}
		if (e.clubPaidAt === null) return { text: 'Überweisung offen', tone: 'open' };
		return e.clubPaidVia === 'treasury'
			? { text: `überwiesen ${fmtDate(e.clubPaidAt)}`, tone: 'ok' }
			: { text: 'bezahlt', tone: 'ok' };
	}

	const receiptHref = (e: AccountingEntry) =>
		`/api/v1${BASE}/closed-accountings/${id}/receipts/${e.id}`;
</script>

<div class="space-y-6">
	<a
		href="/modules/treasury?tab=accountings"
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" /> Alle Abrechnungen
	</a>

	{#if loading}
		<Skeleton class="h-10 w-72" />
		<Skeleton class="h-48 w-full" />
	{:else if notFound}
		<EmptyState
			title="Abrechnung nicht gefunden"
			description="Sie ist nicht abgeschlossen (mehr) oder die Aktion existiert nicht."
		/>
	{:else if error}
		<p class="text-sm text-destructive" role="alert">{error}</p>
		<Button variant="outline" onclick={load}>Erneut versuchen</Button>
	{:else if acc}
		<PageHeader
			title={`Abrechnung ${acc.name}`}
			description={`${fmtDate(acc.startsOn)}${acc.endsOn ? ` – ${fmtDate(acc.endsOn)}` : ''}${
				acc.location ? ` · ${acc.location}` : ''
			} · abgeschlossen am ${fmtDate(acc.closedAt)}`}
		>
			{#snippet actions()}
				<Button variant="outline" onclick={pdf} disabled={busy}><FileText /> PDF mit Belegen</Button
				>
				<Button variant="outline" onclick={() => setFiled(!acc?.filedAt)} disabled={busy}>
					{acc?.filedAt ? 'Ablage zurücknehmen' : 'Als abgelegt markieren'}
				</Button>
			{/snippet}
		</PageHeader>

		<div class="flex flex-wrap items-center gap-2">
			{#if acc.filedAt}
				<Badge variant="secondary"
					>abgelegt {fmtDate(acc.filedAt)}{acc.filedBy ? ` von ${acc.filedBy}` : ''}</Badge
				>
			{:else}
				<Badge variant="outline">nicht abgelegt</Badge>
			{/if}
			<span class="text-xs text-muted-foreground">Nur Ansicht – Änderungen in der Aktion.</span>
		</div>

		<div class="grid gap-6 lg:grid-cols-3">
			<Card.Root>
				<Card.Header><Card.Title>Ergebnis</Card.Title></Card.Header>
				<Card.Content><SummaryList rows={totals} /></Card.Content>
			</Card.Root>
			<Card.Root class="lg:col-span-2">
				<Card.Header>
					<Card.Title>Soll / Ist je Kategorie</Card.Title>
					<Card.Description>Soll aus der Kalkulation, Ist aus der Abrechnung.</Card.Description>
				</Card.Header>
				<Card.Content class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Kategorie</Table.Head>
								<Table.Head class="text-right">Soll</Table.Head>
								<Table.Head class="text-right">Ist</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each acc.summary.byCategory as c (c.category)}
								<Table.Row>
									<Table.Cell>
										{categoryLabel(c.category)}
										<span class="text-xs text-muted-foreground"
											>{c.type === 'income' ? 'Einnahme' : 'Ausgabe'}</span
										>
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums text-muted-foreground"
										>{c.plannedCents === null ? '–' : formatEuro(c.plannedCents)}</Table.Cell
									>
									<Table.Cell class="text-right tabular-nums"
										>{formatEuro(c.actualCents)}</Table.Cell
									>
								</Table.Row>
							{:else}
								<Table.Row>
									<Table.Cell colspan={3} class="text-muted-foreground">Keine Buchungen.</Table.Cell
									>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</Card.Content>
			</Card.Root>
		</div>

		{#if acc.interims?.length}
			<Card.Root>
				<Card.Header>
					<Card.Title>Zwischenabrechnungen</Card.Title>
					<Card.Description>
						Festgehaltene Stände der Abrechnung vor dem Abschluss. Jede Zwischenabrechnung steht für
						sich; enthaltene Auslagen wurden sofort an die Kasse übergeben.
					</Card.Description>
				</Card.Header>
				<Card.Content class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Nr.</Table.Head>
								<Table.Head>Datum</Table.Head>
								<Table.Head class="text-right">Einnahmen</Table.Head>
								<Table.Head class="text-right">Ausgaben</Table.Head>
								<Table.Head class="text-right">Auslagen</Table.Head>
								<Table.Head class="text-right"><span class="sr-only">PDF</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each acc.interims as it (it.id)}
								<Table.Row>
									<Table.Cell class="font-medium whitespace-nowrap">ZA {it.number}</Table.Cell>
									<Table.Cell class="whitespace-nowrap tabular-nums"
										>{fmtDate(it.createdAt)}</Table.Cell
									>
									<Table.Cell class="text-right tabular-nums"
										>{formatEuro(it.incomeCents)}</Table.Cell
									>
									<Table.Cell class="text-right tabular-nums"
										>{formatEuro(it.expenseCents)}</Table.Cell
									>
									<Table.Cell class="text-right tabular-nums"
										>{formatEuro(it.reimbursementCents)}</Table.Cell
									>
									<Table.Cell class="text-right">
										<div class="flex flex-wrap justify-end gap-1">
											<Button
												size="sm"
												variant="outline"
												onclick={() => interimPdf(it)}
												disabled={interimBusy === it.id}
											>
												<FileText />
												{interimBusy === it.id ? 'Erstellt …' : 'PDF'}<span class="sr-only">
													der Zwischenabrechnung Nr. {it.number}</span
												>
											</Button>
											<Button
												size="sm"
												variant="outline"
												onclick={() => interimPdf(it, true)}
												disabled={interimBusy === `${it.id}:dl`}
											>
												<Download />
												{interimBusy === `${it.id}:dl` ? BUSY_LOAD : 'Herunterladen'}<span
													class="sr-only"
												>
													: Zwischenabrechnung Nr. {it.number}</span
												>
											</Button>
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</Card.Content>
			</Card.Root>
		{/if}

		<Card.Root>
			<Card.Header>
				<Card.Title>Buchungen</Card.Title>
				<Card.Description>
					Alle Einnahmen und Ausgaben der Aktion mit Belegen und Zahlstatus.
				</Card.Description>
			</Card.Header>
			<Card.Content class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Datum</Table.Head>
							<Table.Head>Beschreibung</Table.Head>
							<Table.Head class="text-right">Betrag</Table.Head>
							<Table.Head>Beleg</Table.Head>
							<Table.Head>Status</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each autoRows as r (r.label)}
							<Table.Row>
								<Table.Cell class="text-muted-foreground">–</Table.Cell>
								<Table.Cell>
									<div class="font-medium">{r.label}</div>
									<Badge variant="secondary" class="mt-1">Automatisch</Badge>
								</Table.Cell>
								<Table.Cell class="text-right whitespace-nowrap text-success tabular-nums"
									>+{formatEuro(r.cents)}</Table.Cell
								>
								<Table.Cell class="text-muted-foreground">–</Table.Cell>
								<Table.Cell></Table.Cell>
							</Table.Row>
						{/each}
						{#each entries as e (e.id)}
							{@const st = statusOf(e)}
							<Table.Row>
								<Table.Cell class="align-top whitespace-nowrap tabular-nums"
									>{fmtDate(e.entryDate)}</Table.Cell
								>
								<Table.Cell class="max-w-80 align-top">
									<div class="font-medium">
										{e.description}
									</div>
									<div class="text-xs text-muted-foreground">
										{categoryLabel(e.category)}{payerText(e) ? ` · ${payerText(e)}` : ''}{e.purpose
											? ` · Zweck: ${e.purpose}`
											: ''}
									</div>
								</Table.Cell>
								<Table.Cell
									class={[
										'text-right align-top whitespace-nowrap tabular-nums',
										e.type === 'income' && 'text-success'
									]}
								>
									{e.type === 'income' ? '+' : '−'}{formatEuro(e.amountCents)}
								</Table.Cell>
								<Table.Cell class="align-top">
									{#if e.receipt && canReceipts}
										<a
											href={receiptHref(e)}
											target="_blank"
											rel="noopener"
											class="text-sm underline underline-offset-2"
										>
											Ansehen<span class="sr-only">: Beleg zu {e.description}</span>
										</a>
									{:else if e.receipt}
										<span class="text-sm">vorhanden</span>
									{:else if e.type === 'expense' && e.category !== 'refund'}
										<Badge variant="warning">fehlt</Badge>
									{:else}
										<span class="text-muted-foreground">–</span>
									{/if}
								</Table.Cell>
								<Table.Cell class="align-top">
									{#if st.tone === 'open'}
										<Badge variant="warning">{st.text}</Badge>
									{:else if st.tone === 'ok'}
										<Badge variant="secondary">{st.text}</Badge>
									{/if}
								</Table.Cell>
							</Table.Row>
						{:else}
							{#if !autoRows.length}
								<Table.Row>
									<Table.Cell colspan={5} class="text-muted-foreground">Keine Buchungen.</Table.Cell
									>
								</Table.Row>
							{/if}
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Überweisungen der Kasse</Card.Title>
				<Card.Description>
					Auslagen, Ausgaben des Stammes und Rückzahlungen zu dieser Aktion im Tab „Auszahlungen“.
				</Card.Description>
			</Card.Header>
			<Card.Content class="overflow-x-auto">
				{#if !acc.payables.length}
					<p class="text-sm text-muted-foreground">Keine Überweisungen zu dieser Aktion.</p>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Art</Table.Head>
								<Table.Head>Empfänger</Table.Head>
								<Table.Head class="text-right">Betrag</Table.Head>
								<Table.Head class="text-right">Offen</Table.Head>
								<Table.Head>Status</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each acc.payables as p (p.id)}
								<Table.Row>
									<Table.Cell class="whitespace-nowrap"
										>{PAYABLE_SOURCE_LABELS[p.source]}</Table.Cell
									>
									<Table.Cell>
										<div class="font-medium">{p.recipientName}</div>
										<div class="text-xs text-muted-foreground">{p.description}</div>
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums"
										>{formatEuro(p.amountCents)}</Table.Cell
									>
									<Table.Cell class="text-right tabular-nums">{formatEuro(p.openCents)}</Table.Cell>
									<Table.Cell>
										{#if p.cancelledAt}
											<Badge variant="outline">storniert</Badge>
										{:else if p.openCents === 0}
											<Badge variant="secondary"
												>bezahlt{p.payments.length
													? ` ${fmtDate(p.payments[p.payments.length - 1]!.bookedOn)}`
													: ''}</Badge
											>
										{:else}
											<Badge variant="warning">offen</Badge>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
				{#if acc.refund}
					<p class="mt-3 text-sm text-muted-foreground">
						Rückzahlung des Überschusses: {acc.refund.count} Personen, zusammen {formatEuro(
							acc.refund.totalCents
						)} (gebucht {fmtDate(acc.refund.bookedAt)}).
					</p>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</div>
