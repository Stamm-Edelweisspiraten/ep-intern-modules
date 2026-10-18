<script lang="ts">
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import { Badge } from '$lib/components/ui/badge';
	import type { EventRef } from '../schemas';
	import { formatRefRange } from './event-format';

	/**
	 * Termine einer Galerie als Badges (Farbpunkt, Titel, Datum); `max` kürzt mit „+n“,
	 * `compact` zeigt nur den Titel (Datum im Tooltip, z. B. auf schmalen Karten).
	 */
	let {
		events,
		max,
		compact = false,
		class: className = ''
	}: { events: EventRef[]; max?: number; compact?: boolean; class?: string } = $props();

	const visible = $derived(max === undefined ? events : events.slice(0, max));
	const hidden = $derived(events.length - visible.length);
</script>

{#if events.length > 0}
	<ul class={['flex flex-wrap gap-1.5', className]} aria-label="Termine">
		{#each visible as ev (ev.id)}
			<li class="min-w-0 max-w-full">
				<Badge
					variant="outline"
					class="h-auto max-w-full gap-1.5 py-0.5"
					title={`${ev.title} · ${formatRefRange(ev)}`}
				>
					{#if ev.color}
						<span
							class="size-2 shrink-0 rounded-full"
							style:background-color={ev.color}
							aria-hidden="true"
						></span>
					{:else}
						<CalendarIcon class="size-3 shrink-0" aria-hidden="true" />
					{/if}
					<span class="truncate">{ev.title}</span>
					{#if !compact}
						<span class="text-muted-foreground shrink-0 tabular-nums">{formatRefRange(ev)}</span>
					{/if}
				</Badge>
			</li>
		{/each}
		{#if hidden > 0}
			<li>
				<Badge variant="secondary" class="h-auto py-0.5 tabular-nums">+{hidden}</Badge>
			</li>
		{/if}
	</ul>
{/if}
