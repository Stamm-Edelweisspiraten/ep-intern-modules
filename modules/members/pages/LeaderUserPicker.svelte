<script lang="ts">
	import Search from '@lucide/svelte/icons/search';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import UserRound from '@lucide/svelte/icons/user-round';
	import X from '@lucide/svelte/icons/x';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Input } from '$lib/components/ui/input';
	import { EntityAvatar } from '$lib/components/layout';
	import type { GroupLeaderUser, LinkUserRef } from '../schemas';

	/** Benutzerkonten als Gruppenleitung: Chips der gewählten Konten + Suche (ab 2 Zeichen) */
	let {
		id,
		value = $bindable<GroupLeaderUser[]>([]),
		max = 20,
		disabled = false,
		invalid = false
	}: {
		id: string;
		value?: GroupLeaderUser[];
		max?: number;
		disabled?: boolean;
		invalid?: boolean;
	} = $props();

	let search = $state('');
	let results = $state<LinkUserRef[]>([]);
	let searching = $state(false);
	let searchError = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	const visible = $derived(results.filter((u) => !value.some((v) => v.id === u.id)));

	function onInput() {
		clearTimeout(timer);
		const q = search.trim();
		searchError = '';
		if (q.length < 2) {
			results = [];
			searching = false;
			return;
		}
		searching = true;
		const mine = ++seq;
		timer = setTimeout(async () => {
			try {
				const found = await apiFetch<LinkUserRef[]>(
					`/modules/members/groups/leader-users?search=${encodeURIComponent(q)}`
				);
				if (mine === seq) results = found;
			} catch (e) {
				if (mine === seq) {
					results = [];
					searchError = e instanceof ApiClientError ? e.message : 'Suche fehlgeschlagen.';
				}
			} finally {
				if (mine === seq) searching = false;
			}
		}, 250);
	}

	function add(u: LinkUserRef) {
		if (value.some((v) => v.id === u.id) || value.length >= max) return;
		value = [...value, { id: u.id, name: u.name, active: true }];
		search = '';
		results = [];
	}

	function remove(userId: string) {
		value = value.filter((v) => v.id !== userId);
	}
</script>

<div class="space-y-2">
	{#if value.length}
		<ul class="flex flex-wrap gap-1.5" aria-label="Gewählte Benutzerkonten">
			{#each value as u (u.id)}
				<li
					class="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 py-0.5 pr-1 pl-2 text-sm"
				>
					<UserRound class="size-3.5 text-muted-foreground" aria-hidden="true" />
					<span class={u.active ? '' : 'text-muted-foreground'}>{u.name}</span>
					{#if !u.active}<span class="text-xs text-muted-foreground">(deaktiviert)</span>{/if}
					<button
						type="button"
						class="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
						aria-label={`${u.name} als Gruppenleitung entfernen`}
						{disabled}
						onclick={() => remove(u.id)}
					>
						<X class="size-3.5" />
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	<div class="relative">
		<Search
			class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
			aria-hidden="true"
		/>
		<Input
			{id}
			type="search"
			class="pl-8"
			bind:value={search}
			oninput={onInput}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					const first = visible[0];
					if (first) add(first);
				}
			}}
			autocomplete="off"
			placeholder="Benutzerkonto suchen (ab 2 Zeichen)"
			aria-invalid={invalid || undefined}
			disabled={disabled || value.length >= max}
		/>
	</div>
	{#if search.trim().length >= 2}
		<div class="rounded-md border" aria-live="polite">
			{#if searching}
				<p class="p-3 text-xs text-muted-foreground">Sucht …</p>
			{:else if searchError}
				<p class="p-3 text-xs text-destructive" role="alert">{searchError}</p>
			{:else if visible.length === 0}
				<p class="p-3 text-xs text-muted-foreground">Kein passendes Konto gefunden.</p>
			{:else}
				<ul class="max-h-48 divide-y overflow-y-auto">
					{#each visible as u (u.id)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:-outline-offset-2"
								onclick={() => add(u)}
							>
								<EntityAvatar name={u.name} size={28} />
								<span class="min-w-0 flex-1">
									<span class="block truncate font-medium">{u.name}</span>
									{#if u.email}
										<span class="block truncate text-xs text-muted-foreground">{u.email}</span>
									{/if}
								</span>
								<UserPlus class="size-4 text-muted-foreground" aria-hidden="true" />
								<span class="sr-only">hinzufügen</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
