<script lang="ts">
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { EmptyState } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { can } from '$lib/sdk/client';
	import type { MyFieldDefinition, MyMember } from '../schemas';
	import ProfileMemberCard from './ProfileMemberCard.svelte';
	import { errorText, loadMyFields, loadMyMembers } from './profile-shared';

	// `userId` wird nicht gebraucht: Daten kommen über die eigenen Endpoints (Rechte serverseitig)
	let { userId: _userId }: { userId: string } = $props();

	let members = $state<MyMember[]>([]);
	let fields = $state<MyFieldDefinition[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let dirty = $state<Record<string, boolean>>({});

	const permissions = $derived((page.data.permissions as string[] | undefined) ?? []);
	const canEdit = $derived(can(permissions, 'members.own.edit'));
	const anyDirty = $derived(Object.values(dirty).some(Boolean));
	const collapsible = $derived(members.length > 3);

	async function load() {
		loading = true;
		error = null;
		try {
			[members, fields] = await Promise.all([loadMyMembers(), loadMyFields()]);
		} catch (e) {
			error = errorText(e, 'Deine Mitglieder konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}
	void load();

	beforeNavigate(({ cancel, willUnload }) => {
		if (!anyDirty) return;
		if (willUnload) {
			cancel();
			return;
		}
		if (!confirm('Du hast ungespeicherte Änderungen. Seite trotzdem verlassen?')) cancel();
	});
</script>

<svelte:window
	onbeforeunload={(e) => {
		if (anyDirty) e.preventDefault();
	}}
/>

{#if loading}
	<div class="space-y-4">
		<Skeleton class="h-40 w-full" />
		<Skeleton class="h-40 w-full" />
	</div>
{:else if error}
	<div class="space-y-3" role="alert">
		<p class="text-sm text-destructive">{error}</p>
		<Button variant="outline" size="sm" onclick={load}>Erneut versuchen</Button>
	</div>
{:else if members.length === 0}
	<EmptyState
		title="Noch kein Mitglied verknüpft"
		description="Wenn du einen Brief mit Link oder QR-Code und einem 6-stelligen Code bekommen hast, öffne den Link und gib den Code ein. Danach siehst du hier die Angaben deines Kindes."
	/>
{:else}
	<div class="space-y-6">
		{#if !canEdit}
			<p class="text-sm text-muted-foreground">
				Du kannst deine Mitglieder hier ansehen, aber nichts ändern.
			</p>
		{/if}
		{#each members as m, i (m.id)}
			<ProfileMemberCard
				member={m}
				{fields}
				{canEdit}
				{collapsible}
				startOpen={!collapsible || i === 0}
				ondirty={(d) => (dirty[m.id] = d)}
			/>
		{/each}
		<p class="text-xs text-muted-foreground">
			Noch ein Mitglied verknüpfen? Öffne den Link aus dem Brief der Stammesleitung und gib den Code
			ein.
		</p>
	</div>
{/if}
