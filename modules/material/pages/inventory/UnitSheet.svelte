<script lang="ts">
	// Schreibgeschützte Ansicht eines Stücks/einer Kiste im Seitenblatt; Aktionen je Recht.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArchiveRestore from '@lucide/svelte/icons/archive-restore';
	import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
	import Box from '@lucide/svelte/icons/box';
	import ClipboardList from '@lucide/svelte/icons/clipboard-list';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Package from '@lucide/svelte/icons/package';
	import PackageX from '@lucide/svelte/icons/package-x';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Printer from '@lucide/svelte/icons/printer';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { formatDateTimeDe } from '$lib/sdk/dates';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Sheet from '$lib/components/ui/sheet';
	import { ConfirmDialog, ErrorState, LoadingState, formatEuro } from '$lib/components/layout';
	import type { Article, ContainerTarget, Location, UnitDetail } from '../../schemas';
	import { API, errorText, formatDate, formatPeriod, reservationHref, setHref } from '../helpers';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import PrintLabelsDialog from '../shared/PrintLabelsDialog.svelte';
	import StatusBadge from '../shared/StatusBadge.svelte';
	import ConditionDialog from './ConditionDialog.svelte';
	import MoveDialog from './MoveDialog.svelte';
	import TargetsDialog from './TargetsDialog.svelte';
	import UnitDialog from './UnitDialog.svelte';

	let {
		open = $bindable(false),
		unitId,
		articles,
		locations,
		canManage,
		canReport,
		canLabels,
		onchanged,
		onopenunit
	}: {
		open?: boolean;
		unitId: string | null;
		articles: Article[];
		locations: Location[];
		canManage: boolean;
		/** Zustand melden (Verwaltung oder Reservierungsrecht) */
		canReport: boolean;
		canLabels: boolean;
		/** Nach Änderungen (Liste neu laden) */
		onchanged: () => void | Promise<void>;
		/** Ein Stück aus dem Kisteninhalt öffnen */
		onopenunit: (id: string) => void;
	} = $props();

	let unit = $state<UnitDetail | null>(null);
	let loading = $state(false);
	let error = $state('');
	let seq = 0;

	async function load(id: string) {
		const my = ++seq;
		if (untrack(() => unit?.id) !== id) unit = null;
		loading = true;
		error = '';
		try {
			const d = await apiFetch<UnitDetail>(`${API}/units/${id}`);
			if (my === seq) unit = d;
		} catch (e) {
			if (my === seq) {
				unit = null;
				error = errorText(e, 'Stück konnte nicht geladen werden');
			}
		} finally {
			if (my === seq) loading = false;
		}
	}

	$effect(() => {
		if (open && unitId) void load(unitId);
	});

	async function refresh() {
		if (unitId) await load(unitId);
		await onchanged();
	}

	// --- Dialoge ---
	let dialogKey = $state(0);
	let editOpen = $state(false);
	let moveOpen = $state(false);
	let conditionOpen = $state(false);
	let targetsOpen = $state(false);
	let printOpen = $state(false);
	let retireOpen = $state(false);
	let deleteOpen = $state(false);
	let busy = $state(false);

	function openDialog(set: () => void) {
		dialogKey++;
		set();
	}

	async function setRetired(retired: boolean) {
		if (!unit) return;
		busy = true;
		try {
			await apiFetch(`${API}/units/${unit.id}/retire`, {
				method: 'POST',
				body: JSON.stringify({ retired, note: '' })
			});
			toast.success(retired ? 'Ausgemustert' : 'Wieder aufgenommen');
			await refresh();
		} catch (e) {
			toast.error(errorText(e, 'Änderung fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!unit) return;
		const name = unit.name;
		try {
			await apiFetch(`${API}/units/${unit.id}`, { method: 'DELETE' });
			toast.success(`${name} gelöscht`);
			open = false;
			await onchanged();
		} catch (e) {
			if (e instanceof ApiClientError && e.status === 409) {
				toast.error(e.message, {
					description: 'Stattdessen kannst du das Stück ausmustern – der Verlauf bleibt erhalten.'
				});
			} else {
				toast.error(errorText(e, 'Löschen fehlgeschlagen'));
			}
		}
	}

	function targetVariant(t: ContainerTarget): 'success' | 'warning' | 'destructive' {
		if (t.actual >= t.target) return 'success';
		return t.actual === 0 ? 'destructive' : 'warning';
	}
	function targetText(t: ContainerTarget): string {
		if (t.actual === t.target) return 'vollständig';
		if (t.actual > t.target) return `${t.actual - t.target} zu viel`;
		return `fehlt ${t.target - t.actual}`;
	}

	const missingTargets = $derived(
		unit?.contents?.targets.filter((t) => t.actual < t.target).length ?? 0
	);
	const placeText = $derived(
		unit
			? unit.containerId
				? `In ${unit.containerName ?? 'Kiste'}${unit.locationPath ? ` · ${unit.locationPath}` : ''}`
				: unit.locationPath || 'Ohne Ort'
			: ''
	);
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-lg">
		<Sheet.Header class="border-b">
			<Sheet.Title class="flex items-center gap-2 pr-8">
				{#if unit?.isContainer}<Box class="size-5 shrink-0" aria-hidden="true" />{/if}
				<span class="min-w-0 truncate">{unit?.name ?? 'Stück'}</span>
			</Sheet.Title>
			<Sheet.Description>
				{#if unit}
					<span class="font-mono">{unit.code}</span> · {unit.articleName}
				{:else}
					Details
				{/if}
			</Sheet.Description>
			{#if unit}
				<div class="flex flex-wrap items-center gap-1.5">
					<ConditionBadge condition={unit.condition} />
					{#if unit.retired}<Badge variant="outline">Ausgemustert</Badge>{/if}
					{#if unit.issued}<Badge variant="warning">Ausgegeben</Badge>{/if}
					{#if unit.isContainer}<Badge variant="secondary">Kiste</Badge>{/if}
				</div>
				{#if canManage || canReport || canLabels}
					<div class="flex flex-wrap gap-2 pt-1">
						{#if canManage}
							<Button
								size="sm"
								variant="outline"
								onclick={() => openDialog(() => (editOpen = true))}
							>
								<Pencil /> Bearbeiten
							</Button>
							<Button
								size="sm"
								variant="outline"
								onclick={() => openDialog(() => (moveOpen = true))}
							>
								<ArrowRightLeft /> Umlagern
							</Button>
						{/if}
						{#if canReport}
							<Button
								size="sm"
								variant="outline"
								onclick={() => openDialog(() => (conditionOpen = true))}
							>
								<ShieldAlert /> Zustand melden
							</Button>
						{/if}
						{#if canManage || canLabels}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button {...props} size="sm" variant="outline" aria-label="Weitere Aktionen">
											<EllipsisVertical />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									{#if canLabels}
										<DropdownMenu.Item onclick={() => (printOpen = true)}>
											<Printer /> Etikett drucken
										</DropdownMenu.Item>
									{/if}
									{#if canManage && unit.isContainer}
										<DropdownMenu.Item onclick={() => openDialog(() => (targetsOpen = true))}>
											<ClipboardList /> Packliste bearbeiten
										</DropdownMenu.Item>
									{/if}
									{#if canManage}
										{#if unit.retired}
											<DropdownMenu.Item disabled={busy} onclick={() => setRetired(false)}>
												<ArchiveRestore /> Wieder aufnehmen
											</DropdownMenu.Item>
										{:else}
											<DropdownMenu.Item disabled={busy} onclick={() => (retireOpen = true)}>
												<PackageX /> Ausmustern
											</DropdownMenu.Item>
										{/if}
										<DropdownMenu.Separator />
										<DropdownMenu.Item class="text-destructive" onclick={() => (deleteOpen = true)}>
											<Trash2 /> Löschen
										</DropdownMenu.Item>
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					</div>
				{/if}
			{/if}
		</Sheet.Header>

		<div class="space-y-6 p-4">
			{#if loading && !unit}
				<LoadingState label="Stück" rows={6} rowClass="h-8 w-full" />
			{:else if error}
				<ErrorState
					message={error}
					onretry={async () => {
						if (unitId) await load(unitId);
					}}
					busy={loading}
				/>
			{:else if unit}
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
					<dt class="text-muted-foreground">Artikel</dt>
					<dd>
						{unit.articleName}{#if unit.categoryName}<span class="text-muted-foreground">
								· {unit.categoryName}</span
							>{/if}
					</dd>
					<dt class="text-muted-foreground">Ort</dt>
					<dd>
						{#if unit.containerId}
							<button
								type="button"
								class="text-left text-link underline-offset-4 hover:underline"
								onclick={() => onopenunit(unit!.containerId!)}
							>
								{placeText}
							</button>
						{:else}
							{placeText}
						{/if}
					</dd>
					{#if unit.setId}
						<dt class="text-muted-foreground">Set</dt>
						<dd>
							<a class="text-link underline-offset-4 hover:underline" href={setHref(unit.setId)}>
								{unit.setName}
							</a>
						</dd>
					{/if}
					<dt class="text-muted-foreground">Zustand</dt>
					<dd>
						<ConditionBadge condition={unit.condition} />
						{#if unit.conditionNote}
							<span class="mt-1 block text-muted-foreground">{unit.conditionNote}</span>
						{/if}
					</dd>
					{#if unit.issued}
						<dt class="text-muted-foreground">Ausgegeben an</dt>
						<dd>
							<a
								class="text-link underline-offset-4 hover:underline"
								href={reservationHref(unit.issued.reservationId)}
							>
								{unit.issued.title}
							</a>
						</dd>
					{/if}
					{#if unit.purchasedOn || unit.valueCents != null}
						<dt class="text-muted-foreground">Anschaffung</dt>
						<dd>
							{[
								unit.purchasedOn ? formatDate(unit.purchasedOn) : '',
								unit.valueCents != null ? formatEuro(unit.valueCents) : ''
							]
								.filter(Boolean)
								.join(' · ')}
						</dd>
					{/if}
					{#if unit.notes}
						<dt class="text-muted-foreground">Notiz</dt>
						<dd class="whitespace-pre-line">{unit.notes}</dd>
					{/if}
					<dt class="text-muted-foreground">Erfasst</dt>
					<dd>{formatDate(unit.createdAt)}</dd>
				</dl>

				{#if unit.contents}
					<section class="space-y-3" aria-labelledby="unit-contents">
						<h3 id="unit-contents" class="text-sm font-semibold">Inhalt</h3>
						{#if !unit.contents.units.length && !unit.contents.stock.length}
							<p class="text-sm text-muted-foreground">Die Kiste ist leer.</p>
						{:else}
							<ul class="divide-y rounded-md border">
								{#each unit.contents.units as u (u.id)}
									<li>
										<button
											type="button"
											class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
											onclick={() => onopenunit(u.id)}
										>
											{#if u.isContainer}
												<Box class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
											{:else}
												<Package class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
											{/if}
											<span class="min-w-0 flex-1 truncate">{u.name}</span>
											<span class="font-mono text-xs text-muted-foreground">{u.code}</span>
											<ConditionBadge condition={u.condition} hideOk />
										</button>
									</li>
								{/each}
								{#each unit.contents.stock as s (s.id)}
									<li class="flex items-center gap-2 px-3 py-2 text-sm">
										<span class="min-w-0 flex-1 truncate">{s.articleName}</span>
										<span class="tabular-nums">{s.quantity} {s.unitLabel}</span>
									</li>
								{/each}
							</ul>
						{/if}

						<div class="flex items-center justify-between gap-2">
							<h3 class="text-sm font-semibold">Packliste</h3>
							{#if unit.contents.targets.length}
								{#if missingTargets}
									<Badge variant="warning">{missingTargets} unvollständig</Badge>
								{:else}
									<Badge variant="success">Vollständig</Badge>
								{/if}
							{/if}
						</div>
						{#if !unit.contents.targets.length}
							<p class="text-sm text-muted-foreground">
								Keine Packliste hinterlegt.{#if canManage}
									<Button
										size="sm"
										variant="link"
										class="h-auto px-1"
										onclick={() => openDialog(() => (targetsOpen = true))}>Jetzt anlegen</Button
									>{/if}
							</p>
						{:else}
							<ul class="divide-y rounded-md border" aria-label="Packliste Soll und Ist">
								{#each unit.contents.targets as t (t.articleId)}
									<li class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
										<span class="min-w-0 flex-1 truncate">{t.articleName}</span>
										<span class="tabular-nums">
											{t.actual} / {t.target}
											{t.unitLabel}
										</span>
										<Badge variant={targetVariant(t)}>{targetText(t)}</Badge>
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				{/if}

				<section class="space-y-2" aria-labelledby="unit-reservations">
					<h3 id="unit-reservations" class="text-sm font-semibold">Reservierungen</h3>
					{#if !unit.reservations.length}
						<p class="text-sm text-muted-foreground">Keine kommenden Reservierungen.</p>
					{:else}
						<ul class="divide-y rounded-md border">
							{#each unit.reservations as r (r.id)}
								<li class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
									<a
										class="min-w-0 flex-1 truncate text-link underline-offset-4 hover:underline"
										href={reservationHref(r.id)}
									>
										{r.title}
									</a>
									<span class="text-xs text-muted-foreground">
										{formatPeriod(r.startsOn, r.endsOn)}
									</span>
									<StatusBadge status={r.status} />
								</li>
							{/each}
						</ul>
					{/if}
				</section>

				<section class="space-y-2" aria-labelledby="unit-history">
					<h3 id="unit-history" class="text-sm font-semibold">Verlauf</h3>
					{#if !unit.history.length}
						<p class="text-sm text-muted-foreground">Noch keine Einträge.</p>
					{:else}
						<ol class="space-y-2">
							{#each unit.history as h (h.id)}
								<li class="rounded-md border px-3 py-2 text-sm">
									<p>{h.label}</p>
									{#if h.note}<p class="text-muted-foreground">{h.note}</p>{/if}
									<p class="text-xs text-muted-foreground">
										{formatDateTimeDe(h.createdAt)}{h.actorName ? ` · ${h.actorName}` : ''}
									</p>
								</li>
							{/each}
						</ol>
					{/if}
				</section>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>

{#if unit}
	{#key dialogKey}
		<UnitDialog bind:open={editOpen} {unit} {articles} {locations} onsaved={refresh} />
		<MoveDialog
			bind:open={moveOpen}
			unitIds={[unit.id]}
			title={`${unit.name} (${unit.code})`}
			current={{
				locationId: unit.locationId,
				containerId: unit.containerId,
				containerName: unit.containerName ?? ''
			}}
			{locations}
			onsaved={refresh}
		/>
		<ConditionDialog
			bind:open={conditionOpen}
			unitId={unit.id}
			name={`${unit.name} (${unit.code})`}
			condition={unit.condition}
			note={unit.conditionNote}
			onsaved={refresh}
		/>
		{#if unit.contents}
			<TargetsDialog
				bind:open={targetsOpen}
				unitId={unit.id}
				name={unit.name}
				targets={unit.contents.targets}
				{articles}
				onsaved={refresh}
			/>
		{/if}
	{/key}
	<PrintLabelsDialog bind:open={printOpen} target="unit" ids={[unit.id]} />
	<ConfirmDialog
		bind:open={retireOpen}
		title="Stück ausmustern?"
		description={`„${unit.name}“ verschwindet aus Bestand und Reservierungen, der Verlauf bleibt. Du kannst es später wieder aufnehmen.`}
		confirmLabel="Ausmustern"
		onconfirm={() => setRetired(true)}
	/>
	<ConfirmDialog
		bind:open={deleteOpen}
		title="Stück löschen?"
		description={`„${unit.name}“ (${unit.code}) wird endgültig gelöscht. War es schon einmal reserviert, musst du es stattdessen ausmustern.`}
		confirmLabel="Löschen"
		destructive
		onconfirm={remove}
	/>
{/if}
