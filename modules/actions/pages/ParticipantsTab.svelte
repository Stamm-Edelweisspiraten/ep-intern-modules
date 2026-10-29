<script lang="ts">
	import { toast } from 'svelte-sonner';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Download from '@lucide/svelte/icons/download';
	import Mail from '@lucide/svelte/icons/mail';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import FileDown from '@lucide/svelte/icons/file-down';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Search from '@lucide/svelte/icons/search';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import X from '@lucide/svelte/icons/x';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import * as Table from '$lib/components/ui/table';
	import { DataTable, MobileActionBar } from '$lib/components/layout';
	import {
		DIET_LABELS,
		PARTICIPANT_BULK_MAX_IDS,
		PARTICIPANT_ROLE_LABELS,
		ageAt,
		type Participant,
		type ParticipantRole
	} from '../schemas';
	import PaymentCell from './PaymentCell.svelte';

	/**
	 * Tab „Teilnehmende“: Liste mit Suche, Schnellfiltern (Chips, kombinierbar) und
	 * Mehrfachbearbeitung (Zuschuss, Rolle) über `PATCH …/participants`.
	 */
	let {
		participants,
		loading,
		error,
		base,
		startsOn,
		canEdit,
		showPayments,
		description,
		canOpenInvoices,
		canExportSheets,
		sheetsBusy,
		onadd,
		onedit,
		ondelete,
		onsheets,
		onchanged
	}: {
		participants: Participant[];
		loading: boolean;
		error: string;
		/** API-Basis der Aktion, z. B. `/modules/actions/actions/<id>` */
		base: string;
		startsOn: string;
		canEdit: boolean;
		showPayments: boolean;
		description?: string;
		canOpenInvoices: boolean;
		canExportSheets: boolean;
		sheetsBusy: boolean;
		onadd: () => void;
		onedit: (p: Participant) => void;
		ondelete: (p: Participant) => void;
		onsheets: () => void;
		onchanged: () => Promise<void> | void;
	} = $props();

	// --- Info-Mail an Teilnehmende (Modul Nachrichten) ---------------------------

	/** Nur mit aktivem Modul „Nachrichten“ und Senderecht (Modulrechte fehlen bei deaktiviertem Modul) */
	const canMail = $derived(can((page.data.permissions ?? []) as string[], 'messages.message.send'));
	const actionId = $derived(decodeURIComponent(base.split('/').pop() ?? ''));

	/**
	 * Übergibt die Empfänger an „Neue Nachricht“ (gleicher Weg wie die Mitgliederliste):
	 * Mitglieder über ihre ID, alle anderen über die Kontaktadresse aus der Anmeldung.
	 * Ausgewählte Personen, sonst alle gefilterten.
	 */
	function mailParticipants() {
		const chosen = selected.length ? participants.filter((p) => selected.includes(p.id)) : filtered;
		const members = chosen
			.filter((p) => p.memberId)
			.map((p) => ({ id: p.memberId as string, name: p.name }));
		const addresses = chosen
			.filter((p) => !p.memberId && p.contactEmail)
			.map((p) => (p.contactEmail as string).toLowerCase());
		try {
			sessionStorage.setItem(
				'messages:compose',
				JSON.stringify({ members, addresses: [...new Set(addresses)], actionId })
			);
		} catch {
			// ohne sessionStorage: Nachricht ohne Vorbelegung öffnen
		}
		void goto(`/modules/messages/new?action=${encodeURIComponent(actionId)}`);
	}

	// --- Schnellfilter ---------------------------------------------------------

	type FilterKey =
		'role:participant' | 'role:team' | 'pay:paid' | 'pay:open' | 'sub:yes' | 'sub:no' | 'missing';

	interface Chip {
		key: FilterKey;
		label: string;
		/** Chips derselben Gruppe sind ODER-verknüpft, Gruppen untereinander UND */
		group: string;
		test: (p: Participant) => boolean;
	}

	/** Gleiche Regel wie `incomplete[]` in `deriveSubsidyCounts` (Geburtsdatum bzw. Wohnort fehlt) */
	function missingData(p: Participant): boolean {
		return (
			(!p.birthDate && p.subsidyEligible !== false) ||
			(p.bremenResident == null && p.subsidyEligible == null)
		);
	}
	const isPaid = (p: Participant) =>
		!!p.payment && (p.payment.status === 'paid' || p.payment.status === 'waived');
	const isOpen = (p: Participant) =>
		!!p.payment &&
		(p.payment.status === 'open' || p.payment.status === 'partial' || p.payment.overdue);

	const chips = $derived<Chip[]>([
		{
			key: 'role:participant',
			label: 'Teilnehmende',
			group: 'role',
			test: (p) => p.role === 'participant'
		},
		{ key: 'role:team', label: 'Team', group: 'role', test: (p) => p.role === 'team' },
		...(showPayments
			? ([
					{ key: 'pay:paid', label: 'Beitrag bezahlt', group: 'pay', test: isPaid },
					{ key: 'pay:open', label: 'Beitrag offen', group: 'pay', test: isOpen }
				] satisfies Chip[])
			: []),
		{
			key: 'sub:yes',
			label: 'Zuschuss berechtigt',
			group: 'sub',
			test: (p) => p.subsidyEffective
		},
		{
			key: 'sub:no',
			label: 'Nicht berechtigt',
			group: 'sub',
			test: (p) => !p.subsidyEffective
		},
		{ key: 'missing', label: 'Angaben fehlen', group: 'missing', test: missingData }
	]);

	let active = $state<FilterKey[]>([]);
	let search = $state('');

	/** Nur Filter, die es (noch) gibt – z. B. Beitrag nur mit Kasse */
	const activeChips = $derived(chips.filter((c) => active.includes(c.key)));

	const searched = $derived.by(() => {
		const q = search.trim().toLocaleLowerCase('de');
		if (!q) return participants;
		return participants.filter((p) =>
			[p.name, p.groupLabel, p.contactEmail]
				.filter(Boolean)
				.some((v) => v!.toLocaleLowerCase('de').includes(q))
		);
	});

	const filtered = $derived.by(() => {
		if (!activeChips.length) return searched;
		const groups = new Map<string, Chip[]>();
		for (const c of activeChips) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
		return searched.filter((p) => [...groups.values()].every((g) => g.some((c) => c.test(p))));
	});

	const counts = $derived(
		new Map(chips.map((c) => [c.key, searched.filter((p) => c.test(p)).length]))
	);
	const filtering = $derived(activeChips.length > 0 || search.trim() !== '');

	function toggleChip(key: FilterKey) {
		active = active.includes(key) ? active.filter((k) => k !== key) : [...active, key];
	}
	function resetFilters() {
		active = [];
		search = '';
	}

	// --- Auswahl und Mehrfachbearbeitung ----------------------------------------

	let selected = $state<string[]>([]);
	let bulkBusy = $state(false);

	/** Ausgewählt UND sichtbar: versteckte Zeilen werden nie mitbearbeitet */
	const selectedVisible = $derived(
		filtered.filter((p) => selected.includes(p.id)).map((p) => p.id)
	);
	const allVisible = $derived(
		filtered.length > 0 && filtered.every((p) => selected.includes(p.id))
	);
	const someVisible = $derived(!allVisible && selectedVisible.length > 0);

	function toggle(id: string, on: boolean) {
		if (on && selected.length >= PARTICIPANT_BULK_MAX_IDS && !selected.includes(id)) {
			toast.error(`Höchstens ${PARTICIPANT_BULK_MAX_IDS} Personen auf einmal`);
			return;
		}
		selected = on ? [...new Set([...selected, id])] : selected.filter((i) => i !== id);
	}
	function toggleVisible(on: boolean) {
		const ids = filtered.map((p) => p.id);
		selected = on
			? [...new Set([...selected, ...ids])].slice(0, PARTICIPANT_BULK_MAX_IDS)
			: selected.filter((i) => !ids.includes(i));
	}

	async function bulkUpdate(
		change: { subsidyEligible: boolean | null } | { role: ParticipantRole },
		what: string
	) {
		const ids = selectedVisible;
		if (!ids.length || bulkBusy) return;
		bulkBusy = true;
		try {
			const res = await apiFetch<{ updated: number }>(`${base}/participants`, {
				method: 'PATCH',
				body: JSON.stringify({ ids, ...change })
			});
			toast.success(
				`${what}: ${res.updated} ${res.updated === 1 ? 'Person' : 'Personen'} geändert`
			);
			selected = [];
			await onchanged();
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Ändern fehlgeschlagen');
		} finally {
			bulkBusy = false;
		}
	}

	// --- Anzeige -----------------------------------------------------------------

	function fmtAge(p: Participant): string {
		if (!p.birthDate) return '–';
		const a = ageAt(p.birthDate, startsOn);
		return a === null || a < 0 ? '–' : String(a);
	}
	function truncate(s: string, n = 60) {
		return s.length > n ? `${s.slice(0, n - 1)}…` : s;
	}
</script>

<div class={canEdit && selectedVisible.length ? 'pb-20 sm:pb-0' : ''}>
	<DataTable
		caption="Teilnehmende"
		mobile="cards"
		title="Teilnehmende"
		{description}
		{loading}
		{error}
		empty={!filtered.length}
		emptyTitle={participants.length ? 'Keine Treffer' : 'Noch keine Teilnehmenden'}
		emptyDescription={participants.length
			? 'Niemand passt zu Suche und Filtern.'
			: 'Füge Teilnehmende manuell hinzu.'}
	>
		{#snippet toolbar()}
			<div class="relative w-full sm:w-64">
				<Search
					class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<Input
					type="search"
					class="pl-8"
					placeholder="Name, Gruppe, E-Mail …"
					aria-label="Teilnehmende suchen"
					bind:value={search}
				/>
			</div>
			<div class="flex flex-wrap items-center gap-2 sm:ml-auto">
				<Button variant="outline" href={`/api/v1${base}/participants.csv`} download>
					<Download /> CSV exportieren
				</Button>
				{#if canMail && participants.length}
					<Button variant="outline" onclick={mailParticipants}>
						<Mail />
						{selected.length ? `Info-Mail an Auswahl (${selected.length})` : 'Info-Mail'}
					</Button>
				{/if}
				{#if canExportSheets}
					<Button variant="outline" disabled={sheetsBusy} onclick={onsheets}>
						<FileDown />
						{sheetsBusy ? 'Erzeuge PDF …' : 'Teilnehmerliste (PDF)'}
					</Button>
				{/if}
				{#if canEdit}
					<Button onclick={onadd}><UserPlus /> Teilnehmende*n hinzufügen</Button>
				{/if}
			</div>
			{#if participants.length}
				<div
					class="flex w-full flex-wrap items-center gap-1.5"
					role="group"
					aria-label="Schnellfilter"
				>
					{#each chips as c (c.key)}
						{@const on = active.includes(c.key)}
						<button
							type="button"
							aria-pressed={on}
							onclick={() => toggleChip(c.key)}
							class={[
								'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
								on
									? 'border-primary bg-primary text-primary-foreground'
									: 'bg-background text-foreground hover:bg-muted'
							]}
						>
							{c.label}
							<span
								class={[
									'rounded-full px-1.5 tabular-nums',
									on ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground'
								]}
							>
								{counts.get(c.key) ?? 0}
							</span>
						</button>
					{/each}
					{#if filtering}
						<Button size="sm" variant="ghost" class="h-7" onclick={resetFilters}>
							<X /> Filter zurücksetzen
						</Button>
						<span class="text-xs text-muted-foreground" aria-live="polite">
							{filtered.length} von {participants.length}
						</span>
					{/if}
				</div>
			{/if}
			{#if canEdit}
				<MobileActionBar
					show={selectedVisible.length > 0}
					label="Sammelaktionen"
					class="sm:w-full sm:rounded-md sm:border sm:bg-muted/40 sm:px-3 sm:py-2"
				>
					<span class="text-sm font-medium" aria-live="polite">
						{selectedVisible.length} ausgewählt
					</span>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger disabled={bulkBusy}>
							{#snippet child({ props })}
								<Button {...props} size="sm" variant="outline">
									Zuschuss <ChevronDown />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="start">
							<DropdownMenu.Item
								onclick={() => bulkUpdate({ subsidyEligible: null }, 'Zuschuss automatisch')}
							>
								Automatisch (Alter + Wohnort)
							</DropdownMenu.Item>
							<DropdownMenu.Item
								onclick={() => bulkUpdate({ subsidyEligible: true }, 'Zuschuss berechtigt')}
							>
								Berechtigt
							</DropdownMenu.Item>
							<DropdownMenu.Item
								onclick={() => bulkUpdate({ subsidyEligible: false }, 'Nicht berechtigt')}
							>
								Nicht berechtigt
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger disabled={bulkBusy}>
							{#snippet child({ props })}
								<Button {...props} size="sm" variant="outline">
									Rolle <ChevronDown />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="start">
							<DropdownMenu.Item
								onclick={() => bulkUpdate({ role: 'participant' }, 'Rolle Teilnehmende')}
							>
								Teilnehmende
							</DropdownMenu.Item>
							<DropdownMenu.Item onclick={() => bulkUpdate({ role: 'team' }, 'Rolle Team')}>
								Team
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
					{#if bulkBusy}<span class="text-xs text-muted-foreground">Speichert …</span>{/if}
					<Button size="sm" variant="ghost" class="ml-auto" onclick={() => (selected = [])}>
						<X /> Auswahl aufheben
					</Button>
				</MobileActionBar>
			{/if}
		{/snippet}
		{#snippet emptyAction()}
			{#if participants.length}
				<Button variant="outline" onclick={resetFilters}><X /> Filter zurücksetzen</Button>
			{/if}
		{/snippet}
		{#snippet head()}
			<Table.Row>
				{#if canEdit}
					<Table.Head class="w-10">
						<Checkbox
							aria-label="Alle angezeigten Teilnehmenden auswählen"
							checked={allVisible}
							indeterminate={someVisible}
							onCheckedChange={(v) => toggleVisible(v === true)}
						/>
					</Table.Head>
				{/if}
				<Table.Head>Name</Table.Head>
				<Table.Head>Gruppe</Table.Head>
				<Table.Head>E-Mail</Table.Head>
				<Table.Head>Alter</Table.Head>
				<Table.Head>Rolle</Table.Head>
				<!-- Gesundheitsdaten nur mit Sonderrecht (`members.data.export`, wie das PDF) -->
				{#if canExportSheets}
					<Table.Head>Ernährung</Table.Head>
					<Table.Head>Allergien / Hinweise</Table.Head>
				{/if}
				{#if showPayments}<Table.Head>Beitrag</Table.Head>{/if}
				<Table.Head>Quelle</Table.Head>
				{#if canEdit}<Table.Head class="text-right">Aktionen</Table.Head>{/if}
			</Table.Row>
		{/snippet}
		{#each filtered as p (p.id)}
			{@const hint = [p.allergies, p.notes].filter(Boolean).join(' · ')}
			<Table.Row data-state={selected.includes(p.id) ? 'selected' : undefined}>
				{#if canEdit}
					<Table.Cell>
						<Checkbox
							aria-label={`${p.name} auswählen`}
							checked={selected.includes(p.id)}
							onCheckedChange={(v) => toggle(p.id, v === true)}
						/>
					</Table.Cell>
				{/if}
				<Table.Cell class="font-medium">{p.name}</Table.Cell>
				<Table.Cell>{p.groupLabel ?? '–'}</Table.Cell>
				<Table.Cell class="max-w-48 truncate text-xs" title={p.contactEmail ?? undefined}>
					{p.contactEmail ?? '–'}
				</Table.Cell>
				<Table.Cell>{fmtAge(p)}</Table.Cell>
				<Table.Cell>
					{PARTICIPANT_ROLE_LABELS[p.role]}{p.role === 'team' && p.juleica ? ' (Juleica)' : ''}
				</Table.Cell>
				{#if canExportSheets}
					<Table.Cell>{p.diet ? DIET_LABELS[p.diet] : '–'}</Table.Cell>
					<Table.Cell class="max-w-64" title={hint || undefined}>
						{hint ? truncate(hint) : '–'}
					</Table.Cell>
				{/if}
				{#if showPayments}
					<Table.Cell>
						<PaymentCell payment={p.payment} linkToInvoice={canOpenInvoices} />
					</Table.Cell>
				{/if}
				<Table.Cell>
					<Badge variant="outline">{p.source === 'link' ? 'Anmeldelink' : 'Manuell'}</Badge>
				</Table.Cell>
				{#if canEdit}
					<Table.Cell class="text-right">
						<div class="flex justify-end gap-2">
							<Button
								size="icon"
								variant="outline"
								aria-label={`${p.name} bearbeiten`}
								onclick={() => onedit(p)}><Pencil /></Button
							>
							<Button
								size="icon"
								variant="destructive"
								aria-label={`${p.name} entfernen`}
								onclick={() => ondelete(p)}><Trash2 /></Button
							>
						</div>
					</Table.Cell>
				{/if}
			</Table.Row>
		{/each}
	</DataTable>
</div>
