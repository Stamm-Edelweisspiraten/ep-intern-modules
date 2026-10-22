<script lang="ts">
	import Bell from '@lucide/svelte/icons/bell';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Switch } from '$lib/components/ui/switch';
	import { ErrorState, LoadingState } from '$lib/components/layout';
	import type { InboxEvent, MyInboxNotifications } from '../schemas';
	import { BASE, errorText } from './helpers';

	/**
	 * Profil: Benachrichtigungen zum Posteingang je Postfach – „Neue Nachricht“ (mit Inhalt) und in
	 * gemeinsamen Postfächern „Jemand anderes hat geantwortet“. Speichert sofort (optimistisch, bei
	 * Fehler zurückgesetzt). Ohne Postfach wird die Karte nicht angezeigt.
	 */

	// Profil-Abschnitte bekommen `userId`; die Karte zeigt immer die eigenen Einstellungen
	let { userId: _userId }: { userId: string } = $props();
	const uid = $props.id();

	let data = $state<MyInboxNotifications | null>(null);
	let loading = $state(true);
	let error = $state('');
	let saving = $state<Record<string, boolean>>({});

	async function load() {
		loading = true;
		error = '';
		try {
			data = await apiFetch<MyInboxNotifications>(`${BASE}/me/notifications`);
		} catch (e) {
			error = errorText(e, 'Benachrichtigungen konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}
	void load();

	function setLocal(mailbox: string, event: InboxEvent, enabled: boolean) {
		const e = data?.mailboxes.find((m) => m.key === mailbox)?.events.find((x) => x.event === event);
		if (e) e.enabled = enabled;
	}

	async function change(mailbox: string, event: InboxEvent, enabled: boolean) {
		const key = `${mailbox}|${event}`;
		setLocal(mailbox, event, enabled);
		saving[key] = true;
		try {
			data = await apiFetch<MyInboxNotifications>(`${BASE}/me/notifications`, {
				method: 'PUT',
				body: JSON.stringify({ mailbox, event, enabled })
			});
			toast.success('Gespeichert');
		} catch (e) {
			setLocal(mailbox, event, !enabled);
			toast.error(errorText(e, 'Die Einstellung konnte nicht gespeichert werden.'));
		} finally {
			saving[key] = false;
		}
	}
</script>

{#if loading}
	<LoadingState label="Lädt …" rows={2} />
{:else if error}
	<ErrorState message={error} onretry={load} compact />
{:else if data && data.mailboxes.length}
	<Card>
		<CardHeader>
			<CardTitle level={2} class="flex items-center gap-2">
				<Bell class="size-4" /> Benachrichtigungen zum Posteingang
			</CardTitle>
			<CardDescription>
				{#if data.email}
					Per E-Mail an {data.email}, wenn in deinen Postfächern etwas Neues ankommt.
				{:else}
					Deinem Konto ist keine E-Mail-Adresse zugeordnet.
				{/if}
			</CardDescription>
		</CardHeader>
		<CardContent>
			<ul class="divide-y">
				{#each data.mailboxes as m (m.key)}
					<li class="space-y-2 py-3 first:pt-0 last:pb-0">
						<p class="text-sm font-medium">
							{m.name}
							<span class="font-normal text-muted-foreground">({m.address})</span>
						</p>
						<div class="space-y-2">
							{#each m.events as e (e.event)}
								{@const id = `${uid}-${m.key}-${e.event}`}
								<div class="flex items-center justify-between gap-4">
									<label for={id} class="text-sm">{e.label}</label>
									<Switch
										{id}
										checked={e.enabled}
										disabled={saving[`${m.key}|${e.event}`]}
										onCheckedChange={(v) => change(m.key, e.event, v)}
									/>
								</div>
							{/each}
						</div>
					</li>
				{/each}
			</ul>
		</CardContent>
	</Card>
{/if}
