<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Table from '$lib/components/ui/table';
	import { SelectField } from '$lib/components/ui/select-field';
	import { ConfirmDialog, FormField, NumberStepper } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		ACCOUNT_KIND_LABELS,
		CATEGORY_KINDS,
		CATEGORY_KIND_LABELS,
		MAIL_PLACEHOLDERS,
		settingsInput,
		type Account,
		type Category,
		type CategoryKind,
		type TreasurySettings
	} from '../schemas';
	import { BASE, errorMessage, fmtDate, issuesToErrors, type SharedData } from './helpers';
	import AccountDialog from './AccountDialog.svelte';

	let {
		accounts,
		categories,
		perm,
		onchanged
	}: SharedData & { onchanged: () => void | Promise<void> } = $props();

	// --- Konten ---
	let accountOpen = $state(false);
	let accountEdit = $state<Account | null>(null);
	let deleteOpen = $state(false);
	let toDelete = $state<Account | null>(null);

	async function makeDefault(a: Account) {
		try {
			await apiFetch(`${BASE}/accounts/${a.id}/default`, { method: 'PUT' });
			toast.success(`${a.name} ist jetzt das Standardkonto`);
			await onchanged();
		} catch (e) {
			toast.error(errorMessage(e, 'Speichern fehlgeschlagen'));
		}
	}

	async function removeAccount() {
		if (!toDelete) return;
		try {
			await apiFetch(`${BASE}/accounts/${toDelete.id}`, { method: 'DELETE' });
			toast.success('Konto gelöscht');
			await onchanged();
		} catch (e) {
			toast.error(errorMessage(e, 'Löschen fehlgeschlagen'));
		}
	}

	// --- Kategorien ---
	let catOpen = $state(false);
	let catEdit = $state<Category | null>(null);
	let catName = $state('');
	let catKind = $state<string | null>('expense');
	let catArchived = $state(false);
	let catBusy = $state(false);
	const kindOptions = CATEGORY_KINDS.map((k) => ({
		value: k as string,
		label: CATEGORY_KIND_LABELS[k]
	}));

	function openCategory(c: Category | null) {
		catEdit = c;
		catName = c?.name ?? '';
		catKind = c?.kind ?? 'expense';
		catArchived = c?.archived ?? false;
		catOpen = true;
	}

	async function saveCategory(e: SubmitEvent) {
		e.preventDefault();
		catBusy = true;
		try {
			await apiFetch(catEdit ? `${BASE}/categories/${catEdit.id}` : `${BASE}/categories`, {
				method: catEdit ? 'PUT' : 'POST',
				body: JSON.stringify({
					name: catName,
					kind: catKind as CategoryKind,
					archived: catArchived
				})
			});
			toast.success('Kategorie gespeichert');
			catOpen = false;
			await onchanged();
		} catch (err) {
			toast.error(errorMessage(err, 'Speichern fehlgeschlagen'));
		} finally {
			catBusy = false;
		}
	}

	// --- Einstellungen ---
	let settings = $state<TreasurySettings | null>(null);
	let saving = $state(false);
	let errors = $state<Record<string, string>>({});

	$effect(() => {
		void apiFetch<TreasurySettings>(`${BASE}/settings`)
			.then((s) => (settings = s))
			.catch(() => (settings = null));
	});

	async function saveSettings(e: SubmitEvent) {
		e.preventDefault();
		if (!settings) return;
		const parsed = settingsInput.safeParse(settings);
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			toast.error('Bitte die markierten Felder prüfen.');
			return;
		}
		errors = {};
		saving = true;
		try {
			settings = await apiFetch<TreasurySettings>(`${BASE}/settings`, {
				method: 'PUT',
				body: JSON.stringify(parsed.data)
			});
			toast.success('Einstellungen gespeichert');
		} catch (err) {
			toast.error(errorMessage(err, 'Speichern fehlgeschlagen'));
		} finally {
			saving = false;
		}
	}
</script>

<div class="space-y-6">
	{#if perm.accounts}
		<Card.Root>
			<Card.Header class="flex flex-row items-center justify-between gap-2 space-y-0">
				<div>
					<Card.Title>Konten</Card.Title>
					<Card.Description>
						Das Standardkonto ist in allen Dialogen vorausgewählt. Konten mit Buchungen lassen sich
						nur archivieren.
					</Card.Description>
				</div>
				<Button
					onclick={() => {
						accountEdit = null;
						accountOpen = true;
					}}
				>
					<Plus /> Konto
				</Button>
			</Card.Header>
			<Card.Content class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Name</Table.Head>
							<Table.Head>Art</Table.Head>
							<Table.Head>Anfangsbestand</Table.Head>
							<Table.Head class="text-right">Saldo</Table.Head>
							<Table.Head class="text-right"><span class="sr-only">Aktionen</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each accounts as a (a.id)}
							<Table.Row class={a.archived ? 'text-muted-foreground' : ''}>
								<Table.Cell class="font-medium">
									{a.name}
									{#if a.isDefault}<Badge class="ml-1">Standard</Badge>{/if}
									{#if a.archived}<Badge variant="outline" class="ml-1">archiviert</Badge>{/if}
									{#if a.iban}<div class="text-xs text-muted-foreground">{a.iban}</div>{/if}
								</Table.Cell>
								<Table.Cell>{ACCOUNT_KIND_LABELS[a.kind]}</Table.Cell>
								<Table.Cell class="tabular-nums">
									{formatEuro(a.openingBalanceCents)} am {fmtDate(a.openingDate)}
								</Table.Cell>
								<Table.Cell class="text-right font-medium tabular-nums"
									>{formatEuro(a.balanceCents)}</Table.Cell
								>
								<Table.Cell class="text-right whitespace-nowrap">
									{#if !a.isDefault && !a.archived}
										<Button variant="ghost" size="sm" onclick={() => makeDefault(a)}>
											Als Standard
										</Button>
									{/if}
									<Button
										variant="ghost"
										size="icon"
										aria-label={`${a.name} bearbeiten`}
										onclick={() => {
											accountEdit = a;
											accountOpen = true;
										}}
									>
										<Pencil />
									</Button>
									{#if a.transactionCount === 0}
										<Button
											variant="ghost"
											size="icon"
											aria-label={`${a.name} löschen`}
											onclick={() => {
												toDelete = a;
												deleteOpen = true;
											}}
										>
											<Trash2 />
										</Button>
									{/if}
								</Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row>
								<Table.Cell colspan={5} class="text-muted-foreground">
									Noch kein Konto – lege z. B. „Girokonto“ und „Barkasse“ an.
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header class="flex flex-row items-center justify-between gap-2 space-y-0">
				<Card.Title>Kategorien</Card.Title>
				<Button variant="outline" onclick={() => openCategory(null)}><Plus /> Kategorie</Button>
			</Card.Header>
			<Card.Content class="flex flex-wrap gap-2">
				{#each categories as c (c.id)}
					<button type="button" onclick={() => openCategory(c)} aria-label={`${c.name} bearbeiten`}>
						<Badge variant={c.archived ? 'outline' : 'secondary'}>
							{c.name} · {CATEGORY_KIND_LABELS[c.kind]}{c.archived ? ' (archiviert)' : ''}
						</Badge>
					</button>
				{/each}
			</Card.Content>
		</Card.Root>
	{/if}

	{#if perm.settings && settings}
		<form class="space-y-6" onsubmit={saveSettings} novalidate>
			<Card.Root>
				<Card.Header>
					<Card.Title>Kontodaten für Rechnungen und Mails</Card.Title>
					<Card.Description>Leer = Kontodaten aus den Einstellungen der Aktionen.</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-4 sm:grid-cols-2">
					<FormField label="Kontoinhaber" id="st-holder"
						><Input id="st-holder" bind:value={settings.bankHolder} /></FormField
					>
					<FormField label="IBAN" id="st-iban"
						><Input id="st-iban" bind:value={settings.bankIban} /></FormField
					>
					<FormField label="BIC" id="st-bic"
						><Input id="st-bic" bind:value={settings.bankBic} /></FormField
					>
					<FormField label="Bank" id="st-bank"
						><Input id="st-bank" bind:value={settings.bankName} /></FormField
					>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Fristen und Erinnerungen</Card.Title>
				</Card.Header>
				<Card.Content class="grid gap-4 sm:grid-cols-2">
					<FormField
						label="Beiträge fällig (Tage vor Beginn)"
						id="st-before"
						hint="Fälligkeit neuer Rechnungen aus Aktionen."
						error={errors.daysBeforeStart}
					>
						<NumberStepper
							id="st-before"
							label="Tage vor Beginn"
							bind:value={settings.daysBeforeStart}
							min={0}
							max={365}
						/>
					</FormField>
					<FormField
						label="Mindest-Zahlungsfrist (Tage)"
						id="st-min"
						hint="Neue Rechnungen sind frühestens so viele Tage nach Erstellung fällig."
						error={errors.minDays}
					>
						<NumberStepper
							id="st-min"
							label="Mindestfrist"
							bind:value={settings.minDays}
							min={0}
							max={365}
						/>
					</FormField>
					<div class="flex items-center gap-2 sm:col-span-2">
						<Switch id="st-rem" bind:checked={settings.remindersEnabled} />
						<Label for="st-rem">Automatische Zahlungserinnerungen (täglich)</Label>
					</div>
					<FormField
						label="1. Erinnerung (Tage nach Fälligkeit)"
						id="st-first"
						error={errors.firstDays}
					>
						<NumberStepper
							id="st-first"
							label="Erste Erinnerung"
							bind:value={settings.firstDays}
							min={1}
							max={365}
						/>
					</FormField>
					<FormField
						label="2. Erinnerung (Tage nach der ersten)"
						id="st-second"
						error={errors.secondDays}
					>
						<NumberStepper
							id="st-second"
							label="Zweite Erinnerung"
							bind:value={settings.secondDays}
							min={1}
							max={365}
						/>
					</FormField>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>E-Mail-Texte</Card.Title>
					<Card.Description>
						Platzhalter: {#each MAIL_PLACEHOLDERS as [key, label], i (key)}<code
								class="text-xs"
								title={label}>{key}</code
							>{i < MAIL_PLACEHOLDERS.length - 1 ? ', ' : ''}{/each}
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="flex items-center gap-2">
						<Switch id="st-paid" bind:checked={settings.paidMailEnabled} />
						<Label for="st-paid">Zahlungsbestätigung senden, sobald eine Rechnung bezahlt ist</Label
						>
					</div>
					<FormField label="Betreff Bestätigung" id="st-ps" error={errors.paidSubject}>
						<Input id="st-ps" bind:value={settings.paidSubject} maxlength={150} />
					</FormField>
					<FormField label="Text Bestätigung" id="st-pb" error={errors.paidBody}>
						<Textarea id="st-pb" bind:value={settings.paidBody} rows={8} maxlength={5000} />
					</FormField>
					<FormField label="Betreff Erinnerung" id="st-rs" error={errors.reminderSubject}>
						<Input id="st-rs" bind:value={settings.reminderSubject} maxlength={150} />
					</FormField>
					<FormField label="Text Erinnerung" id="st-rb" error={errors.reminderBody}>
						<Textarea id="st-rb" bind:value={settings.reminderBody} rows={10} maxlength={5000} />
					</FormField>
					<FormField
						label="Betreff Rechnungs-Mail"
						id="st-is"
						error={errors.invoiceSubject}
						hint="Für neue, geänderte und stornierte Rechnungen (PDF im Anhang). Bei der Anmeldung hängt die Rechnung an der Anmeldebestätigung."
					>
						<Input id="st-is" bind:value={settings.invoiceSubject} maxlength={150} />
					</FormField>
					<FormField label="Text Rechnungs-Mail" id="st-ib" error={errors.invoiceBody}>
						<Textarea id="st-ib" bind:value={settings.invoiceBody} rows={10} maxlength={5000} />
					</FormField>
				</Card.Content>
			</Card.Root>
			<div class="flex justify-end">
				<Button type="submit" disabled={saving}
					>{saving ? 'Speichert …' : 'Einstellungen speichern'}</Button
				>
			</div>
		</form>
	{/if}
</div>

<AccountDialog bind:open={accountOpen} account={accountEdit} onsaved={onchanged} />
<ConfirmDialog
	bind:open={deleteOpen}
	title="Konto löschen?"
	description="Das Konto hat keine Buchungen und wird dauerhaft entfernt."
	confirmLabel="Löschen"
	destructive
	onconfirm={removeAccount}
/>

<Dialog.Root bind:open={catOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>{catEdit ? 'Kategorie bearbeiten' : 'Neue Kategorie'}</Dialog.Title>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={saveCategory}>
			<FormField label="Name *" id="cat-name">
				<Input id="cat-name" bind:value={catName} maxlength={60} required />
			</FormField>
			<FormField label="Gilt für" id="cat-kind">
				<SelectField id="cat-kind" label="Gilt für" options={kindOptions} bind:value={catKind} />
			</FormField>
			{#if catEdit}
				<div class="flex items-center gap-2">
					<Switch id="cat-arch" bind:checked={catArchived} />
					<Label for="cat-arch">Archiviert (nicht mehr auswählbar)</Label>
				</div>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (catOpen = false)}>Abbrechen</Button>
				<Button type="submit" disabled={catBusy || !catName.trim()}>Speichern</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
