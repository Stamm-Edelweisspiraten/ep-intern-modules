<script lang="ts">
	import { beforeNavigate } from '$app/navigation';
	import Briefcase from '@lucide/svelte/icons/briefcase';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import type { MyOffices } from '../schemas';
	import MyBioCard from './MyBioCard.svelte';
	import NotificationPrefsCard from './NotificationPrefsCard.svelte';
	import { BASE, errorText } from './helpers';

	// `userId` wird nicht gebraucht: `/me` liefert immer die eigenen Ämter
	let { userId: _userId }: { userId: string } = $props();

	let my = $state<MyOffices | null>(null);
	let loading = $state(true);
	let error = $state('');
	let dirty = $state(false);

	async function load() {
		loading = true;
		error = '';
		try {
			my = await apiFetch<MyOffices>(`${BASE}/me`);
		} catch (e) {
			error = errorText(e, 'Deine Ämter konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}
	void load();

	beforeNavigate(({ cancel, willUnload }) => {
		if (!dirty) return;
		if (willUnload) {
			cancel();
			return;
		}
		if (!confirm('Du hast ungespeicherte Änderungen. Seite trotzdem verlassen?')) cancel();
	});
</script>

<svelte:window
	onbeforeunload={(e) => {
		if (dirty) e.preventDefault();
	}}
/>

{#if loading}
	<div class="space-y-4">
		<Skeleton class="h-24 w-full" />
		<Skeleton class="h-40 w-full" />
	</div>
{:else if error}
	<div class="space-y-3" role="alert">
		<p class="text-sm text-destructive">{error}</p>
		<Button variant="outline" size="sm" onclick={load}>Erneut versuchen</Button>
	</div>
{:else if my}
	<div class="space-y-6">
		<Card>
			<CardHeader>
				<CardTitle>Meine Ämter</CardTitle>
				<CardDescription>
					{my.offices.length > 0
						? 'Diese Ämter hast du im Stamm. Sie werden von der Stammesleitung vergeben.'
						: 'Du hast derzeit kein Amt.'}
				</CardDescription>
			</CardHeader>
			{#if my.offices.length > 0}
				<CardContent>
					<ul class="flex flex-wrap gap-2">
						{#each my.offices as o (o.id)}
							<li class="flex items-center gap-2 rounded-md border px-3 py-1.5">
								<Briefcase class="size-4 text-muted-foreground" aria-hidden="true" />
								<span class="font-medium">{o.name}</span>
							</li>
						{/each}
					</ul>
					<p class="mt-3 text-xs text-muted-foreground">
						Alle Ämter mit Inhaber*innen findest du unter <a
							href="/modules/offices"
							class="text-link underline-offset-4 hover:underline">Ämter</a
						>.
					</p>
				</CardContent>
			{/if}
		</Card>

		{#if my.canEditBio}
			<MyBioCard {my} onsaved={(next) => (my = next)} ondirty={(d) => (dirty = d)} />
		{/if}

		{#if my.offices.length > 0}
			<!-- Blendet sich selbst aus, wenn keines der eigenen Ämter aus einer Modul-Vorlage stammt -->
			<NotificationPrefsCard />
		{/if}
	</div>
{/if}
