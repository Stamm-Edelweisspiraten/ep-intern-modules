<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
	import CheckIcon from '@lucide/svelte/icons/check';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { cn } from '$lib/utils.js';
	import { MAX_EVENTS_PER_GALLERY, type EventRef } from '../schemas';
	import { formatRefRange } from './event-format';

	/**
	 * Mehrfachauswahl von Terminen (Modul `events`) mit serverseitiger Suche.
	 * Gewählte Termine erscheinen als entfernbare Chips; `value` enthält die vollständigen `EventRef`s.
	 */
	let {
		value = $bindable<EventRef[]>([]),
		disabled = false,
		placeholder = 'Termin hinzufügen …',
		id
	}: {
		value?: EventRef[];
		disabled?: boolean;
		placeholder?: string;
		id?: string;
	} = $props();

	const uid = $props.id();
	const listId = `${uid}-list`;
	const DEBOUNCE_MS = 250;

	let open = $state(false);
	let query = $state('');
	let results = $state<EventRef[]>([]);
	let loading = $state(false);
	let failed = $state(false);
	let active = $state(0);
	let listEl: HTMLElement | null = $state(null);

	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	const selectedIds = $derived(new Set(value.map((e) => e.id)));
	const full = $derived(value.length >= MAX_EVENTS_PER_GALLERY);

	async function load(q: string) {
		const mine = ++seq;
		loading = true;
		failed = false;
		try {
			const params = new URLSearchParams({ limit: '20' });
			if (q.trim()) params.set('search', q.trim());
			const data = await apiFetch<EventRef[]>(`/modules/galleries/events?${params}`);
			if (mine !== seq) return;
			results = data;
		} catch {
			// z. B. Modul `events` inaktiv → einfach „Keine Termine gefunden“
			if (mine !== seq) return;
			results = [];
			failed = true;
		} finally {
			if (mine === seq) loading = false;
		}
		active = 0;
	}

	function schedule() {
		clearTimeout(timer);
		timer = setTimeout(() => void load(query), DEBOUNCE_MS);
	}

	function onOpenChange(next: boolean) {
		clearTimeout(timer);
		if (next) {
			query = '';
			active = 0;
			void load('');
		}
	}

	function toggle(e: EventRef) {
		if (selectedIds.has(e.id)) {
			value = value.filter((x) => x.id !== e.id);
		} else if (!full) {
			value = [...value, e];
		}
	}
	function remove(eventId: string) {
		value = value.filter((x) => x.id !== eventId);
	}

	$effect(() => {
		// Aktiven Eintrag im Sichtbereich halten
		void active;
		listEl
			?.querySelector<HTMLElement>('[data-active="true"]')
			?.scrollIntoView({ block: 'nearest' });
	});

	$effect(() => () => clearTimeout(timer));

	function onKeydown(e: KeyboardEvent) {
		const n = results.length;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (n) active = (active + 1) % n;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (n) active = (active - 1 + n) % n;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const o = results[active];
			if (o) toggle(o);
		}
	}
</script>

{#snippet dot(color: string | null)}
	<span
		class={cn('size-2.5 shrink-0 rounded-full', !color && 'bg-muted-foreground/40')}
		style={color ? `background-color: ${color}` : undefined}
		aria-hidden="true"
	></span>
{/snippet}

<div class={cn('space-y-2', disabled && 'opacity-60')} data-slot="event-picker">
	{#if value.length > 0}
		<ul class="flex flex-wrap gap-1.5" aria-label="Gewählte Termine">
			{#each value as ev (ev.id)}
				<li
					class="bg-secondary text-secondary-foreground inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 pr-0.5 pl-2 text-xs"
				>
					{@render dot(ev.color)}
					<span class="min-w-0 truncate">
						<span class="font-medium">{ev.title}</span>
						<span class="text-muted-foreground tabular-nums">· {formatRefRange(ev)}</span>
					</span>
					<button
						type="button"
						{disabled}
						aria-label={`${ev.title} entfernen`}
						class="hover:bg-foreground/10 focus-visible:ring-ring/50 inline-flex size-5 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2"
						onclick={() => remove(ev.id)}
					>
						<XIcon class="size-3" />
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	<Popover.Root bind:open {onOpenChange}>
		<Popover.Trigger
			{id}
			{disabled}
			role="combobox"
			aria-label="Termine auswählen"
			aria-expanded={open}
			aria-haspopup="listbox"
			aria-controls={open ? listId : undefined}
			class="border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 text-muted-foreground flex min-h-8 w-full items-center gap-2 rounded-lg border bg-transparent px-2.5 text-left text-sm outline-none focus-visible:ring-3 disabled:pointer-events-none"
		>
			<CalendarPlus class="size-4 shrink-0" />
			<span class="truncate">{placeholder}</span>
		</Popover.Trigger>
		<Popover.Content class="w-[min(22rem,calc(100vw-2rem))] p-0" align="start">
			<div class="flex items-center gap-2 border-b px-2.5">
				<SearchIcon class="text-muted-foreground size-4 shrink-0" />
				<!-- svelte-ignore a11y_autofocus -->
				<input
					type="text"
					role="combobox"
					aria-label="Termine suchen"
					aria-expanded="true"
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={results[active] ? `${uid}-opt-${results[active]!.id}` : undefined}
					autocomplete="off"
					autofocus
					placeholder="Termine suchen …"
					bind:value={query}
					oninput={schedule}
					onkeydown={onKeydown}
					class="placeholder:text-muted-foreground h-9 w-full bg-transparent text-sm outline-none"
				/>
			</div>
			<div
				bind:this={listEl}
				id={listId}
				role="listbox"
				tabindex="-1"
				aria-multiselectable="true"
				aria-label="Termine"
				aria-busy={loading}
				class="max-h-64 overflow-y-auto p-1"
			>
				{#each results as ev, i (ev.id)}
					{@const checked = selectedIds.has(ev.id)}
					{@const blocked = !checked && full}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						id={`${uid}-opt-${ev.id}`}
						role="option"
						aria-selected={checked}
						aria-disabled={blocked}
						data-active={i === active}
						tabindex="-1"
						class={cn(
							'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm select-none',
							i === active && 'bg-accent text-accent-foreground',
							blocked && 'cursor-not-allowed opacity-50'
						)}
						onpointermove={() => (active = i)}
						onmousedown={(e) => e.preventDefault()}
						onclick={() => toggle(ev)}
					>
						<span
							class={cn(
								'border-input mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
								checked && 'bg-primary text-primary-foreground border-primary'
							)}
							aria-hidden="true"
						>
							{#if checked}<CheckIcon class="size-3.5" />{/if}
						</span>
						<span class="min-w-0 flex-1">
							<span class="flex items-center gap-1.5">
								{@render dot(ev.color)}
								<span class="truncate">{ev.title}</span>
							</span>
							<span class="text-muted-foreground block text-xs tabular-nums">
								{formatRefRange(ev)}
							</span>
						</span>
					</div>
				{:else}
					<p class="text-muted-foreground px-2 py-4 text-center text-sm">
						{loading ? 'Sucht …' : 'Keine Termine gefunden'}
					</p>
				{/each}
			</div>
			<div
				class="text-muted-foreground flex items-center justify-between gap-2 border-t px-2.5 py-1.5 text-xs"
			>
				<span aria-live="polite">
					{#if full}
						Höchstens {MAX_EVENTS_PER_GALLERY} Termine
					{:else if failed}
						Termine nicht verfügbar
					{:else}
						{value.length} ausgewählt
					{/if}
				</span>
				{#if loading && results.length > 0}<span>Sucht …</span>{/if}
			</div>
		</Popover.Content>
	</Popover.Root>
	{#if full}
		<p class="text-muted-foreground text-xs">
			Es sind höchstens {MAX_EVENTS_PER_GALLERY} Termine möglich.
		</p>
	{/if}
</div>
