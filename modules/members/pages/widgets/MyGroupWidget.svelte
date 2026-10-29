<script lang="ts">
	// Dashboard-Kachel „Meine Gruppe“ (Gruppenleitung): je geleiteter Gruppe Mitgliederzahl, nächste
	// Gruppenstunde und Geburtstage der nächsten 14 Tage.
	import { onMount } from 'svelte';
	import UsersRound from '@lucide/svelte/icons/users-round';
	import Cake from '@lucide/svelte/icons/cake';
	import Clock from '@lucide/svelte/icons/clock';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import type { LedGroupBirthday, LedGroupOverview, LedGroupSummary } from '../../schemas';

	let { onstatus }: DashboardWidgetProps = $props();

	const WEEKDAYS = [
		'Montag',
		'Dienstag',
		'Mittwoch',
		'Donnerstag',
		'Freitag',
		'Samstag',
		'Sonntag'
	] as const;

	let overview = $state<LedGroupOverview | null>(null);
	let loading = $state(true);
	let error = $state('');

	const groups = $derived(overview?.groups ?? []);

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			overview = await apiFetch<LedGroupOverview>('/modules/members/led/overview');
			onstatus?.(overview.groups.length ? 'ready' : 'empty');
		} catch (e) {
			error =
				e instanceof ApiClientError && e.message
					? e.message
					: 'Gruppen konnten nicht geladen werden.';
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	/** `TT.MM.` aus `YYYY-MM-DD` */
	const dayMonth = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;

	function meetingText(g: LedGroupSummary): string {
		if (!g.meetingWeekday) return 'Keine feste Gruppenstunde';
		const time = g.meetingTime
			? g.meetingEndTime
				? `${g.meetingTime}–${g.meetingEndTime}`
				: `${g.meetingTime} Uhr`
			: '';
		const when = [WEEKDAYS[g.meetingWeekday - 1], time].filter(Boolean).join(', ');
		if (!g.nextMeeting || !overview) return when;
		if (g.nextMeeting === overview.today) return time ? `Heute, ${time}` : 'Heute';
		return `${when} (${dayMonth(g.nextMeeting)})`;
	}

	function birthdayText(b: LedGroupBirthday): string {
		const name = b.scoutName ? `${b.firstName} (${b.scoutName})` : `${b.firstName} ${b.lastName}`;
		const when =
			b.days === 0 ? 'heute' : b.days === 1 ? 'morgen' : `in ${b.days} Tagen (${dayMonth(b.date)})`;
		return `${name} wird ${b.age} – ${when}`;
	}

	const countText = (n: number) => (n === 1 ? '1 Mitglied' : `${n} Mitglieder`);
	const membersHref = (id: string) => `/modules/members?${new URLSearchParams({ groupId: id })}`;
</script>

<DashboardCard
	title={groups.length > 1 ? 'Meine Gruppen' : 'Meine Gruppe'}
	icon={UsersRound}
	href="/modules/members"
	hrefLabel="Mitglieder"
	{loading}
	{error}
	onretry={load}
	empty={!groups.length}
	emptyText="Du leitest keine Gruppe."
	skeletonRows={2}
>
	<ul class="divide-y">
		{#each groups as g (g.id)}
			<li class="py-2">
				<div class="flex items-baseline justify-between gap-2">
					<a
						href={membersHref(g.id)}
						class="truncate font-medium underline-offset-4 hover:underline"
					>
						{g.name}
					</a>
					<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
						{countText(g.memberCount)}
					</span>
				</div>
				<p class="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
					<Clock class="size-3.5 shrink-0" aria-hidden="true" />
					<span class="truncate">{meetingText(g)}</span>
				</p>
				{#each g.birthdays as b (b.memberId)}
					<p
						class={[
							'mt-0.5 flex items-center gap-1 text-xs',
							b.days <= 1 ? 'font-medium text-link' : 'text-muted-foreground'
						]}
					>
						<Cake class="size-3.5 shrink-0" aria-hidden="true" />
						<span class="truncate">{birthdayText(b)}</span>
					</p>
				{/each}
			</li>
		{/each}
	</ul>
</DashboardCard>
