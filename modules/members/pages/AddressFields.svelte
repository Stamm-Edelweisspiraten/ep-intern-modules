<script lang="ts" module>
	import type { AddressSuggestions as Result } from '../schemas';

	/**
	 * Vorschläge je Straßenname (ohne Hausnummer), für alle Adressfelder der Sitzung (5 min).
	 * `number` = Hausnummer, mit der die Vorschläge geladen wurden (wird beim Anzeigen getauscht).
	 */
	const cache = new Map<string, { at: number; number: string; value: Result }>();
	const CACHE_MS = 5 * 60_000;
	/** Mindestabstand zwischen zwei Anfragen */
	const MIN_GAP_MS = 250;
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Users from '@lucide/svelte/icons/users';
	import { apiFetch } from '$lib/sdk/client';
	import { Input } from '$lib/components/ui/input';
	import { FormField } from '$lib/components/layout';
	import { SelectField } from '$lib/components/ui/select-field';
	import type { AddressSuggestion } from '../schemas';
	import { matchesStreetName, splitHouseNumber, withHouseNumber } from '../address-utils';
	import { countryOptions } from './countries';

	/**
	 * Anschrift mit Autovervollständigung: Beim Tippen in „Straße und Hausnummer“ kommen Vorschläge
	 * (Straße, Nr., PLZ, Ort, Land) vom Server – zuerst vorhandene Mitglieder-Anschriften, dann das
	 * Straßenverzeichnis (Region der eingegebenen PLZ bzw. des Stamms zuerst); wer eine auswählt,
	 * füllt alle Felder. Geladen wird schon während des Tippens (höchstens eine Anfrage gleichzeitig,
	 * Abstand ≥ 250 ms); die Hausnummer wird ohne neue Anfrage eingesetzt. Bei deutscher PLZ ohne Ort
	 * wird der Ort aus der mitgelieferten Liste ergänzt. Fällt der Dienst aus, bleiben es normale
	 * Eingabefelder.
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
	let loading = $state(false);
	/** Läuft gerade eine Anfrage? Neue Eingaben warten darauf (höchstens eine Anfrage gleichzeitig). */
	let busy = false;
	let lastStart = 0;
	let seq = 0;

	const options = $derived(countryOptions(country));

	function currentQuery() {
		const q = street.trim().replace(/\s+/g, ' ');
		const plz = postalCode.trim();
		const { name, number } = splitHouseNumber(q);
		return { q, plz, number, key: `${name.toLowerCase()}|${plz.slice(0, 2)}|${country}` };
	}

	/**
	 * Vorschläge mit der aktuell getippten Hausnummer anzeigen. Antworten zu einer älteren, kürzeren
	 * Eingabe werden auf Straßen gefiltert, die noch zur aktuellen passen (nichts Veraltetes zeigen).
	 */
	function show(res: Result, fetchedNumber: string, number: string, q: string) {
		const lower = q.toLowerCase();
		const { name } = splitHouseNumber(q);
		const items: AddressSuggestion[] = [];
		for (const s of res.items) {
			if (s.source === 'members') {
				// Vorhandene Anschriften nur, wenn sie zur Eingabe passen (inkl. Nummer)
				if (s.street.toLowerCase().startsWith(lower)) items.push(s);
				continue;
			}
			// Photon findet auch Tippfehler („Rockwinkeler“) – nur Verzeichnis-Treffer filtern
			if (s.source === 'directory' && !matchesStreetName(s.street, name)) continue;
			const street = withHouseNumber(s.street, fetchedNumber, number);
			const place = [s.postalCode, s.city].filter(Boolean).join(' ');
			items.push({ ...s, street, label: [street, place].filter(Boolean).join(', ') });
		}
		suggestions = items;
		active = -1;
		open = items.length > 0;
	}

	function fromCache(): boolean {
		const { q, number, key } = currentQuery();
		const hit = cache.get(key);
		if (!hit || Date.now() - hit.at >= CACHE_MS) return false;
		seq++;
		loading = false;
		show(hit.value, hit.number, number, q);
		return true;
	}

	/**
	 * Vorschläge schon während des Tippens laden (nicht erst nach einer Pause). So liegt ein kurzer
	 * Anfang (z. B. „Schwachh“) schon im Server-Zwischenspeicher, und die längere Eingabe wird dort nur
	 * noch gefiltert; nur die Hausnummer zu ändern fragt gar nicht neu.
	 */
	function onStreetInput() {
		const { q } = currentQuery();
		if (q.length < 3) {
			seq++;
			suggestions = [];
			open = false;
			loading = false;
			return;
		}
		if (fromCache()) return;
		loading = true;
		if (!busy) void fetchCurrent();
	}

	async function fetchCurrent() {
		busy = true;
		const wait = MIN_GAP_MS - (Date.now() - lastStart);
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		const { q, plz, number, key } = currentQuery();
		if (q.length < 3 || !loading) {
			busy = false;
			return;
		}
		lastStart = Date.now();
		const mine = ++seq;
		const params = new URLSearchParams({ q });
		if (plz) params.set('postalCode', plz);
		if (country) params.set('country', country);
		try {
			const res = await apiFetch<Result>(`/modules/members/address/suggest?${params}`);
			if (!res.unavailable) cache.set(key, { at: Date.now(), number, value: res });
			if (mine === seq) show(res, number, currentQuery().number, currentQuery().q);
		} catch {
			if (mine === seq) {
				suggestions = [];
				open = false;
			}
		} finally {
			busy = false;
		}
		// Eingabe hat sich während der Anfrage geändert und wartet (`loading`) → aktuelle nachladen
		const now = currentQuery();
		if (loading && now.key !== key && now.q.length >= 3) {
			if (!fromCache()) void fetchCurrent();
		} else if (loading && now.key === key) {
			fromCache();
			loading = false;
		} else if (mine === seq) loading = false;
	}

	function pick(s: AddressSuggestion) {
		seq++;
		loading = false;
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
				class="pr-8"
			/>
			{#if loading}
				<LoaderCircle
					class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
					aria-label="Sucht Adressen …"
				/>
			{/if}
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
							{#if s.source === 'members'}
								<Users class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							{:else}
								<MapPin class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							{/if}
							<span class="min-w-0 flex-1 truncate">{s.label}</span>
							{#if s.source === 'members'}
								<span class="shrink-0 text-xs text-muted-foreground">bei Mitgliedern</span>
							{/if}
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
