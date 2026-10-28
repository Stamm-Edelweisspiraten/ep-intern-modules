<script lang="ts">
	// Karte „Material“ in der Übersicht: Materialreservierungen dieser Aktion, Knopf „Material reservieren“.
	// Nur über die REST-API von `material` (kein Import aus dem Modul); ohne aktives Modul/Recht/Zugriff unsichtbar.
	import { page } from '$app/state';
	import Boxes from '@lucide/svelte/icons/boxes';
	import Plus from '@lucide/svelte/icons/plus';
	import { apiFetch, can, formatDateDe } from '$lib/sdk/client';
	import { Badge, type BadgeVariant } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';

	let {
		actionId,
		actionName,
		startsOn,
		endsOn = null
	}: { actionId: string; actionName: string; startsOn: string; endsOn?: string | null } = $props();

	// Lokale Typen (Auszug aus `material/schemas.ts` – kein Import aus dem Modul, ESLint-Modulgrenze)
	type State = 'upcoming' | 'running' | 'past' | 'cancelled';
	interface MaterialReservation {
		id: string;
		title: string;
		startsOn: string;
		endsOn: string;
		state: State;
		itemSummary: string;
		mine: boolean;
	}
	interface ByAction {
		reservations: MaterialReservation[];
		canCreate: boolean;
	}

	const STATE: Record<State, { label: string; variant: BadgeVariant }> = {
		upcoming: { label: 'Reserviert', variant: 'info' },
		running: { label: 'Läuft', variant: 'warning' },
		past: { label: 'Vergangen', variant: 'secondary' },
		cancelled: { label: 'Storniert', variant: 'outline' }
	};

	// „Alle Reservierungen“ sieht nur die Verwaltung; sonst öffnet „Meine“ die Reservierung per `open`
	const canManageAll = $derived(
		can((page.data.permissions ?? []) as string[], 'material.reservation.manage')
	);
	const reservationHref = (r: MaterialReservation) =>
		`/modules/material?tab=${r.mine || !canManageAll ? 'meine' : 'alle'}&open=${r.id}`;

	let info = $state<ByAction | null>(null);

	$effect(() => {
		const id = actionId;
		let stale = false;
		apiFetch<ByAction>(`/modules/material/reservations/by-action/${id}`)
			.then((res) => {
				if (!stale) info = res;
			})
			.catch(() => {
				if (!stale) info = null; // Modul aus, kein Recht oder kein Zugriff → Karte entfällt
			});
		return () => {
			stale = true;
		};
	});

	const period = (from: string, to: string) =>
		from === to ? formatDateDe(from) : `${formatDateDe(from)} – ${formatDateDe(to)}`;

	const newHref = $derived(
		`/modules/material?${new URLSearchParams({
			action: actionId,
			from: startsOn,
			to: endsOn ?? startsOn,
			title: actionName
		})}`
	);
</script>

{#if info && (info.reservations.length || info.canCreate)}
	<Card.Root>
		<Card.Header class="flex flex-row items-center justify-between gap-2 space-y-0">
			<Card.Title class="flex items-center gap-2">
				<Boxes class="size-4 text-muted-foreground" aria-hidden="true" /> Material
			</Card.Title>
			{#if info.canCreate}
				<Button size="sm" variant="outline" href={newHref}><Plus /> Material reservieren</Button>
			{/if}
		</Card.Header>
		<Card.Content>
			{#if info.reservations.length}
				<ul class="divide-y">
					{#each info.reservations as r (r.id)}
						<li class="py-2">
							<a
								href={reservationHref(r)}
								class="flex items-start justify-between gap-2 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
							>
								<span class="min-w-0">
									<span class="block truncate font-medium">{r.title}</span>
									<span class="block text-xs text-muted-foreground tabular-nums">
										{period(r.startsOn, r.endsOn)}{r.itemSummary ? ` · ${r.itemSummary}` : ''}
									</span>
								</span>
								<Badge variant={STATE[r.state].variant} class="shrink-0">
									{STATE[r.state].label}
								</Badge>
							</a>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-muted-foreground">
					Reserviere Zelte, Kisten und Material für diese Aktion – es ist dann für andere im
					Zeitraum belegt.
				</p>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
