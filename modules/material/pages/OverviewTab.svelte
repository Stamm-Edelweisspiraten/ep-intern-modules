<script lang="ts">
	// Übersicht: Kennzahlen, Mindestbestand-Hinweis, Schnellaktionen.
	import { onMount } from 'svelte';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import Boxes from '@lucide/svelte/icons/boxes';
	import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
	import ScanLine from '@lucide/svelte/icons/scan-line';
	import { page } from '$app/state';
	import { apiFetch, can } from '$lib/sdk/client';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { ErrorState, LoadingState } from '$lib/components/layout';
	import { BASE_PATH, PERMISSIONS, type Overview } from '../schemas';
	import { API, errorText } from './helpers';

	let { onnavigate }: { onnavigate?: (tab: string) => void } = $props();

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canReserve = $derived(can(permissions, PERMISSIONS.reserve));

	let data = $state<Overview | null>(null);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		try {
			data = await apiFetch<Overview>(`${API}/overview`);
		} catch (e) {
			error = errorText(e, 'Übersicht konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	type Tone = 'default' | 'warning' | 'destructive' | 'info';
	type Stat = { label: string; value: number; hint?: string; tone: Tone; tab?: string };

	const stats = $derived.by((): Stat[] => {
		if (!data) return [];
		return [
			{ label: 'Artikel', value: data.articles, tone: 'default', tab: 'inventory' },
			{ label: 'Stücke', value: data.units, tone: 'default', tab: 'inventory' },
			{ label: 'Kisten', value: data.containers, tone: 'default', tab: 'inventory' },
			{ label: 'Zelte & Sets', value: data.sets, tone: 'default', tab: 'sets' },
			{ label: 'Lagerorte', value: data.locations, tone: 'default', tab: 'inventory' },
			{
				label: 'Ausgegeben',
				value: data.issuedUnits,
				hint: 'Stücke gerade unterwegs',
				tone: data.issuedUnits ? 'info' : 'default',
				tab: 'reservations'
			},
			{
				label: 'Kommende Reservierungen',
				value: data.upcomingReservations,
				tone: 'default',
				tab: 'reservations'
			},
			{
				label: 'Rückgabe überfällig',
				value: data.overdueReservations,
				hint: 'Reservierungen',
				tone: data.overdueReservations ? 'destructive' : 'default',
				tab: 'reservations'
			},
			{
				label: 'Beschädigt oder defekt',
				value: data.damagedUnits,
				hint: 'Stücke',
				tone: data.damagedUnits ? 'warning' : 'default',
				tab: 'inventory'
			}
		];
	});

	const toneClass: Record<Tone, string> = {
		default: '',
		info: 'text-info',
		warning: 'text-warning',
		destructive: 'text-destructive'
	};

	const empty = $derived(!!data && !data.articles && !data.units && !data.locations);
</script>

<div class="space-y-6">
	<div class="flex flex-wrap gap-2">
		<Button href={`${BASE_PATH}/scan`}><ScanLine aria-hidden="true" /> Scannen</Button>
		{#if canReserve}
			<Button variant="outline" onclick={() => onnavigate?.('reservations')}>
				<CalendarPlus aria-hidden="true" /> Material reservieren
			</Button>
		{/if}
		<Button variant="outline" onclick={() => onnavigate?.('inventory')}>
			<Boxes aria-hidden="true" /> Bestand
		</Button>
	</div>

	{#if loading && !data}
		<LoadingState
			label="Übersicht"
			rows={3}
			rowClass="h-24 w-full"
			class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
		/>
	{:else if error && !data}
		<ErrorState message={error} onretry={load} busy={loading} />
	{:else if data}
		{#if data.lowStock.length}
			<Alert.Root variant="warning">
				<AlertTriangle aria-hidden="true" />
				<Alert.Title>Mindestbestand unterschritten</Alert.Title>
				<Alert.Description>
					<ul class="mt-1 space-y-0.5">
						{#each data.lowStock as l (l.articleId)}
							<li>
								<a
									class="underline-offset-4 hover:underline"
									href={`${BASE_PATH}?article=${l.articleId}`}
									data-sveltekit-reload
								>
									{l.name}
								</a>: {l.total} von mindestens {l.min}
							</li>
						{/each}
					</ul>
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if empty}
			<Alert.Root variant="info">
				<Alert.Title>Noch leer</Alert.Title>
				<Alert.Description>
					Leg im Reiter „Bestand“ Lagerorte und Artikel an und erfasse eure Stücke – danach
					erscheinen hier die Kennzahlen.
				</Alert.Description>
			</Alert.Root>
		{/if}

		<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Kennzahlen">
			{#each stats as s (s.label)}
				<li>
					<Card.Root class="h-full">
						<button
							type="button"
							class="flex h-full w-full flex-col gap-1 p-4 text-left hover:bg-muted/40"
							onclick={() => s.tab && onnavigate?.(s.tab)}
							aria-label={`${s.label}: ${s.value}${s.hint ? ` ${s.hint}` : ''}`}
						>
							<span class="text-xs text-muted-foreground">{s.label}</span>
							<span class={['text-2xl font-semibold tabular-nums', toneClass[s.tone]].join(' ')}>
								{s.value}
							</span>
							{#if s.hint}<span class="text-xs text-muted-foreground">{s.hint}</span>{/if}
						</button>
					</Card.Root>
				</li>
			{/each}
		</ul>
	{/if}
</div>
