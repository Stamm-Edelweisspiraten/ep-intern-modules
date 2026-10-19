<script lang="ts">
	import Bell from '@lucide/svelte/icons/bell';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { SelectField, type SelectFieldOption } from '$lib/components/ui/select-field';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		NOTIFY_MODES,
		NOTIFY_MODE_LABELS,
		type MyNotifications,
		type NotifyMode
	} from '../schemas';
	import { BASE, errorText } from './helpers';

	/**
	 * Benachrichtigungen der eigenen Vorlagen-Ämter (z. B. „Kasse“ aus `treasury`): Modus je Ereignis
	 * (Sofort / Täglich / Aus). Jede Änderung wird sofort gespeichert (optimistisch, bei Fehler
	 * zurückgesetzt). Ohne Vorlagen-Ämter wird die Karte nicht angezeigt.
	 */

	const MODE_OPTIONS: SelectFieldOption[] = NOTIFY_MODES.map((m) => ({
		value: m,
		label: NOTIFY_MODE_LABELS[m]
	}));

	const uid = $props.id();

	let data = $state<MyNotifications | null>(null);
	let loading = $state(true);
	let error = $state('');
	/** Schlüssel der gerade gespeicherten Ereignisse (`modul:amt:ereignis`) */
	let saving = $state<Record<string, boolean>>({});

	async function load() {
		loading = true;
		error = '';
		try {
			data = await apiFetch<MyNotifications>(`${BASE}/me/notifications`);
		} catch (e) {
			error = errorText(e, 'Benachrichtigungen konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}
	void load();

	function keyOf(module: string, office: string, event: string) {
		return `${module}:${office}:${event}`;
	}

	function setMode(module: string, office: string, event: string, mode: NotifyMode) {
		if (!data) return;
		for (const o of data.offices) {
			if (o.module !== module || o.officeKey !== office) continue;
			for (const e of o.events) if (e.key === event) e.mode = mode;
		}
	}

	async function change(module: string, office: string, event: string, value: string | null) {
		if (!data || !value || !(NOTIFY_MODES as readonly string[]).includes(value)) return;
		const mode = value as NotifyMode;
		const previous = data.offices
			.find((o) => o.module === module && o.officeKey === office)
			?.events.find((e) => e.key === event)?.mode;
		if (!previous || previous === mode) return;
		const key = keyOf(module, office, event);
		setMode(module, office, event, mode);
		saving[key] = true;
		try {
			data = await apiFetch<MyNotifications>(`${BASE}/me/notifications`, {
				method: 'PUT',
				body: JSON.stringify({ module, office, event, mode })
			});
			toast.success('Gespeichert');
		} catch (e) {
			setMode(module, office, event, previous);
			toast.error(errorText(e, 'Einstellung konnte nicht gespeichert werden'));
		} finally {
			saving[key] = false;
		}
	}
</script>

{#if loading}
	<Skeleton class="h-32 w-full" />
{:else if error}
	<Card>
		<CardHeader>
			<CardTitle>Benachrichtigungen</CardTitle>
		</CardHeader>
		<CardContent class="space-y-3" role="alert">
			<p class="text-sm text-destructive">{error}</p>
			<Button variant="outline" size="sm" onclick={load}>Erneut versuchen</Button>
		</CardContent>
	</Card>
{:else if data && data.offices.length > 0}
	<Card>
		<CardHeader>
			<CardTitle>Benachrichtigungen</CardTitle>
			<CardDescription>
				{#if data.email}
					Gehen an deine Konto-Adresse <span class="font-medium text-foreground">{data.email}</span
					>. „Täglich“ fasst alle Ereignisse eines Tages in einer Mail zusammen.
				{:else}
					Für dein Konto ist keine E-Mail-Adresse hinterlegt – Benachrichtigungen können dir derzeit
					nicht zugestellt werden.
				{/if}
			</CardDescription>
		</CardHeader>
		<CardContent class="space-y-6">
			{#each data.offices as o (o.officeId)}
				<section aria-labelledby="{uid}-{o.officeId}" class="space-y-3">
					<h3 id="{uid}-{o.officeId}" class="flex items-center gap-2 text-sm font-semibold">
						<Bell class="size-4 text-muted-foreground" aria-hidden="true" />
						<span>
							{o.officeName}
							<span class="font-normal text-muted-foreground">(aus Modul {o.moduleName})</span>
						</span>
					</h3>
					{#if o.events.length === 0}
						<p class="text-sm text-muted-foreground">Für dieses Amt gibt es keine Ereignisse.</p>
					{:else}
						<ul class="divide-y rounded-md border">
							{#each o.events as e (e.key)}
								{@const key = keyOf(o.module, o.officeKey, e.key)}
								<li
									class="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
								>
									<div class="min-w-0">
										<p class="text-sm font-medium">{e.label}</p>
										{#if e.description}
											<p class="text-xs text-muted-foreground">{e.description}</p>
										{/if}
									</div>
									<SelectField
										class="sm:w-60"
										label="{e.label} ({o.officeName})"
										options={MODE_OPTIONS}
										value={e.mode}
										disabled={!!saving[key]}
										onchange={(v) => change(o.module, o.officeKey, e.key, v)}
									/>
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/each}
		</CardContent>
	</Card>
{/if}
