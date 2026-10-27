<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Copy from '@lucide/svelte/icons/copy';
	import FileText from '@lucide/svelte/icons/file-text';
	import Lock from '@lucide/svelte/icons/lock';
	import MoreHorizontal from '@lucide/svelte/icons/ellipsis';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { SegmentedSlider } from '$lib/components/ui/segmented-slider';
	import { MoneyInput } from '$lib/components/layout';
	import { downloadPdf } from '$lib/components/layout/download';
	import { formatEuro } from '$lib/components/layout/money';
	import { formatDateDe, todayBerlin } from '$lib/sdk/dates';
	import { choiceOf, donationForChoice, validateDonation, type DonationChoice } from '../refund';
	import type { RefundItem } from './refund-types';

	let {
		actionId,
		items,
		deadline = null,
		deadlineRunning = false,
		editable,
		onchanged
	}: {
		actionId: string;
		items: RefundItem[];
		/** Rückmeldung bis einschließlich JJJJ-MM-TT (`null` = keine Frist) */
		deadline?: string | null;
		/** Frist läuft noch: Link offen, Kasse zahlt noch nicht aus */
		deadlineRunning?: boolean;
		/** Bearbeitungsrecht und Abrechnung offen */
		editable: boolean;
		onchanged: () => void | Promise<void>;
	} = $props();

	const base = $derived(`/modules/actions/actions/${actionId}/accounting/refund`);
	const CHOICES: { value: DonationChoice; label: string }[] = [
		{ value: 'payout', label: 'Auszahlen' },
		{ value: 'partial', label: 'Teilweise' },
		{ value: 'donate', label: 'Spenden' }
	];

	let busyId = $state<string | null>(null);
	/** Entwurf der Frist; folgt dem gespeicherten Wert, bis man ihn ändert */
	let deadlineDraft = $derived(deadline ?? '');
	let deadlineBusy = $state(false);
	let deadlineError = $state('');
	let lettersBusy = $state(false);
	/** Teilspende in Bearbeitung je Posten (Cent) */
	let partial = $state<Record<string, number>>({});
	/** Posten, deren Wahl auf „Teilweise“ steht, aber noch nicht gespeichert ist */
	let pendingPartial = $state<Record<string, boolean>>({});

	const errMsg = (e: unknown, fallback: string) =>
		e instanceof ApiClientError ? e.message : e instanceof Error ? e.message : fallback;

	function choiceFor(it: RefundItem): DonationChoice {
		return pendingPartial[it.id ?? ''] ? 'partial' : choiceOf(it);
	}

	async function save(it: RefundItem, donatedCents: number) {
		if (!it.id) return;
		const problem = validateDonation(it.amountCents, donatedCents);
		if (problem) {
			toast.error(problem);
			return;
		}
		busyId = it.id;
		try {
			await apiFetch(`${base}/items/${it.id}/donation`, {
				method: 'PUT',
				body: JSON.stringify({ donatedCents })
			});
			pendingPartial = { ...pendingPartial, [it.id]: false };
			toast.success(
				donatedCents === 0
					? `${it.name}: wird ausgezahlt`
					: `${it.name}: ${formatEuro(donatedCents)} gespendet`
			);
			await onchanged();
		} catch (e) {
			toast.error(errMsg(e, 'Speichern fehlgeschlagen'));
		} finally {
			busyId = null;
		}
	}

	function onChoice(it: RefundItem, choice: DonationChoice) {
		if (!it.id) return;
		if (choice === 'partial') {
			// Betrag erst eingeben, dann speichern
			const start =
				it.donatedCents > 0 && it.donatedCents < it.amountCents
					? it.donatedCents
					: Math.floor(it.amountCents / 2 / 100) * 100;
			partial = { ...partial, [it.id]: start };
			pendingPartial = { ...pendingPartial, [it.id]: true };
			return;
		}
		pendingPartial = { ...pendingPartial, [it.id]: false };
		void save(it, donationForChoice(it.amountCents, choice));
	}

	async function copyLink(it: RefundItem, rotate = false) {
		if (!it.id) return;
		busyId = it.id;
		try {
			const res = await apiFetch<{ url: string }>(`${base}/items/${it.id}/link`, {
				method: 'POST',
				body: JSON.stringify(rotate ? { rotate: true } : {})
			});
			await navigator.clipboard.writeText(res.url);
			toast.success(rotate ? 'Neuer Link kopiert – der alte gilt nicht mehr' : 'Link kopiert');
			if (!it.hasLink || rotate) await onchanged();
		} catch (e) {
			toast.error(errMsg(e, 'Link konnte nicht erzeugt werden'));
		} finally {
			busyId = null;
		}
	}

	async function letters(ids?: string[]) {
		lettersBusy = true;
		try {
			await downloadPdf(
				`/api/v1${base}/letters.pdf`,
				{ method: 'POST', body: JSON.stringify(ids ? { itemIds: ids } : {}) },
				'Rueckzahlung-Briefe.pdf'
			);
			await onchanged();
		} catch (e) {
			toast.error(errMsg(e, 'Briefe konnten nicht erzeugt werden'));
		} finally {
			lettersBusy = false;
		}
	}

	async function saveDeadline(value: string | null) {
		deadlineBusy = true;
		deadlineError = '';
		try {
			await apiFetch(`${base}/deadline`, {
				method: 'PUT',
				body: JSON.stringify({ deadline: value })
			});
			toast.success(value ? `Rückmeldung bis ${formatDateDe(value)}` : 'Frist entfernt');
			await onchanged();
		} catch (e) {
			const msg = errMsg(e, 'Frist konnte nicht gespeichert werden');
			const details =
				e instanceof ApiClientError && Array.isArray(e.details)
					? (e.details as { path?: unknown[]; message?: string }[])
					: [];
			deadlineError = details.find((d) => d.path?.[0] === 'deadline')?.message ?? msg;
		} finally {
			deadlineBusy = false;
		}
	}

	const totals = $derived(
		items.reduce(
			(a, i) => ({
				donated: a.donated + i.donatedCents,
				payout: a.payout + i.payoutCents,
				donors: a.donors + (i.donatedCents > 0 ? 1 : 0)
			}),
			{ donated: 0, payout: 0, donors: 0 }
		)
	);
</script>

<div class="space-y-3">
	<div class="space-y-2 rounded-lg border p-3">
		<div class="flex flex-wrap items-end gap-2">
			<div class="space-y-1">
				<label class="text-sm font-medium" for="refund-deadline">Rückmeldung bis</label>
				<Input
					id="refund-deadline"
					type="date"
					class="w-44"
					min={todayBerlin()}
					bind:value={deadlineDraft}
					disabled={!editable || deadlineBusy}
					aria-invalid={!!deadlineError}
					aria-describedby="refund-deadline-hint{deadlineError ? ' refund-deadline-error' : ''}"
				/>
			</div>
			{#if editable}
				<Button
					size="sm"
					variant="outline"
					disabled={deadlineBusy || !deadlineDraft || deadlineDraft === (deadline ?? '')}
					onclick={() => saveDeadline(deadlineDraft)}
				>
					{deadlineBusy ? 'Speichert …' : 'Frist speichern'}
				</Button>
				{#if deadline}
					<Button
						size="sm"
						variant="ghost"
						disabled={deadlineBusy}
						onclick={() => saveDeadline(null)}
					>
						Frist entfernen
					</Button>
				{/if}
			{/if}
		</div>
		{#if deadlineError}
			<p id="refund-deadline-error" class="text-xs text-destructive" role="alert">
				{deadlineError}
			</p>
		{/if}
		<p id="refund-deadline-hint" class="text-xs text-muted-foreground">
			{#if deadline && deadlineRunning}
				Bis zum {formatDateDe(deadline)} kann jede Person über den Link wählen. Die Kasse zahlt erst danach
				aus; ohne Rückmeldung wird ausgezahlt.
			{:else if deadline}
				Die Frist ist am {formatDateDe(deadline)} abgelaufen. Der Link ist geschlossen, die Kasse zahlt
				aus. Nachträgliche Rückmeldungen kannst du hier noch eintragen.
			{:else}
				Ohne Frist zahlt die Kasse sofort aus. Mit Frist wartet sie, bis alle sich melden konnten.
			{/if}
		</p>
	</div>

	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="text-sm text-muted-foreground" aria-live="polite">
			Auszahlung {formatEuro(totals.payout)} · gespendet {formatEuro(totals.donated)}
			{#if totals.donors}({totals.donors}
				{totals.donors === 1 ? 'Person' : 'Personen'}){/if}
		</p>
		{#if editable}
			<Button variant="outline" size="sm" disabled={lettersBusy} onclick={() => letters()}>
				<FileText />
				{lettersBusy ? 'Erzeugt …' : 'Briefe mit QR-Code (PDF)'}
			</Button>
		{/if}
	</div>

	<ul class="max-h-[50dvh] divide-y overflow-auto rounded-lg border">
		{#each items as it (it.id ?? it.participantId)}
			{@const locked = it.paidCents > 0}
			{@const choice = choiceFor(it)}
			<li class="space-y-2 px-3 py-2.5">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div class="min-w-0">
						<div class="truncate text-sm font-medium">{it.name}</div>
						<div class="text-xs text-muted-foreground tabular-nums">
							Anteil {formatEuro(it.amountCents)}
							{#if it.donatedCents > 0}
								· Auszahlung {formatEuro(it.payoutCents)}
							{/if}
						</div>
					</div>
					<div class="flex flex-wrap items-center gap-1.5">
						{#if it.decidedVia === 'link'}<Badge variant="info">über Link</Badge>{/if}
						{#if locked}
							<Badge variant="success"><Lock class="size-3" aria-hidden="true" /> überwiesen</Badge>
						{/if}
						{#if editable && it.id}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon"
											aria-label={`Weitere Aktionen für ${it.name}`}
										>
											<MoreHorizontal />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									<DropdownMenu.Item onclick={() => letters([it.id!])}>
										<FileText /> Brief (PDF)
									</DropdownMenu.Item>
									<DropdownMenu.Item onclick={() => copyLink(it)}>
										<Copy /> Link kopieren
									</DropdownMenu.Item>
									{#if it.hasLink}
										<DropdownMenu.Item onclick={() => copyLink(it, true)}>
											<RefreshCw /> Link erneuern
										</DropdownMenu.Item>
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					</div>
				</div>
				{#if editable && it.id}
					<SegmentedSlider
						value={choice}
						options={CHOICES.map((c) => ({ ...c, disabled: locked }))}
						label={`Rückzahlung für ${it.name}`}
						disabled={locked || busyId === it.id}
						onchange={(v) => onChoice(it, v)}
					/>
					{#if choice === 'partial' && !locked}
						<div class="flex flex-wrap items-center gap-2">
							<span class="text-sm">Davon spenden</span>
							<MoneyInput
								class="w-32"
								label={`Spende von ${it.name} in Euro`}
								max={it.amountCents}
								cents={partial[it.id!] ?? it.donatedCents}
								onchange={(v) => (partial = { ...partial, [it.id!]: v })}
							/>
							<Button
								size="sm"
								disabled={busyId === it.id}
								onclick={() => save(it, partial[it.id!] ?? it.donatedCents)}
							>
								Speichern
							</Button>
							<span class="text-xs text-muted-foreground">ganze Euro</span>
						</div>
					{/if}
				{:else}
					<p class="text-sm">
						{#if it.donatedCents >= it.amountCents}
							Spendet alles
						{:else if it.donatedCents > 0}
							Spendet {formatEuro(it.donatedCents)}
						{:else}
							Wird ausgezahlt
						{/if}
					</p>
				{/if}
			</li>
		{/each}
	</ul>
	<p class="text-xs text-muted-foreground">
		Ohne Rückmeldung wird ausgezahlt. Gespendetes bleibt in der Stammkasse; die Kasse zahlt nur den
		Rest aus. Nach der Überweisung lässt sich die Wahl nicht mehr ändern.
	</p>
</div>
