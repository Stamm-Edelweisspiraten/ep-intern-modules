<script lang="ts">
	// Scannen (mobil zuerst): Code per Kamera, USB-Scanner oder Eingabe → Treffer anzeigen oder direkt für eine
	// Reservierung ausgeben/zurücknehmen. `/modules/material/scan/<code>` (QR mit Handy-Kamera) löst sofort auf.
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import { apiFetch, can } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { SelectField } from '$lib/components/ui/select-field';
	import { ConfirmDialog, LoadingState, PageTitle } from '$lib/components/layout';
	import {
		BASE_PATH,
		CONDITIONS,
		CONDITION_LABELS,
		PERMISSIONS,
		codeFromScan,
		type CodeTarget,
		type Condition,
		type MaterialSet,
		type Reservation,
		type ReservationListItem,
		type UnitDetail,
		type UnitSummary
	} from '../schemas';
	import { API, errorText, formatPeriod, reservationHref, setHref, unitHref } from './helpers';
	import ConditionBadge from './shared/ConditionBadge.svelte';
	import StatusBadge from './shared/StatusBadge.svelte';
	import ScanField from './reservations/ScanField.svelte';
	import {
		isNotPartOfReservation,
		issueUnits,
		loadSetUnits,
		resolveCode,
		targetHint,
		unissueUnit
	} from './reservations/scan';

	let { params }: ModulePageProps = $props();

	type Mode = 'show' | 'issue' | 'return';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canHandleAny = $derived(
		can(permissions, PERMISSIONS.reserve) || can(permissions, PERMISSIONS.reservations)
	);

	let mode = $state<Mode>('show');
	let camera = $state(false);
	let busy = $state(false);

	// --- Anzeigen ---
	type Hit =
		| { type: 'unit'; target: CodeTarget; unit: UnitDetail }
		| { type: 'set'; target: CodeTarget; set: MaterialSet }
		| { type: 'location'; target: CodeTarget; units: UnitSummary[]; total: number }
		| { type: 'reserved'; code: string }
		| { type: 'unknown'; raw: string };
	let hit = $state<Hit | null>(null);
	let lookupError = $state('');

	// --- Ausgeben / Zurücknehmen ---
	let reservations = $state<ReservationListItem[]>([]);
	let reservationId = $state<string | null>(null);
	let current = $state<Reservation | null>(null);
	let returnCondition = $state<Condition>('ok');
	interface Booked {
		key: string;
		unitId: string;
		name: string;
		code: string;
		kind: 'issued' | 'returned';
		undone: boolean;
	}
	let booked = $state<Booked[]>([]);
	let extraOpen = $state(false);
	let extraText = $state('');
	let extraIds: { id: string; name: string; code: string }[] = [];

	const reservationOptions = $derived(
		reservations
			.filter((r) => (mode === 'return' ? r.status === 'issued' : true))
			.map((r) => ({
				value: r.id,
				label: `${r.title} · ${formatPeriod(r.startsOn, r.endsOn)}`
			}))
	);

	async function loadReservations() {
		try {
			reservations = await apiFetch<ReservationListItem[]>(`${API}/reservations?status=open`);
		} catch (e) {
			toast.error(errorText(e, 'Reservierungen konnten nicht geladen werden'));
		}
	}

	async function selectReservation(id: string | null) {
		reservationId = id;
		current = null;
		booked = [];
		if (!id) return;
		try {
			current = await apiFetch<Reservation>(`${API}/reservations/${id}`);
			if (!current.canHandle) toast.error('Diese Reservierung darfst du nicht ausgeben.');
		} catch (e) {
			toast.error(errorText(e, 'Reservierung konnte nicht geladen werden'));
		}
	}

	function setMode(m: Mode) {
		mode = m;
		hit = null;
		if (m !== 'show' && !reservations.length) void loadReservations();
		if (m === 'return' && current && current.status !== 'issued') void selectReservation(null);
	}

	async function show(raw: string) {
		lookupError = '';
		busy = true;
		try {
			const t = await resolveCode(raw);
			if (!t) {
				hit = { type: 'unknown', raw };
			} else if (t.type === 'unit') {
				hit = { type: 'unit', target: t, unit: await apiFetch<UnitDetail>(`${API}/units/${t.id}`) };
			} else if (t.type === 'set') {
				hit = { type: 'set', target: t, set: await apiFetch<MaterialSet>(`${API}/sets/${t.id}`) };
			} else if (t.type === 'location') {
				const res = await apiFetch<{ items: UnitSummary[]; total: number }>(
					`${API}/units?locationId=${t.id}&deep=1&limit=100`
				);
				hit = { type: 'location', target: t, units: res.items, total: res.total };
			} else {
				hit = { type: 'reserved', code: t.code };
			}
		} catch (e) {
			hit = null;
			lookupError = errorText(e, 'Code konnte nicht geprüft werden');
		} finally {
			busy = false;
		}
	}

	async function unitsOf(t: CodeTarget): Promise<{ id: string; name: string; code: string }[]> {
		if (t.type === 'unit') return [{ id: t.id, name: t.name, code: t.code }];
		if (t.type === 'set')
			return (await loadSetUnits(t.id)).map((u) => ({ id: u.id, name: u.name, code: u.code }));
		return [];
	}

	async function issue(list: { id: string; name: string; code: string }[], allowExtra = false) {
		if (!current) return;
		try {
			current = await issueUnits(current.id, { unitIds: list.map((u) => u.id), allowExtra });
			for (const u of list)
				booked.unshift({
					key: crypto.randomUUID(),
					unitId: u.id,
					name: u.name,
					code: u.code,
					kind: 'issued',
					undone: false
				});
			navigator.vibrate?.(40);
			toast.success(
				list.length === 1 ? `${list[0]!.name} ausgegeben` : `${list.length} Stücke ausgegeben`
			);
		} catch (e) {
			if (!allowExtra && isNotPartOfReservation(e)) {
				extraIds = list;
				extraText = `${e.message}. Trotzdem mitgeben? Es wird als zusätzliche Position aufgenommen, wenn es im Zeitraum frei ist.`;
				extraOpen = true;
			} else toast.error(errorText(e, 'Ausgabe fehlgeschlagen'));
		}
	}

	async function giveBack(list: { id: string; name: string; code: string }[]) {
		if (!current) return;
		const out = new Set(current.assigned.filter((a) => !a.returnedAt).map((a) => a.unit.id));
		const mine = list.filter((u) => out.has(u.id));
		if (!mine.length) {
			toast.error(
				list.length === 1
					? `${list[0]!.name} ist nicht aus dieser Reservierung ausgegeben`
					: 'Davon ist nichts aus dieser Reservierung ausgegeben'
			);
			return;
		}
		try {
			current = await apiFetch<Reservation>(`${API}/reservations/${current.id}/return`, {
				method: 'POST',
				body: JSON.stringify({
					units: mine.map((u) => ({ unitId: u.id, condition: returnCondition, note: '' })),
					bulk: [],
					closeMissingAsLost: false
				})
			});
			for (const u of mine)
				booked.unshift({
					key: crypto.randomUUID(),
					unitId: u.id,
					name: u.name,
					code: u.code,
					kind: 'returned',
					undone: false
				});
			navigator.vibrate?.(40);
			toast.success(
				current.status === 'returned'
					? 'Alles zurück – Reservierung abgeschlossen'
					: `${mine.length === 1 ? mine[0]!.name : `${mine.length} Stücke`} zurück (${CONDITION_LABELS[returnCondition]})`
			);
		} catch (e) {
			toast.error(errorText(e, 'Rückgabe fehlgeschlagen'));
		}
	}

	async function undo(b: Booked) {
		if (!current || b.kind !== 'issued') return;
		try {
			current = await unissueUnit(current.id, b.unitId);
			b.undone = true;
			toast.success(`Ausgabe von ${b.name} zurückgenommen`);
		} catch (e) {
			toast.error(errorText(e, 'Zurücknehmen fehlgeschlagen'));
		}
	}

	async function onscan(raw: string) {
		if (busy) return;
		if (mode === 'show') return show(raw);
		if (!current) {
			toast.error('Wähle zuerst eine Reservierung.');
			return;
		}
		busy = true;
		try {
			const t = await resolveCode(raw);
			const list = t ? await unitsOf(t) : [];
			if (!t || !list.length) {
				toast.error(t?.type === 'set' ? `Set ${t.name} ist leer` : targetHint(t));
				return;
			}
			if (mode === 'issue') await issue(list);
			else await giveBack(list);
		} catch (e) {
			toast.error(errorText(e, 'Code konnte nicht geprüft werden'));
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		const code = params.code ?? '';
		if (code && codeFromScan(code)) void show(code);
		else if (code) hit = { type: 'unknown', raw: code };
	});

	const MODES: { value: Mode; label: string }[] = [
		{ value: 'show', label: 'Anzeigen' },
		{ value: 'issue', label: 'Ausgeben' },
		{ value: 'return', label: 'Zurücknehmen' }
	];
	const outCount = $derived(current ? current.assigned.filter((a) => !a.returnedAt).length : 0);
</script>

<PageTitle title="Scannen" />

<div class="mx-auto max-w-xl space-y-4">
	<a
		href={BASE_PATH}
		class="inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" aria-hidden="true" /> Material
	</a>
	<h1 class="text-title">Scannen</h1>

	{#if canHandleAny}
		<div class="grid grid-cols-3 gap-1 rounded-lg border p-1" role="group" aria-label="Modus">
			{#each MODES as m (m.value)}
				<Button
					size="sm"
					variant={mode === m.value ? 'default' : 'ghost'}
					aria-pressed={mode === m.value}
					onclick={() => setMode(m.value)}
				>
					{m.label}
				</Button>
			{/each}
		</div>
	{/if}

	{#if mode !== 'show'}
		<Card.Root>
			<Card.Content class="space-y-3 pt-4">
				<SelectField
					label="Reservierung"
					placeholder={reservationOptions.length
						? 'Reservierung wählen …'
						: mode === 'return'
							? 'Keine ausgegebenen Reservierungen'
							: 'Keine offenen Reservierungen'}
					options={reservationOptions}
					value={reservationId}
					onchange={selectReservation}
				/>
				{#if current}
					<div class="flex flex-wrap items-center justify-between gap-2 text-sm">
						<a class="text-link hover:underline" href={reservationHref(current.id)}>
							{current.title}
						</a>
						<span class="flex items-center gap-2 text-xs text-muted-foreground">
							<span class="tabular-nums">{outCount} draußen</span>
							<StatusBadge status={current.status} overdue={current.overdue} />
						</span>
					</div>
				{/if}
				{#if mode === 'return'}
					<SelectField
						label="Zustand der nächsten Scans"
						options={CONDITIONS.map((c) => ({
							value: c,
							label: `Zustand: ${CONDITION_LABELS[c]}`
						}))}
						value={returnCondition}
						onchange={(v) => (returnCondition = (v as Condition | null) ?? 'ok')}
					/>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}

	<ScanField {onscan} {busy} id="scan-page-code" bind:camera />

	{#if mode === 'show'}
		{#if busy && !hit}
			<LoadingState label="Treffer" rows={2} />
		{:else if lookupError}
			<p class="text-sm text-destructive" role="alert">{lookupError}</p>
		{:else if hit}
			<Card.Root>
				<Card.Content class="space-y-3 pt-4 text-sm" aria-live="polite">
					{#if hit.type === 'unit'}
						{@const u = hit.unit}
						<div class="flex flex-wrap items-start justify-between gap-2">
							<div>
								<p class="text-section">{u.name}</p>
								<p class="text-xs text-muted-foreground">
									{u.code} · {u.articleName}{u.isContainer ? ' · Kiste' : ''}
								</p>
							</div>
							<ConditionBadge condition={u.condition} />
						</div>
						<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
							<dt class="text-muted-foreground">Ort</dt>
							<dd>{u.locationPath || 'ohne Ort'}</dd>
							{#if u.setName}
								<dt class="text-muted-foreground">Set</dt>
								<dd>{u.setName}</dd>
							{/if}
							<dt class="text-muted-foreground">Ausgegeben</dt>
							<dd>
								{#if u.issued}
									<a
										class="text-link hover:underline"
										href={reservationHref(u.issued.reservationId)}
									>
										{u.issued.title}
									</a>
								{:else}
									nein
								{/if}
							</dd>
						</dl>
						{#if u.contents && (u.contents.units.length || u.contents.stock.length)}
							<div>
								<p class="font-medium">Inhalt</p>
								<ul class="text-xs text-muted-foreground">
									{#each u.contents.units as c (c.id)}<li>{c.name} · {c.code}</li>{/each}
									{#each u.contents.stock as s (s.id)}
										<li>{s.quantity} {s.unitLabel} {s.articleName}</li>
									{/each}
								</ul>
							</div>
						{/if}
						<Button href={unitHref(u.id)} variant="outline" size="sm">Details</Button>
					{:else if hit.type === 'set'}
						{@const s = hit.set}
						<div class="flex flex-wrap items-start justify-between gap-2">
							<div>
								<p class="text-section">Set {s.name}</p>
								<p class="text-xs text-muted-foreground">{s.code} · {s.templateName}</p>
							</div>
							{#if s.completeness.complete}
								<Badge variant="success">Vollständig</Badge>
							{:else}
								<Badge variant="warning">Unvollständig</Badge>
							{/if}
						</div>
						{#if s.completeness.missing.length}
							<p class="text-xs text-warning">
								Fehlt: {s.completeness.missing
									.map((m) => `${m.count} × ${m.articleName}`)
									.join(', ')}
							</p>
						{/if}
						<ul class="divide-y rounded-md border">
							{#each s.units as unit (unit.id)}
								<li class="flex items-center justify-between gap-2 px-3 py-1.5">
									<a class="text-link hover:underline" href={unitHref(unit.id)}>{unit.name}</a>
									<ConditionBadge condition={unit.condition} hideOk />
								</li>
							{/each}
						</ul>
						<Button href={setHref(s.id)} variant="outline" size="sm">Set öffnen</Button>
					{:else if hit.type === 'location'}
						<div>
							<p class="text-section">{hit.target.type === 'location' ? hit.target.name : ''}</p>
							<p class="text-xs text-muted-foreground">
								Lagerort {hit.target.type === 'location' ? hit.target.code : ''} · {hit.total}
								{hit.total === 1 ? 'Stück' : 'Stücke'} (mit Unterorten und Kisteninhalt)
							</p>
						</div>
						{#if hit.units.length}
							<ul class="max-h-80 divide-y overflow-y-auto rounded-md border">
								{#each hit.units as unit (unit.id)}
									<li class="flex items-center justify-between gap-2 px-3 py-1.5">
										<span class="min-w-0">
											<a class="text-link hover:underline" href={unitHref(unit.id)}>{unit.name}</a>
											<span class="block truncate text-xs text-muted-foreground">
												{unit.code} · {unit.locationPath}
											</span>
										</span>
										<ConditionBadge condition={unit.condition} hideOk />
									</li>
								{/each}
							</ul>
							{#if hit.total > hit.units.length}
								<p class="text-xs text-muted-foreground">
									{hit.total - hit.units.length} weitere im Bestand.
								</p>
							{/if}
						{:else}
							<p class="text-muted-foreground">Hier liegt nichts.</p>
						{/if}
					{:else if hit.type === 'reserved'}
						<p class="text-section">{hit.code}</p>
						<p>Noch keinem Stück zugeordnet – im Bestand „Stück erfassen“ mit diesem Code.</p>
						<Button href={`${BASE_PATH}?tab=inventory`} variant="outline" size="sm">
							Zum Bestand
						</Button>
					{:else}
						<p class="font-medium">Unbekannter Code</p>
						<p class="break-all text-muted-foreground">„{hit.raw}“ gehört zu keinem Material.</p>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}
	{:else if booked.length}
		<section class="space-y-2" aria-labelledby="scan-booked">
			<h2 id="scan-booked" class="text-section">Gebucht</h2>
			<ul class="divide-y rounded-md border text-sm" aria-live="polite">
				{#each booked as b (b.key)}
					<li class="flex items-center justify-between gap-2 px-3 py-2">
						<span class="min-w-0">
							<span class={b.undone ? 'line-through text-muted-foreground' : 'font-medium'}>
								{b.name}
							</span>
							<span class="block text-xs text-muted-foreground">
								{b.code} · {b.kind === 'issued' ? 'ausgegeben' : 'zurück'}
							</span>
						</span>
						{#if b.kind === 'issued' && !b.undone}
							<Button size="sm" variant="ghost" onclick={() => undo(b)}>
								<Undo2 /> Rückgängig
							</Button>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<ConfirmDialog
	bind:open={extraOpen}
	title="Gehört nicht zur Reservierung"
	description={extraText}
	confirmLabel="Trotzdem mitgeben"
	onconfirm={() => issue(extraIds, true)}
/>
