<script lang="ts">
	import { untrack } from 'svelte';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import { apiFetch } from '$lib/sdk/client';
	import { Input } from '$lib/components/ui/input';
	import { FormField } from '$lib/components/layout';
	import { SelectField } from '$lib/components/ui/select-field';
	import type { AddressSuggestion, AddressSuggestions } from '../schemas';
	import { countryOptions } from './countries';

	/**
	 * Anschrift mit Autovervollständigung: Beim Tippen in „Straße und Hausnummer“ kommen Vorschläge
	 * (Straße, Nr., PLZ, Ort, Land) vom Server; wer eine auswählt, füllt alle Felder. Bei deutscher PLZ
	 * ohne Ort wird der Ort aus der mitgelieferten Liste ergänzt. Fällt der Dienst aus, bleiben es
	 * normale Eingabefelder.
	 */
	let {
		street = $bindable(''),
		postalCode = $bindable(''),
		city = $bindable(''),
		country = $bindable('DE'),
		errors = {},
		idPrefix = 'm'
	}: {
		street?: string;
		postalCode?: string;
		city?: string;
		country?: string;
		errors?: Record<string, string>;
		idPrefix?: string;
	} = $props();

	const uid = $props.id();
	const listId = `${uid}-suggestions`;

	let suggestions = $state<AddressSuggestion[]>([]);
	let open = $state(false);
	let active = $state(-1);
	let places = $state<string[]>([]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	const options = $derived(countryOptions(country));

	/** Vorschläge laden (entprellt); nur bei Eingabe durch die Person, nicht beim Befüllen. */
	function onStreetInput() {
		clearTimeout(timer);
		const q = street.trim();
		if (q.length < 3) {
			suggestions = [];
			open = false;
			return;
		}
		timer = setTimeout(async () => {
			const mine = ++seq;
			const query = [q, city.trim()].filter(Boolean).join(' ');
			try {
				const res = await apiFetch<AddressSuggestions>(
					`/modules/members/address/suggest?q=${encodeURIComponent(query)}`
				);
				if (mine !== seq) return;
				suggestions = res.items;
				active = -1;
				open = res.items.length > 0;
			} catch {
				if (mine === seq) {
					suggestions = [];
					open = false;
				}
			}
		}, 300);
	}

	function pick(s: AddressSuggestion) {
		clearTimeout(timer);
		seq++;
		street = s.street;
		if (s.postalCode) postalCode = s.postalCode;
		if (s.city) city = s.city;
		country = s.country;
		suggestions = [];
		open = false;
		places = [];
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = (active + 1) % suggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = (active - 1 + suggestions.length) % suggestions.length;
		} else if (e.key === 'Enter' && active >= 0) {
			e.preventDefault();
			pick(suggestions[active]!);
		} else if (e.key === 'Escape') {
			open = false;
		}
	}

	// Deutsche PLZ → Ort (offline)
	$effect(() => {
		const code = postalCode.trim();
		const c = country;
		untrack(() => {
			places = [];
			if (c !== 'DE' || !/^\d{5}$/.test(code)) return;
			apiFetch<{ items: string[] }>(`/modules/members/address/places?postalCode=${code}`)
				.then((r) => {
					if (postalCode.trim() !== code) return;
					if (r.items.length === 1 && !city.trim()) city = r.items[0]!;
					else places = r.items.filter((p) => p !== city);
				})
				.catch(() => {});
		});
	});
</script>

<div class="space-y-4">
	<FormField label="Straße und Hausnummer *" id={`${idPrefix}-street`} error={errors.street}>
		<div class="relative">
			<Input
				id={`${idPrefix}-street`}
				role="combobox"
				aria-expanded={open}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
				aria-invalid={!!errors.street}
				aria-describedby={errors.street ? `${idPrefix}-street-error` : undefined}
				autocomplete="off"
				bind:value={street}
				oninput={onStreetInput}
				onkeydown={onKeydown}
				onblur={() => setTimeout(() => (open = false), 120)}
				required
				maxlength={200}
			/>
			{#if open}
				<ul
					id={listId}
					role="listbox"
					aria-label="Adressvorschläge"
					class="absolute top-full right-0 left-0 z-50 mt-1 max-h-64 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
				>
					{#each suggestions as s, i (s.label)}
						<li
							id={`${listId}-${i}`}
							role="option"
							aria-selected={i === active}
							class="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm {i ===
							active
								? 'bg-accent text-accent-foreground'
								: 'hover:bg-accent/60'}"
							onmousedown={(e) => {
								e.preventDefault();
								pick(s);
							}}
						>
							<MapPin class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span class="truncate">{s.label}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</FormField>

	<div class="grid items-start gap-4 sm:grid-cols-[8rem_1fr]">
		<FormField label="PLZ *" id={`${idPrefix}-postal`} error={errors.postalCode}>
			<Input
				id={`${idPrefix}-postal`}
				bind:value={postalCode}
				inputmode={country === 'DE' ? 'numeric' : 'text'}
				autocomplete="postal-code"
				aria-invalid={!!errors.postalCode}
				aria-describedby={errors.postalCode ? `${idPrefix}-postal-error` : undefined}
				required
				maxlength={10}
			/>
		</FormField>
		<FormField label="Ort *" id={`${idPrefix}-city`} error={errors.city}>
			<Input
				id={`${idPrefix}-city`}
				bind:value={city}
				autocomplete="address-level2"
				aria-invalid={!!errors.city}
				aria-describedby={errors.city ? `${idPrefix}-city-error` : undefined}
				required
				maxlength={100}
			/>
			{#if places.length}
				<p class="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
					Ort wählen:
					{#each places as p (p)}
						<button
							type="button"
							class="rounded-md border px-1.5 py-0.5 hover:bg-accent"
							onclick={() => {
								city = p;
								places = [];
							}}>{p}</button
						>
					{/each}
				</p>
			{/if}
		</FormField>
	</div>

	<FormField label="Land *" id={`${idPrefix}-country`} error={errors.country}>
		<SelectField
			id={`${idPrefix}-country`}
			label="Land"
			{options}
			bind:value={() => country, (v) => (country = v ?? 'DE')}
		/>
	</FormField>
</div>
