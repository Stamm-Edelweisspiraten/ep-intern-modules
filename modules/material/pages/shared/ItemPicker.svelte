<script lang="ts">
	// Objekte für den Etikettendruck wählen: Lagerartikel per Suche (`GET /inventory?search=`) bzw.
	// Lagerorte (`GET /locations`, lokal gefiltert). Gewählte erscheinen als Chips über der Trefferliste.
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Badge } from '$lib/components/ui/badge';
	import { SvelteMap } from 'svelte/reactivity';
	import type { Inventory, Item, Location } from '../../schemas';
	import { API, errorText } from '../helpers';

	let {
		target,
		selected = $bindable([]),
		label = 'Suchen',
		id = 'item-picker',
		max = 200
	}: {
		/** Lagerartikel oder Lagerorte */
		target: 'item' | 'location';
		/** Gewählte IDs (Reihenfolge = Auswahlreihenfolge) */
		selected?: string[];
		/** Zugängliche Bezeichnung des Suchfelds */
		label?: string;
		id?: string;
		/** Höchstzahl wählbarer Objekte */
		max?: number;
	} = $props();

	interface Option {
		id: string;
		title: string;
		detail: string;
		code: string;
	}

	const LIMIT = 30;
	let query = $state('');
	let results = $state<Option[]>([]);
	let loading = $state(false);
	let error = $state('');
	/** Bekannte Einträge (für Chips gewählter Objekte, auch wenn sie nicht mehr in den Treffern stehen) */
	const known = new SvelteMap<string, Option>();
	let locations: Option[] | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	const itemOption = (i: Item): Option => ({
		id: i.id,
		title: i.quantity > 1 ? `${i.name} (${i.quantity} ×)` : i.name,
		detail: [i.typeName, i.locationName].filter(Boolean).join(' · '),
		code: i.code
	});
	const locationOption = (l: Location): Option => ({
		id: l.id,
		title: l.name,
		detail: l.description,
		code: l.code
	});

	function remember(list: Option[]) {
		for (const o of list) known.set(o.id, o);
	}

	async function search(q: string) {
		const mine = ++seq;
		loading = true;
		error = '';
		try {
			let list: Option[];
			if (target === 'location') {
				locations ??= (await apiFetch<Location[]>(`${API}/locations`)).map(locationOption);
				const needle = q.trim().toLocaleLowerCase('de');
				list = needle
					? locations.filter((o) =>
							`${o.title} ${o.code} ${o.detail}`.toLocaleLowerCase('de').includes(needle)
						)
					: locations;
			} else {
				const params = new URLSearchParams();
				if (q.trim()) params.set('search', q.trim());
				const inv = await apiFetch<Inventory>(`${API}/inventory?${params}`);
				list = [...inv.types.flatMap((t) => t.items), ...inv.items].map(itemOption);
			}
			if (mine !== seq) return;
			remember(list);
			results = list.slice(0, LIMIT);
		} catch (e) {
			if (mine === seq) error = errorText(e, 'Suche fehlgeschlagen');
		} finally {
			if (mine === seq) loading = false;
		}
	}

	// Erste Trefferliste und bei Zielwechsel neu laden
	let loadedTarget: string | null = null;
	$effect(() => {
		if (loadedTarget === target) return;
		loadedTarget = target;
		locations = null;
		query = '';
		void search('');
	});

	function onInput() {
		clearTimeout(timer);
		timer = setTimeout(() => void search(query), 250);
	}

	function toggle(id: string, on: boolean) {
		if (on) {
			if (!selected.includes(id) && selected.length < max) selected = [...selected, id];
		} else selected = selected.filter((x) => x !== id);
	}

	const chips = $derived(
		selected.map((sid) => known.get(sid) ?? { id: sid, title: 'Unbekannt', detail: '', code: '' })
	);
	const placeholder = $derived(
		target === 'location' ? 'Lagerort suchen …' : 'Artikel, Code oder Typ suchen …'
	);
</script>

<div class="space-y-2">
	{#if chips.length}
		<ul class="flex flex-wrap gap-1" aria-label="Ausgewählt">
			{#each chips as c (c.id)}
				<li>
					<Badge variant="secondary" class="gap-1 pr-0.5">
						<span class="max-w-48 truncate">{c.title}</span>
						<button
							type="button"
							class="rounded-sm p-0.5 hover:bg-muted"
							aria-label={`${c.title} entfernen`}
							onclick={() => toggle(c.id, false)}
						>
							<X class="size-3" aria-hidden="true" />
						</button>
					</Badge>
				</li>
			{/each}
		</ul>
	{/if}
	<Input
		{id}
		type="search"
		aria-label={label}
		{placeholder}
		bind:value={query}
		oninput={onInput}
		autocomplete="off"
	/>
	<div class="max-h-60 overflow-y-auto rounded-md border" aria-busy={loading}>
		{#if error}
			<p class="p-3 text-sm text-destructive" role="alert">{error}</p>
		{:else if !results.length}
			<p class="p-3 text-sm text-muted-foreground">
				{loading ? 'Sucht …' : 'Keine Treffer.'}
			</p>
		{:else}
			<ul class="divide-y">
				{#each results as o (o.id)}
					{@const checked = selected.includes(o.id)}
					<li>
						<label
							class="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/60"
						>
							<Checkbox
								{checked}
								disabled={!checked && selected.length >= max}
								onCheckedChange={(v) => toggle(o.id, v === true)}
								aria-label={o.title}
							/>
							<span class="min-w-0 flex-1">
								<span class="block truncate font-medium">{o.title}</span>
								{#if o.detail}
									<span class="block truncate text-xs text-muted-foreground">{o.detail}</span>
								{/if}
							</span>
							{#if o.code}
								<span class="shrink-0 font-mono text-xs text-muted-foreground">{o.code}</span>
							{/if}
						</label>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
	<p class="text-xs text-muted-foreground" aria-live="polite">
		<span class="tabular-nums">{selected.length}</span>
		{selected.length === 1 ? 'Objekt' : 'Objekte'} gewählt
	</p>
</div>
