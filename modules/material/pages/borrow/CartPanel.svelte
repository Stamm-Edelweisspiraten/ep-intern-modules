<script lang="ts">
	// Merkliste: Zelte und Artikel mit Menge, Probleme je Position, Summe und „Reservieren“.
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import { formatPeriod } from '../helpers';
	import { cartSummary, isCartEmpty, partsText, type Cart, type CartProblem } from './cart';

	let {
		cart,
		from,
		to,
		problems,
		checking = false,
		checkError = '',
		periodValid = true,
		heading = true,
		onremovearticle,
		onremovetent,
		onclamp,
		onclear,
		onreserve
	}: {
		cart: Cart;
		from: string;
		to: string;
		problems: ReadonlyMap<string, CartProblem>;
		checking?: boolean;
		checkError?: string;
		periodValid?: boolean;
		/** Überschrift zeigen (im Blatt steht sie schon im Kopf) */
		heading?: boolean;
		onremovearticle: (articleId: string) => void;
		onremovetent: (templateId: string) => void;
		onclamp: () => void;
		onclear: () => void;
		onreserve: () => void;
	} = $props();

	const summary = $derived(cartSummary(cart));
	const empty = $derived(isCartEmpty(cart));
	const hasProblems = $derived(problems.size > 0);

	function tentProblem(parts: Cart['tents'][number]['parts']): string | null {
		const short = parts.filter((p) => problems.has(p.articleId)).map((p) => p.articleName);
		return short.length ? `Zu wenig frei: ${short.join(', ')}` : null;
	}

	function amount(a: Cart['articles'][number]): string {
		return a.kind === 'bulk' ? `${a.quantity} ${a.unitLabel}` : `${a.quantity} ×`;
	}
</script>

<section aria-label="Merkliste" class="space-y-3">
	<div class="flex items-baseline justify-between gap-2">
		{#if heading}<h2 class="text-section">Merkliste</h2>{:else}<span></span>{/if}
		{#if !empty}
			<Button variant="ghost" size="sm" onclick={onclear}>Leeren</Button>
		{/if}
	</div>
	<p class="text-sm text-muted-foreground tabular-nums">
		{periodValid ? formatPeriod(from, to) : 'Zeitraum prüfen'}
	</p>

	{#if empty}
		<p class="text-sm text-muted-foreground">
			Noch leer. Wähle links mit + aus, was du im Zeitraum brauchst.
		</p>
	{:else}
		<ul class="divide-y border-y">
			{#each cart.tents as t (t.templateId)}
				{@const problem = tentProblem(t.parts)}
				<li class="flex items-start gap-2 py-2">
					<span class="min-w-0 flex-1">
						<span class="block font-medium tabular-nums">{t.count} × {t.name}</span>
						<span class="block text-xs text-muted-foreground">je {partsText(t.parts)}</span>
						{#if problem}<span class="block text-xs text-destructive">{problem}</span>{/if}
					</span>
					<Button
						variant="ghost"
						size="icon"
						class="shrink-0"
						aria-label="{t.name} von der Merkliste entfernen"
						onclick={() => onremovetent(t.templateId)}
					>
						<X />
					</Button>
				</li>
			{/each}
			{#each cart.articles as a (a.articleId)}
				{@const problem = problems.get(a.articleId)}
				<li class="flex items-start gap-2 py-2">
					<span class="min-w-0 flex-1">
						<span class="block font-medium">
							<span class="tabular-nums">{amount(a)}</span>
							{a.name}
						</span>
						{#if problem}
							<span class="block text-xs text-destructive">{problem.message}</span>
						{/if}
					</span>
					<Button
						variant="ghost"
						size="icon"
						class="shrink-0"
						aria-label="{a.name} von der Merkliste entfernen"
						onclick={() => onremovearticle(a.articleId)}
					>
						<X />
					</Button>
				</li>
			{/each}
		</ul>

		<p class="text-sm tabular-nums">
			{summary.positions}
			{summary.positions === 1 ? 'Position' : 'Positionen'} · {summary.items}
			{summary.items === 1 ? 'Teil' : 'Teile'}
		</p>

		<div aria-live="polite" class="space-y-2">
			{#if checking}
				<p class="text-xs text-muted-foreground">Prüft Verfügbarkeit …</p>
			{:else if checkError}
				<p class="text-xs text-destructive">{checkError}</p>
			{:else if hasProblems}
				<p class="text-sm text-destructive">Nicht alles ist im Zeitraum frei.</p>
				<Button variant="outline" size="sm" onclick={onclamp}>An freie Mengen anpassen</Button>
			{/if}
		</div>
	{/if}

	<Button class="w-full" disabled={empty || hasProblems || !periodValid} onclick={onreserve}>
		Reservieren
	</Button>
</section>
