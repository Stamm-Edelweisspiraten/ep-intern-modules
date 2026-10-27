<script lang="ts">
	// Stücke/Kisten suchen und auswählen (Mehrfachauswahl mit Suche, optional nur im Zeitraum freie).
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import type { UnitSummary } from '../../schemas';
	import { API } from '../helpers';
	import ConditionBadge from './ConditionBadge.svelte';

	let {
		selected = $bindable([]),
		known = [],
		articleId,
		containersOnly = false,
		from,
		to,
		exclude = [],
		label = 'Stücke suchen',
		single = false,
		onpick
	}: {
		/** Gewählte Stück-IDs */
		selected?: string[];
		/** Bereits bekannte Stücke (für die Anzeige der gewählten) */
		known?: UnitSummary[];
		articleId?: string;
		containersOnly?: boolean;
		/** Nur im Zeitraum freie Stücke zeigen */
		from?: string;
		to?: string;
		/** Diese IDs nie anbieten */
		exclude?: string[];
		label?: string;
		/** Einzelauswahl: Klick wählt und meldet sofort (`onpick`) */
		single?: boolean;
		onpick?: (unit: UnitSummary) => void;
	} = $props();

	let search = $state('');
	let items = $state<UnitSummary[]>([]);
	let total = $state(0);
	let loading = $state(false);
	let error = $state('');
	const cache = new Map<string, UnitSummary>();

	$effect(() => {
		for (const u of known) cache.set(u.id, u);
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;
	$effect(() => {
		const q = search.trim();
		const params = new URLSearchParams({ limit: '50' });
		if (q) params.set('search', q);
		if (articleId) params.set('articleId', articleId);
		if (containersOnly) params.set('containers', '1');
		if (from && to) {
			params.set('from', from);
			params.set('to', to);
		}
		clearTimeout(timer);
		const my = ++seq;
		timer = setTimeout(async () => {
			loading = true;
			error = '';
			try {
				const res = await apiFetch<{ items: UnitSummary[]; total: number }>(
					`${API}/units?${params}`
				);
				if (my !== seq) return;
				for (const u of res.items) cache.set(u.id, u);
				items = res.items;
				total = res.total;
			} catch {
				if (my === seq) error = 'Stücke konnten nicht geladen werden.';
			} finally {
				if (my === seq) loading = false;
			}
		}, 200);
		return () => clearTimeout(timer);
	});

	const visible = $derived(items.filter((u) => !exclude.includes(u.id)));
	const chosen = $derived(selected.map((id) => cache.get(id)).filter((u): u is UnitSummary => !!u));

	function toggle(u: UnitSummary, on: boolean) {
		if (single) {
			onpick?.(u);
			return;
		}
		selected = on ? [...new Set([...selected, u.id])] : selected.filter((x) => x !== u.id);
	}
</script>

<div class="space-y-2">
	{#if !single && chosen.length}
		<ul class="flex flex-wrap gap-1.5" aria-label="Ausgewählt">
			{#each chosen as u (u.id)}
				<li>
					<Badge variant="secondary" class="gap-1 pr-1">
						{u.name}
						<button
							type="button"
							class="rounded-full p-0.5 hover:bg-background"
							aria-label={`${u.name} entfernen`}
							onclick={() => toggle(u, false)}
						>
							<X class="size-3" aria-hidden="true" />
						</button>
					</Badge>
				</li>
			{/each}
		</ul>
	{/if}
	<Input
		type="search"
		placeholder="Name oder Code …"
		aria-label={label}
		bind:value={search}
		data-scan-field
	/>
	<div class="max-h-64 overflow-y-auto rounded-md border" aria-busy={loading}>
		{#if error}
			<p class="p-3 text-sm text-destructive" role="alert">{error}</p>
		{:else if !visible.length}
			<p class="p-3 text-sm text-muted-foreground">
				{loading ? 'Lädt …' : from ? 'Keine freien Stücke gefunden.' : 'Keine Stücke gefunden.'}
			</p>
		{:else}
			<ul class="divide-y">
				{#each visible as u (u.id)}
					{@const on = selected.includes(u.id)}
					<li>
						<label
							class="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50"
						>
							{#if !single}
								<Checkbox checked={on} onCheckedChange={(v) => toggle(u, v === true)} />
							{:else}
								<input
									type="radio"
									class="sr-only"
									name="unit-picker"
									onchange={() => toggle(u, true)}
								/>
							{/if}
							<span class="min-w-0 flex-1">
								<span class="block truncate font-medium">{u.name}</span>
								<span class="block truncate text-xs text-muted-foreground">
									{u.code} · {u.locationPath}{u.setName ? ` · Set ${u.setName}` : ''}
								</span>
							</span>
							<ConditionBadge condition={u.condition} hideOk />
						</label>
					</li>
				{/each}
			</ul>
			{#if total > visible.length}
				<p class="border-t p-2 text-xs text-muted-foreground">
					{total - visible.length} weitere – Suche eingrenzen.
				</p>
			{/if}
		{/if}
	</div>
</div>
