<script lang="ts">
	import { untrack } from 'svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Lock from '@lucide/svelte/icons/lock';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import { FormRenderer } from '$lib/components/forms';
	import { ContactListField, EntityAvatar, toastWithUndo } from '$lib/components/layout';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader } from '$lib/components/ui/card';
	import * as Tabs from '$lib/components/ui/tabs';
	import { apiFetch } from '$lib/sdk/client';
	import type { FormValue, FormValues } from '$lib/forms';
	import type { MyFieldDefinition, MyMember } from '../schemas';
	import { MY_BASE, contactErrors, errorText, issuesFrom, memberName } from './profile-shared';

	let {
		member,
		fields,
		canEdit,
		collapsible = false,
		startOpen = true,
		ondirty
	}: {
		member: MyMember;
		fields: MyFieldDefinition[];
		canEdit: boolean;
		collapsible?: boolean;
		startOpen?: boolean;
		ondirty?: (dirty: boolean) => void;
	} = $props();

	type Contact = { name: string; value: string };
	const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
	const toRows = (list: { name: string | null; value: string }[]): Contact[] =>
		list.map((c) => ({ name: c.name ?? '', value: c.value }));
	const clean = (rows: Contact[]): Contact[] =>
		rows
			.map((r) => ({ name: r.name.trim(), value: r.value.trim() }))
			.filter((r) => r.name || r.value);

	const visible = $derived(fields.filter((f) => !f.field.hidden));
	const normalFields = $derived(visible.filter((f) => !f.sensitive).map((f) => f.field));
	const sensitiveFields = $derived(visible.filter((f) => f.sensitive).map((f) => f.field));

	function initialValues(): FormValues {
		return Object.fromEntries(
			untrack(() => visible).map((f) => [
				f.key,
				(untrack(() => member.custom)[f.key] ?? null) as FormValue
			])
		);
	}

	// Gespeicherter Stand (base) und Entwurf (Eingaben) – KEIN Autosave
	let basePhones = $state<Contact[]>(untrack(() => toRows(member.phones)));
	let baseEmails = $state<Contact[]>(untrack(() => toRows(member.emails)));
	let baseValues = $state<FormValues>(initialValues());
	let phones = $state<Contact[]>(untrack(() => toRows(member.phones)));
	let emails = $state<Contact[]>(untrack(() => toRows(member.emails)));
	let values = $state<FormValues>(initialValues());

	const contactsDirty = $derived(
		JSON.stringify([clean(phones), clean(emails)]) !==
			JSON.stringify([clean(basePhones), clean(baseEmails)])
	);
	const valuesDirty = $derived(JSON.stringify(values) !== JSON.stringify(baseValues));
	$effect(() => {
		ondirty?.(contactsDirty || valuesDirty);
	});

	let open = $state(untrack(() => startOpen));
	let tab = $state<'contacts' | 'fields'>('contacts');
	let busy = $state(false);
	let issues = $state<Record<string, string>>({});
	let formError = $state<string | null>(null);

	const activeDirty = $derived(tab === 'contacts' ? contactsDirty : valuesDirty);
	const phoneErrors = $derived(contactErrors(issues, 'phones'));
	const emailErrors = $derived(contactErrors(issues, 'emails'));
	const fieldErrors = $derived(
		Object.fromEntries(
			Object.entries(issues)
				.filter(([k]) => !/^(phones|emails)(\.|$)/.test(k))
				.map(([k, v]) => [k.replace(/^(values|custom)\./, ''), v])
		)
	);

	const groupsText = $derived(member.groups.map((g) => g.name).join(', '));
	const subtitle = $derived(
		[member.scoutName ? `Fahrtenname: ${member.scoutName}` : null, groupsText || 'Keine Gruppe']
			.filter(Boolean)
			.join(' · ')
	);
	// Fehler, die einem sichtbaren Feld zugeordnet sind, stehen dort – das Banner nur ohne Zuordnung
	const hasFieldIssue = $derived(
		Object.keys(issues).some((k) => /^(phones|emails)(\.|$)/.test(k)) ||
			Object.keys(fieldErrors).some((k) => visible.some((f) => f.key === k))
	);
	// Zähler je Speicherstand: Rückgängig gilt nur für den jeweils letzten Stand
	let contactsSeq = 0;
	let valuesSeq = 0;
	const uid = $props.id();

	function discard() {
		issues = {};
		formError = null;
		if (tab === 'contacts') {
			phones = clone(basePhones);
			emails = clone(baseEmails);
		} else values = clone(baseValues);
	}

	async function putContacts(next: { phones: Contact[]; emails: Contact[] }) {
		await apiFetch(`${MY_BASE}/my/members/${member.id}/contacts`, {
			method: 'PUT',
			body: JSON.stringify(next)
		});
	}
	async function putValues(next: FormValues) {
		await apiFetch(`${MY_BASE}/my/members/${member.id}/fields`, {
			method: 'PUT',
			body: JSON.stringify({ values: next })
		});
	}

	async function save() {
		if (!canEdit || !activeDirty || busy) return;
		busy = true;
		issues = {};
		formError = null;
		try {
			if (tab === 'contacts') {
				const before = { phones: clone(basePhones), emails: clone(baseEmails) };
				const next = { phones: clean(phones), emails: clean(emails) };
				await putContacts(next);
				const seq = ++contactsSeq;
				basePhones = clone(next.phones);
				baseEmails = clone(next.emails);
				phones = clone(next.phones);
				emails = clone(next.emails);
				toastWithUndo({
					message: 'Kontakte gespeichert',
					undo: async () => {
						if (seq !== contactsSeq) throw new Error('Veraltet');
						// weitergetippter Entwurf bleibt erhalten: nur bei sauberem Stand auch die Eingaben zurücksetzen
						const wasClean = !contactsDirty;
						await putContacts(before);
						contactsSeq++;
						basePhones = clone(before.phones);
						baseEmails = clone(before.emails);
						if (wasClean) {
							phones = clone(before.phones);
							emails = clone(before.emails);
						}
					}
				});
			} else {
				const before = clone(baseValues);
				const next = clone(values);
				await putValues(next);
				const seq = ++valuesSeq;
				baseValues = clone(next);
				toastWithUndo({
					message: 'Angaben gespeichert',
					undo: async () => {
						if (seq !== valuesSeq) throw new Error('Veraltet');
						const wasClean = !valuesDirty;
						await putValues(before);
						valuesSeq++;
						baseValues = clone(before);
						if (wasClean) values = clone(before);
					}
				});
			}
		} catch (e) {
			issues = issuesFrom(e);
			formError = errorText(e, 'Speichern war nicht möglich. Bitte versuche es erneut.');
		} finally {
			busy = false;
		}
	}
</script>

<Card>
	<CardHeader>
		<div class="flex flex-wrap items-center gap-3">
			<EntityAvatar name={memberName(member)} size={40} />
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-center gap-2">
					<h2 class="font-semibold">{memberName(member)}</h2>
					{#if member.relation}<Badge variant="secondary">{member.relation}</Badge>{/if}
					{#if !canEdit}<Badge variant="outline">Nur Ansicht</Badge>{/if}
				</div>
				<p class="text-xs text-muted-foreground">{subtitle}</p>
			</div>
			{#if collapsible}
				<Button
					variant="ghost"
					size="icon"
					aria-label={open
						? `${memberName(member)} einklappen`
						: `${memberName(member)} ausklappen`}
					aria-expanded={open}
					aria-controls="{uid}-body"
					onclick={() => (open = !open)}
				>
					<ChevronDown class={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
				</Button>
			{/if}
		</div>
		{#if open}
			<p class="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
				<Lock class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
				Diese Angaben pflegt die Stammesleitung. Änderungen bitte dort melden.
			</p>
		{/if}
	</CardHeader>

	{#if open}
		<CardContent id="{uid}-body" class="space-y-4">
			{#if formError && !hasFieldIssue}
				<Alert variant="destructive"
					><AlertDescription role="alert">{formError}</AlertDescription></Alert
				>
			{/if}

			<Tabs.Root bind:value={tab}>
				<Tabs.List variant="line" class="mb-2">
					<Tabs.Trigger value="contacts">Kontakte{contactsDirty ? ' •' : ''}</Tabs.Trigger>
					{#if visible.length}
						<Tabs.Trigger value="fields">Zusatzfelder{valuesDirty ? ' •' : ''}</Tabs.Trigger>
					{/if}
				</Tabs.List>

				<Tabs.Content value="contacts" class="grid max-w-2xl gap-6">
					<ContactListField
						id="{uid}-phones"
						label="Telefonnummern"
						type="tel"
						valueLabel="Telefonnummer"
						valuePlaceholder="z. B. 0151 1234567"
						addLabel="Telefonnummer hinzufügen"
						bind:items={phones}
						errors={phoneErrors}
						listError={issues.phones ?? null}
						readonly={!canEdit}
						disabled={busy}
					/>
					<ContactListField
						id="{uid}-emails"
						label="E-Mail-Adressen"
						type="email"
						valueLabel="E-Mail-Adresse"
						valuePlaceholder="name@example.org"
						addLabel="E-Mail-Adresse hinzufügen"
						bind:items={emails}
						errors={emailErrors}
						listError={issues.emails ?? null}
						readonly={!canEdit}
						disabled={busy}
					/>
				</Tabs.Content>

				{#if visible.length}
					<Tabs.Content value="fields" class="grid max-w-2xl gap-6">
						{#if canEdit}
							<p class="text-xs text-muted-foreground">Alle Angaben sind freiwillig.</p>
						{/if}
						{#if normalFields.length}
							<FormRenderer
								definition={{ version: 1, fields: normalFields }}
								bind:values
								errors={fieldErrors}
								idPrefix="{uid}-f"
								disabled={!canEdit || busy}
							/>
						{/if}
						{#if sensitiveFields.length}
							<div class="grid gap-3 rounded-lg border p-4">
								<div class="flex items-start gap-2">
									<ShieldAlert class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
									<div>
										<p class="text-sm font-medium">Gesundheitsangaben</p>
										<p class="text-xs text-muted-foreground">
											Gesundheitsdaten: Nur die Leitung deines Stammes sieht sie, sie sind für
											Fahrten gedacht.
										</p>
									</div>
								</div>
								<FormRenderer
									definition={{ version: 1, fields: sensitiveFields }}
									bind:values
									errors={fieldErrors}
									idPrefix="{uid}-s"
									disabled={!canEdit || busy}
								/>
							</div>
						{/if}
					</Tabs.Content>
				{/if}
			</Tabs.Root>

			{#if canEdit}
				<div
					class="sticky bottom-0 z-10 -mx-6 flex flex-wrap items-center justify-between gap-2 border-t bg-card px-6 py-3 sm:static sm:z-auto sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0"
				>
					<p class="text-xs text-muted-foreground" aria-live="polite">
						{activeDirty ? 'Ungespeicherte Änderungen' : ''}
					</p>
					<div class="flex gap-2">
						<Button variant="ghost" disabled={!activeDirty || busy} onclick={discard}>
							Verwerfen
						</Button>
						<Button disabled={!activeDirty || busy} onclick={save}>
							{busy ? 'Speichert …' : 'Speichern'}
						</Button>
					</div>
				</div>
			{/if}
		</CardContent>
	{/if}
</Card>
