<script lang="ts" module>
	/** Heutiges Datum (lokale Zeit) als `YYYY-MM-DD`. */
	export function todayIso(): string {
		const d = new Date();
		const p = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
	}

	/**
	 * Deutsches Datum → `YYYY-MM-DD`; `null` bei ungültiger Eingabe, `''` bei leerer.
	 * Akzeptiert „18.10.2026“, „18.10.26“, „1.2.26“, „18102026“, „181026“ und ISO „2026-10-18“.
	 */
	export function parseGermanDate(input: string): string | null {
		const s = input.trim();
		if (!s) return '';
		let d: number, m: number, y: number;
		let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
		if (match) {
			[y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
		} else if ((match = /^(\d{1,2})[./\-\s](\d{1,2})[./\-\s](\d{2}|\d{4})$/.exec(s))) {
			[d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
			if (match[3]!.length === 2) y += 2000;
		} else if ((match = /^(\d{2})(\d{2})(\d{2}|\d{4})$/.exec(s))) {
			[d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
			if (match[3]!.length === 2) y += 2000;
		} else return null;
		if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
		const check = new Date(Date.UTC(y, m - 1, d));
		if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
		const p = (n: number) => String(n).padStart(2, '0');
		return `${y}-${p(m)}-${p(d)}`;
	}

	/** `YYYY-MM-DD` → „TT.MM.JJJJ“ (sonst unverändert). */
	export function formatGermanDate(iso: string): string {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
		return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { Input } from '$lib/components/ui/input';

	let {
		value = $bindable(''),
		error = $bindable(''),
		id,
		invalid = false,
		describedBy,
		disabled = false,
		required = false
	}: {
		/** `YYYY-MM-DD` oder `''` */
		value?: string;
		/** Fehlertext bei ungültiger Eingabe ('' = gültig); wird hier angezeigt, solange `invalid` nicht gesetzt ist */
		error?: string;
		id: string;
		/** Fehler wird außen angezeigt */
		invalid?: boolean;
		describedBy?: string;
		disabled?: boolean;
		required?: boolean;
	} = $props();

	let focused = $state(false);
	let text = $state('');

	// Externe Änderungen (z. B. Zurücksetzen) übernehmen, solange nicht getippt wird
	$effect(() => {
		const v = value;
		// Ungültige Eingabe stehen lassen (Wert ist dann ''), damit sie korrigiert werden kann
		if (
			!focused &&
			untrack(() => parseGermanDate(text)) !== v &&
			!(v === '' && untrack(() => error))
		)
			text = formatGermanDate(v);
	});

	function oninput(e: Event & { currentTarget: HTMLInputElement }) {
		const cleaned = e.currentTarget.value.replace(/[^0-9.\-/ ]/g, '');
		text = cleaned;
		e.currentTarget.value = cleaned;
		if (error && parseGermanDate(cleaned)) error = '';
	}

	function commit() {
		focused = false;
		const parsed = parseGermanDate(text);
		if (parsed === null) {
			value = '';
			error = 'Bitte ein gültiges Datum im Format TT.MM.JJJJ eingeben';
			return;
		}
		error = parsed === '' && required ? 'Bitte ein Datum eingeben' : '';
		value = parsed;
		text = formatGermanDate(parsed);
	}

	const ownErrorId = $derived(`${id}-format-error`);
	const showOwn = $derived(!!error && !invalid);
</script>

<Input
	{id}
	type="text"
	inputmode="numeric"
	autocomplete="off"
	placeholder="TT.MM.JJJJ"
	maxlength={10}
	value={text}
	{disabled}
	aria-invalid={invalid || !!error}
	aria-describedby={showOwn ? ownErrorId : describedBy}
	onfocus={() => (focused = true)}
	{oninput}
	onblur={commit}
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Enter') commit();
	}}
/>
{#if showOwn}
	<p id={ownErrorId} role="alert" class="text-destructive text-xs">{error}</p>
{/if}
