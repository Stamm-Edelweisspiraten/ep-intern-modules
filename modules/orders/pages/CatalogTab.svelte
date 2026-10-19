<script lang="ts">
	import { onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import { page } from '$app/state';
	import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { EmptyState, MobileActionBar, SearchInput } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { PERMISSIONS, type Article, type OrderCreated } from '../schemas';
	import ArticleCard from './ArticleCard.svelte';
	import ArticleDetailDialog from './ArticleDetailDialog.svelte';
	import CartPanel from './CartPanel.svelte';
	import {
		BASE,
		addToCart,
		cartCount,
		cartTotal,
		errorText,
		itemLabel,
		loadCart,
		reconcileCart,
		saveCart,
		type CartItem
	} from './helpers';

	let { onordered }: { onordered?: (created: OrderCreated) => void } = $props();

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canCreate = $derived(can(permissions, PERMISSIONS.create));
	const canManage = $derived(can(permissions, PERMISSIONS.manage));

	const desktop = new MediaQuery('(min-width: 1024px)', false);

	let articles = $state<Article[]>([]);
	let loading = $state(true);
	let error = $state('');

	let cart = $state<CartItem[]>([]);
	let memberId = $state<string | null>(null);
	let note = $state('');
	let cartOpen = $state(false);

	const search = $derived((page.url.searchParams.get('q') ?? '').trim().toLowerCase());
	const visible = $derived(
		search
			? articles.filter(
					(a) =>
						a.title.toLowerCase().includes(search) ||
						(a.description ?? '').toLowerCase().includes(search) ||
						a.variants.some((v) => v.label.toLowerCase() === search)
				)
			: articles
	);

	async function load() {
		loading = !articles.length;
		error = '';
		try {
			articles = await apiFetch<Article[]>(`${BASE}/articles?scope=catalog`);
			const r = reconcileCart(cart, articles);
			if (r.changed) {
				cart = r.cart;
				saveCart(cart);
				if (r.removed)
					toast.info(
						r.removed === 1
							? 'Ein Artikel im Warenkorb ist nicht mehr bestellbar und wurde entfernt.'
							: `${r.removed} Artikel im Warenkorb sind nicht mehr bestellbar und wurden entfernt.`
					);
			}
		} catch (e) {
			error = errorText(e, 'Artikel konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		cart = loadCart();
		void load();
	});

	function setCart(next: CartItem[]) {
		cart = next;
		saveCart(next);
	}

	// --- Artikel ansehen ---------------------------------------------------------
	let selected = $state<Article | null>(null);
	let detailOpen = $state(false);
	let detailKey = $state(0);

	function select(a: Article) {
		selected = a;
		detailKey++;
		detailOpen = true;
	}

	function add(item: CartItem) {
		setCart(addToCart(cart, item));
		toast.success(`${itemLabel(item.articleTitle, item.variantLabel)} im Warenkorb`, {
			action: desktop.current ? undefined : { label: 'Warenkorb', onClick: () => (cartOpen = true) }
		});
	}

	function ordered(created: OrderCreated) {
		cartOpen = false;
		void load();
		onordered?.(created);
	}

	const count = $derived(cartCount(cart));
	const total = $derived(cartTotal(cart));
</script>

{#snippet cartPanel()}
	<CartPanel
		bind:cart
		bind:memberId
		bind:note
		{canCreate}
		{canManage}
		oncartchange={(c) => saveCart(c)}
		onordered={ordered}
	/>
{/snippet}

<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
	<div class={['min-w-0 space-y-4', !desktop.current && 'max-sm:pb-20']}>
		<div class="flex flex-wrap items-center gap-2">
			<div class="w-full sm:max-w-72">
				<SearchInput param="q" placeholder="Artikel suchen …" label="Artikel suchen" />
			</div>
			{#if !desktop.current}
				<MobileActionBar label="Warenkorb" class="sm:ml-auto">
					<Button
						variant={count ? 'default' : 'outline'}
						class="max-sm:flex-1"
						onclick={() => (cartOpen = true)}
					>
						<ShoppingCart />
						Warenkorb
						{#if count}
							<span class="tabular-nums">({count}) · {formatEuro(total)}</span>
						{/if}
					</Button>
				</MobileActionBar>
			{/if}
		</div>

		{#if loading}
			<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
				{#each [0, 1, 2] as i (i)}
					<div class="space-y-3 rounded-xl border p-0">
						<Skeleton class="aspect-[4/3] w-full rounded-b-none" />
						<div class="space-y-2 p-4">
							<Skeleton class="h-4 w-2/3" />
							<Skeleton class="h-3 w-full" />
							<Skeleton class="h-8 w-24" />
						</div>
					</div>
				{/each}
			</div>
		{:else if error}
			<div class="space-y-3 rounded-lg border p-4" role="alert">
				<p class="text-sm text-destructive">{error}</p>
				<Button variant="outline" size="sm" onclick={load}>Erneut versuchen</Button>
			</div>
		{:else if !articles.length}
			<EmptyState
				title="Noch keine Artikel"
				description="Sobald die*der Kämmerer*in Artikel anlegt, kannst du sie hier bestellen."
			/>
		{:else if !visible.length}
			<EmptyState
				title="Nichts gefunden"
				description="Kein Artikel passt zur Suche. Versuche einen anderen Begriff."
			/>
		{:else}
			<ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
				{#each visible as a (a.id)}
					<li><ArticleCard article={a} onselect={select} /></li>
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
				<Sheet.Description class="sr-only">Positionen prüfen und bestellen</Sheet.Description>
			</Sheet.Header>
			<div class="px-4 pb-6">
				{@render cartPanel()}
			</div>
		</Sheet.Content>
	</Sheet.Root>
{/if}

{#if selected}
	{#key detailKey}
		<ArticleDetailDialog
			bind:open={detailOpen}
			article={selected}
			canOrder={canCreate || canManage}
			onadd={add}
		/>
	{/key}
{/if}
