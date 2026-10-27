<script lang="ts" module>
	import type { CatalogArticle, CatalogTemplate } from '../../schemas';

	export type DetailItem =
		{ kind: 'article'; article: CatalogArticle } | { kind: 'tent'; template: CatalogTemplate };
</script>

<script lang="ts">
	// Kleine Detailansicht eines Artikels oder Zelttyps: Foto groß, Beschreibung, Orte, freie Anzahl.
	// Handy als Blatt von unten, sonst als Dialog.
	import * as Dialog from '$lib/components/ui/dialog';
	import { BottomSheet } from '$lib/components/layout';
	import { formatPeriod } from '../helpers';
	import { partsText } from './cart';

	let {
		open = $bindable(false),
		item,
		phone,
		from,
		to
	}: {
		open?: boolean;
		item: DetailItem | null;
		phone: boolean;
		from: string;
		to: string;
	} = $props();

	const title = $derived(
		item ? (item.kind === 'article' ? item.article.name : item.template.name) : ''
	);
	const image = $derived(
		item?.kind === 'article' && item.article.thumbUrl
			? item.article.thumbUrl.replace(/\/thumb$/, '/web')
			: null
	);
</script>

{#snippet body()}
	{#if item}
		<div class="space-y-4">
			{#if image}
				<img src={image} alt={title} class="max-h-72 w-full rounded-lg border object-contain" />
			{/if}
			{#if item.kind === 'article'}
				{@const a = item.article}
				<p class="text-sm tabular-nums">
					<span class={a.free > 0 ? 'font-medium text-link' : 'text-muted-foreground'}>
						{a.free}
						{a.kind === 'bulk' ? a.unitLabel : ''} frei
					</span>
					<span class="text-muted-foreground">von {a.total} · {formatPeriod(from, to)}</span>
				</p>
				{#if a.description}
					<p class="text-sm whitespace-pre-line">{a.description}</p>
				{/if}
				<dl class="space-y-2 text-sm">
					{#if a.categoryName}
						<div>
							<dt class="text-muted-foreground">Kategorie</dt>
							<dd>{a.categoryName}</dd>
						</div>
					{/if}
					<div>
						<dt class="text-muted-foreground">Liegt in</dt>
						<dd>
							{#if a.places.length}
								<ul>
									{#each a.places as p (p)}<li>{p}</li>{/each}
								</ul>
							{:else}
								Kein Lagerort erfasst
							{/if}
						</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Code</dt>
						<dd class="font-mono">{a.code}</dd>
					</div>
				</dl>
			{:else}
				{@const t = item.template}
				<p class="text-sm tabular-nums">
					<span class={t.free > 0 ? 'font-medium text-link' : 'text-muted-foreground'}>
						{t.free} frei
					</span>
					<span class="text-muted-foreground">· {formatPeriod(from, to)}</span>
				</p>
				{#if t.description}
					<p class="text-sm whitespace-pre-line">{t.description}</p>
				{/if}
				<dl class="space-y-2 text-sm">
					<div>
						<dt class="text-muted-foreground">Ein Zelt besteht aus</dt>
						<dd>{partsText(t.parts)}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Fertige Sets</dt>
						<dd class="tabular-nums">{t.sets}</dd>
					</div>
				</dl>
				<p class="text-xs text-muted-foreground">
					Reserviert werden die Teile. Bei der Ausgabe stellt die Materialwart*in sie zusammen –
					gern als fertiges Set.
				</p>
			{/if}
		</div>
	{/if}
{/snippet}

{#if phone}
	<BottomSheet bind:open {title}>
		{@render body()}
	</BottomSheet>
{:else}
	<Dialog.Root bind:open>
		<Dialog.Content class="sm:max-w-lg">
			<Dialog.Header>
				<Dialog.Title>{title}</Dialog.Title>
			</Dialog.Header>
			{@render body()}
		</Dialog.Content>
	</Dialog.Root>
{/if}
