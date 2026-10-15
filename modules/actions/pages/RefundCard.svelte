<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { formatEuro } from '$lib/components/layout/money';
	import { fmtDate } from './format';
	import RefundDialog from './RefundDialog.svelte';
	import type { RefundState } from './refund-types';

	let {
		actionId,
		editable,
		reloadKey = 0,
		onchanged
	}: {
		actionId: string;
		/** Bearbeitungsrecht und Abrechnung offen */
		editable: boolean;
		/** Aendert sich, wenn die Buchungen neu geladen wurden */
		reloadKey?: number;
		onchanged: () => void | Promise<void>;
	} = $props();

	const url = $derived(`/modules/actions/actions/${actionId}/accounting/refund`);

	let state_ = $state<RefundState | null>(null);
	let loading = $state(true);
	let error = $state('');
	let dialogOpen = $state(false);

	async function load() {
		try {
			state_ = await apiFetch<RefundState>(url);
			error = '';
		} catch (e) {
			error = e instanceof ApiClientError ? e.message : 'Rückzahlung konnte nicht geladen werden';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void actionId;
		void reloadKey;
		void load();
	});

	const booked = $derived(state_?.booked ?? null);
	const surplus = $derived(booked ? booked.surplusCents : (state_?.surplusCents ?? 0));
	const maxPerHead = $derived(
		state_ && state_.autoCount > 0
			? Math.floor(state_.surplusCents / state_.autoCount / 100) * 100
			: 0
	);

	const status = $derived.by(() => {
		if (!state_) return '';
		if (booked) {
			const n = booked.count ?? booked.items.length;
			const per = booked.perHeadCents ?? booked.items[0]?.amountCents ?? 0;
			return `Gebucht am ${fmtDate(booked.bookedAt)} · ${n} × ${formatEuro(per)}`;
		}
		if (state_.blockers.length) return `Nicht möglich: ${state_.blockers[0]}`;
		if (state_.canBook && maxPerHead > 0) {
			return `${formatEuro(state_.surplusCents)} Überschuss · bis zu ${formatEuro(maxPerHead)} je Person möglich`;
		}
		return `${formatEuro(state_.surplusCents)} Überschuss`;
	});
</script>

{#if loading && !state_}
	<Skeleton class="h-16 w-full" aria-busy="true" aria-label="Lade Rückzahlung" />
{:else if error && !state_}
	<div class="flex flex-wrap items-center gap-3 rounded-lg border p-3">
		<p class="text-sm text-destructive" role="alert">{error}</p>
		<Button variant="outline" size="sm" onclick={load}>Erneut versuchen</Button>
	</div>
{:else if state_}
	<Card.Root>
		<Card.Content class="flex flex-wrap items-center justify-between gap-3 py-3">
			<div class="min-w-0">
				<div class="text-sm font-semibold">Rückzahlung des Überschusses</div>
				<div class="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
					{#if booked}<Check class="size-4 shrink-0 text-green-600" aria-hidden="true" />{/if}
					<span>{status}</span>
				</div>
			</div>
			<Button
				variant={booked ? 'outline' : 'default'}
				size="sm"
				onclick={() => (dialogOpen = true)}
				aria-label={`${booked ? 'Details' : 'Rückzahlung berechnen'} (${formatEuro(surplus)} Überschuss)`}
			>
				{booked ? 'Details' : 'Rückzahlung berechnen'}
			</Button>
		</Card.Content>
	</Card.Root>
{/if}

<RefundDialog
	bind:open={dialogOpen}
	{actionId}
	{editable}
	onchanged={async () => {
		await onchanged();
		await load();
	}}
/>
