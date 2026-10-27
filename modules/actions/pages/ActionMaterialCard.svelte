<script lang="ts">
	// Karte „Material“ in der Übersicht: Materialreservierungen dieser Aktion, Knopf „Material reservieren“.
	// Nur über die REST-API von `material` (kein Import aus dem Modul); ohne aktives Modul/Recht/Zugriff unsichtbar.
	import Boxes from '@lucide/svelte/icons/boxes';
	import Plus from '@lucide/svelte/icons/plus';
	import { apiFetch, formatDateDe } from '$lib/sdk/client';
	import { Badge, type BadgeVariant } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';

	let {
		actionId,
		actionName,
		startsOn,
		endsOn = null
	}: { actionId: string; actionName: string; startsOn: string; endsOn?: string | null } = $props();

	type Status = 'reserved' | 'issued' | 'returned' | 'cancelled';
	interface MaterialReservation {
		id: string;
		title: string;
		startsOn: string;
		endsOn: string;
		status: Status;
		itemSummary: string;
		overdue: boolean;
	}
	interface ByAction {
		reservations: MaterialReservation[];
		canCreate: boolean;
	}

	const STATUS: Record<Status, { label: string; variant: BadgeVariant }> = {
		reserved: { label: 'Reserviert', variant: 'info' },
		issued: { label: 'Ausgegeben', variant: 'warning' },
		returned: { label: 'Zurückgegeben', variant: 'secondary' },
		cancelled: { label: 'Storniert', variant: 'outline' }
	};

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
			tab: 'reservations',
			newFor: actionId,
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
								href={`/modules/material?tab=reservations&open=${r.id}`}
								class="flex items-start justify-between gap-2 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
							>
								<span class="min-w-0">
									<span class="block truncate font-medium">{r.title}</span>
									<span class="block text-xs text-muted-foreground tabular-nums">
										{period(r.startsOn, r.endsOn)}{r.itemSummary ? ` · ${r.itemSummary}` : ''}
									</span>
								</span>
								{#if r.overdue}
									<Badge variant="destructive" class="shrink-0">Überfällig</Badge>
								{:else}
									<Badge variant={STATUS[r.status].variant} class="shrink-0">
										{STATUS[r.status].label}
									</Badge>
								{/if}
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
