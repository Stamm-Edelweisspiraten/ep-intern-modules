<script lang="ts">
	import { toast } from 'svelte-sonner';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Info from '@lucide/svelte/icons/info';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { formatEuro } from '$lib/components/layout/money';
	import type { AccountingSummary } from '../schemas';

	let {
		open = $bindable(false),
		base,
		summary,
		viaTreasury = false,
		pendingSubmissions = 0,
		onclosed,
		onreview
	}: {
		open?: boolean;
		/** Basis-Pfad der Abrechnung (`/modules/actions/actions/<id>/accounting`) */
		base: string;
		summary: AccountingSummary;
		/** Auszahlungen laufen über die Kasse */
		viaTreasury?: boolean;
		/** Eingereichte Auslagen über den Kosten-Link, die noch geprüft werden müssen */
		pendingSubmissions?: number;
		onclosed: () => void | Promise<void>;
		/** Wechsel zum Bereich Kosten-Link */
		onreview: () => void;
	} = $props();

	type Status = 'ok' | 'warn' | 'info';
	type Item = {
		key: string;
		status: Status;
		title: string;
		detail?: string;
		review?: boolean;
		accept?: boolean;
	};

	let accept = $state(false);
	let busy = $state(false);

	$effect(() => {
		if (open) accept = false;
	});

	const missing = $derived(summary.missingReceipts);
	const blocked = $derived(missing > 0 && !accept);

	const items = $derived.by<Item[]>(() => {
		const list: Item[] = [];
		list.push(
			missing > 0
				? {
						key: 'receipts',
						status: 'warn',
						title: missing === 1 ? '1 Ausgabe ohne Beleg' : `${missing} Ausgaben ohne Beleg`,
						detail: 'Ohne Belege ist die Abrechnung unvollständig, z. B. gegenüber Zuschussgebern.',
						accept: true
					}
				: { key: 'receipts', status: 'ok', title: 'Belege vollständig' }
		);
		const club = summary.openClubPayments;
		if (club.count > 0) {
			list.push({
				key: 'club',
				status: 'info',
				title: `${club.count === 1 ? 'Eine offene Überweisung' : `${club.count} offene Überweisungen`} des Stammes (${formatEuro(club.cents)})`,
				detail: viaTreasury
					? 'Die Kasse überweist weiterhin.'
					: 'Bitte die Überweisungen weiterhin ausführen.'
			});
		} else {
			list.push({ key: 'club', status: 'ok', title: 'Keine offenen Überweisungen des Stammes' });
		}
		if (summary.openReimbursementCents > 0) {
			list.push({
				key: 'reimburse',
				status: 'info',
				title: `Offene Auslagen (${formatEuro(summary.openReimbursementCents)})`,
				detail: viaTreasury
					? 'Gehen mit dem Abschluss als Auszahlung an die Kasse.'
					: 'Können nach dem Abschluss ausgezahlt werden.'
			});
		} else {
			list.push({ key: 'reimburse', status: 'ok', title: 'Keine offenen Auslagen' });
		}
		if (pendingSubmissions > 0) {
			list.push({
				key: 'submissions',
				status: 'warn',
				title:
					pendingSubmissions === 1
						? '1 eingereichte Auslage wartet auf Prüfung'
						: `${pendingSubmissions} eingereichte Auslagen warten auf Prüfung`,
				detail: 'Nach dem Abschluss können sie nicht mehr übernommen werden.',
				review: true
			});
		}
		if (summary.balanceCents > 0) {
			list.push({
				key: 'refund',
				status: 'info',
				title: `Überschuss ${formatEuro(summary.balanceCents)}`,
				detail: 'Eine Rückzahlung an die Teilnehmenden vor dem Abschluss buchen.'
			});
		}
		return list;
	});

	async function submit(ev: SubmitEvent) {
		ev.preventDefault();
		if (blocked || busy) return;
		busy = true;
		try {
			await apiFetch(`${base}/close`, {
				method: 'POST',
				body: JSON.stringify({ acceptMissingReceipts: missing > 0 && accept })
			});
			toast.success('Abrechnung abgeschlossen');
			open = false;
			await onclosed();
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Abschließen fehlgeschlagen');
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="w-full max-w-full overflow-y-auto sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Abrechnung abschließen?</Dialog.Title>
			<Dialog.Description>Danach können Buchungen nicht mehr geändert werden.</Dialog.Description>
		</Dialog.Header>

		<form class="space-y-4" onsubmit={submit}>
			<div class="rounded-lg border px-4 py-3">
				<div class="text-xs text-muted-foreground">Saldo</div>
				<div
					class={[
						'text-2xl font-semibold tabular-nums',
						summary.balanceCents < 0
							? 'text-red-700 dark:text-red-400'
							: 'text-green-700 dark:text-green-400'
					]}
				>
					{formatEuro(summary.balanceCents)}
				</div>
			</div>

			<ul class="space-y-3" aria-label="Prüfpunkte vor dem Abschluss">
				{#each items as item (item.key)}
					<li class="flex items-start gap-3">
						{#if item.status === 'ok'}
							<CircleCheck
								class="mt-0.5 size-4 shrink-0 text-green-700 dark:text-green-400"
								aria-label="in Ordnung"
							/>
						{:else if item.status === 'warn'}
							<TriangleAlert
								class="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
								aria-label="Warnung"
							/>
						{:else}
							<Info class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Hinweis" />
						{/if}
						<div class="min-w-0 flex-1 space-y-1">
							<p class="text-sm font-medium">{item.title}</p>
							{#if item.detail}
								<p class="text-xs text-muted-foreground">{item.detail}</p>
							{/if}
							{#if item.review}
								<Button
									type="button"
									variant="link"
									size="sm"
									class="h-auto p-0"
									onclick={() => {
										open = false;
										onreview();
									}}
								>
									Jetzt prüfen
								</Button>
							{/if}
							{#if item.accept}
								<div class="flex items-start gap-2 pt-1">
									<Checkbox
										id="close-accept"
										checked={accept}
										onCheckedChange={(v) => (accept = v === true)}
										class="mt-0.5"
									/>
									<Label for="close-accept">Trotzdem abschließen</Label>
								</div>
							{/if}
						</div>
					</li>
				{/each}
			</ul>

			<Dialog.Footer class="gap-2">
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy || blocked}>
					{busy ? 'Schließt ab …' : 'Abschließen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
