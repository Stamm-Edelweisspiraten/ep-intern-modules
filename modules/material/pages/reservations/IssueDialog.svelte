<script lang="ts">
	// Ausgabe: Zuteilungsvorschlag für Anzahl-Zeilen, Scannen (Kamera/USB/Eingabe), Mengen, Fehlscan zurücknehmen.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { BUSY_SAVE, ConfirmDialog, NumberStepper } from '$lib/components/layout';
	import type { AllocationSuggestion, Reservation, ReservationLine } from '../../schemas';
	import { API, errorText } from '../helpers';
	import ScanField from './ScanField.svelte';
	import {
		isNotPartOfReservation,
		issueUnits,
		loadSetUnits,
		resolveCode,
		targetHint,
		unissueUnit
	} from './scan';

	let {
		open = $bindable(false),
		reservation,
		onchanged
	}: {
		open?: boolean;
		reservation: Reservation;
		/** Neuer Stand nach jeder Buchung */
		onchanged?: (r: Reservation) => void | Promise<void>;
	} = $props();

	interface Pending {
		id: string;
		name: string;
		code: string;
	}

	let res = $state<Reservation>(untrack(() => reservation));
	let allocation = $state<AllocationSuggestion[]>([]);
	let allocationError = $state('');
	let loadingAllocation = $state(false);
	let pending = $state<Pending[]>([]);
	let bulk = $state<Record<string, number>>({});
	let busy = $state(false);
	let scanBusy = $state(false);
	let error = $state('');
	let extraOpen = $state(false);
	let extraText = $state('');
	let camera = $state(false);

	$effect(() => {
		if (!open) {
			camera = false;
			return;
		}
		untrack(() => {
			res = reservation;
			pending = [];
			error = '';
			initBulk(reservation);
			void loadAllocation();
		});
	});

	function initBulk(r: Reservation) {
		bulk = Object.fromEntries(
			r.lines
				.filter((l) => l.articleKind === 'bulk')
				.map((l) => [l.id, l.issuedQty > 0 ? l.issuedQty : l.quantity])
		);
	}

	async function loadAllocation() {
		loadingAllocation = true;
		allocationError = '';
		try {
			allocation = await apiFetch<AllocationSuggestion[]>(
				`${API}/reservations/${res.id}/allocation`
			);
		} catch (e) {
			allocation = [];
			allocationError = errorText(e, 'Vorschlag konnte nicht geladen werden.');
		} finally {
			loadingAllocation = false;
		}
	}

	const outIds = $derived(new Set(res.assigned.filter((a) => !a.returnedAt).map((a) => a.unit.id)));
	const outUnits = $derived(res.assigned.filter((a) => !a.returnedAt));
	const bulkLines = $derived(res.lines.filter((l) => l.articleKind === 'bulk'));
	const unitLines = $derived(res.lines.filter((l) => l.articleKind !== 'bulk'));
	const bulkChanges = $derived(
		bulkLines
			.filter((l) => (bulk[l.id] ?? l.issuedQty) !== l.issuedQty)
			.map((l) => ({ lineId: l.id, quantity: bulk[l.id] ?? 0 }))
	);
	const canSubmit = $derived(pending.length > 0 || bulkChanges.length > 0);

	function addPending(list: Pending[]) {
		let added = 0;
		for (const p of list) {
			if (outIds.has(p.id) || pending.some((x) => x.id === p.id)) continue;
			pending.push(p);
			added++;
		}
		return added;
	}

	function takeSuggestion(s: AllocationSuggestion) {
		addPending(s.units.map((u) => ({ id: u.id, name: u.name, code: u.code })));
	}

	function takeAll() {
		for (const s of allocation) takeSuggestion(s);
		for (const l of unitLines) if (l.kind === 'unit') void takeLine(l);
	}

	async function takeLine(l: ReservationLine) {
		if (l.kind === 'unit' && l.unitId) {
			addPending([{ id: l.unitId, name: l.name, code: l.code ?? '' }]);
		} else if (l.kind === 'set' && l.setId) {
			try {
				const units = await loadSetUnits(l.setId);
				const n = addPending(units.map((u) => ({ id: u.id, name: u.name, code: u.code })));
				if (!n) toast.info(`Set ${l.name}: nichts mehr auszugeben`);
			} catch (e) {
				toast.error(errorText(e, 'Set konnte nicht geladen werden'));
			}
		}
	}

	async function onscan(raw: string) {
		scanBusy = true;
		try {
			const t = await resolveCode(raw);
			if (t?.type === 'unit') {
				if (outIds.has(t.id)) toast.info(`${t.name} ist schon ausgegeben`);
				else if (!addPending([{ id: t.id, name: t.name, code: t.code }]))
					toast.info(`${t.name} ist schon in der Liste`);
				else toast.success(`${t.name} erfasst`);
			} else if (t?.type === 'set') {
				const units = await loadSetUnits(t.id);
				const n = addPending(units.map((u) => ({ id: u.id, name: u.name, code: u.code })));
				toast.success(`Set ${t.name}: ${n} Teile erfasst`);
			} else {
				toast.error(targetHint(t));
			}
		} catch (e) {
			toast.error(errorText(e, 'Code konnte nicht geprüft werden'));
		} finally {
			scanBusy = false;
		}
	}

	async function submit(allowExtra = false) {
		if (!canSubmit) return;
		busy = true;
		error = '';
		try {
			const n = pending.length;
			res = await issueUnits(res.id, {
				unitIds: pending.map((p) => p.id),
				bulk: bulkChanges,
				allowExtra
			});
			pending = [];
			initBulk(res);
			toast.success(n ? `${n} ${n === 1 ? 'Stück' : 'Stücke'} ausgegeben` : 'Ausgabe gebucht');
			await onchanged?.(res);
			void loadAllocation();
		} catch (e) {
			if (!allowExtra && isNotPartOfReservation(e)) {
				extraText = `${e.message}. Trotzdem mitgeben? Es wird als zusätzliche Position aufgenommen, wenn es im Zeitraum frei ist.`;
				extraOpen = true;
			} else {
				error = errorText(e, 'Ausgabe fehlgeschlagen');
			}
		} finally {
			busy = false;
		}
	}

	async function unissue(unitId: string, name: string) {
		busy = true;
		try {
			res = await unissueUnit(res.id, unitId);
			initBulk(res);
			toast.success(`Ausgabe von ${name} zurückgenommen`);
			await onchanged?.(res);
			void loadAllocation();
		} catch (e) {
			toast.error(errorText(e, 'Zurücknehmen fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	function progressOf(l: ReservationLine): { done: number; total: number } {
		if (l.articleKind === 'bulk') return { done: l.issuedQty, total: l.quantity };
		return { done: l.assignedCount, total: l.quantity };
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Ausgeben – {res.title}</Dialog.Title>
			<Dialog.Description>
				Stücke scannen oder den Vorschlag übernehmen, dann „Ausgabe buchen“. Kisten nehmen ihren
				Inhalt mit.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-5">
			<section class="space-y-2" aria-labelledby="issue-scan">
				<h3 id="issue-scan" class="text-sm font-medium">Scannen</h3>
				<ScanField {onscan} busy={scanBusy || busy} id="issue-code" bind:camera />
			</section>

			<section class="space-y-2" aria-labelledby="issue-lines">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h3 id="issue-lines" class="text-sm font-medium">Positionen</h3>
					{#if allocation.length || unitLines.some((l) => l.kind === 'unit')}
						<Button size="sm" variant="outline" onclick={takeAll} disabled={busy}>
							Alle Vorschläge übernehmen
						</Button>
					{/if}
				</div>
				{#if allocationError}
					<p class="text-xs text-destructive" role="alert">{allocationError}</p>
				{/if}
				<ul class="divide-y rounded-md border">
					{#each res.lines as l (l.id)}
						{@const p = progressOf(l)}
						{@const s = allocation.find((a) => a.lineId === l.id)}
						<li class="space-y-2 p-3">
							<div class="flex flex-wrap items-start justify-between gap-2">
								<div class="min-w-0">
									<div class="font-medium">
										{l.kind === 'set' ? `Set ${l.name}` : l.name}
										{#if l.code}<span class="text-xs text-muted-foreground"> · {l.code}</span>{/if}
									</div>
									<div class="text-xs text-muted-foreground tabular-nums">
										{p.done} von {p.total}
										{l.articleKind === 'bulk' ? l.unitLabel : 'ausgegeben'}
									</div>
								</div>
								<Badge variant={p.done >= p.total ? 'success' : 'outline'} class="tabular-nums">
									{p.done}/{p.total}
								</Badge>
							</div>
							{#if l.articleKind === 'bulk'}
								<div class="flex flex-wrap items-center gap-2">
									<span class="text-sm">Ausgegeben insgesamt</span>
									<NumberStepper
										label={`Ausgegeben: ${l.name}`}
										min={l.returnedQty}
										max={Math.max(l.quantity, l.issuedQty) * 2}
										unit={l.unitLabel}
										value={bulk[l.id] ?? l.issuedQty}
										disabled={busy}
										onchange={(v) => (bulk = { ...bulk, [l.id]: v })}
									/>
								</div>
							{:else if s}
								<div class="rounded-md bg-muted/50 p-2 text-sm">
									<p class="text-xs text-muted-foreground">
										Vorschlag für {s.needed}:
										{s.units.map((u) => u.name).join(', ') || '–'}
									</p>
									{#if s.splitSets.length}
										<p class="mt-1 text-xs text-info">
											Aufgeteilt {s.splitSets.length === 1 ? 'wird' : 'werden'}: {s.splitSets.join(
												', '
											)}
										</p>
									{/if}
									{#if s.missing > 0}
										<p class="mt-1 text-xs text-warning">{s.missing} nicht verfügbar</p>
									{/if}
									{#if s.units.length}
										<Button
											size="sm"
											variant="outline"
											class="mt-2"
											onclick={() => takeSuggestion(s)}
										>
											Vorschlag übernehmen
										</Button>
									{/if}
								</div>
							{:else if (l.kind === 'unit' || l.kind === 'set') && p.done < p.total}
								<Button size="sm" variant="outline" onclick={() => takeLine(l)} disabled={busy}>
									{l.kind === 'set' ? 'Ganzes Set übernehmen' : 'Übernehmen'}
								</Button>
							{:else if loadingAllocation && l.kind === 'article'}
								<p class="text-xs text-muted-foreground">Vorschlag lädt …</p>
							{/if}
						</li>
					{/each}
				</ul>
			</section>

			<section class="space-y-2" aria-labelledby="issue-pending">
				<h3 id="issue-pending" class="text-sm font-medium">
					Zum Ausgeben erfasst <span class="text-muted-foreground tabular-nums"
						>({pending.length})</span
					>
				</h3>
				{#if pending.length}
					<ul class="flex flex-wrap gap-1.5">
						{#each pending as p (p.id)}
							<li>
								<Badge variant="secondary" class="gap-1 pr-1">
									{p.name}
									<span class="text-muted-foreground">{p.code}</span>
									<button
										type="button"
										class="rounded-full p-0.5 hover:bg-background"
										aria-label={`${p.name} entfernen`}
										onclick={() => (pending = pending.filter((x) => x.id !== p.id))}
									>
										<X class="size-3" aria-hidden="true" />
									</button>
								</Badge>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">Noch nichts erfasst.</p>
				{/if}
			</section>

			{#if outUnits.length}
				<section class="space-y-2" aria-labelledby="issue-out">
					<h3 id="issue-out" class="text-sm font-medium">
						Schon ausgegeben <span class="text-muted-foreground tabular-nums"
							>({outUnits.length})</span
						>
					</h3>
					<ul class="max-h-48 divide-y overflow-y-auto rounded-md border">
						{#each outUnits as a (a.unit.id)}
							<li class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
								<span class="min-w-0 truncate">
									{a.unit.name} <span class="text-xs text-muted-foreground">{a.unit.code}</span>
								</span>
								<Button
									size="sm"
									variant="ghost"
									disabled={busy}
									aria-label={`Ausgabe von ${a.unit.name} zurücknehmen`}
									onclick={() => unissue(a.unit.id, a.unit.name)}
								>
									<Undo2 /> Fehlscan
								</Button>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
		</div>

		<Dialog.Footer class="sticky bottom-0 bg-background">
			<Button variant="outline" onclick={() => (open = false)}>Schließen</Button>
			<Button onclick={() => submit()} disabled={busy || !canSubmit}>
				{busy
					? BUSY_SAVE
					: pending.length
						? `${pending.length} ${pending.length === 1 ? 'Stück' : 'Stücke'} ausgeben`
						: 'Ausgabe buchen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={extraOpen}
	title="Gehört nicht zur Reservierung"
	description={extraText}
	confirmLabel="Trotzdem mitgeben"
	onconfirm={() => submit(true)}
/>
