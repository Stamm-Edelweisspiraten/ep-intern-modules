<script lang="ts">
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import ShieldOff from '@lucide/svelte/icons/shield-off';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Table from '$lib/components/ui/table';
	import { ConfirmDialog, DataTable, PageHeader } from '$lib/components/layout';
	import type { AnonymizeResult, RetentionList } from '../retention.service';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canDelete = $derived(can(permissions, 'members.member.delete'));

	let data = $state<RetentionList | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let selected = $state<string[]>([]);
	let confirmOpen = $state(false);
	let busy = $state(false);

	const items = $derived(data?.items ?? []);
	const allSelected = $derived(items.length > 0 && selected.length === items.length);
	const someSelected = $derived(selected.length > 0 && !allSelected);

	const formatDate = (d: string) => {
		const [y, m, day] = d.split('-');
		return `${day}.${m}.${y}`;
	};

	async function load() {
		loading = true;
		loadError = '';
		try {
			data = await apiFetch<RetentionList>('/modules/members/retention');
			selected = selected.filter((id) => data?.items.some((i) => i.id === id));
		} catch (e) {
			loadError = e instanceof ApiClientError ? e.message : 'Laden fehlgeschlagen';
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void load();
	});

	function toggle(id: string, on: boolean) {
		selected = on ? [...new Set([...selected, id])] : selected.filter((s) => s !== id);
	}
	function toggleAll(on: boolean) {
		selected = on ? items.map((i) => i.id) : [];
	}

	async function anonymize() {
		busy = true;
		try {
			const r = await apiFetch<AnonymizeResult>('/modules/members/retention/anonymize', {
				method: 'POST',
				body: JSON.stringify({ ids: selected })
			});
			toast.success(
				r.affected === 1 ? '1 Mitglied anonymisiert' : `${r.affected} Mitglieder anonymisiert`
			);
			if (r.skipped.length) {
				toast.warning(
					`${r.skipped.length} übersprungen: ${r.skipped
						.map((s) => `${s.name || 'Unbekannt'} (${s.reason})`)
						.join(', ')}`
				);
			}
			selected = [];
			await load();
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Anonymisieren fehlgeschlagen');
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="Löschfristen"
	description={data
		? `Ehemalige Mitglieder, deren Austritt mehr als ${data.years} ${data.years === 1 ? 'Jahr' : 'Jahre'} zurückliegt (vor dem ${formatDate(data.cutoff)}). Die Frist lässt sich unter Administration → Einstellungen → Module ändern.`
		: 'Ehemalige Mitglieder, deren Löschfrist abgelaufen ist.'}
/>

<p class="mb-4 max-w-3xl text-sm text-muted-foreground">
	Anonymisieren entfernt Namen, Kontakte, Anschrift, Zusatzfelder (auch Gesundheitsangaben),
	Einwilligungen, Gruppen, Konto-Verknüpfungen und Dokumente. Teilnahmen an Aktionen verlieren den
	Namen und die Gesundheitsangaben. Erhalten bleiben Geburtsjahr, Stand und Mitgliedszeitraum für
	Statistiken; Rechnungen der Kasse bleiben wegen der Aufbewahrungspflicht unverändert. Das lässt
	sich nicht rückgängig machen.
</p>

<div class={selected.length ? 'pb-20 sm:pb-0' : ''}>
	<DataTable
		caption="Ehemalige Mitglieder mit abgelaufener Löschfrist"
		mobile="cards"
		{loading}
		error={loadError}
		onretry={load}
		empty={items.length === 0}
		emptyTitle="Nichts zu tun"
		emptyDescription="Für kein ehemaliges Mitglied ist die Löschfrist abgelaufen."
	>
		{#snippet toolbar()}
			{#if canDelete && items.length > 0}
				<div class="flex w-full flex-wrap items-center gap-2">
					<span class="text-sm text-muted-foreground" aria-live="polite">
						{selected.length} von {data?.total ?? items.length} ausgewählt
					</span>
					<Button
						size="sm"
						variant="destructive"
						class="ml-auto"
						disabled={!selected.length || busy}
						onclick={() => (confirmOpen = true)}
					>
						<ShieldOff />
						{busy ? 'Anonymisiert …' : 'Ausgewählte anonymisieren'}
					</Button>
				</div>
			{/if}
		{/snippet}
		{#snippet head()}
			<Table.Row>
				{#if canDelete}
					<Table.Head class="w-10">
						<Checkbox
							aria-label="Alle auswählen"
							checked={allSelected}
							indeterminate={someSelected}
							onCheckedChange={(v) => toggleAll(v === true)}
						/>
					</Table.Head>
				{/if}
				<Table.Head>Name</Table.Head>
				<Table.Head>Austritt</Table.Head>
			</Table.Row>
		{/snippet}
		{#each items as m (m.id)}
			<Table.Row data-state={selected.includes(m.id) ? 'selected' : undefined}>
				{#if canDelete}
					<Table.Cell>
						<Checkbox
							aria-label={`${m.firstName} ${m.lastName} auswählen`}
							checked={selected.includes(m.id)}
							onCheckedChange={(v) => toggle(m.id, v === true)}
						/>
					</Table.Cell>
				{/if}
				<Table.Cell class="font-medium">{m.firstName} {m.lastName}</Table.Cell>
				<Table.Cell>{formatDate(m.exitDate)}</Table.Cell>
			</Table.Row>
		{/each}
	</DataTable>
</div>

<ConfirmDialog
	bind:open={confirmOpen}
	title={selected.length === 1
		? '1 ehemaliges Mitglied anonymisieren?'
		: `${selected.length} ehemalige Mitglieder anonymisieren?`}
	description="Personenbezogene Daten werden endgültig entfernt, auch Kopien in Aktionen. Das lässt sich nicht rückgängig machen."
	confirmLabel="Anonymisieren"
	destructive
	onconfirm={anonymize}
/>
