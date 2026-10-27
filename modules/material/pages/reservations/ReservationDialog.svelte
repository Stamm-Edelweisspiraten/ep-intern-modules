<script lang="ts">
	// Reservierung anlegen/bearbeiten: Titel, Zeitraum, Aktion, Notiz und Positionen mit Live-Prüfung.
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Boxes from '@lucide/svelte/icons/boxes';
	import Package from '@lucide/svelte/icons/package';
	import Tent from '@lucide/svelte/icons/tent';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { ApiClientError, apiFetch, todayBerlin } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SelectField } from '$lib/components/ui/select-field';
	import { BUSY_SAVE, FormField, NumberStepper } from '$lib/components/layout';
	import {
		MAX_QUANTITY,
		reservationInput,
		type Article,
		type ArticleAvailability,
		type LineAvailability,
		type MaterialSet,
		type Reservation,
		type ReservationLineInput,
		type UnitSummary
	} from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';
	import UnitPicker from '../shared/UnitPicker.svelte';
	import type { ReservationPrefill } from './scan';

	let {
		open = $bindable(false),
		reservation = null,
		prefill = null,
		onsaved
	}: {
		open?: boolean;
		/** Bearbeiten (sonst neu) */
		reservation?: Reservation | null;
		/** Vorbelegung für neue Reservierungen (z. B. aus einer Aktion) */
		prefill?: ReservationPrefill | null;
		onsaved?: (r: Reservation) => void | Promise<void>;
	} = $props();

	interface DraftLine {
		key: string;
		input: ReservationLineInput;
		name: string;
		detail: string;
	}
	interface ActionOption {
		id: string;
		name: string;
	}

	type AddMode = 'article' | 'set' | 'unit';

	let title = $state('');
	let startsOn = $state('');
	let endsOn = $state('');
	let notes = $state('');
	let actionId = $state<string | null>(null);
	let actionName = $state<string | null>(null);
	let lines = $state<DraftLine[]>([]);
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let busy = $state(false);

	let articles = $state<Article[]>([]);
	let sets = $state<MaterialSet[]>([]);
	let actions = $state<ActionOption[]>([]);
	let free = $state<Record<string, number>>({});
	let catalogError = $state('');

	let addMode = $state<AddMode>('article');
	let addArticle = $state<string | null>(null);
	let addQty = $state(1);
	let addSet = $state<string | null>(null);

	let check = $state<LineAvailability[]>([]);
	let checking = $state(false);
	let serverLineErrors = $state<Record<number, string>>({});

	const editing = $derived(!!reservation);
	/** Nach der Ausgabe nur Titel, Notiz, Aktion und Ende */
	const issued = $derived(reservation?.status === 'issued');
	const periodValid = $derived(!!startsOn && !!endsOn && endsOn >= startsOn);

	function lineFromReservation(l: Reservation['lines'][number]): DraftLine | null {
		const key = crypto.randomUUID();
		if (l.kind === 'unit' && l.unitId)
			return {
				key,
				input: { kind: 'unit', unitId: l.unitId },
				name: l.name,
				detail: l.code ?? ''
			};
		if (l.kind === 'set' && l.setId)
			return {
				key,
				input: { kind: 'set', setId: l.setId },
				name: `Set ${l.name}`,
				detail: `${l.quantity} Teile`
			};
		if (l.kind === 'article' && l.articleId)
			return {
				key,
				input: { kind: 'article', articleId: l.articleId, quantity: l.quantity },
				name: l.name,
				detail: l.unitLabel
			};
		return null;
	}

	$effect(() => {
		if (!open) return;
		untrack(() => {
			const r = reservation;
			const p = prefill;
			const today = todayBerlin();
			title = r?.title ?? p?.title ?? '';
			startsOn = r?.startsOn ?? p?.from ?? today;
			endsOn = r?.endsOn ?? p?.to ?? p?.from ?? startsOn;
			if (endsOn < startsOn) endsOn = startsOn;
			notes = r?.notes ?? '';
			actionId = r?.actionId ?? p?.actionId ?? null;
			actionName = r?.actionName ?? p?.actionName ?? null;
			lines = (r?.lines ?? []).map(lineFromReservation).filter((l): l is DraftLine => !!l);
			errors = {};
			formError = '';
			serverLineErrors = {};
			check = [];
			addArticle = null;
			addSet = null;
			addQty = 1;
			void loadCatalog();
		});
		void tick().then(() => document.getElementById('res-title')?.focus());
	});

	async function loadCatalog() {
		catalogError = '';
		const [a, s] = await Promise.allSettled([
			apiFetch<Article[]>(`${API}/articles`),
			apiFetch<MaterialSet[]>(`${API}/sets`)
		]);
		if (a.status === 'fulfilled') articles = a.value;
		if (s.status === 'fulfilled') sets = s.value;
		if (a.status === 'rejected' || s.status === 'rejected')
			catalogError = 'Artikel oder Sets konnten nicht geladen werden.';
		try {
			const res = await apiFetch<{ items: ActionOption[] }>('/modules/actions/actions?limit=200');
			actions = res.items.map((x) => ({ id: x.id, name: x.name }));
		} catch {
			actions = []; // Modul „Aktionen“ nicht aktiv oder kein Recht → keine freie Auswahl
		}
	}

	// Freie Anzahl je Artikel im Zeitraum
	$effect(() => {
		if (!open || !periodValid) return;
		const params = new URLSearchParams({ from: startsOn, to: endsOn });
		if (reservation) params.set('excludeReservationId', reservation.id);
		let stale = false;
		const t = setTimeout(async () => {
			try {
				const list = await apiFetch<ArticleAvailability[]>(
					`${API}/availability/articles?${params}`
				);
				if (!stale) free = Object.fromEntries(list.map((x) => [x.articleId, x.free]));
			} catch {
				if (!stale) free = {};
			}
		}, 300);
		return () => {
			stale = true;
			clearTimeout(t);
		};
	});

	// Live-Prüfung der Positionen (entprellt)
	$effect(() => {
		if (!open || issued) return;
		const payload = {
			startsOn,
			endsOn,
			excludeReservationId: reservation?.id ?? null,
			lines: lines.map((l) => l.input)
		};
		if (!periodValid || !payload.lines.length) {
			check = [];
			return;
		}
		const body = JSON.stringify(payload);
		let stale = false;
		const t = setTimeout(async () => {
			checking = true;
			try {
				const res = await apiFetch<LineAvailability[]>(`${API}/availability`, {
					method: 'POST',
					body
				});
				if (!stale) {
					check = res;
					serverLineErrors = {};
				}
			} catch {
				if (!stale) check = [];
			} finally {
				if (!stale) checking = false;
			}
		}, 400);
		return () => {
			stale = true;
			clearTimeout(t);
		};
	});

	const articleOptions = $derived(
		articles
			.filter((a) => !a.archived)
			.map((a) => ({
				value: a.id,
				label:
					free[a.id] !== undefined
						? `${a.name} (frei: ${free[a.id]} ${a.unitLabel})`
						: `${a.name} (${a.kind === 'bulk' ? a.stockTotal : a.usableCount} ${a.unitLabel})`
			}))
	);
	const setOptions = $derived(
		sets.map((s) => ({
			value: s.id,
			label: `${s.name} · ${s.templateName}${s.completeness.complete ? '' : ' (unvollständig)'}`
		}))
	);
	const chosenArticle = $derived(articles.find((a) => a.id === addArticle) ?? null);
	const chosenUnitIds = $derived(
		lines.flatMap((l) => (l.input.kind === 'unit' ? [l.input.unitId] : []))
	);
	const actionOptions = $derived.by(() => {
		const list = actions.map((a) => ({ value: a.id, label: a.name }));
		if (actionId && !list.some((o) => o.value === actionId))
			list.unshift({ value: actionId, label: actionName ?? 'Aktion' });
		return list;
	});

	function addArticleLine() {
		const a = chosenArticle;
		if (!a || addQty < 1) return;
		const existing = lines.find((l) => l.input.kind === 'article' && l.input.articleId === a.id);
		if (existing && existing.input.kind === 'article') {
			existing.input = {
				...existing.input,
				quantity: Math.min(MAX_QUANTITY, existing.input.quantity + addQty)
			};
		} else {
			lines.push({
				key: crypto.randomUUID(),
				input: { kind: 'article', articleId: a.id, quantity: addQty },
				name: a.name,
				detail: a.unitLabel
			});
		}
		addQty = 1;
	}

	function addSetLine() {
		const s = sets.find((x) => x.id === addSet);
		if (!s) return;
		if (lines.some((l) => l.input.kind === 'set' && l.input.setId === s.id)) {
			toast.info(`Set ${s.name} ist schon dabei`);
			return;
		}
		lines.push({
			key: crypto.randomUUID(),
			input: { kind: 'set', setId: s.id },
			name: `Set ${s.name}`,
			detail: `${s.units.length} Teile${s.completeness.complete ? '' : ' · unvollständig'}`
		});
		addSet = null;
	}

	function addUnitLine(u: UnitSummary) {
		if (chosenUnitIds.includes(u.id)) return;
		lines.push({
			key: crypto.randomUUID(),
			input: { kind: 'unit', unitId: u.id },
			name: u.name,
			detail: `${u.code}${u.isContainer ? ' · Kiste' : ''}`
		});
	}

	function removeLine(key: string) {
		lines = lines.filter((l) => l.key !== key);
		serverLineErrors = {};
	}

	function setQuantity(key: string, q: number) {
		const l = lines.find((x) => x.key === key);
		if (l && l.input.kind === 'article') l.input = { ...l.input, quantity: Math.max(1, q) };
	}

	function lineState(i: number): {
		error: string | null;
		notes: string[];
		available: number | null;
	} {
		const r = check.find((c) => c.index === i);
		return {
			error: serverLineErrors[i] ?? (r && !r.ok ? (r.message ?? 'Nicht verfügbar') : null),
			notes: r?.notes ?? [],
			available: r?.available ?? null
		};
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		formError = '';
		const parsed = reservationInput.safeParse({
			title,
			actionId,
			startsOn,
			endsOn,
			notes,
			lines: lines.map((l) => l.input)
		});
		if (!parsed.success) {
			errors = fieldErrors(parsed.error.issues);
			const first = Object.keys(errors)[0];
			if (first) document.getElementById(`res-${first.split('.')[0]}`)?.focus();
			return;
		}
		errors = {};
		busy = true;
		try {
			const body = issued
				? { title: parsed.data.title, notes: parsed.data.notes, actionId, endsOn }
				: parsed.data;
			const saved = await apiFetch<Reservation>(
				editing ? `${API}/reservations/${reservation!.id}` : `${API}/reservations`,
				{ method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) }
			);
			toast.success(editing ? 'Reservierung gespeichert' : 'Material reserviert');
			open = false;
			await onsaved?.(saved);
		} catch (err) {
			if (err instanceof ApiClientError && err.status === 409) {
				const d = err.details as { lines?: { index: number; message: string }[] } | undefined;
				serverLineErrors = Object.fromEntries((d?.lines ?? []).map((l) => [l.index, l.message]));
				formError = d?.lines?.length
					? 'Nicht alles ist im Zeitraum frei – siehe markierte Positionen.'
					: err.message;
			} else {
				errors = apiFieldErrors(err);
				formError = Object.keys(errors).length
					? 'Bitte prüfe die markierten Felder.'
					: errorText(err, 'Speichern fehlgeschlagen');
			}
		} finally {
			busy = false;
		}
	}

	const MODES: { value: AddMode; label: string; icon: typeof Package }[] = [
		{ value: 'article', label: 'Anzahl', icon: Package },
		{ value: 'set', label: 'Ganzes Set', icon: Tent },
		{ value: 'unit', label: 'Stück / Kiste', icon: Boxes }
	];
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{editing ? 'Reservierung bearbeiten' : 'Material reservieren'}</Dialog.Title>
			<Dialog.Description>
				{issued
					? 'Das Material ist ausgegeben: Titel, Notiz, Aktion und Ende lassen sich noch ändern.'
					: 'Reservierungen gelten sofort. Konkrete Stücke für „Anzahl“-Positionen werden erst bei der Ausgabe zugeteilt.'}
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={save} novalidate>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div class="sm:col-span-2">
					<FormField label="Titel" id="res-title" required error={errors.title}>
						<Input id="res-title" bind:value={title} placeholder="z. B. Sommerlager 2026" />
					</FormField>
				</div>
				<FormField label="Von" id="res-startsOn" required error={errors.startsOn}>
					<Input id="res-startsOn" type="date" bind:value={startsOn} disabled={issued} />
				</FormField>
				<FormField label="Bis" id="res-endsOn" required error={errors.endsOn}>
					<Input id="res-endsOn" type="date" bind:value={endsOn} min={startsOn} />
				</FormField>
				<div class="sm:col-span-2">
					<FormField
						label="Aktion"
						id="res-actionId"
						error={errors.actionId}
						hint={actionOptions.length ? undefined : 'Keine Aktionen verfügbar.'}
					>
						<SelectField
							id="res-actionId"
							label="Aktion"
							options={actionOptions}
							bind:value={actionId}
							emptyLabel="Keine Aktion"
							placeholder="Keine Aktion"
							onchange={(v) =>
								(actionName = actionOptions.find((o) => o.value === v)?.label ?? null)}
						/>
					</FormField>
				</div>
				<div class="sm:col-span-2">
					<FormField label="Notiz" id="res-notes" error={errors.notes}>
						<Textarea id="res-notes" rows={2} bind:value={notes} />
					</FormField>
				</div>
			</div>

			<fieldset class="space-y-3">
				<legend class="text-sm font-medium">Positionen</legend>
				{#if errors.lines}
					<p class="text-xs text-destructive" role="alert">{errors.lines}</p>
				{/if}
				{#if lines.length}
					<ul class="divide-y rounded-md border" aria-busy={checking}>
						{#each lines as l, i (l.key)}
							{@const st = lineState(i)}
							<li class="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
								<div class="min-w-0 flex-1">
									<div class="font-medium">{l.name}</div>
									{#if l.detail && l.input.kind !== 'article'}
										<div class="text-xs text-muted-foreground">{l.detail}</div>
									{/if}
									{#if st.error}
										<p class="mt-1 text-xs text-destructive" role="alert">{st.error}</p>
									{:else if l.input.kind === 'article' && st.available !== null}
										<p class="mt-1 text-xs text-muted-foreground tabular-nums">
											frei im Zeitraum: {st.available}
										</p>
									{/if}
									{#each st.notes as n (n)}
										<p class="mt-1 text-xs text-info">{n}</p>
									{/each}
								</div>
								<div class="flex items-center gap-2">
									{#if l.input.kind === 'article'}
										<NumberStepper
											label={`Anzahl ${l.name}`}
											min={1}
											max={MAX_QUANTITY}
											unit={l.detail}
											value={l.input.quantity}
											disabled={issued}
											invalid={!!st.error}
											onchange={(v) => setQuantity(l.key, v)}
										/>
									{/if}
									{#if !issued}
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={`${l.name} entfernen`}
											onclick={() => removeLine(l.key)}
										>
											<Trash2 />
										</Button>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">Noch keine Positionen.</p>
				{/if}

				{#if !issued}
					<div class="space-y-3 rounded-md border border-dashed p-3">
						<div class="flex flex-wrap gap-1" role="group" aria-label="Art der Position">
							{#each MODES as m (m.value)}
								<Button
									type="button"
									size="sm"
									variant={addMode === m.value ? 'default' : 'outline'}
									aria-pressed={addMode === m.value}
									onclick={() => (addMode = m.value)}
								>
									<m.icon aria-hidden="true" />
									{m.label}
								</Button>
							{/each}
						</div>
						{#if catalogError}
							<p class="text-xs text-destructive" role="alert">{catalogError}</p>
						{/if}
						{#if addMode === 'article'}
							<p class="text-xs text-muted-foreground">
								Für Mengen (Tassen) und Anfragen wie „8 Kohtenbahnen“ – welche Bahnen es werden,
								entscheidet die Ausgabe.
							</p>
							<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
								<SelectField
									class="min-w-0 flex-1"
									label="Artikel"
									placeholder="Artikel wählen …"
									options={articleOptions}
									bind:value={addArticle}
								/>
								<NumberStepper
									label="Anzahl"
									min={1}
									max={MAX_QUANTITY}
									unit={chosenArticle?.unitLabel}
									bind:value={addQty}
								/>
								<Button type="button" disabled={!chosenArticle} onclick={addArticleLine}>
									Hinzufügen
								</Button>
							</div>
						{:else if addMode === 'set'}
							<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
								<SelectField
									class="min-w-0 flex-1"
									label="Set"
									placeholder={sets.length ? 'Set wählen …' : 'Keine Sets angelegt'}
									options={setOptions}
									bind:value={addSet}
								/>
								<Button type="button" disabled={!addSet} onclick={addSetLine}>Hinzufügen</Button>
							</div>
						{:else}
							<UnitPicker
								single
								label="Stück oder Kiste suchen"
								from={periodValid ? startsOn : undefined}
								to={periodValid ? endsOn : undefined}
								exclude={chosenUnitIds}
								onpick={addUnitLine}
							/>
						{/if}
					</div>
				{/if}
			</fieldset>

			{#if formError}
				<p class="text-sm text-destructive" role="alert">{formError}</p>
			{/if}
			<Dialog.Footer class="sticky bottom-0 bg-background">
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>
					{busy ? BUSY_SAVE : editing ? 'Speichern' : 'Reservieren'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
