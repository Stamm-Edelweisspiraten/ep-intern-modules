<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Download from '@lucide/svelte/icons/download';
	import FileText from '@lucide/svelte/icons/file-text';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Switch } from '$lib/components/ui/switch';
	import * as Table from '$lib/components/ui/table';
	import { formatEuro } from '$lib/components/layout/money';
	import type { AccountingInterimItem, ClosedAccountingItem } from '../closed-accountings';
	import { BASE, errorMessage, fmtDate, openApiFile, type SharedData } from './helpers';

	let { version }: SharedData = $props();

	let closed = $state<ClosedAccountingItem[] | null>(null);
	let error = $state('');
	let showFiled = $state(false);
	let busy = $state<string | null>(null);

	async function load() {
		error = '';
		try {
			closed = await apiFetch<ClosedAccountingItem[]>(`${BASE}/closed-accountings`);
		} catch (e) {
			error = errorMessage(e, 'Abrechnungen konnten nicht geladen werden');
		}
	}

	// Abhängigkeit nur `version` – `load` selbst wird nicht verfolgt (sonst Schleife)
	$effect(() => {
		void version;
		untrack(() => void load());
	});

	const visible = $derived((closed ?? []).filter((c) => showFiled || !c.filedAt));
	const detailHref = (id: string) => `/modules/treasury/accountings/${id}`;

	async function pdf(c: ClosedAccountingItem) {
		busy = c.actionId;
		try {
			await openApiFile(`${BASE}/closed-accountings/${c.actionId}/pdf`);
		} catch (e) {
			toast.error(errorMessage(e, 'PDF konnte nicht erstellt werden'));
		} finally {
			busy = null;
		}
	}

	async function interimPdf(c: ClosedAccountingItem, it: AccountingInterimItem, download = false) {
		busy = download ? `${it.id}:dl` : it.id;
		try {
			await openApiFile(`${BASE}/closed-accountings/${c.actionId}/interims/${it.id}/pdf`, download);
		} catch (e) {
			toast.error(errorMessage(e, 'PDF konnte nicht erstellt werden'));
		} finally {
			busy = null;
		}
	}

	async function setFiled(c: ClosedAccountingItem, filed: boolean) {
		try {
			await apiFetch(`${BASE}/closed-accountings/${c.actionId}/filed`, {
				method: 'PUT',
				body: JSON.stringify({ filed })
			});
			toast.success(filed ? `${c.name} als abgelegt markiert` : 'Markierung entfernt');
			await load();
		} catch (e) {
			toast.error(errorMessage(e, 'Speichern fehlgeschlagen'));
		}
	}
</script>

<Card.Root>
	<Card.Header class="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
		<div>
			<Card.Title>Abgeschlossene Abrechnungen</Card.Title>
			<Card.Description>
				Abrechnungen der Aktionen zum Nachvollziehen und Ablegen – Buchungen, Belege und
				Überweisungen im Detail, als PDF mit allen Belegen. Zwischenabrechnungen noch offener
				Aktionen stehen als PDF bereit.
			</Card.Description>
		</div>
		<div class="flex items-center gap-2">
			<Switch id="acc-filed" bind:checked={showFiled} />
			<Label for="acc-filed">Auch abgelegte zeigen</Label>
		</div>
	</Card.Header>
	<Card.Content class="overflow-x-auto">
		{#if error}
			<p class="text-sm text-destructive" role="alert">{error}</p>
			<Button variant="outline" class="mt-2" onclick={load}>Erneut versuchen</Button>
		{:else if closed === null}
			<Skeleton class="h-20 w-full" />
		{:else if !visible.length}
			<p class="text-sm text-muted-foreground">
				{closed.length
					? 'Alle abgeschlossenen Abrechnungen sind abgelegt.'
					: 'Noch keine Aktion hat ihre Abrechnung abgeschlossen oder zwischenabgerechnet.'}
			</p>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Aktion</Table.Head>
						<Table.Head>Stand</Table.Head>
						<Table.Head class="text-right">Einnahmen</Table.Head>
						<Table.Head class="text-right">Ausgaben</Table.Head>
						<Table.Head class="text-right">Ergebnis</Table.Head>
						<Table.Head>Ablage</Table.Head>
						<Table.Head class="text-right"><span class="sr-only">Aktionen</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each visible as c (c.actionId)}
						<Table.Row>
							<Table.Cell>
								{#if c.status === 'closed'}
									<a
										href={detailHref(c.actionId)}
										class="font-medium underline-offset-2 hover:underline">{c.name}</a
									>
								{:else}
									<span class="font-medium">{c.name}</span>
								{/if}
								<div class="text-xs text-muted-foreground">
									{fmtDate(c.startsOn)}{c.endsOn ? ` – ${fmtDate(c.endsOn)}` : ''}
								</div>
							</Table.Cell>
							<Table.Cell class="align-top">
								{#if c.closedAt}
									<div class="whitespace-nowrap tabular-nums">{fmtDate(c.closedAt)}</div>
								{:else}
									<Badge variant="warning">Zwischenabgerechnet ({c.interims.length})</Badge>
								{/if}
								{#if c.interims.length}
									<div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
										{#each c.interims as it (it.id)}
											<span class="inline-flex items-center gap-1 whitespace-nowrap">
												<button
													type="button"
													class="text-xs underline underline-offset-2 hover:text-foreground disabled:opacity-50"
													onclick={() => interimPdf(c, it)}
													disabled={busy === it.id}
													title={`Zwischenabrechnung Nr. ${it.number} vom ${fmtDate(it.createdAt)} ansehen`}
												>
													{busy === it.id ? 'Erstellt …' : `ZA ${it.number} (PDF)`}<span
														class="sr-only"
													>
														: Zwischenabrechnung Nr. {it.number} von {c.name}</span
													>
												</button>
												<button
													type="button"
													class="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
													onclick={() => interimPdf(c, it, true)}
													disabled={busy === `${it.id}:dl`}
													title={`Zwischenabrechnung Nr. ${it.number} herunterladen`}
													aria-label={`Zwischenabrechnung Nr. ${it.number} von ${c.name} herunterladen`}
												>
													<Download class="size-3.5" />
												</button>
											</span>
										{/each}
									</div>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{formatEuro(c.incomeCents)}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{formatEuro(c.expenseCents)}</Table.Cell>
							<Table.Cell
								class="text-right font-medium tabular-nums {c.balanceCents < 0
									? 'text-destructive'
									: ''}"
							>
								{formatEuro(c.balanceCents)}
							</Table.Cell>
							<Table.Cell>
								{#if c.status === 'interim'}
									<span class="text-xs text-muted-foreground">nach Abschluss</span>
								{:else if c.filedAt}
									<Badge variant="secondary">abgelegt {fmtDate(c.filedAt)}</Badge>
									{#if c.filedBy}<div class="text-xs text-muted-foreground">
											von {c.filedBy}
										</div>{/if}
								{:else}
									<Badge variant="outline">offen</Badge>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-right whitespace-nowrap">
								{#if c.status === 'closed'}
									<Button size="sm" variant="outline" href={detailHref(c.actionId)}>Ansehen</Button>
									<Button
										size="sm"
										variant="outline"
										onclick={() => pdf(c)}
										disabled={busy === c.actionId}
									>
										<FileText />
										{busy === c.actionId ? 'Erstellt …' : 'PDF'}
									</Button>
									<Button size="sm" variant="ghost" onclick={() => setFiled(c, !c.filedAt)}>
										{c.filedAt ? 'Zurücknehmen' : 'Als abgelegt markieren'}
									</Button>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Card.Content>
</Card.Root>
