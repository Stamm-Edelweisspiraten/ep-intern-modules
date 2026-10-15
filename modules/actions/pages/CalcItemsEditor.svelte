<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { MoneyInput } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		CALC_BASES,
		CALC_BASIS_LABELS,
		CALC_CATEGORY_LABELS,
		CALC_GROUPS,
		type CalcBasis,
		MAX_CALC_ITEMS,
		type CalcCategory,
		type CalcItem,
		type CalculationResult
	} from '../schemas';

	let {
		items = $bindable(),
		result,
		disabled = false
	}: {
		items: CalcItem[];
		result: CalculationResult;
		disabled?: boolean;
	} = $props();

	const basisOptions = CALC_BASES.map((b) => ({ value: b, label: CALC_BASIS_LABELS[b] }));
	const totals = $derived(new Map(result.lines.map((l) => [l.id, l.totalCents])));
	const atLimit = $derived(items.length >= MAX_CALC_ITEMS);

	function newId() {
		return typeof crypto !== 'undefined' && 'randomUUID' in crypto
			? crypto.randomUUID()
			: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	function inGroup(groupId: string) {
		const g = CALC_GROUPS.find((x) => x.id === groupId);
		return items.filter((i) => g?.categories.includes(i.category));
	}

	function groupTotal(groupId: string) {
		return inGroup(groupId).reduce((s, i) => s + (totals.get(i.id) ?? 0), 0);
	}

	function add(groupId: string, category?: CalcCategory) {
		const g = CALC_GROUPS.find((x) => x.id === groupId);
		if (!g || atLimit) return;
		const cat = category ?? g.categories[0] ?? 'other';
		items.push({
			id: newId(),
			category: cat,
			label: CALC_CATEGORY_LABELS[cat],
			amountCents: 0,
			basis: g.defaultBasis
		});
	}

	function remove(item: CalcItem) {
		const idx = items.findIndex((i) => i.id === item.id);
		if (idx < 0) return;
		const copy = { ...item };
		items.splice(idx, 1);
		toast(`„${copy.label || 'Posten'}“ entfernt`, {
			action: {
				label: 'Rückgängig',
				onClick: () => {
					items.splice(Math.min(idx, items.length), 0, copy);
				}
			}
		});
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Kosten</Card.Title>
		<Card.Description
			>Wähle je Posten, ob einmalig, pro Person oder pro Person und Nacht gerechnet wird.</Card.Description
		>
	</Card.Header>
	<Card.Content class="flex flex-col gap-6">
		{#each CALC_GROUPS as g (g.id)}
			{@const rows = inGroup(g.id)}
			<section class="flex flex-col" aria-label={g.label}>
				<div class="flex items-baseline justify-between gap-3 border-b pb-1.5">
					<h3
						class="text-muted-foreground min-w-0 truncate text-xs font-semibold tracking-wide uppercase"
					>
						{g.label}
					</h3>
					<span class="shrink-0 text-sm font-semibold tabular-nums">
						{formatEuro(groupTotal(g.id))}
					</span>
				</div>
				{#if rows.length === 0}
					<p class="text-muted-foreground py-2 text-xs">Noch keine Posten.</p>
				{/if}
				{#each rows as item (item.id)}
					<div
						class="grid grid-cols-[minmax(0,1fr)_auto_2rem] items-center gap-x-2 gap-y-1.5 border-b border-dashed py-1.5 last:border-b-0 sm:min-h-11 sm:grid-cols-[minmax(0,1fr)_7.5rem_13.5rem_5.5rem_2rem]"
					>
						<Input
							class="col-span-full sm:col-span-1"
							bind:value={item.label}
							aria-label="Bezeichnung"
							maxlength={100}
							{disabled}
							aria-invalid={item.label.trim() === '' || undefined}
						/>
						<div class="flex min-w-0 items-center gap-2 sm:contents">
							<MoneyInput
								class="w-28 min-w-0 shrink-0 sm:w-auto"
								bind:cents={item.amountCents}
								label={`Betrag für ${item.label || 'Posten'}`}
								{disabled}
								max={100_000_000}
							/>
							<SelectField
								class="min-w-0 flex-1 sm:w-auto sm:min-w-0"
								size="sm"
								label={`Einheit für ${item.label || 'Posten'}`}
								value={item.basis}
								{disabled}
								options={basisOptions}
								onchange={(v) => v && (item.basis = v as CalcBasis)}
							/>
						</div>
						<div class="text-right text-sm font-medium tabular-nums">
							{formatEuro(totals.get(item.id) ?? 0)}
						</div>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`${item.label || 'Posten'} entfernen`}
							{disabled}
							onclick={() => remove(item)}
						>
							<Trash2 />
						</Button>
						{#if g.id === 'program' && (item.amountCents ?? 0) >= 0}
							<p class="text-muted-foreground col-span-full text-xs tabular-nums">
								≙ {formatEuro(result.programPerPersonCents)} pro Person (aufgerundet)
							</p>
						{/if}
					</div>
				{/each}
				<div class="pt-2">
					{#if g.categories.length > 1}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger disabled={disabled || atLimit}>
								{#snippet child({ props })}
									<Button {...props} variant="ghost" size="sm" disabled={disabled || atLimit}>
										<Plus /> Posten hinzufügen <ChevronDown />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="start">
								{#each g.categories as c (c)}
									<DropdownMenu.Item onSelect={() => add(g.id, c)}>
										{CALC_CATEGORY_LABELS[c]}
									</DropdownMenu.Item>
								{/each}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{:else}
						<Button
							variant="ghost"
							size="sm"
							disabled={disabled || atLimit}
							onclick={() => add(g.id)}
						>
							<Plus /> Posten hinzufügen
						</Button>
					{/if}
				</div>
			</section>
		{/each}
	</Card.Content>
</Card.Root>
