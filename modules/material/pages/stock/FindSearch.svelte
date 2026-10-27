<script lang="ts">
	// „Wo ist …?“: große Suche über Stücke, Kisten, Mengenartikel, Sets und Orte. Treffer zeigen den
	// Lagerort als Pfad (Haupt-Datenelement). Codes und volle Scan-URLs (USB-Scanner, QR) werden erkannt;
	// Enter mit genau passendem Code öffnet den Treffer direkt.
	import { onMount, untrack } from 'svelte';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { ErrorState, LoadingState } from '$lib/components/layout';
	import { codeFromScan, type FindHit } from '../../schemas';
	import { API, errorText } from '../helpers';
	import ConditionBadge from '../shared/ConditionBadge.svelte';

	let {
		query = $bindable(''),
		autofocus = false,
		onopen
	}: {
		query?: string;
		/** Beim Laden fokussieren (nur Desktop) */
		autofocus?: boolean;
		onopen: (hit: FindHit) => void;
	} = $props();

	const TYPE_LABELS: Record<FindHit['type'], string> = {
		unit: 'Stück',
		container: 'Kiste',
		article: 'Menge',
		set: 'Set',
		location: 'Ort'
	};

	let input = $state<HTMLInputElement | null>(null);
	let hits = $state<FindHit[]>([]);
	let loading = $state(false);
	let error = $state('');
	let searched = $state('');
	let pendingOpen = $state<string | null>(null);

	/** Volle Scan-URL → Code; sonst der Text */
	function normalized(raw: string): string {
		const text = raw.trim();
		if (/^https?:\/\//i.test(text)) return codeFromScan(text) ?? text;
		return text;
	}

	let seq = 0;
	async function run(q: string) {
		const my = ++seq;
		loading = true;
		error = '';
		try {
			const res = await apiFetch<FindHit[]>(`${API}/find?q=${encodeURIComponent(q)}`);
			if (my !== seq) return;
			hits = res;
			searched = q;
			if (pendingOpen) {
				const code = pendingOpen;
				pendingOpen = null;
				const exact = res.find((h) => h.code.toUpperCase() === code);
				if (exact) onopen(exact);
			}
		} catch (e) {
			if (my === seq) error = errorText(e, 'Suche fehlgeschlagen');
		} finally {
			if (my === seq) loading = false;
		}
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const q = normalized(query).slice(0, 100);
		clearTimeout(timer);
		if (!q) {
			untrack(() => {
				seq++;
				hits = [];
				searched = '';
				loading = false;
				error = '';
			});
			return;
		}
		timer = setTimeout(() => void run(q), 250);
		return () => clearTimeout(timer);
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && query) {
			e.preventDefault();
			query = '';
			return;
		}
		if (e.key !== 'Enter') return;
		e.preventDefault();
		const q = normalized(query);
		if (q !== query.trim()) query = q;
		const code = codeFromScan(q);
		if (!code) return;
		const exact = searched === q ? hits.find((h) => h.code.toUpperCase() === code) : undefined;
		if (exact) onopen(exact);
		else pendingOpen = code;
	}

	onMount(() => {
		if (autofocus) input?.focus();
	});

	const showResults = $derived(!!query.trim());
</script>

<div class="space-y-3">
	<div class="relative">
		<Search
			class="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
			aria-hidden="true"
		/>
		<input
			bind:this={input}
			bind:value={query}
			{onkeydown}
			type="search"
			inputmode="search"
			autocomplete="off"
			spellcheck="false"
			placeholder="Wo ist …? Name oder Code, z. B. Kohtenbahn oder M-000123"
			aria-label="Wo ist …? Material, Kiste, Set oder Ort suchen"
			aria-controls={showResults ? 'find-results' : undefined}
			data-scan-field
			class="focus-ring h-11 w-full rounded-lg border border-input bg-background pr-11 pl-10 text-base placeholder:text-muted-foreground focus-visible:border-ring"
		/>
		{#if query}
			<button
				type="button"
				class="focus-ring absolute top-1/2 right-1 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
				aria-label="Suche leeren"
				onclick={() => {
					query = '';
					input?.focus();
				}}
			>
				<X class="size-4" aria-hidden="true" />
			</button>
		{/if}
	</div>

	{#if showResults}
		<section id="find-results" aria-label="Treffer" aria-busy={loading}>
			{#if loading && !hits.length}
				<LoadingState label="Treffer" rows={4} rowClass="h-12 w-full" />
			{:else if error}
				<ErrorState message={error} onretry={() => run(normalized(query))} compact />
			{:else if searched && !hits.length}
				<p class="py-6 text-sm text-muted-foreground" role="status">
					Nichts gefunden für „{searched}“. Prüfe die Schreibweise oder suche nach dem Code auf dem
					Etikett.
				</p>
			{:else if hits.length}
				<p class="sr-only" role="status">
					{hits.length === 1 ? '1 Treffer' : `${hits.length} Treffer`}
				</p>
				<ul class="divide-y border-y">
					{#each hits as h (`${h.type}:${h.id}`)}
						<li>
							<button
								type="button"
								class="focus-ring grid min-h-14 w-full grid-cols-[3.5rem_1fr_auto] items-center gap-x-3 gap-y-0.5 px-1 py-2 text-left hover:bg-muted/50 sm:grid-cols-[4rem_minmax(0,14rem)_1fr_auto]"
								onclick={() => onopen(h)}
							>
								<span class="text-xs text-muted-foreground">{TYPE_LABELS[h.type]}</span>
								<span class="min-w-0">
									<span class="block truncate font-medium">{h.name}</span>
									<span class="block truncate text-xs text-muted-foreground">
										<span class="font-mono">{h.code}</span>{h.detail ? ` · ${h.detail}` : ''}
									</span>
								</span>
								<span class="col-start-2 row-start-2 min-w-0 text-sm sm:col-start-3 sm:row-start-1">
									<span class="block truncate text-foreground">{h.place || 'Ohne Ort'}</span>
									{#if h.away}
										<span class="block truncate text-xs text-warning">unterwegs: {h.away}</span>
									{/if}
								</span>
								<span
									class="col-start-3 row-span-2 row-start-1 flex items-center justify-end gap-2 sm:col-start-4"
								>
									{#if h.quantity != null && (h.type === 'article' || h.type === 'set')}
										<span class="text-sm tabular-nums">
											{h.quantity}<span class="sr-only">
												{h.type === 'set' ? ' Stücke' : ' im Bestand'}</span
											>
										</span>
									{/if}
									{#if h.condition}<ConditionBadge condition={h.condition} hideOk />{/if}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>
