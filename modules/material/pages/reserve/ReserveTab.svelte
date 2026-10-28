<script lang="ts">
	// Reiter „Reservieren“ – aufgebaut wie die Bestellen-Ansicht in `orders`: Zeitraum, Suche, Kategorien
	// und Scannen oben, Kachelraster, Warenkorb rechts (mobil als Blatt). Bearbeiten über `editId`.
	import { onMount, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import { page } from '$app/state';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Search from '@lucide/svelte/icons/search';
	import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { ConfirmDialog, EmptyState, ErrorState, MobileActionBar } from '$lib/components/layout';
	import { localToday } from '$lib/components/layout/month-calendar';
	import { cn } from '$lib/utils';
	import {
		PERMISSIONS,
		isRealDate,
		reservationInput,
		type Catalog,
		type CatalogEntry,
		type CategoryRef,
		type LineAvailability,
		type PurposeOptions,
		type Reservation
	} from '../../schemas';
	import {
		API,
		apiFieldErrors,
		errorText,
		fieldErrors,
		formatPeriod,
		safeReplaceState
	} from '../helpers';
	import CategoryGlyph from '../shared/CategoryGlyph.svelte';
	import ScanButton from '../shared/ScanButton.svelte';
	import { resolveScan } from '../shared/scan';
	import CartPanel from './CartPanel.svelte';
	import EntryCard from './EntryCard.svelte';
	import EntryDetailDialog from './EntryDetailDialog.svelte';
	import {
		CART_KEY,
		addLine,
		cartCount,
		clearDraft,
		editCartKey,
		emptyDraft,
		fromReservation,
		itemQuantityInCart,
		lineKey,
		loadDraft,
		reconcileCart,
		saveDraft,
		toLines,
		typeQuantityInCart,
		type CartDraft,
		type CartLine
	} from './cart';

	let {
		editId,
		onsaved,
		oncanceledit
	}: {
		/** Bestehende Reservierung bearbeiten (`?edit=`) */
		editId: string | null;
		onsaved: (id: string, mine: boolean) => void;
		/** Bearbeiten abbrechen: der Aufrufer zeigt wieder den leeren Katalog */
		oncanceledit?: () => void;
	} = $props();

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canReserve = $derived(can(permissions, PERMISSIONS.reserve));
	const myId = $derived((page.data.user as { id?: string } | null | undefined)?.id ?? null);

	const desktop = new MediaQuery('(min-width: 1024px)', false);
	const today = localToday();

	// Der Aufrufer rendert die Komponente je `editId` neu (`{#key}`), daher fest beim Start.
	// svelte-ignore state_referenced_locally
	const storageKey = editId ? editCartKey(editId) : CART_KEY;

	let draft = $state<CartDraft>(emptyDraft(today));
	/** Entwurf geladen → speichern, Katalog und Verfügbarkeit laden */
	let ready = $state(false);

	// --- Bearbeiten ----------------------------------------------------------------
	let editing = $state<Reservation | null>(null);
	let editError = $state('');
	let editLoading = $state(false);

	async function loadEdit(id: string) {
		editLoading = true;
		editError = '';
		try {
			const r = await apiFetch<Reservation>(`${API}/reservations/${id}`);
			if (!r.canEdit) {
				editError = 'Du darfst diese Reservierung nicht bearbeiten.';
				return;
			}
			if (r.status === 'cancelled') {
				editError = 'Die Reservierung ist storniert und kann nicht mehr bearbeitet werden.';
				return;
			}
			editing = r;
			draft = loadDraft(storageKey, today, { keepDates: true }) ?? fromReservation(r);
			ready = true;
		} catch (e) {
			editError = errorText(e, 'Reservierung konnte nicht geladen werden.');
		} finally {
			editLoading = false;
		}
	}

	function cancelEdit() {
		ready = false;
		clearDraft(storageKey);
		if (oncanceledit) return oncanceledit();
		const url = new URL(page.url);
		url.searchParams.delete('edit');
		safeReplaceState(url);
	}

	/** Vorbelegung aus der Aktions-Karte: `?action=&from=&to=&title=` */
	function applyUrlPrefill() {
		const params = page.url.searchParams;
		const keys = ['action', 'from', 'to', 'title'];
		if (!keys.some((k) => params.has(k))) return;
		const action = params.get('action');
		const from = params.get('from') ?? '';
		const to = params.get('to') ?? '';
		const title = (params.get('title') ?? '').trim();
		if (action) {
			draft.purpose = 'action';
			draft.actionId = action;
		}
		if (isRealDate(from)) {
			draft.from = from;
			draft.to = isRealDate(to) && to >= from ? to : from;
		}
		if (title) draft.title = title.slice(0, 150);
		const url = new URL(page.url);
		for (const k of keys) url.searchParams.delete(k);
		safeReplaceState(url);
	}

	// --- Zweck ---------------------------------------------------------------------
	let options = $state<PurposeOptions | null>(null);
	let optionsError = $state('');

	async function loadOptions() {
		optionsError = '';
		try {
			options = await apiFetch<PurposeOptions>(`${API}/purpose-options`);
		} catch (e) {
			optionsError = errorText(e, 'Aktionen und Gruppen konnten nicht geladen werden.');
		}
	}

	onMount(() => {
		if (canReserve) void loadOptions();
		if (editId) {
			void loadEdit(editId);
		} else {
			draft = loadDraft(storageKey, today) ?? emptyDraft(today);
			applyUrlPrefill();
			ready = true;
		}
	});

	// Entwurf merken
	$effect(() => {
		if (!ready) return;
		saveDraft(storageKey, $state.snapshot(draft) as CartDraft);
	});

	// --- Zeitraum und Katalog --------------------------------------------------------
	let catalog = $state<Catalog | null>(null);
	let catalogLoading = $state(true);
	let catalogError = $state('');
	let catalogSeq = 0;

	const dateError = $derived(
		!isRealDate(draft.from)
			? 'Bitte ein gültiges Beginn-Datum eingeben.'
			: !isRealDate(draft.to)
				? 'Bitte ein gültiges Ende-Datum eingeben.'
				: draft.to < draft.from
					? 'Ende liegt vor dem Beginn.'
					: ''
	);

	async function loadCatalog(from: string, to: string) {
		const seq = ++catalogSeq;
		catalogLoading = !catalog;
		catalogError = '';
		try {
			const p = new URLSearchParams({ from, to });
			if (editId) p.set('excludeReservationId', editId);
			const result = await apiFetch<Catalog>(`${API}/catalog?${p}`);
			if (seq !== catalogSeq) return;
			catalog = result;
			const r = reconcileCart(draft.lines, result);
			if (r.changed) draft.lines = r.lines;
			if (r.removed.length) {
				toast.info(
					r.removed.length === 1
						? `„${r.removed[0]}“ ist nicht mehr reservierbar und wurde aus dem Warenkorb entfernt.`
						: `${r.removed.length} Positionen sind nicht mehr reservierbar und wurden entfernt.`
				);
			}
		} catch (e) {
			if (seq === catalogSeq) catalogError = errorText(e, 'Material konnte nicht geladen werden.');
		} finally {
			if (seq === catalogSeq) catalogLoading = false;
		}
	}

	$effect(() => {
		if (!ready || dateError) return;
		const from = draft.from;
		const to = draft.to;
		const t = setTimeout(
			() => void loadCatalog(from, to),
			untrack(() => (catalog ? 300 : 0))
		);
		return () => clearTimeout(t);
	});

	function setFrom(v: string) {
		draft.from = v;
		if (isRealDate(v) && isRealDate(draft.to) && draft.to < v) draft.to = v;
	}

	// --- Verfügbarkeit des Warenkorbs ------------------------------------------------
	let issues = $state<Record<string, string>>({});
	let availSeq = 0;

	function applyChecks(checks: LineAvailability[], lines: CartLine[]) {
		const next: Record<string, string> = {};
		for (const c of checks) {
			const line = lines[c.index];
			if (line && !c.ok) next[lineKey(line)] = c.message ?? 'Im Zeitraum nicht frei';
		}
		issues = next;
	}

	$effect(() => {
		if (!ready || dateError) return;
		const lines = $state.snapshot(draft.lines) as CartLine[];
		const from = draft.from;
		const to = draft.to;
		if (!lines.length) {
			issues = {};
			return;
		}
		const t = setTimeout(async () => {
			const seq = ++availSeq;
			try {
				const checks = await apiFetch<LineAvailability[]>(`${API}/availability`, {
					method: 'POST',
					body: JSON.stringify({
						startsOn: from,
						endsOn: to,
						excludeReservationId: editId,
						lines: toLines(lines)
					})
				});
				if (seq === availSeq) applyChecks(checks, lines);
			} catch {
				// Prüfung ist nur ein Hinweis – der Server prüft beim Speichern erneut
			}
		}, 500);
		return () => clearTimeout(t);
	});

	// --- Filter --------------------------------------------------------------------
	let search = $state('');
	let categoryId = $state<string | null>(null);

	const categories = $derived.by(() => {
		const map = new Map<string, CategoryRef>();
		for (const e of catalog?.entries ?? []) if (e.category) map.set(e.category.id, e.category);
		return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
	});
	const hasUncategorized = $derived((catalog?.entries ?? []).some((e) => !e.category));

	const visible = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return (catalog?.entries ?? []).filter((e) => {
			if (categoryId === 'none' ? !!e.category : categoryId && e.category?.id !== categoryId)
				return false;
			if (!q) return true;
			return (
				e.name.toLowerCase().includes(q) ||
				e.description.toLowerCase().includes(q) ||
				(e.code ?? '').toLowerCase() === q ||
				e.items.some((i) => i.name.toLowerCase().includes(q) || i.code.toLowerCase() === q)
			);
		});
	});

	function inCartOf(e: CatalogEntry): number {
		if (e.kind === 'item') return itemQuantityInCart(draft.lines, e.id);
		return (
			typeQuantityInCart(draft.lines, e.id) +
			e.items.reduce((s, i) => s + itemQuantityInCart(draft.lines, i.id), 0)
		);
	}

	// --- Ansehen und hinzufügen ------------------------------------------------------
	let selected = $state<CatalogEntry | null>(null);
	let detailOpen = $state(false);
	let detailKey = $state(0);
	let cartOpen = $state(false);

	function select(e: CatalogEntry) {
		selected = e;
		detailKey++;
		detailOpen = true;
	}

	function cartToastAction() {
		return desktop.current ? undefined : { label: 'Warenkorb', onClick: () => (cartOpen = true) };
	}

	function add(lines: CartLine[]) {
		let next = draft.lines;
		for (const l of lines) next = addLine(next, l);
		draft.lines = next;
		const n = lines.reduce((s, l) => s + l.quantity, 0);
		toast.success(
			lines.length === 1 ? `${lines[0]!.name} im Warenkorb` : `${n} Teile im Warenkorb`,
			{ action: cartToastAction() }
		);
	}

	// --- Scannen -------------------------------------------------------------------
	let scanning = $state(false);

	function findItem(id: string) {
		for (const e of catalog?.entries ?? []) {
			if (e.kind === 'item' && e.id === id) {
				return { id, name: e.name, code: e.code, free: e.free, quantity: e.total, entry: e };
			}
			const i = e.items.find((x) => x.id === id);
			if (i)
				return { id, name: i.name, code: i.code, free: i.free, quantity: i.quantity, entry: e };
		}
		return null;
	}

	async function onscan(raw: string) {
		if (!canReserve) {
			toast.error('Du darfst nicht reservieren.');
			return;
		}
		if (!catalog) {
			toast.error('Das Material lädt noch – bitte gleich noch einmal scannen.');
			return;
		}
		scanning = true;
		try {
			const target = await resolveScan(raw);
			if (!target) {
				toast.error('Unbekannter Code');
				return;
			}
			if (target.type === 'location') {
				toast.error(`${target.name} ist ein Lagerort, kein Artikel.`);
				return;
			}
			if (target.type === 'reserved') {
				toast.error(`Der Code ${target.code} gehört noch zu keinem Artikel.`);
				return;
			}
			const hit = findItem(target.id);
			if (!hit) {
				toast.error(`${target.name} kann nicht reserviert werden.`);
				return;
			}
			const inCart = itemQuantityInCart(draft.lines, hit.id);
			if (hit.free - inCart <= 0) {
				toast.info(
					inCart
						? `${hit.name} liegt schon im Warenkorb.`
						: `${hit.name} ist im Zeitraum ${formatPeriod(draft.from, draft.to)} nicht frei.`
				);
				return;
			}
			draft.lines = addLine(draft.lines, {
				kind: 'item',
				itemId: hit.id,
				name: hit.name,
				code: hit.code,
				thumbUrl: hit.entry.thumbUrl,
				quantity: 1,
				max: Math.max(1, hit.quantity)
			});
			toast.success(`${hit.name} im Warenkorb`, { action: cartToastAction() });
		} catch (e) {
			toast.error(errorText(e, 'Code konnte nicht geprüft werden.'));
		} finally {
			scanning = false;
		}
	}

	// --- Absenden ------------------------------------------------------------------
	let errors = $state<Record<string, string>>({});
	let confirmOpen = $state(false);
	let busy = $state(false);

	function payload() {
		return {
			title: draft.title.trim(),
			purpose: draft.purpose,
			actionId: draft.purpose === 'action' ? draft.actionId : null,
			groupId: draft.purpose === 'group' ? draft.groupId : null,
			startsOn: draft.from,
			endsOn: draft.to,
			notes: draft.notes.trim(),
			lines: toLines(draft.lines)
		};
	}

	const FIELD_IDS: Record<string, string> = {
		title: 'material-cart-title-input',
		actionId: 'material-cart-action',
		groupId: 'material-cart-group',
		notes: 'material-cart-notes',
		startsOn: 'material-reserve-from',
		endsOn: 'material-reserve-to'
	};

	function focusFirst(errs: Record<string, string>) {
		const first = Object.keys(FIELD_IDS).find((k) => errs[k]);
		if (!first) return;
		if (!desktop.current && first !== 'startsOn' && first !== 'endsOn') cartOpen = true;
		setTimeout(() => document.getElementById(FIELD_IDS[first]!)?.focus(), 50);
	}

	function requestSubmit() {
		errors = {};
		if (dateError) {
			toast.error(dateError);
			document.getElementById('material-reserve-from')?.focus();
			return;
		}
		const parsed = reservationInput.safeParse(payload());
		if (!parsed.success) {
			errors = fieldErrors(parsed.error.issues);
			if (errors.lines) toast.error(errors.lines);
			focusFirst(errors);
			return;
		}
		confirmOpen = true;
	}

	async function submit() {
		busy = true;
		const body = payload();
		const lines = $state.snapshot(draft.lines) as CartLine[];
		try {
			const r = await apiFetch<Reservation>(
				editId ? `${API}/reservations/${editId}` : `${API}/reservations`,
				{ method: editId ? 'PATCH' : 'POST', body: JSON.stringify(body) }
			);
			ready = false;
			clearDraft(storageKey);
			if (!editId) draft = emptyDraft(today);
			toast.success(editId ? 'Reservierung gespeichert' : 'Material reserviert');
			onsaved(r.id, !r.createdBy || r.createdBy === myId);
		} catch (e) {
			if (e instanceof ApiClientError && e.status === 409) {
				const checks = (e.details as { lines?: LineAvailability[] } | null)?.lines;
				if (Array.isArray(checks)) applyChecks(checks, lines);
				toast.error(e.message || 'Nicht alles ist im Zeitraum frei.');
				if (!desktop.current) cartOpen = true;
			} else if (e instanceof ApiClientError && e.status === 422) {
				const errs = apiFieldErrors(e);
				const lineIssues: Record<string, string> = {};
				for (const [k, msg] of Object.entries(errs)) {
					const m = /^lines\.(\d+)/.exec(k);
					const line = m ? lines[Number(m[1])] : undefined;
					if (line) lineIssues[lineKey(line)] = msg;
				}
				issues = { ...issues, ...lineIssues };
				errors = errs;
				toast.error(e.message || 'Bitte prüfe deine Angaben.');
				focusFirst(errs);
			} else {
				toast.error(errorText(e, 'Reservierung konnte nicht gespeichert werden.'));
			}
		} finally {
			busy = false;
		}
	}

	const count = $derived(cartCount(draft.lines));
	const period = $derived(dateError ? '' : formatPeriod(draft.from, draft.to));
</script>

{#snippet cartPanel()}
	<CartPanel
		bind:draft
		{issues}
		{errors}
		{options}
		{optionsError}
		onretryoptions={loadOptions}
		{busy}
		editing={!!editId}
		{canReserve}
		onsubmit={requestSubmit}
		oncancel={editId ? cancelEdit : undefined}
	/>
{/snippet}

{#if editId && (editLoading || editError)}
	{#if editLoading}
		<div class="space-y-3" aria-busy="true">
			<Skeleton class="h-12 w-full" />
			<Skeleton class="h-40 w-full" />
		</div>
	{:else}
		<ErrorState
			title="Bearbeiten nicht möglich"
			message={editError}
			onretry={() => {
				if (editId) void loadEdit(editId);
			}}
		/>
		<div class="mt-3">
			<Button variant="outline" onclick={cancelEdit}>Neue Reservierung anlegen</Button>
		</div>
	{/if}
{:else}
	{#if editing}
		<Alert.Root variant="info" class="mb-4">
			<Pencil aria-hidden="true" />
			<Alert.Title>Du bearbeitest „{editing.title}“</Alert.Title>
			<Alert.Description>
				<p>
					Ändere Zeitraum, Material oder Angaben und speichere. Die Reservierung selbst zählt dabei
					nicht als belegt.
				</p>
				<Button variant="outline" size="sm" class="mt-2" onclick={cancelEdit}>Abbrechen</Button>
			</Alert.Description>
		</Alert.Root>
	{/if}

	<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
		<div class={['min-w-0 space-y-4', !desktop.current && 'max-sm:pb-20']}>
			<div class="flex flex-wrap items-end gap-3">
				<div class="grid w-full grid-cols-2 gap-2 sm:w-auto">
					<div class="space-y-1">
						<Label for="material-reserve-from">Von *</Label>
						<Input
							id="material-reserve-from"
							type="date"
							min={editId ? undefined : today}
							value={draft.from}
							aria-invalid={dateError && !isRealDate(draft.from) ? 'true' : undefined}
							aria-describedby={dateError ? 'material-reserve-date-error' : undefined}
							oninput={(e) => setFrom(e.currentTarget.value)}
							class="sm:w-40"
						/>
					</div>
					<div class="space-y-1">
						<Label for="material-reserve-to">Bis *</Label>
						<Input
							id="material-reserve-to"
							type="date"
							min={isRealDate(draft.from) ? draft.from : today}
							bind:value={draft.to}
							aria-invalid={dateError && isRealDate(draft.from) ? 'true' : undefined}
							aria-describedby={dateError ? 'material-reserve-date-error' : undefined}
							class="sm:w-40"
						/>
					</div>
				</div>
				<div class="relative w-full sm:w-64">
					<Search
						class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
						aria-hidden="true"
					/>
					<Input
						type="search"
						class="pl-8"
						placeholder="Material suchen …"
						aria-label="Material suchen"
						bind:value={search}
					/>
				</div>
				<div class="flex flex-wrap items-center gap-2 sm:ml-auto">
					{#if canReserve}
						<ScanButton
							{onscan}
							busy={scanning}
							label="Scannen"
							title="Artikel scannen"
							description="Halte den QR-Code oder Strichcode eines Artikels vor die Kamera – auch auf einem Bildschirm. Ein USB-Handscanner funktioniert überall auf der Seite. Der Artikel kommt in den Warenkorb."
						/>
					{/if}
					{#if !desktop.current}
						<MobileActionBar label="Warenkorb">
							<Button
								variant={count ? 'default' : 'outline'}
								class="max-sm:flex-1"
								onclick={() => (cartOpen = true)}
							>
								<ShoppingCart />
								{editId ? 'Reservierung' : 'Warenkorb'}
								{#if count}<span class="tabular-nums">({count})</span>{/if}
							</Button>
						</MobileActionBar>
					{/if}
				</div>
			</div>
			{#if dateError}
				<p id="material-reserve-date-error" class="text-xs text-destructive" role="alert">
					{dateError}
				</p>
			{:else if errors.startsOn || errors.endsOn}
				<p id="material-reserve-date-error" class="text-xs text-destructive" role="alert">
					{errors.startsOn ?? errors.endsOn}
				</p>
			{/if}

			{#if categories.length > 1 || (categories.length && hasUncategorized)}
				<div class="flex flex-wrap gap-2" role="group" aria-label="Kategorien">
					{#each [{ id: null, name: 'Alle', icon: null, color: null }, ...categories] as c (c.id ?? 'all')}
						{@const active = categoryId === c.id}
						<button
							type="button"
							class={cn(
								'flex h-9 items-center gap-2 rounded-full border px-3 text-sm transition-colors',
								active
									? 'border-link bg-link/10 font-semibold text-link'
									: 'bg-background hover:bg-muted'
							)}
							aria-pressed={active}
							onclick={() => (categoryId = active ? null : c.id)}
						>
							{#if c.id}<CategoryGlyph category={c} size="sm" />{/if}
							{c.name}
						</button>
					{/each}
					{#if hasUncategorized}
						<button
							type="button"
							class={cn(
								'flex h-9 items-center rounded-full border px-3 text-sm transition-colors',
								categoryId === 'none'
									? 'border-link bg-link/10 font-semibold text-link'
									: 'bg-background hover:bg-muted'
							)}
							aria-pressed={categoryId === 'none'}
							onclick={() => (categoryId = categoryId === 'none' ? null : 'none')}
						>
							Ohne Kategorie
						</button>
					{/if}
				</div>
			{/if}

			{#if dateError && !catalog}
				<EmptyState
					title="Zeitraum wählen"
					description="Wähle einen gültigen Zeitraum, um zu sehen, was frei ist."
				/>
			{:else if catalogLoading}
				<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
					{#each [0, 1, 2] as i (i)}
						<div class="space-y-3 rounded-xl border">
							<Skeleton class="aspect-[4/3] w-full rounded-b-none" />
							<div class="space-y-2 p-4">
								<Skeleton class="h-4 w-2/3" />
								<Skeleton class="h-3 w-1/3" />
								<Skeleton class="h-8 w-24" />
							</div>
						</div>
					{/each}
				</div>
			{:else if catalogError}
				<ErrorState
					title="Material konnte nicht geladen werden"
					message={catalogError}
					onretry={() => loadCatalog(draft.from, draft.to)}
				/>
			{:else if !catalog?.entries.length}
				<EmptyState
					title="Noch kein Material"
					description="Sobald die Materialwart*in Material im Lager anlegt, kannst du es hier reservieren."
				/>
			{:else if !visible.length}
				<EmptyState
					title="Nichts gefunden"
					description="Kein Material passt zu Suche oder Kategorie. Versuche einen anderen Begriff."
				/>
			{:else}
				<ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Material">
					{#each visible as e (e.kind + e.id)}
						<li><EntryCard entry={e} inCart={inCartOf(e)} onselect={select} /></li>
					{/each}
				</ul>
			{/if}
		</div>

		{#if desktop.current}
			<aside class="self-start lg:sticky lg:top-4">
				<Card.Root>
					<Card.Content>
						{@render cartPanel()}
					</Card.Content>
				</Card.Root>
			</aside>
		{/if}
	</div>

	{#if !desktop.current}
		<Sheet.Root bind:open={cartOpen}>
			<Sheet.Content side="bottom" class="max-h-[90dvh] overflow-y-auto">
				<Sheet.Header>
					<Sheet.Title class="sr-only">Warenkorb</Sheet.Title>
					<Sheet.Description class="sr-only">Material prüfen und reservieren</Sheet.Description>
				</Sheet.Header>
				<div class="px-4 pb-6">
					{@render cartPanel()}
				</div>
			</Sheet.Content>
		</Sheet.Root>
	{/if}

	{#if selected}
		{#key detailKey}
			<EntryDetailDialog
				bind:open={detailOpen}
				entry={selected}
				lines={draft.lines}
				{canReserve}
				{period}
				onadd={add}
			/>
		{/key}
	{/if}

	<ConfirmDialog
		bind:open={confirmOpen}
		title={editId ? 'Änderungen speichern?' : 'Material reservieren?'}
		description={`${count === 1 ? '1 Teil' : `${count} Teile`} für „${draft.title.trim()}“, ${period}. Das Material ist dann für andere in diesem Zeitraum belegt.`}
		confirmLabel={editId ? 'Speichern' : 'Reservieren'}
		onconfirm={submit}
	/>
{/if}
