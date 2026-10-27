<script lang="ts">
	// Ausleihen: Katalog mit freier Anzahl im Zeitraum, Zelte als Typ × Anzahl, Merkliste → Reservieren.
	// URL `?action=<id>&from&to&title` belegt Zeitraum, Aktion und Titel vor.
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import Search from '@lucide/svelte/icons/search';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Alert from '$lib/components/ui/alert';
	import {
		BottomSheet,
		EmptyState,
		ErrorState,
		LoadingState,
		PageHeader,
		ScrollPills,
		deviceLayout,
		listenForScanner,
		sheetsSettled
	} from '$lib/components/layout';
	import { apiFetch, can, todayBerlin } from '$lib/sdk/client';
	import {
		PERMISSIONS,
		codeFromScan,
		type Catalog,
		type CatalogArticle,
		type CatalogTemplate,
		type Category,
		type CodeTarget,
		type LineAvailability,
		type Reservation,
		type UnitSummary
	} from '../schemas';
	import { API, errorText, formatPeriod, reservationHref } from './helpers';
	import MaterialNav from './MaterialNav.svelte';
	import CatalogRow from './borrow/CatalogRow.svelte';
	import CartPanel from './borrow/CartPanel.svelte';
	import ItemDetail, { type DetailItem } from './borrow/ItemDetail.svelte';
	import ReserveDialog from './borrow/ReserveDialog.svelte';
	import {
		articleQuantity,
		cartLines,
		cartSummary,
		clampCart,
		emptyCart,
		freeFromAvailability,
		freeFromCatalog,
		isCartEmpty,
		isIsoDate,
		maxArticleQuantity,
		maxTentCount,
		nextWeekend,
		parseCart,
		partsText,
		problemsByArticle,
		setArticleQuantity,
		setTentCount,
		tentCount,
		type Cart,
		type CartProblem
	} from './borrow/cart';

	const STORAGE_KEY = 'material.borrow.cart';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canReserve = $derived(can(permissions, PERMISSIONS.reserve));
	const device = $derived(deviceLayout());
	const phone = $derived(device === 'phone');

	// --- Zeitraum, Aktion ------------------------------------------------------------
	const weekend = nextWeekend(todayBerlin());
	let from = $state(weekend.from);
	let to = $state(weekend.to);
	let ready = $state(false);
	let actionId = $state<string | null>(null);
	let actionName = $state<string | null>(null);
	let urlTitle = $state('');
	const periodValid = $derived(isIsoDate(from) && isIsoDate(to) && to >= from);

	// --- Suche, Kategorien -----------------------------------------------------------
	let searchText = $state('');
	let search = $state('');
	let categoryId = $state('');
	let categories = $state<Category[]>([]);

	$effect(() => {
		const q = searchText.trim();
		const t = setTimeout(() => (search = q), 250);
		return () => clearTimeout(t);
	});

	// --- Katalog ---------------------------------------------------------------------
	let catalog = $state<Catalog | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let reloadKey = $state(0);
	const retry = () => {
		reloadKey++;
	};
	/** Nach einem Scan: diesen Artikel öffnen, sobald er im Katalog steht */
	let pendingOpen: string | null = null;

	$effect(() => {
		if (!ready || !periodValid) return;
		const params = new URLSearchParams({ from, to });
		if (search) params.set('search', search);
		if (categoryId) params.set('categoryId', categoryId);
		void reloadKey;
		let stale = false;
		loading = true;
		loadError = '';
		apiFetch<Catalog>(`${API}/catalog?${params}`)
			.then((c) => {
				if (stale) return;
				catalog = c;
				if (pendingOpen) {
					const a = c.articles.find((x) => x.id === pendingOpen);
					pendingOpen = null;
					if (a) openDetail({ kind: 'article', article: a });
				}
			})
			.catch((e) => {
				if (!stale) loadError = errorText(e, 'Der Katalog konnte nicht geladen werden.');
			})
			.finally(() => {
				if (!stale) loading = false;
			});
		return () => {
			stale = true;
		};
	});

	const templates = $derived(categoryId ? [] : (catalog?.templates ?? []));
	const groups = $derived.by(() => {
		const out: { key: string; name: string; items: CatalogArticle[] }[] = [];
		for (const a of catalog?.articles ?? []) {
			const key = a.categoryId ?? '';
			let g = out.find((x) => x.key === key);
			if (!g) {
				g = { key, name: a.categoryName ?? 'Ohne Kategorie', items: [] };
				out.push(g);
			}
			g.items.push(a);
		}
		return out;
	});
	const catalogFree = $derived(freeFromCatalog(catalog?.articles ?? []));

	/** Befund-Satz unter dem Titel */
	const finding = $derived.by(() => {
		if (!periodValid) return 'Wähle einen gültigen Zeitraum.';
		if (!catalog) return `Zeitraum ${formatPeriod(from, to)}.`;
		const articles = catalog.articles;
		const freeCount = articles.filter((a) => a.free > 0).length;
		const examples = [
			...templates.filter((t) => t.free > 0).map((t) => `${t.free} × ${t.name}`),
			...articles
				.filter((a) => a.free > 0)
				.map((a) =>
					a.kind === 'bulk' ? `${a.free} ${a.unitLabel} ${a.name}` : `${a.free} × ${a.name}`
				)
		].slice(0, 3);
		const period = formatPeriod(catalog.from, catalog.to);
		if (!articles.length && !templates.length)
			return search || categoryId
				? `Keine Treffer für ${period}.`
				: `${period}: noch kein Material erfasst.`;
		const what = search || categoryId ? 'Treffern' : 'Artikeln';
		return `${period}: ${freeCount} von ${articles.length} ${what} frei${
			examples.length ? ` – z. B. ${examples.join(', ')}` : ''
		}.`;
	});

	// --- Merkliste -------------------------------------------------------------------
	let cart = $state<Cart>(emptyCart());
	let liveMsg = $state('');
	let cartSheetOpen = $state(false);

	$effect(() => {
		if (!ready) return;
		const data = JSON.stringify({ cart, from, to });
		try {
			sessionStorage.setItem(STORAGE_KEY, data);
		} catch {
			// Speicher nicht verfügbar (privates Fenster) – Merkliste lebt nur bis zum Neuladen
		}
	});

	function announce(name: string, qty: number) {
		liveMsg = qty > 0 ? `${name}: ${qty} auf der Merkliste` : `${name} von der Merkliste entfernt`;
	}

	function changeArticle(
		a: Pick<CatalogArticle, 'id' | 'name' | 'unitLabel' | 'kind'>,
		qty: number
	) {
		cart = setArticleQuantity(cart, a, qty);
		announce(a.name, articleQuantity(cart, a.id));
	}

	function changeTent(t: CatalogTemplate, n: number) {
		cart = setTentCount(cart, t, n);
		announce(t.name, tentCount(cart, t.id));
	}

	function removeArticle(id: string) {
		const a = cart.articles.find((x) => x.articleId === id);
		if (!a) return;
		cart = setArticleQuantity(cart, { id, name: a.name, unitLabel: a.unitLabel, kind: a.kind }, 0);
		announce(a.name, 0);
	}

	function removeTent(id: string) {
		const t = cart.tents.find((x) => x.templateId === id);
		if (!t) return;
		cart = setTentCount(cart, { id, name: t.name, parts: t.parts }, 0);
		announce(t.name, 0);
	}

	function clearCart() {
		cart = emptyCart();
		liveMsg = 'Merkliste geleert';
	}

	// --- Verfügbarkeit der Merkliste --------------------------------------------------
	let problems = $state<Map<string, CartProblem>>(new Map());
	let availFree = $state<Map<string, number>>(new Map());
	let checking = $state(false);
	let checkError = $state('');

	$effect(() => {
		const lines = cartLines(cart);
		if (!ready || !periodValid || !lines.length) {
			problems = new Map();
			availFree = new Map();
			checking = false;
			checkError = '';
			return;
		}
		const body = JSON.stringify({ startsOn: from, endsOn: to, lines });
		let stale = false;
		const t = setTimeout(async () => {
			checking = true;
			try {
				const res = await apiFetch<LineAvailability[]>(`${API}/availability`, {
					method: 'POST',
					body
				});
				if (stale) return;
				problems = problemsByArticle(lines, res);
				availFree = freeFromAvailability(lines, res);
				checkError = '';
			} catch (e) {
				if (!stale) checkError = errorText(e, 'Verfügbarkeit konnte nicht geprüft werden.');
			} finally {
				if (!stale) checking = false;
			}
		}, 300);
		return () => {
			stale = true;
			clearTimeout(t);
		};
	});

	function clampToFree() {
		cart = clampCart(cart, availFree);
		liveMsg = 'Merkliste an die freien Mengen angepasst';
	}

	// --- Details ---------------------------------------------------------------------
	let detailOpen = $state(false);
	let detail = $state<DetailItem | null>(null);

	function openDetail(item: DetailItem) {
		detail = item;
		detailOpen = true;
	}

	// --- Scannen / Code-Eingabe -------------------------------------------------------
	const looksLikeCode = (raw: string) =>
		/^https?:\/\//i.test(raw.trim()) || /^[A-Z]-\d{3,}$/i.test(raw.trim());

	async function resolveCode(raw: string) {
		const code = codeFromScan(raw);
		if (!code) {
			toast.error('Diesen Code kenne ich nicht.');
			return;
		}
		try {
			const target = await apiFetch<CodeTarget>(`${API}/codes/${encodeURIComponent(code)}`);
			if (target.type === 'article') {
				pendingOpen = target.id;
				categoryId = '';
				searchText = search = target.code;
			} else if (target.type === 'unit') {
				const unit = await apiFetch<UnitSummary>(`${API}/units/${target.id}`);
				pendingOpen = unit.articleId;
				categoryId = '';
				searchText = search = unit.articleName;
			} else if (target.type === 'set') {
				toast.info(`${target.name} ist ein Set – reserviere es über den Zelttyp.`);
			} else if (target.type === 'location') {
				toast.info(`${target.name} ist ein Lagerort – was dort liegt, siehst du im Lager.`);
			} else {
				toast.info('Dieses Etikett ist noch keinem Material zugeordnet.');
			}
		} catch (e) {
			toast.error(errorText(e, 'Diesen Code kenne ich nicht.'));
		}
	}

	function onSearchKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && looksLikeCode(searchText)) {
			e.preventDefault();
			const raw = searchText;
			searchText = '';
			void resolveCode(raw);
		}
	}

	// --- Reservieren -----------------------------------------------------------------
	let reserveOpen = $state(false);
	let actions = $state<{ id: string; name: string }[]>([]);
	let actionsLoading = $state(false);
	const reserveLines = $derived(cartLines(cart));
	const suggestedTitle = $derived(
		urlTitle ||
			(actionName ? `Material für ${actionName}` : `Material für ${formatPeriod(from, to)}`)
	);

	async function loadActions() {
		actionsLoading = true;
		try {
			const res = await apiFetch<{ items: { id: string; name: string }[] }>(
				'/modules/actions/actions?limit=200'
			);
			actions = res.items.map((a) => ({ id: a.id, name: a.name }));
		} catch {
			actions = []; // Modul „Aktionen“ nicht aktiv oder kein Recht → ohne Aktionsauswahl
		} finally {
			if (actionId && actionName && !actions.some((a) => a.id === actionId))
				actions = [{ id: actionId, name: actionName }, ...actions];
			actionsLoading = false;
		}
	}

	async function startReserve() {
		if (cartSheetOpen) {
			cartSheetOpen = false;
			await sheetsSettled();
		}
		reserveOpen = true;
	}

	async function saved(r: Reservation) {
		cart = emptyCart();
		try {
			sessionStorage.removeItem(STORAGE_KEY);
		} catch {
			// egal
		}
		await goto(reservationHref(r.id));
	}

	function conflict(lines: { index: number; message: string }[]) {
		const current = cartLines(cart);
		problems = problemsByArticle(
			current,
			lines.map((l) => ({ index: l.index, ok: false, message: l.message }))
		);
	}

	// --- Start -----------------------------------------------------------------------
	onMount(() => {
		const q = page.url.searchParams;
		const qFrom = q.get('from');
		const qTo = q.get('to');
		urlTitle = (q.get('title') ?? '').slice(0, 150);
		const qAction = q.get('action');

		let stored: { cart?: unknown; from?: unknown; to?: unknown };
		try {
			stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') ?? {};
		} catch {
			stored = {};
		}
		cart = parseCart(stored.cart);

		if (isIsoDate(qFrom)) {
			from = qFrom;
			to = isIsoDate(qTo) && qTo >= qFrom ? qTo : qFrom;
		} else if (
			typeof stored.from === 'string' &&
			typeof stored.to === 'string' &&
			isIsoDate(stored.from) &&
			isIsoDate(stored.to) &&
			stored.from >= todayBerlin()
		) {
			from = stored.from;
			to = stored.to;
		}

		void apiFetch<Category[]>(`${API}/categories`)
			.then((c) => (categories = c))
			.catch(() => (categories = []));

		const init = async () => {
			if (qAction && /^[0-9a-f-]{36}$/i.test(qAction)) {
				try {
					const res = await apiFetch<{
						action: { id: string; name: string; startsOn: string; endsOn: string | null };
					}>(`${API}/reservations/by-action/${qAction}`);
					actionId = res.action.id;
					actionName = res.action.name;
					if (!isIsoDate(qFrom) && isIsoDate(res.action.startsOn)) {
						from = res.action.startsOn;
						to =
							isIsoDate(res.action.endsOn) && res.action.endsOn >= from ? res.action.endsOn : from;
					}
				} catch {
					toast.error('Die Aktion wurde nicht gefunden – du reservierst ohne Aktion.');
				}
			}
			ready = true;
			if (untrack(() => canReserve)) void loadActions();
		};
		void init();

		return listenForScanner((code) => void resolveCode(code));
	});

	function setFrom(v: string) {
		from = v;
		if (isIsoDate(v) && isIsoDate(to) && to < v) to = v;
	}

	const summary = $derived(cartSummary(cart));
	const showBar = $derived(canReserve && !isCartEmpty(cart));
</script>

<PageHeader title="Ausleihen" description={finding} />
<MaterialNav />

<p class="sr-only" aria-live="polite">{liveMsg}</p>

<div
	class={[
		'grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]',
		showBar ? 'pb-40 lg:pb-0' : phone ? 'pb-24' : ''
	]}
>
	<div class="min-w-0 space-y-6">
		<!-- Zeitraum und Suche -->
		<div class="space-y-4">
			<div class="grid grid-cols-2 gap-3 sm:max-w-md">
				<div class="space-y-1.5">
					<label for="borrow-from" class="text-sm font-medium">Von</label>
					<Input
						id="borrow-from"
						type="date"
						value={from}
						onchange={(e) => setFrom(e.currentTarget.value)}
						aria-invalid={!isIsoDate(from) || undefined}
					/>
				</div>
				<div class="space-y-1.5">
					<label for="borrow-to" class="text-sm font-medium">Bis</label>
					<Input
						id="borrow-to"
						type="date"
						value={to}
						min={from}
						onchange={(e) => (to = e.currentTarget.value)}
						aria-invalid={!periodValid || undefined}
						aria-describedby={periodValid ? undefined : 'borrow-period-error'}
					/>
				</div>
			</div>
			{#if !periodValid}
				<p id="borrow-period-error" class="text-xs text-destructive" role="alert">
					Das Ende darf nicht vor dem Beginn liegen.
				</p>
			{/if}

			<div class="relative">
				<label for="borrow-search" class="sr-only">Was brauchst du?</label>
				<Search
					class="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<Input
					id="borrow-search"
					type="search"
					class="h-11 pl-10 text-base"
					placeholder="Was brauchst du? Name oder Code …"
					name="q"
					inputmode="search"
					autocomplete="off"
					spellcheck={false}
					data-scan-field
					bind:value={searchText}
					onkeydown={onSearchKey}
				/>
			</div>

			{#if categories.length}
				<ScrollPills
					label="Kategorie"
					value={categoryId}
					options={[
						{ value: '', label: 'Alles' },
						...categories.map((c) => ({ value: c.id, label: c.name }))
					]}
					onchange={(v) => (categoryId = v)}
				/>
			{/if}
		</div>

		{#if !canReserve}
			<Alert.Root variant="info">
				<Alert.Description>
					Zum Reservieren fehlt dir die Berechtigung. Du kannst sehen, was im Zeitraum frei ist.
				</Alert.Description>
			</Alert.Root>
		{/if}

		<!-- Katalog -->
		{#if !periodValid}
			<p class="text-sm text-muted-foreground">
				Wähle einen gültigen Zeitraum, um zu sehen, was frei ist.
			</p>
		{:else if loadError && !catalog}
			<ErrorState message={loadError} onretry={retry} busy={loading} />
		{:else if !catalog}
			<LoadingState label="Katalog" rows={6} rowClass="h-14 w-full" />
		{:else}
			{#if loadError}
				<ErrorState compact message={loadError} onretry={retry} busy={loading} />
			{/if}
			<div class={['space-y-8 transition-opacity', loading && 'opacity-60']} aria-busy={loading}>
				{#if !catalog.articles.length && !templates.length}
					{#if search || categoryId}
						<EmptyState
							title="Nichts gefunden"
							description={search
								? `Zu „${search}“ gibt es kein Material. Versuch es mit einem anderen Wort.`
								: 'In dieser Kategorie gibt es kein Material.'}
						/>
					{:else}
						<EmptyState
							title="Noch kein Material erfasst"
							description="Sobald die Materialwart*in Material im Lager anlegt, kannst du es hier ausleihen."
						/>
					{/if}
				{/if}

				{#if templates.length}
					<section aria-labelledby="borrow-tents">
						<h2 id="borrow-tents" class="text-section">Ganze Zelte</h2>
						<p class="text-sm text-muted-foreground">
							Ein Zelt reservierst du als Teile – bei der Ausgabe wird es zusammengestellt.
						</p>
						<ul class="mt-2 divide-y border-y">
							{#each templates as t (t.id)}
								{@const short = t.parts.filter((p) => problems.has(p.articleId))}
								<CatalogRow
									title={t.name}
									subtitle={partsText(t.parts)}
									tent
									free={t.free}
									quantity={tentCount(cart, t.id)}
									max={maxTentCount(cart, t, catalogFree)}
									{canReserve}
									problem={tentCount(cart, t.id) > 0 && short.length > 0
										? `Zu wenig frei: ${short.map((p) => p.articleName).join(', ')}`
										: null}
									onchange={(n) => changeTent(t, n)}
									onopen={() => openDetail({ kind: 'tent', template: t })}
								/>
							{/each}
						</ul>
					</section>
				{/if}

				{#each groups as g (g.key)}
					<section aria-labelledby="borrow-cat-{g.key || 'none'}">
						<h2 id="borrow-cat-{g.key || 'none'}" class="text-section">{g.name}</h2>
						<ul class="mt-2 divide-y border-y">
							{#each g.items as a (a.id)}
								{@const qty = articleQuantity(cart, a.id)}
								<CatalogRow
									title={a.name}
									subtitle={a.places.length ? a.places.join(' · ') : 'Kein Lagerort erfasst'}
									thumbUrl={a.thumbUrl}
									icon={a.categoryIcon}
									free={a.free}
									total={a.total}
									freeLabel={a.kind === 'bulk' ? `${a.unitLabel} frei` : 'frei'}
									quantity={qty}
									max={maxArticleQuantity(cart, a.id, a.free)}
									{canReserve}
									problem={qty ? (problems.get(a.id)?.message ?? null) : null}
									onchange={(n) => changeArticle(a, n)}
									onopen={() => openDetail({ kind: 'article', article: a })}
								/>
							{/each}
						</ul>
					</section>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Merkliste: Desktop rechts -->
	{#if canReserve}
		<aside class="hidden lg:block" aria-label="Merkliste">
			<div class="sticky top-20 rounded-lg border p-4">
				<CartPanel
					{cart}
					{from}
					{to}
					{problems}
					{checking}
					{checkError}
					{periodValid}
					onremovearticle={removeArticle}
					onremovetent={removeTent}
					onclamp={clampToFree}
					onclear={clearCart}
					onreserve={startReserve}
				/>
			</div>
		</aside>
	{/if}
</div>

<!-- Merkliste: Handy/Tablet als Leiste unten -->
{#if showBar}
	<div
		class={[
			'fixed inset-x-0 z-30 flex items-center gap-3 border-t bg-background px-4 py-2 lg:hidden',
			!phone && 'safe-bottom bottom-0'
		]}
		style={phone ? 'bottom: calc(3.5rem + max(0.5rem, env(safe-area-inset-bottom)))' : undefined}
		role="region"
		aria-label="Merkliste"
	>
		<button
			type="button"
			class="min-h-11 min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
			onclick={() => (cartSheetOpen = true)}
		>
			<span class="block text-sm font-medium">Merkliste</span>
			<span
				class={[
					'block truncate text-xs tabular-nums',
					problems.size ? 'text-destructive' : 'text-muted-foreground'
				]}
			>
				{summary.positions}
				{summary.positions === 1 ? 'Position' : 'Positionen'} · {summary.items}
				{summary.items === 1 ? 'Teil' : 'Teile'}{problems.size ? ' · nicht alles frei' : ''}
			</span>
		</button>
		<Button onclick={startReserve} disabled={problems.size > 0 || !periodValid}>Reservieren</Button>
	</div>

	<BottomSheet bind:open={cartSheetOpen} title="Merkliste" size="tall">
		<CartPanel
			heading={false}
			{cart}
			{from}
			{to}
			{problems}
			{checking}
			{checkError}
			{periodValid}
			onremovearticle={removeArticle}
			onremovetent={removeTent}
			onclamp={clampToFree}
			onclear={clearCart}
			onreserve={startReserve}
		/>
	</BottomSheet>
{/if}

<ItemDetail bind:open={detailOpen} item={detail} {phone} {from} {to} />

{#if canReserve}
	<ReserveDialog
		bind:open={reserveOpen}
		{from}
		{to}
		lines={reserveLines}
		{suggestedTitle}
		{actionId}
		{actions}
		{actionsLoading}
		onsaved={saved}
		onconflict={conflict}
	/>
{/if}
