<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { page } from '$app/state';
	import { EmptyState, SummaryList, toastWithUndo } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Switch } from '$lib/components/ui/switch';
	import { apiFetch, can } from '$lib/sdk/client';
	import type { MailCategory, MyMember } from '../schemas';
	import { MY_BASE, errorText, loadMyMembers, memberName } from './profile-shared';

	// `userId` wird nicht gebraucht: Daten kommen über die eigenen Endpoints (Rechte serverseitig)
	let { userId: _userId }: { userId: string } = $props();

	let members = $state<MyMember[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let pending = $state<Record<string, boolean>>({});
	// „Aktions-Infos“ bleiben sichtbar, sobald sie einmal als Abwahl geführt wurden (auch nach Wiedereinschalten)
	let showActionInfo = $state(false);

	const permissions = $derived((page.data.permissions as string[] | undefined) ?? []);
	const canEdit = $derived(can(permissions, 'members.own.edit'));

	const ALL: { key: MailCategory; label: string; hint: string }[] = [
		{
			key: 'payment-confirmation',
			label: 'Zahlungsbestätigung',
			hint: 'Eine Mail, wenn eine Zahlung bei uns eingegangen ist.'
		},
		{
			key: 'action-info',
			label: 'Aktions-Infos',
			hint: 'Informationen zu Aktionen und Fahrten.'
		}
	];
	// „Aktions-Infos“ nur, wenn das Backend sie schon als Abwahl führt (danach dauerhaft)
	const categories = $derived(
		ALL.filter((c) => c.key === 'payment-confirmation' || showActionInfo)
	);

	function setMembers(next: MyMember[]) {
		members = next;
		if (next.some((m) => m.mailOptOut.includes('action-info'))) showActionInfo = true;
	}
	function setOptOut(id: string, mailOptOut: MailCategory[]) {
		setMembers(members.map((m) => (m.id === id ? { ...m, mailOptOut } : m)));
	}

	const mandatory = [
		{ label: 'Rechnungen', value: 'Immer aktiv' },
		{ label: 'Jahresbeitrag', value: 'Immer aktiv' },
		{ label: 'Zahlungserinnerungen', value: 'Immer aktiv' },
		{ label: 'Anmeldebestätigungen', value: 'Immer aktiv' },
		{ label: 'Sicherheitsmails', value: 'Immer aktiv' }
	];

	async function load() {
		loading = true;
		error = null;
		try {
			setMembers(await loadMyMembers());
		} catch (e) {
			error = errorText(e, 'Deine Einstellungen konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}
	void load();

	const isOn = (m: MyMember, c: MailCategory) => !m.mailOptOut.includes(c);

	async function put(id: string, category: MailCategory, enabled: boolean) {
		const r = await apiFetch<{ mailOptOut: MailCategory[] }>(
			`${MY_BASE}/my/members/${id}/mail-prefs`,
			{ method: 'PUT', body: JSON.stringify({ category, enabled }) }
		);
		setOptOut(id, r.mailOptOut);
	}

	/**
	 * Sofort speichern: Zustand wird optimistisch gesetzt und bei Fehler explizit zurückgesetzt – nur so
	 * springt der Schalter (bits-ui hält intern einen eigenen Zustand) wieder auf den alten Stand.
	 */
	async function toggle(m: MyMember, c: (typeof ALL)[number], enabled: boolean) {
		const k = `${m.id}:${c.key}`;
		if (pending[k]) return;
		pending[k] = true;
		const previous = m.mailOptOut;
		setOptOut(
			m.id,
			enabled ? previous.filter((x) => x !== c.key) : [...new Set([...previous, c.key])]
		);
		try {
			await put(m.id, c.key, enabled);
			toastWithUndo({
				message: `${c.label} für ${m.firstName} ${enabled ? 'eingeschaltet' : 'ausgeschaltet'}`,
				undo: () => put(m.id, c.key, !enabled)
			});
		} catch (e) {
			setOptOut(m.id, previous);
			toast.error(errorText(e, 'Speichern war nicht möglich.'));
		} finally {
			pending[k] = false;
		}
	}
</script>

{#snippet sw(m: MyMember, c: (typeof ALL)[number])}
	<Switch
		checked={isOn(m, c.key)}
		disabled={!canEdit || pending[`${m.id}:${c.key}`]}
		aria-label="{c.label} für {m.firstName}"
		onCheckedChange={(v) => toggle(m, c, v)}
	/>
{/snippet}

{#if loading}
	<Skeleton class="h-40 w-full" />
{:else if error}
	<div class="space-y-3" role="alert">
		<p class="text-sm text-destructive">{error}</p>
		<Button variant="outline" size="sm" onclick={load}>Erneut versuchen</Button>
	</div>
{:else if members.length === 0}
	<EmptyState
		title="Noch kein Mitglied verknüpft"
		description="Sobald ein Mitglied mit deinem Konto verknüpft ist, kannst du hier Benachrichtigungen einstellen."
	/>
{:else}
	<div class="space-y-6">
		<p class="max-w-2xl text-sm text-muted-foreground">
			Rechnungen, Jahresbeitrag, Zahlungserinnerungen und Sicherheitsmails bekommst du immer. Sie
			lassen sich nicht abschalten.
		</p>

		<Card>
			<CardHeader><CardTitle class="font-semibold">Immer aktiv</CardTitle></CardHeader>
			<CardContent class="max-w-2xl">
				<SummaryList rows={mandatory} />
			</CardContent>
		</Card>

		<Card>
			<CardHeader><CardTitle class="font-semibold">Abschaltbar</CardTitle></CardHeader>
			<CardContent class="max-w-3xl">
				{#if !canEdit}
					<p class="mb-3 text-xs text-muted-foreground">Nur Ansicht.</p>
				{/if}

				{#if members.length === 1}
					{@const m = members[0]!}
					<ul class="divide-y">
						{#each categories as c (c.key)}
							<li class="flex items-center justify-between gap-4 py-3">
								<div class="min-w-0">
									<p class="text-sm font-medium">{c.label}</p>
									<p class="text-xs text-muted-foreground">{c.hint}</p>
								</div>
								{@render sw(m, c)}
							</li>
						{/each}
					</ul>
				{:else}
					<table class="hidden w-full text-sm sm:table">
						<thead>
							<tr class="border-b text-left">
								<th scope="col" class="py-2 pr-4 font-medium">Mail</th>
								{#each members as m (m.id)}
									<th scope="col" class="px-3 py-2 text-center font-medium">{memberName(m)}</th>
								{/each}
							</tr>
						</thead>
						<tbody class="divide-y">
							{#each categories as c (c.key)}
								<tr>
									<th scope="row" class="py-3 pr-4 text-left font-normal">
										<span class="block font-medium">{c.label}</span>
										<span class="block text-xs text-muted-foreground">{c.hint}</span>
									</th>
									{#each members as m (m.id)}
										<td class="px-3 py-3 text-center">{@render sw(m, c)}</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>

					<div class="space-y-4 sm:hidden">
						{#each members as m (m.id)}
							<div class="rounded-lg border p-3">
								<p class="mb-1 text-sm font-semibold">{memberName(m)}</p>
								<ul class="divide-y">
									{#each categories as c (c.key)}
										<li class="flex items-center justify-between gap-4 py-2">
											<span class="text-sm">{c.label}</span>
											{@render sw(m, c)}
										</li>
									{/each}
								</ul>
							</div>
						{/each}
					</div>
				{/if}
			</CardContent>
		</Card>
	</div>
{/if}
