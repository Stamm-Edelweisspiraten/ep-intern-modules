<script lang="ts">
	// Dashboard-Kachel „Meine Mitglieder“: verknüpfte Mitglieder mit Gruppen und nächstem Geburtstag.
	import { onMount } from 'svelte';
	import Users from '@lucide/svelte/icons/users';
	import Cake from '@lucide/svelte/icons/cake';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import type { MyMember } from '../../schemas';

	let { onstatus }: DashboardWidgetProps = $props();

	const MAX = 5;
	/** Geburtstage in so vielen Tagen oder weniger werden hervorgehoben */
	const SOON_DAYS = 14;

	interface Birthday {
		/** Tage bis zum nächsten Geburtstag (0 = heute) */
		days: number;
		/** Alter an diesem Geburtstag */
		age: number;
		/** `TT.MM.` */
		label: string;
	}

	let members = $state<MyMember[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			members = await apiFetch<MyMember[]>('/modules/members/my/members');
			onstatus?.(members.length ? 'ready' : 'empty');
		} catch (e) {
			error =
				e instanceof ApiClientError && e.message
					? e.message
					: 'Mitglieder konnten nicht geladen werden.';
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	/** Nächster Geburtstag ab heute (lokal); 29.02. zählt in Nicht-Schaltjahren am 28.02. */
	function nextBirthday(birthDate: string, now = new Date()): Birthday | null {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
		if (!m) return null;
		const by = Number(m[1]);
		const bm = Number(m[2]) - 1;
		const bd = Number(m[3]);
		const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
		const at = (year: number) => {
			const last = new Date(Date.UTC(year, bm + 1, 0)).getUTCDate();
			return Date.UTC(year, bm, Math.min(bd, last));
		};
		let year = now.getFullYear();
		if (at(year) < today) year += 1;
		const date = new Date(at(year));
		const days = Math.round((date.getTime() - today) / 86_400_000);
		const dd = String(date.getUTCDate()).padStart(2, '0');
		const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
		return { days, age: year - by, label: `${dd}.${mm}.` };
	}

	function birthdayText(b: Birthday): string {
		if (b.days === 0) return `Heute Geburtstag (${b.age})`;
		if (b.days === 1) return `Morgen Geburtstag (${b.age})`;
		return `Geburtstag in ${b.days} Tagen (${b.label}, wird ${b.age})`;
	}

	const rows = $derived(
		members.slice(0, MAX).map((m) => ({ member: m, birthday: nextBirthday(m.birthDate) }))
	);
	const more = $derived(Math.max(0, members.length - MAX));
</script>

<DashboardCard
	title="Meine Mitglieder"
	icon={Users}
	href="/profile"
	hrefLabel="Im Profil bearbeiten"
	{loading}
	{error}
	onretry={load}
	empty={!members.length}
	emptyText="Mit deinem Konto ist kein Mitglied verknüpft."
	skeletonRows={2}
>
	<ul class="divide-y">
		{#each rows as { member: m, birthday: b } (m.id)}
			{@const soon = !!b && b.days <= SOON_DAYS}
			<li class="py-2">
				<p class="truncate font-medium">
					{m.firstName}
					{m.lastName}{#if m.scoutName}
						<span class="font-normal text-muted-foreground"> ({m.scoutName})</span>{/if}
				</p>
				{#if m.groups.length}
					<p class="truncate text-xs text-muted-foreground">
						{m.groups.map((g) => g.name).join(', ')}
					</p>
				{/if}
				{#if b}
					<p
						class={[
							'mt-0.5 flex items-center gap-1 text-xs',
							soon ? 'font-medium text-primary' : 'text-muted-foreground'
						]}
					>
						<Cake class="size-3.5 shrink-0" aria-hidden="true" />
						{birthdayText(b)}
					</p>
				{/if}
			</li>
		{/each}
	</ul>
	{#if more}
		<p class="pt-1 text-xs text-muted-foreground">und {more} weitere</p>
	{/if}
</DashboardCard>
