<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Download from '@lucide/svelte/icons/download';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Table from '$lib/components/ui/table';
	import { ConfirmDialog, DataTable } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { AccountingInterim } from '../schemas';
	import { downloadApiFile } from './download';
	import { fmtDate } from './format';

	let {
		actionId,
		interims,
		onchanged
	}: {
		actionId: string;
		interims: AccountingInterim[];
		onchanged: () => void | Promise<void>;
	} = $props();

	const base = $derived(`/modules/actions/actions/${actionId}/accounting/interims`);
	const sorted = $derived([...interims].sort((a, b) => b.number - a.number));

	let revertOpen = $state(false);
	let target = $state<AccountingInterim | null>(null);
	let busy = $state(false);
	let downloading = $state<string | null>(null);

	const revertDescription = $derived.by(() => {
		const parts = [
			'Der festgehaltene Stand wird gelöscht. Buchungen bleiben unverändert; Auslagen, die nur in dieser Zwischenabrechnung enthalten sind, werden in der Kasse wieder zurückgezogen (sofern noch nicht ausgezahlt).'
		];
		if (target?.revertWarnings.includes('paid')) {
			parts.push(
				`${formatEuro(target.paidReimbursementCents)} wurden bereits ausgezahlt. Diese Auslagen bleiben als erstattet markiert; bezahlte Auszahlungen in der Kasse bleiben bestehen.`
			);
		}
		return parts.join(' ');
	});

	async function download(it: AccountingInterim) {
		downloading = it.id;
		try {
			await downloadApiFile(`${base}/${it.id}/report.pdf`, `Zwischenabrechnung-ZA${it.number}.pdf`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'PDF konnte nicht geladen werden');
		} finally {
			downloading = null;
		}
	}

	async function revert() {
		const it = target;
		if (!it) return;
		busy = true;
		try {
			const force = it.revertWarnings.length > 0 ? '?force=true' : '';
			await apiFetch(`${base}/${it.id}${force}`, { method: 'DELETE' });
			toast.success(`Zwischenabrechnung Nr. ${it.number} zurückgenommen`);
		} catch (e) {
			if (e instanceof ApiClientError && e.status === 403) {
				toast.error(
					'Nur die Eigentümer*in der Aktion oder Personen mit dem Recht ‚Alle Aktionen bearbeiten‘ können Zwischenabrechnungen zurücknehmen.'
				);
			} else {
				toast.error(e instanceof ApiClientError ? e.message : 'Zurücknehmen fehlgeschlagen');
			}
		} finally {
			busy = false;
			await onchanged();
		}
	}
</script>

<DataTable
	caption="Zwischenabrechnungen"
	title="Zwischenabrechnungen"
	description="Festgehaltene Stände der Abrechnung. Jede Zwischenabrechnung steht für sich."
>
	{#snippet head()}
		<Table.Row>
			<Table.Head>Nr.</Table.Head>
			<Table.Head>Stichtag</Table.Head>
			<Table.Head class="text-right">Buchungen</Table.Head>
			<Table.Head class="text-right">Einnahmen</Table.Head>
			<Table.Head class="text-right">Ausgaben</Table.Head>
			<Table.Head class="text-right">Saldo</Table.Head>
			<Table.Head class="text-right"><span class="sr-only">Aktionen</span></Table.Head>
		</Table.Row>
	{/snippet}
	{#each sorted as it (it.id)}
		<Table.Row>
			<Table.Cell class="align-top font-medium whitespace-nowrap">ZA {it.number}</Table.Cell>
			<Table.Cell class="align-top">
				<div class="tabular-nums">{fmtDate(it.createdAt)}</div>
				{#if it.createdBy}<div class="text-xs text-muted-foreground">
						von {it.createdBy.name}
					</div>{/if}
				{#if it.note}<div class="text-xs text-muted-foreground">{it.note}</div>{/if}
			</Table.Cell>
			<Table.Cell class="text-right align-top tabular-nums">{it.entryCount}</Table.Cell>
			<Table.Cell class="text-right align-top tabular-nums">{formatEuro(it.incomeCents)}</Table.Cell
			>
			<Table.Cell class="text-right align-top tabular-nums"
				>{formatEuro(it.expenseCents)}</Table.Cell
			>
			<Table.Cell
				class={[
					'text-right align-top font-medium tabular-nums',
					it.incomeCents - it.expenseCents < 0 && 'text-destructive'
				]}>{formatEuro(it.incomeCents - it.expenseCents)}</Table.Cell
			>
			<Table.Cell class="text-right align-top">
				<div class="flex flex-wrap justify-end gap-1">
					<Button
						size="sm"
						variant="outline"
						disabled={downloading === it.id}
						onclick={() => download(it)}
					>
						<Download />
						{downloading === it.id ? 'Lädt …' : 'PDF'}<span class="sr-only">
							der Zwischenabrechnung Nr. {it.number} herunterladen</span
						>
					</Button>
					<Button
						size="sm"
						variant="ghost"
						href={`/api/v1${base}/${it.id}/report.pdf`}
						target="_blank"
						rel="noopener"
					>
						<ExternalLink /> Ansehen<span class="sr-only">
							: Zwischenabrechnung Nr. {it.number} in neuem Tab</span
						>
					</Button>
					{#if it.canRevert}
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onclick={() => {
								target = it;
								revertOpen = true;
							}}
						>
							<Undo2 /> Zurücknehmen<span class="sr-only">: Zwischenabrechnung Nr. {it.number}</span
							>
						</Button>
					{/if}
				</div>
			</Table.Cell>
		</Table.Row>
	{/each}
</DataTable>

<ConfirmDialog
	bind:open={revertOpen}
	title={target ? `Zwischenabrechnung Nr. ${target.number} zurücknehmen?` : 'Zurücknehmen?'}
	description={revertDescription}
	confirmLabel={target?.revertWarnings.length ? 'Trotzdem zurücknehmen' : 'Zurücknehmen'}
	destructive
	onconfirm={revert}
/>
