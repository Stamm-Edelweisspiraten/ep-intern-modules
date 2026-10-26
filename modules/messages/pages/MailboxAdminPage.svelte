<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import AtSign from '@lucide/svelte/icons/at-sign';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Forward from '@lucide/svelte/icons/forward';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import * as Tabs from '$lib/components/ui/tabs';
	import { ConfirmDialog, DataTable, FormField, PageHeader } from '$lib/components/layout';
	import { BUSY_SAVE } from '$lib/components/layout/busy';
	import ExtraMailboxDialog from './ExtraMailboxDialog.svelte';
	import {
		EXTRA_SHARE_LEVEL_LABELS,
		MAILBOX_KIND_LABELS,
		aliasInput,
		type AliasTarget,
		type AliasesResponse,
		type ExtraMailbox,
		type MailboxAlias
	} from '../schemas';
	import { BASE, errorText } from './helpers';

	let tab = $state<'mailboxes' | 'aliases'>('mailboxes');

	// --- Zusätzliche Postfächer ---
	let mailboxes = $state<ExtraMailbox[]>([]);
	let mailboxesLoading = $state(true);
	let mailboxesError = $state('');
	let editOpen = $state(false);
	let editing = $state<ExtraMailbox | null>(null);
	let deleteOpen = $state(false);
	let deleting = $state<ExtraMailbox | null>(null);

	async function loadMailboxes() {
		mailboxesLoading = true;
		try {
			mailboxes = await apiFetch<ExtraMailbox[]>(`${BASE}/admin/mailboxes`);
			mailboxesError = '';
		} catch (e) {
			mailboxesError = errorText(e, 'Die Postfächer konnten nicht geladen werden.');
		} finally {
			mailboxesLoading = false;
		}
	}

	function openCreate() {
		editing = null;
		editOpen = true;
	}
	function openEdit(m: ExtraMailbox) {
		editing = m;
		editOpen = true;
	}
	function askDelete(m: ExtraMailbox) {
		deleting = m;
		deleteOpen = true;
	}

	async function confirmDelete() {
		const m = deleting;
		if (!m) return;
		try {
			const res = await apiFetch<{ movedMessages: number; deletedAliases: number }>(
				`${BASE}/admin/mailboxes/${m.id}`,
				{ method: 'DELETE' }
			);
			toast.success(
				res.movedMessages
					? `Postfach gelöscht – ${res.movedMessages} Mails liegen jetzt in „Nicht zugeordnet“`
					: 'Postfach gelöscht'
			);
			deleteOpen = false;
			await Promise.all([loadMailboxes(), loadAliases()]);
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		}
	}

	// --- Weiterleitungen ---
	let aliases = $state<MailboxAlias[]>([]);
	let targets = $state<AliasTarget[]>([]);
	let aliasesLoading = $state(true);
	let aliasesError = $state('');
	let aliasOpen = $state(false);
	let aliasAddress = $state('');
	let aliasTarget = $state<string | null>(null);
	let aliasErrors = $state<{ address?: string; targetKey?: string; form?: string }>({});
	let aliasBusy = $state(false);
	let aliasDeleteOpen = $state(false);
	let aliasDeleting = $state<MailboxAlias | null>(null);

	const targetOptions = $derived(
		targets.map((t) => ({
			value: t.key,
			label: `${MAILBOX_KIND_LABELS[t.kind]}: ${t.name}${t.address ? ` (${t.address})` : ''}`
		}))
	);

	async function loadAliases() {
		aliasesLoading = true;
		try {
			const res = await apiFetch<AliasesResponse>(`${BASE}/admin/aliases`);
			aliases = res.aliases;
			targets = res.targets;
			aliasesError = '';
		} catch (e) {
			aliasesError = errorText(e, 'Die Weiterleitungen konnten nicht geladen werden.');
		} finally {
			aliasesLoading = false;
		}
	}

	function openAlias() {
		aliasAddress = '';
		aliasTarget = null;
		aliasErrors = {};
		aliasBusy = false;
		aliasOpen = true;
	}

	async function saveAlias(e: SubmitEvent) {
		e.preventDefault();
		if (aliasBusy) return;
		aliasErrors = {};
		const parsed = aliasInput.safeParse({ address: aliasAddress, targetKey: aliasTarget ?? '' });
		if (!parsed.success) {
			const next: typeof aliasErrors = {};
			for (const i of parsed.error.issues) {
				const f = String(i.path[0] ?? '');
				if (f === 'address' || f === 'targetKey') next[f] ??= i.message;
			}
			aliasErrors = next;
			document.getElementById(next.address ? 'alias-address' : 'alias-target')?.focus();
			return;
		}
		aliasBusy = true;
		try {
			await apiFetch<MailboxAlias>(`${BASE}/admin/aliases`, {
				method: 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success('Weiterleitung angelegt');
			aliasOpen = false;
			await loadAliases();
		} catch (err) {
			if (err instanceof ApiClientError && err.status === 409) {
				aliasErrors = { address: err.message };
				document.getElementById('alias-address')?.focus();
			} else if (err instanceof ApiClientError && err.status === 422) {
				aliasErrors = { targetKey: err.message || 'Bitte ein Postfach wählen' };
			} else {
				aliasErrors = { form: errorText(err, 'Speichern fehlgeschlagen') };
			}
		} finally {
			aliasBusy = false;
		}
	}

	function askDeleteAlias(a: MailboxAlias) {
		aliasDeleting = a;
		aliasDeleteOpen = true;
	}

	async function confirmDeleteAlias() {
		const a = aliasDeleting;
		if (!a) return;
		try {
			await apiFetch(`${BASE}/admin/aliases/${a.id}`, { method: 'DELETE' });
			toast.success('Weiterleitung gelöscht');
			aliasDeleteOpen = false;
			await loadAliases();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		}
	}

	onMount(() => {
		void loadMailboxes();
		void loadAliases();
	});
</script>

<div class="space-y-6">
	<PageHeader
		title="Postfächer"
		description="Zusätzliche Postfächer und Weiterleitungen für den Posteingang der Nachrichten."
	>
		{#snippet actions()}
			{#if tab === 'mailboxes'}
				<Button onclick={openCreate}><Plus class="size-4" /> Postfach anlegen</Button>
			{:else}
				<Button onclick={openAlias}><Plus class="size-4" /> Weiterleitung anlegen</Button>
			{/if}
		{/snippet}
	</PageHeader>

	<Alert.Root variant="info">
		<Alert.Description>
			Alle Adressen müssen beim Mailserver im Catch-all-Postfach ankommen, das der Posteingang
			abruft. Zugriff auf ein Postfach haben nur Konten mit dem Recht „Nachrichten senden“.
		</Alert.Description>
	</Alert.Root>

	<Tabs.Root bind:value={tab}>
		<Tabs.List variant="line" class="mb-4">
			<Tabs.Trigger value="mailboxes">Postfächer</Tabs.Trigger>
			<Tabs.Trigger value="aliases">Weiterleitungen</Tabs.Trigger>
		</Tabs.List>

		<Tabs.Content value="mailboxes">
			<DataTable
				mobile="cards"
				caption="Zusätzliche Postfächer"
				loading={mailboxesLoading}
				error={mailboxesError}
				onretry={loadMailboxes}
				empty={mailboxes.length === 0}
				emptyTitle="Noch keine zusätzlichen Postfächer"
				emptyDescription="Lege ein Postfach an, z. B. für ein Lager, und gib es an Personen oder Gruppen frei."
			>
				{#snippet head()}
					<Table.Row>
						<Table.Head>Name</Table.Head>
						<Table.Head>Adresse</Table.Head>
						<Table.Head>Zugriff</Table.Head>
						<Table.Head class="text-right">Mails</Table.Head>
						<Table.Head class="w-10"><span class="sr-only">Aktionen</span></Table.Head>
					</Table.Row>
				{/snippet}
				{#each mailboxes as m (m.id)}
					<Table.Row>
						<Table.Cell class="font-medium">
							<div class="flex items-center gap-2">
								<AtSign class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
								<span>{m.name}</span>
							</div>
							{#if m.description}
								<p class="text-xs font-normal text-muted-foreground">{m.description}</p>
							{/if}
						</Table.Cell>
						<Table.Cell class="break-all">{m.address}</Table.Cell>
						<Table.Cell>
							{#if m.shares.length === 0}
								<span class="text-xs text-muted-foreground">Niemand</span>
							{:else}
								<div class="flex flex-wrap gap-1">
									{#each m.shares as s (`${s.type}:${s.id}`)}
										<Badge
											variant={s.level === 'edit' ? 'info' : 'secondary'}
											title={EXTRA_SHARE_LEVEL_LABELS[s.level]}
										>
											{s.name}{s.level === 'edit' ? ' · senden' : ''}
										</Badge>
									{/each}
								</div>
							{/if}
						</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{m.messages}</Table.Cell>
						<Table.Cell>
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon"
											aria-label={`Aktionen für ${m.name}`}
										>
											<Ellipsis class="size-4" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									<DropdownMenu.Item onclick={() => openEdit(m)}>
										<Pencil class="size-4" /> Bearbeiten
									</DropdownMenu.Item>
									<DropdownMenu.Item variant="destructive" onclick={() => askDelete(m)}>
										<Trash2 class="size-4" /> Löschen
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</Table.Cell>
					</Table.Row>
				{/each}
			</DataTable>
		</Tabs.Content>

		<Tabs.Content value="aliases">
			<DataTable
				mobile="cards"
				caption="Weiterleitungen"
				loading={aliasesLoading}
				error={aliasesError}
				onretry={loadAliases}
				empty={aliases.length === 0}
				emptyTitle="Noch keine Weiterleitungen"
				emptyDescription="Eine Weiterleitung sortiert Mails an eine weitere Adresse in ein bestehendes Postfach ein – nichts geht nach außen."
			>
				{#snippet head()}
					<Table.Row>
						<Table.Head>Adresse</Table.Head>
						<Table.Head>Landet in</Table.Head>
						<Table.Head class="w-10"><span class="sr-only">Aktionen</span></Table.Head>
					</Table.Row>
				{/snippet}
				{#each aliases as a (a.id)}
					<Table.Row>
						<Table.Cell class="font-medium break-all">{a.address}</Table.Cell>
						<Table.Cell>
							{#if a.target}
								<span class="inline-flex items-center gap-1.5">
									<Forward class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
									{MAILBOX_KIND_LABELS[a.target.kind]}: {a.target.name}
								</span>
								{#if a.target.address}
									<span class="block text-xs text-muted-foreground">{a.target.address}</span>
								{/if}
							{:else}
								<Badge variant="warning">Postfach existiert nicht mehr</Badge>
								<span class="block text-xs text-muted-foreground">
									Mails landen in „Nicht zugeordnet“.
								</span>
							{/if}
						</Table.Cell>
						<Table.Cell>
							<Button
								variant="ghost"
								size="icon"
								aria-label={`Weiterleitung ${a.address} löschen`}
								onclick={() => askDeleteAlias(a)}
							>
								<Trash2 class="size-4" />
							</Button>
						</Table.Cell>
					</Table.Row>
				{/each}
			</DataTable>
		</Tabs.Content>
	</Tabs.Root>
</div>

<ExtraMailboxDialog
	bind:open={editOpen}
	mailbox={editing}
	onsaved={() => void Promise.all([loadMailboxes(), loadAliases()])}
/>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Postfach löschen?"
	description={deleting
		? `„${deleting.name}“ (${deleting.address}) wird gelöscht. Seine Mails wandern in ‚Nicht zugeordnet‘, Ordner und Weiterleitungen auf dieses Postfach werden entfernt.`
		: ''}
	confirmLabel="Löschen"
	destructive
	onconfirm={confirmDelete}
/>

<ConfirmDialog
	bind:open={aliasDeleteOpen}
	title="Weiterleitung löschen?"
	description={aliasDeleting
		? `Mails an ${aliasDeleting.address} landen danach in „Nicht zugeordnet“.`
		: ''}
	confirmLabel="Löschen"
	destructive
	onconfirm={confirmDeleteAlias}
/>

<Dialog.Root bind:open={aliasOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Weiterleitung anlegen</Dialog.Title>
			<Dialog.Description>
				Mails an diese Adresse werden in das gewählte Postfach einsortiert. Nichts wird nach außen
				weitergeleitet.
			</Dialog.Description>
		</Dialog.Header>
		<form class="grid gap-4" onsubmit={saveAlias} novalidate>
			<FormField label="E-Mail-Adresse" id="alias-address" error={aliasErrors.address} required>
				<Input
					id="alias-address"
					type="email"
					bind:value={aliasAddress}
					maxlength={254}
					autocomplete="off"
					placeholder="lager@beispiel.de"
				/>
			</FormField>
			<FormField label="Landet in" id="alias-target" error={aliasErrors.targetKey} required>
				<SelectField
					id="alias-target"
					label="Ziel-Postfach"
					options={targetOptions}
					bind:value={aliasTarget}
					placeholder="Postfach wählen …"
				/>
			</FormField>
			{#if aliasErrors.form}
				<p role="alert" class="text-sm text-destructive">{aliasErrors.form}</p>
			{/if}
			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					onclick={() => (aliasOpen = false)}
					disabled={aliasBusy}
				>
					Abbrechen
				</Button>
				<Button type="submit" disabled={aliasBusy}>
					{aliasBusy ? BUSY_SAVE : 'Anlegen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
