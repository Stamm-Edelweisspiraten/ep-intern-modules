<script lang="ts">
	// Rückgabe: draußen befindliche Stücke mit Zustand und Notiz, Scannen markiert als zurück, Mengen zurück,
	// Rest als verloren abschließen. Kisten bringen ihren Inhalt mit (Server).
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { BUSY_SAVE, ConfirmDialog, NumberStepper } from '$lib/components/layout';
	import { CONDITIONS, CONDITION_LABELS, type Condition, type Reservation } from '../../schemas';
	import { API, errorText } from '../helpers';
	import ScanField from './ScanField.svelte';
	import { loadSetUnits, resolveCode, targetHint } from './scan';

	let {
		open = $bindable(false),
		reservation,
		onchanged
	}: {
		open?: boolean;
		reservation: Reservation;
		onchanged?: (r: Reservation) => void | Promise<void>;
	} = $props();

	interface Row {
		checked: boolean;
		condition: Condition;
		note: string;
	}

	let res = $state<Reservation>(untrack(() => reservation));
	let rows = $state<Record<string, Row>>({});
	let bulk = $state<Record<string, number>>({});
	let busy = $state(false);
	let scanBusy = $state(false);
	let error = $state('');
	let lostOpen = $state(false);
	let camera = $state(false);

	const conditionOptions = CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }));

	$effect(() => {
		if (!open) {
			camera = false;
			return;
		}
		untrack(() => {
			res = reservation;
			error = '';
			init(reservation);
		});
	});

	function init(r: Reservation) {
		const next: Record<string, Row> = {};
		for (const a of r.assigned) {
			if (a.returnedAt) continue;
			next[a.unit.id] = rows[a.unit.id] ?? { checked: false, condition: 'ok', note: '' };
		}
		rows = next;
		bulk = Object.fromEntries(
			r.lines.filter((l) => l.articleKind === 'bulk').map((l) => [l.id, l.issuedQty])
		);
	}

	const outUnits = $derived(res.assigned.filter((a) => !a.returnedAt));
	const bulkLines = $derived(
		res.lines.filter((l) => l.articleKind === 'bulk' && l.issuedQty > l.returnedQty)
	);
	const checkedCount = $derived(outUnits.filter((a) => rows[a.unit.id]?.checked).length);
	const bulkChanges = $derived(
		bulkLines
			.filter((l) => (bulk[l.id] ?? l.returnedQty) !== l.returnedQty)
			.map((l) => ({ lineId: l.id, quantity: bulk[l.id] ?? l.returnedQty }))
	);
	const missingAfter = $derived(
		outUnits.length -
			checkedCount +
			bulkLines.reduce((s, l) => s + (l.issuedQty - (bulk[l.id] ?? l.returnedQty)), 0)
	);

	/** Stück (und ggf. Inhalt einer Kiste) als zurück markieren */
	function mark(unitId: string, on = true) {
		const row = rows[unitId];
		if (!row) return false;
		row.checked = on;
		for (const a of outUnits) {
			if (a.unit.containerId === unitId && rows[a.unit.id]) rows[a.unit.id]!.checked = on;
		}
		return true;
	}

	function markAll(on: boolean) {
		for (const a of outUnits) if (rows[a.unit.id]) rows[a.unit.id]!.checked = on;
	}

	async function onscan(raw: string) {
		scanBusy = true;
		try {
			const t = await resolveCode(raw);
			if (t?.type === 'unit') {
				if (mark(t.id)) toast.success(`${t.name} zurück`);
				else toast.error(`${t.name} ist nicht aus dieser Reservierung ausgegeben`);
			} else if (t?.type === 'set') {
				const units = await loadSetUnits(t.id);
				const n = units.filter((u) => mark(u.id)).length;
				if (n) toast.success(`Set ${t.name}: ${n} Teile zurück`);
				else toast.error(`Vom Set ${t.name} ist nichts ausgegeben`);
			} else {
				toast.error(targetHint(t));
			}
		} catch (e) {
			toast.error(errorText(e, 'Code konnte nicht geprüft werden'));
		} finally {
			scanBusy = false;
		}
	}

	async function submit(closeMissingAsLost = false) {
		busy = true;
		error = '';
		try {
			const units = outUnits
				.filter((a) => rows[a.unit.id]?.checked)
				.map((a) => ({
					unitId: a.unit.id,
					condition: rows[a.unit.id]!.condition,
					note: rows[a.unit.id]!.note.trim()
				}));
			res = await apiFetch<Reservation>(`${API}/reservations/${res.id}/return`, {
				method: 'POST',
				body: JSON.stringify({ units, bulk: bulkChanges, closeMissingAsLost })
			});
			const damaged = units.filter((u) => u.condition !== 'ok' && u.condition !== 'worn').length;
			toast.success(
				res.status === 'returned'
					? 'Alles zurück – Reservierung abgeschlossen'
					: `${units.length} ${units.length === 1 ? 'Stück' : 'Stücke'} zurückgenommen`,
				damaged
					? {
							description: `${damaged} mit Schaden gemeldet – die Materialwart*in wird informiert.`
						}
					: undefined
			);
			init(res);
			await onchanged?.(res);
			if (res.status === 'returned') open = false;
		} catch (e) {
			error = errorText(e, 'Rückgabe fehlgeschlagen');
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Zurücknehmen – {res.title}</Dialog.Title>
			<Dialog.Description>
				Scanne, was zurückkommt, oder hake es ab. Schäden mit Zustand und Notiz melden.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-5">
			<section class="space-y-2" aria-labelledby="return-scan">
				<h3 id="return-scan" class="text-sm font-medium">Scannen</h3>
				<ScanField {onscan} busy={scanBusy || busy} id="return-code" bind:camera />
			</section>

			{#if outUnits.length}
				<section class="space-y-2" aria-labelledby="return-units">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<h3 id="return-units" class="text-sm font-medium">
							Stücke <span class="text-muted-foreground tabular-nums"
								>({checkedCount} von {outUnits.length} zurück)</span
							>
						</h3>
						<Button
							size="sm"
							variant="outline"
							onclick={() => markAll(checkedCount < outUnits.length)}
						>
							{checkedCount < outUnits.length ? 'Alle markieren' : 'Keine markieren'}
						</Button>
					</div>
					<ul class="divide-y rounded-md border">
						{#each outUnits as a (a.unit.id)}
							{@const row = rows[a.unit.id]}
							{#if row}
								<li class="space-y-2 p-3">
									<label class="flex cursor-pointer items-start gap-3">
										<Checkbox
											checked={row.checked}
											onCheckedChange={(v) => mark(a.unit.id, v === true)}
											class="mt-0.5"
										/>
										<span class="min-w-0 flex-1">
											<span class="block font-medium">{a.unit.name}</span>
											<span class="block text-xs text-muted-foreground">
												{a.unit.code}{a.unit.containerName ? ` · in ${a.unit.containerName}` : ''}
												{a.unit.isContainer ? ' · Kiste (Inhalt kommt mit)' : ''}
											</span>
										</span>
									</label>
									{#if row.checked}
										<div class="grid grid-cols-1 gap-2 pl-7 sm:grid-cols-2">
											<SelectField
												size="sm"
												label={`Zustand ${a.unit.name}`}
												options={conditionOptions}
												value={row.condition}
												onchange={(v) => (row.condition = (v as Condition | null) ?? 'ok')}
											/>
											<Input
												class="h-7"
												placeholder={row.condition === 'ok'
													? 'Notiz (optional)'
													: 'Was ist kaputt?'}
												aria-label={`Notiz ${a.unit.name}`}
												maxlength={1000}
												bind:value={row.note}
											/>
										</div>
									{/if}
								</li>
							{/if}
						{/each}
					</ul>
				</section>
			{/if}

			{#if bulkLines.length}
				<section class="space-y-2" aria-labelledby="return-bulk">
					<h3 id="return-bulk" class="text-sm font-medium">Mengen</h3>
					<ul class="divide-y rounded-md border">
						{#each bulkLines as l (l.id)}
							<li class="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
								<div>
									<div class="font-medium">{l.name}</div>
									<div class="text-xs text-muted-foreground tabular-nums">
										ausgegeben {l.issuedQty} · bisher zurück {l.returnedQty}
									</div>
								</div>
								<NumberStepper
									label={`Zurück insgesamt: ${l.name}`}
									min={l.returnedQty}
									max={l.issuedQty}
									unit={l.unitLabel}
									value={bulk[l.id] ?? l.returnedQty}
									disabled={busy}
									onchange={(v) => (bulk = { ...bulk, [l.id]: v })}
								/>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if !outUnits.length && !bulkLines.length}
				<p class="text-sm text-muted-foreground">Es ist nichts mehr draußen.</p>
			{/if}

			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
		</div>

		<Dialog.Footer class="sticky bottom-0 bg-background">
			<Button variant="outline" onclick={() => (open = false)}>Schließen</Button>
			{#if outUnits.length || bulkLines.length}
				<Button variant="outline" disabled={busy} onclick={() => (lostOpen = true)}>
					Rest als verloren abschließen
				</Button>
			{/if}
			<Button onclick={() => submit()} disabled={busy || (!checkedCount && !bulkChanges.length)}>
				{busy ? BUSY_SAVE : 'Rückgabe buchen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={lostOpen}
	destructive
	title="Rest als verloren abschließen?"
	description={missingAfter > 0
		? `Was du jetzt nicht als zurück markiert hast (${missingAfter}), wird als verloren gebucht – Mengen werden aus dem Bestand ausgebucht. Die Reservierung ist danach abgeschlossen.`
		: 'Alles ist markiert – die Rückgabe wird gebucht und die Reservierung abgeschlossen.'}
	confirmLabel="Als verloren abschließen"
	onconfirm={() => submit(true)}
/>
