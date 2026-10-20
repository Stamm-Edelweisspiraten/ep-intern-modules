<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Bell from '@lucide/svelte/icons/bell';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import FileText from '@lucide/svelte/icons/file-text';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Send from '@lucide/svelte/icons/send';
	import { apiFetch, can } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Table from '$lib/components/ui/table';
	import {
		ConfirmDialog,
		EmptyState,
		PageHeader,
		SummaryList,
		toastWithUndo
	} from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		DOCUMENT_REASON_LABELS,
		INVOICE_SOURCE_LABELS,
		type Account,
		type InvoiceDetail,
		type InvoiceLine,
		type Payer
	} from '../schemas';
	import {
		BASE,
		errorMessage,
		fmtDate,
		fmtDateTime,
		openApiFile,
		statusText,
		statusVariant
	} from './helpers';
	import InvoiceDialog from './InvoiceDialog.svelte';
	import LineDialog from './LineDialog.svelte';
	import MarkPaidDialog from './MarkPaidDialog.svelte';
	import HistoryCard from './HistoryCard.svelte';

	let { params }: ModulePageProps = $props();
	const id = $derived(params.id ?? '');
	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canEdit = $derived(can(permissions, 'treasury.invoice.edit'));
	const canDelete = $derived(can(permissions, 'treasury.invoice.delete'));
	const canSend = $derived(can(permissions, 'treasury.invoice.send'));
	const canPay = $derived(can(permissions, 'treasury.transaction.edit'));
	// wie `history.endpoints.ts`: Berichts- UND Kassenrecht
	const canHistory = $derived(
		can(permissions, 'treasury.report.view') && can(permissions, 'treasury.cash.view')
	);

	let inv = $state<InvoiceDetail | null>(null);
	let loading = $state(true);
	let notFound = $state(false);
	let error = $state('');
	let accounts = $state<Account[]>([]);
	let payers = $state<Payer[]>([]);
	let members = $state<{ id: string; name: string }[]>([]);
	let actions = $state<{ id: string; name: string }[]>([]);

	async function load() {
		error = '';
		try {
			inv = await apiFetch<InvoiceDetail>(`${BASE}/invoices/${id}`);
		} catch (e) {
			if ((e as { status?: number }).status === 404) notFound = true;
			else error = errorMessage(e, 'Rechnung konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	async function loadRefs() {
		try {
			[accounts, payers, members, actions] = await Promise.all([
				apiFetch<Account[]>(`${BASE}/accounts`),
				apiFetch<Payer[]>(`${BASE}/payers`),
				apiFetch<{ id: string; name: string }[]>(`${BASE}/members`),
				apiFetch<{ id: string; name: string }[]>(`${BASE}/action-refs`)
			]);
		} catch {
			// Auswahllisten sind optional
		}
	}

	$effect(() => {
		void id;
		loading = true;
		void load();
		void loadRefs();
	});

	let editOpen = $state(false);
	let payOpen = $state(false);
	let lineOpen = $state(false);
	let lineEdit = $state<InvoiceLine | null>(null);
	let cancelOpen = $state(false);
	let deleteOpen = $state(false);
	let busy = $state(false);

	async function post(
		path: string,
		body: unknown,
		success: string,
		undoPath?: string,
		undoBody: unknown = {}
	) {
		busy = true;
		try {
			inv = await apiFetch<InvoiceDetail>(`${BASE}/invoices/${id}${path}`, {
				method: 'POST',
				body: JSON.stringify(body)
			});
			if (undoPath) {
				toastWithUndo({
					message: success,
					undo: () =>
						apiFetch(`${BASE}/invoices/${id}${undoPath}`, {
							method: 'POST',
							body: JSON.stringify(undoBody)
						}),
					onundone: load
				});
			} else toast.success(success);
		} catch (e) {
			toast.error(errorMessage(e, 'Aktion fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function remind() {
		busy = true;
		try {
			const r = await apiFetch<{ invoices: number; mailsSent: number; withoutAddress: number }>(
				`${BASE}/invoices/${id}/remind`,
				{ method: 'POST' }
			);
			if (r.invoices) toast.success(`Erinnerung an ${r.mailsSent} Adresse(n) gesendet`);
			else if (r.withoutAddress) toast.error('Keine E-Mail-Adresse hinterlegt');
			else toast.error('Erinnerung konnte nicht gesendet werden (SMTP prüfen)');
			await load();
		} catch (e) {
			toast.error(errorMessage(e, 'Erinnerung fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function send() {
		busy = true;
		try {
			const r = await apiFetch<{ invoices: number; mailsSent: number; withoutAddress: number }>(
				`${BASE}/invoices/${id}/send`,
				{ method: 'POST' }
			);
			if (r.invoices) toast.success(`Rechnung an ${r.mailsSent} Adresse(n) gesendet`);
			else if (r.withoutAddress) toast.error('Keine E-Mail-Adresse hinterlegt');
			else toast.error('Rechnung konnte nicht gesendet werden (SMTP prüfen)');
			await load();
		} catch (e) {
			toast.error(errorMessage(e, 'Versand fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function versionPdf(version: number) {
		try {
			await openApiFile(`${BASE}/invoices/${id}/documents/${version}/pdf`);
		} catch (e) {
			toast.error(errorMessage(e, 'PDF konnte nicht erstellt werden'));
		}
	}

	async function remove() {
		try {
			await apiFetch(`${BASE}/invoices/${id}`, { method: 'DELETE' });
			toast.success('Rechnung gelöscht');
			await goto('/modules/treasury?tab=invoices');
		} catch (e) {
			toast.error(errorMessage(e, 'Löschen fehlgeschlagen'));
		}
	}

	async function pdf() {
		try {
			await openApiFile(`${BASE}/invoices/${id}/pdf`);
		} catch (e) {
			toast.error(errorMessage(e, 'PDF konnte nicht erstellt werden'));
		}
	}

	const summary = $derived(
		inv
			? [
					{ label: 'Rechnungsbetrag', value: formatEuro(inv.totalCents) },
					{ label: 'Bezahlt', value: formatEuro(inv.paidCents) },
					{ label: 'Offen', value: formatEuro(inv.openCents), emphasis: 'strong' as const },
					...(inv.creditCents > 0
						? [
								{
									label: 'Guthaben',
									value: formatEuro(inv.creditCents),
									hint: 'Bezahlt, aber nicht (mehr) geschuldet – ggf. zurückzahlen oder verrechnen.'
								}
							]
						: [])
				]
			: []
	);
	const editable = $derived(!!inv && inv.status !== 'cancelled');
	/** Eine Zeile je Buchung (eine Zahlung kann mehrere Posten der Rechnung decken) */
	const payments = $derived.by(() => {
		const byTx = new Map<string, InvoiceDetail['payments'][number]>();
		for (const p of inv?.payments ?? []) {
			const cur = byTx.get(p.transactionId);
			byTx.set(p.transactionId, cur ? { ...cur, amountCents: cur.amountCents + p.amountCents } : p);
		}
		return [...byTx.values()];
	});
</script>

<div class="space-y-6">
	<a
		href="/modules/treasury?tab=invoices"
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" /> Alle Rechnungen
	</a>

	{#if loading}
		<Skeleton class="h-10 w-72" />
		<Skeleton class="h-48 w-full" />
	{:else if notFound}
		<EmptyState
			title="Rechnung nicht gefunden"
			description="Sie wurde gelöscht oder existiert nicht."
		/>
	{:else if error}
		<p class="text-sm text-destructive" role="alert">{error}</p>
		<Button variant="outline" onclick={load}>Erneut versuchen</Button>
	{:else if inv}
		<PageHeader
			title={`Rechnung ${inv.number}`}
			description={`${inv.recipientName}${inv.action ? ` · ${inv.action.name}` : ''}`}
		>
			{#snippet actions()}
				{#if canPay && inv && inv.openCents > 0 && editable}
					<Button onclick={() => (payOpen = true)}>Zahlung erfassen</Button>
				{/if}
				<Button variant="outline" onclick={pdf}><FileText /> PDF</Button>
				{#if canSend && inv && editable}
					<Button variant="outline" onclick={send} disabled={busy}><Send /> Rechnung senden</Button>
				{/if}
				{#if canSend && inv && inv.openCents > 0 && editable}
					<Button variant="outline" onclick={remind} disabled={busy}><Bell /> Erinnern</Button>
				{/if}
				{#if canEdit || canDelete}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button {...props} variant="outline" size="icon" aria-label="Weitere Aktionen">
									<Ellipsis />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end">
							{#if canEdit && editable}
								<DropdownMenu.Item onclick={() => (editOpen = true)}>
									<Pencil /> Bearbeiten
								</DropdownMenu.Item>
								<DropdownMenu.Item onclick={() => (cancelOpen = true)}>Stornieren</DropdownMenu.Item
								>
							{/if}
							{#if canEdit && inv?.status === 'cancelled'}
								<DropdownMenu.Item
									onclick={() => post('/reactivate', {}, 'Stornierung zurückgenommen')}
								>
									Stornierung zurücknehmen
								</DropdownMenu.Item>
							{/if}
							{#if canDelete && inv?.source === 'manual' && inv.paidCents === 0}
								<DropdownMenu.Separator />
								<DropdownMenu.Item class="text-destructive" onclick={() => (deleteOpen = true)}>
									Löschen
								</DropdownMenu.Item>
							{/if}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				{/if}
			{/snippet}
		</PageHeader>

		<div class="flex flex-wrap items-center gap-2">
			<Badge variant={statusVariant(inv)}>{statusText(inv)}</Badge>
			<Badge variant="outline"
				>{inv.source === 'action' ? 'Aus Aktion' : INVOICE_SOURCE_LABELS[inv.source]}</Badge
			>
			{#if inv.remindersPaused}<Badge variant="outline">Erinnerungen pausiert</Badge>{/if}
			{#if inv.paidNotifiedAt}<Badge variant="secondary">Bestätigung versendet</Badge>{/if}
		</div>
		{#if inv.status === 'cancelled'}
			<p class="rounded-md border bg-muted/40 px-3 py-2 text-sm" role="note">
				Storniert am {fmtDateTime(inv.cancelledAt)}{inv.cancelReason
					? `: ${inv.cancelReason}`
					: ''}.
				{#if inv.creditCents > 0}
					Bereits bezahlte {formatEuro(inv.creditCents)} stehen als Guthaben – bitte zurückzahlen oder
					verrechnen.
				{/if}
			</p>
		{/if}

		<div class="grid gap-6 lg:grid-cols-3">
			<Card.Root class="lg:col-span-2">
				<Card.Header><Card.Title>Posten</Card.Title></Card.Header>
				<Card.Content class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Bezeichnung</Table.Head>
								<Table.Head class="text-right">Betrag</Table.Head>
								<Table.Head class="text-right">Bezahlt</Table.Head>
								<Table.Head class="text-right">Offen</Table.Head>
								{#if canEdit && editable}<Table.Head
										><span class="sr-only">Aktionen</span></Table.Head
									>{/if}
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each inv.lines as l (l.id)}
								<Table.Row>
									<Table.Cell class="max-w-80">
										<div class="font-medium">{l.description}</div>
										<div class="text-xs text-muted-foreground">
											{[l.member?.name, l.action?.name].filter(Boolean).join(' · ')}
										</div>
										{#if l.waivedCents > 0}
											<div class="text-xs text-amber-700 dark:text-amber-400">
												Ermäßigt um {formatEuro(l.waivedCents)}{l.waiveReason
													? ` (${l.waiveReason})`
													: ''}
											</div>
										{/if}
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums"
										>{formatEuro(l.amountCents - l.waivedCents)}</Table.Cell
									>
									<Table.Cell class="text-right tabular-nums">{formatEuro(l.paidCents)}</Table.Cell>
									<Table.Cell class="text-right font-medium tabular-nums"
										>{formatEuro(l.openCents)}</Table.Cell
									>
									{#if canEdit && editable}
										<Table.Cell class="text-right">
											<Button
												variant="ghost"
												size="sm"
												onclick={() => {
													lineEdit = l;
													lineOpen = true;
												}}
											>
												Anpassen
											</Button>
										</Table.Cell>
									{/if}
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</Card.Content>
			</Card.Root>

			<div class="space-y-6">
				<Card.Root>
					<Card.Header><Card.Title>Betrag</Card.Title></Card.Header>
					<Card.Content><SummaryList rows={summary} /></Card.Content>
				</Card.Root>
				<Card.Root>
					<Card.Header><Card.Title>Details</Card.Title></Card.Header>
					<Card.Content class="space-y-2 text-sm">
						<div class="flex justify-between gap-2">
							<span class="text-muted-foreground">Datum</span>{fmtDate(inv.issuedOn)}
						</div>
						<div class="flex justify-between gap-2">
							<span class="text-muted-foreground">Fällig</span>{fmtDate(inv.dueOn)}
						</div>
						{#if inv.source === 'annual'}
							<div class="flex justify-between gap-2">
								<span class="text-muted-foreground">Herkunft</span>
								<a
									class="underline-offset-4 hover:underline"
									href="/modules/treasury?tab=annual"
									title="Zum Tab Jahresbeitrag">{INVOICE_SOURCE_LABELS.annual}</a
								>
							</div>
						{:else if inv.action}
							<div class="flex justify-between gap-2">
								<span class="text-muted-foreground">Aktion</span>{inv.action.name}
							</div>
						{/if}
						{#if inv.payer}
							<div class="flex justify-between gap-2">
								<span class="text-muted-foreground">Zahler</span>{inv.payer.name}
							</div>
						{/if}
						{#if inv.recipients.length}
							<div>
								<div class="text-muted-foreground">Mails gehen an</div>
								<ul class="mt-1 space-y-0.5">
									{#each inv.recipients as r (r)}<li class="truncate">{r}</li>{/each}
								</ul>
							</div>
						{:else if canEdit || canSend}
							<p class="text-xs text-amber-700 dark:text-amber-400">
								Keine E-Mail-Adresse: Mitglied zuordnen oder E-Mail eintragen.
							</p>
						{/if}
						{#if inv.note}<p class="whitespace-pre-line text-muted-foreground">{inv.note}</p>{/if}
					</Card.Content>
				</Card.Root>
			</div>
		</div>

		<div class="grid gap-6 lg:grid-cols-2">
			<Card.Root>
				<Card.Header><Card.Title>Zahlungen</Card.Title></Card.Header>
				<Card.Content>
					{#if !inv.payments.length}
						<p class="text-sm text-muted-foreground">Noch keine Zahlung zugeordnet.</p>
					{:else}
						<ul class="divide-y text-sm">
							{#each payments as p (p.transactionId)}
								<li class="flex items-center justify-between gap-2 py-2">
									<div>
										<div class="font-medium">{p.counterparty ?? 'Zahlung'}</div>
										<div class="text-xs text-muted-foreground">
											{fmtDate(p.bookedOn)} · {p.accountName}
										</div>
									</div>
									<span class="tabular-nums">{formatEuro(p.amountCents)}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header><Card.Title>Erinnerungen</Card.Title></Card.Header>
				<Card.Content>
					{#if !inv.reminders.length}
						<p class="text-sm text-muted-foreground">Noch keine Erinnerung versendet.</p>
					{:else}
						<ul class="divide-y text-sm">
							{#each inv.reminders as r (r.id)}
								<li class="flex items-center justify-between gap-2 py-2">
									<span>{r.level}. Erinnerung{r.manual ? ' (manuell)' : ''}</span>
									<span class="text-muted-foreground">
										{fmtDateTime(r.sentAt)} · {r.recipients} Empfänger
									</span>
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Content>
			</Card.Root>
			<Card.Root class="lg:col-span-2">
				<Card.Header>
					<Card.Title>Dokumente</Card.Title>
					<Card.Description>
						Jede versendete Fassung der Rechnung (z. B. bei Anmeldung oder nach einer Änderung).
					</Card.Description>
				</Card.Header>
				<Card.Content>
					{#if !inv.documents.length}
						<p class="text-sm text-muted-foreground">
							Noch nicht versendet. Bei Anmeldungen über den Link geht die Rechnung automatisch mit
							der Bestätigung raus.
						</p>
					{:else}
						<ul class="divide-y text-sm">
							{#each inv.documents as d (d.version)}
								<li class="flex flex-wrap items-center justify-between gap-2 py-2">
									<div>
										<div class="font-medium">
											Fassung {d.version} · {DOCUMENT_REASON_LABELS[d.reason]}
										</div>
										<div class="text-xs text-muted-foreground">
											{d.sentAt
												? `versendet ${fmtDateTime(d.sentAt)} an ${d.recipients} Adresse(n)`
												: `erstellt ${fmtDateTime(d.createdAt)}, nicht versendet`} · {formatEuro(
												d.totalCents
											)}
										</div>
									</div>
									<Button size="sm" variant="outline" onclick={() => versionPdf(d.version)}>
										<FileText /> PDF
									</Button>
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Content>
			</Card.Root>
			{#if canHistory}
				<HistoryCard kind="invoice" id={inv.id} class="lg:col-span-2" />
			{/if}
		</div>
	{/if}
</div>

{#if inv}
	<InvoiceDialog
		bind:open={editOpen}
		invoice={inv}
		{payers}
		{members}
		{actions}
		onsaved={(saved) => {
			inv = saved;
		}}
	/>
	<MarkPaidDialog bind:open={payOpen} invoice={inv} {accounts} onsaved={load} />
	<LineDialog bind:open={lineOpen} invoiceId={inv.id} line={lineEdit} {members} onsaved={load} />
{/if}
<ConfirmDialog
	bind:open={cancelOpen}
	title="Rechnung stornieren?"
	description="Die Rechnung wird nicht mehr als offen geführt. Bereits Bezahltes bleibt als Guthaben sichtbar."
	confirmLabel="Stornieren"
	destructive
	onconfirm={() => post('/cancel', { reason: null }, 'Rechnung storniert', '/reactivate')}
/>
<ConfirmDialog
	bind:open={deleteOpen}
	title="Rechnung löschen?"
	description="Die Rechnung wird dauerhaft entfernt."
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
