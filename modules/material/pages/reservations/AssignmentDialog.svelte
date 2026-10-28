<script lang="ts">
	// Zuteilung einer Typ-Position von Hand festlegen (Verwaltung): Artikel des Typs ankreuzen, vorbelegt mit
	// der aktuellen Zuteilung. Gewählte werden angeheftet, den Rest teilt das System weiter automatisch zu.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ErrorState, LoadingState } from '$lib/components/layout';
	import { cn } from '$lib/utils';
	import {
		isUsableCondition,
		type Reservation,
		type ReservationLine,
		type TypeDetail
	} from '../../schemas';
	import ConditionBadge from '../shared/ConditionBadge.svelte';
	import { API, errorText } from '../helpers';

	let {
		open = $bindable(false),
		reservationId,
		line,
		onsaved
	}: {
		open?: boolean;
		reservationId: string;
		/** Typ-Position (auch Zelt-Teil) */
		line: ReservationLine;
		onsaved: (r: Reservation) => void;
	} = $props();

	let type = $state<TypeDetail | null>(null);
	let loading = $state(true);
	let error = $state('');
	let picked = $state<string[]>([]);
	let busy = $state(false);

	async function load() {
		loading = true;
		error = '';
		try {
			type = await apiFetch<TypeDetail>(`${API}/types/${line.typeId}`);
			picked = line.assignments.map((a) => a.itemId);
		} catch (e) {
			error = errorText(e, 'Artikel konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open) untrack(() => void load());
	});

	const items = $derived(
		(type?.items ?? []).filter((i) => !i.archived && isUsableCondition(i.condition))
	);
	/** Einheiten je gewähltem Artikel: Einzelstück 1, Mengenartikel bis zur Restmenge */
	const picks = $derived.by(() => {
		let left = line.quantity;
		const out: { itemId: string; quantity: number }[] = [];
		for (const id of picked) {
			const item = items.find((i) => i.id === id);
			if (!item || left <= 0) continue;
			const current = line.assignments.find((a) => a.itemId === id)?.quantity;
			const n = Math.min(left, current ?? item.quantity);
			out.push({ itemId: id, quantity: n });
			left -= n;
		}
		return out;
	});
	const chosen = $derived(picks.reduce((n, p) => n + p.quantity, 0));
	const full = $derived(chosen >= line.quantity);

	function toggle(id: string, on: boolean) {
		picked = on ? [...picked, id] : picked.filter((x) => x !== id);
	}

	async function save() {
		busy = true;
		try {
			const r = await apiFetch<Reservation>(
				`${API}/reservations/${reservationId}/lines/${line.id}/assignment`,
				{ method: 'PUT', body: JSON.stringify({ items: picks }) }
			);
			toast.success('Zuteilung gespeichert');
			onsaved(r);
			open = false;
		} catch (e) {
			toast.error(errorText(e, 'Zuteilung konnte nicht gespeichert werden'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Zuteilung ändern</Dialog.Title>
			<Dialog.Description>
				{line.label ? `${line.label}: ` : ''}{line.quantity} × {line.name}. Gewählte Artikel werden
				fest zugeteilt, den Rest teilt das System automatisch zu.
			</Dialog.Description>
		</Dialog.Header>

		{#if loading}
			<LoadingState rows={4} />
		{:else if error}
			<ErrorState message={error} onretry={load} compact />
		{:else}
			<p class="text-sm tabular-nums" aria-live="polite">
				Gewählt: <span class="font-semibold">{chosen}</span> von {line.quantity}
			</p>
			<ul class="max-h-80 divide-y overflow-y-auto rounded-md border">
				{#each items as i (i.id)}
					{@const on = picked.includes(i.id)}
					{@const disabled = !on && full}
					<li>
						<label
							class={cn(
								'flex items-start gap-3 px-3 py-2',
								disabled ? 'opacity-60' : 'cursor-pointer hover:bg-muted/50'
							)}
						>
							<Checkbox
								class="mt-0.5"
								checked={on}
								{disabled}
								onCheckedChange={(v) => toggle(i.id, v === true)}
							/>
							<span class="min-w-0 flex-1">
								<span class="flex flex-wrap items-center gap-2">
									<span class="text-sm font-medium">{i.name}</span>
									<ConditionBadge condition={i.condition} hideOk />
								</span>
								<span class="block text-xs text-muted-foreground">
									<span class="font-mono">{i.code}</span>
									{[i.setName ? `Set ${i.setName}` : '', i.locationName ?? '']
										.filter(Boolean)
										.map((x) => ` · ${x}`)
										.join('')}
								</span>
							</span>
						</label>
					</li>
				{:else}
					<li class="px-3 py-4 text-sm text-muted-foreground">Keine nutzbaren Artikel.</li>
				{/each}
			</ul>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button disabled={busy || loading || !!error} onclick={save}>
				{busy ? 'Speichert …' : 'Speichern'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
