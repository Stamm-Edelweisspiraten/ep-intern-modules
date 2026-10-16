<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import type { Payer } from '../schemas';

	/**
	 * Freitext für die Gegenpartei mit Vorschlägen aus den Zahlern (Name, Kontoinhaber, Kinder).
	 * Wählt man einen Zahler, wird `payerId` gesetzt; ändert man den Text danach, wird sie gelöst.
	 */
	let {
		id,
		value = $bindable(''),
		payerId = $bindable(null),
		payers,
		active = true,
		disabled = false,
		invalid = false,
		onpick
	}: {
		id: string;
		value?: string;
		payerId?: string | null;
		payers: Payer[];
		/** Vorschläge anzeigen (z. B. nur bei Einnahmen) */
		active?: boolean;
		disabled?: boolean;
		invalid?: boolean;
		onpick?: (p: Payer) => void;
	} = $props();

	let open = $state(false);

	const selected = $derived(payers.find((p) => p.id === payerId) ?? null);
	const suggestions = $derived.by(() => {
		const q = value.trim().toLowerCase();
		if (!active || q.length < 2) return [];
		return payers
			.filter((p) =>
				[p.name, p.accountHolder ?? '', ...p.members.map((m) => m.name)].some((n) =>
					n.toLowerCase().includes(q)
				)
			)
			.slice(0, 6);
	});

	function pick(p: Payer) {
		payerId = p.id;
		value = p.accountHolder ?? p.name;
		open = false;
		onpick?.(p);
	}
</script>

<div class="relative">
	<Input
		{id}
		bind:value
		maxlength={140}
		{disabled}
		autocomplete="off"
		role="combobox"
		aria-invalid={invalid}
		aria-expanded={open && suggestions.length > 0}
		aria-controls={`${id}-list`}
		aria-autocomplete="list"
		oninput={() => {
			open = true;
			if (selected && value !== (selected.accountHolder ?? selected.name)) payerId = null;
		}}
		onfocus={() => (open = true)}
		onblur={() => setTimeout(() => (open = false), 150)}
		onkeydown={(e) => {
			if (e.key === 'Escape') open = false;
		}}
	/>
	{#if open && suggestions.length}
		<ul
			id={`${id}-list`}
			role="listbox"
			class="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md"
		>
			{#each suggestions as p (p.id)}
				<li role="option" aria-selected={p.id === payerId}>
					<button
						type="button"
						class="flex w-full flex-col items-start rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
						onmousedown={(e) => e.preventDefault()}
						onclick={() => pick(p)}
					>
						<span class="font-medium">{p.name}</span>
						<span class="text-xs text-muted-foreground">
							{[p.accountHolder, p.ibanMasked, p.members.map((m) => m.name).join(', ')]
								.filter(Boolean)
								.join(' · ')}
						</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
