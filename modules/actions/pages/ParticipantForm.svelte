<script lang="ts">
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { page } from '$app/state';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import { todayBerlin } from '$lib/sdk/dates';
	import {
		DIET_LABELS,
		DIETS,
		type MemberSuggestion,
		PARTICIPANT_ROLE_LABELS,
		PARTICIPANT_ROLES,
		type Participant,
		participantInput
	} from '../schemas';
	import SuggestInput from './SuggestInput.svelte';

	let {
		open = $bindable(false),
		actionId,
		participant = null,
		healthVisible = true,
		onsaved
	}: {
		open?: boolean;
		actionId: string;
		participant?: Participant | null;
		/** Gesundheitsfelder zeigen (Sonderrecht `members.data.export`); sonst bleiben sie beim Speichern unverändert */
		healthVisible?: boolean;
		onsaved: () => void | Promise<void>;
	} = $props();

	const today = todayBerlin();

	let name = $state('');
	let groupLabel = $state('');
	let birthDate = $state('');
	let bremen = $state<string | null>(null);
	let role = $state<string | null>('participant');
	let juleica = $state(false);
	let subsidy = $state<string | null>('auto');
	let diet = $state<string | null>(null);
	let allergies = $state('');
	let notes = $state('');
	/** Aus der Mitgliederdatenbank übernommen (nur beim Anlegen) */
	let member = $state<{ id: string; name: string } | null>(null);
	let busy = $state(false);
	let error = $state('');
	let fieldErrors = $state<Record<string, string>>({});

	$effect(() => {
		if (!open) return;
		const p = participant;
		name = p?.name ?? '';
		groupLabel = p?.groupLabel ?? '';
		birthDate = p?.birthDate ?? '';
		bremen = p?.bremenResident === true ? 'yes' : p?.bremenResident === false ? 'no' : null;
		role = p?.role ?? 'participant';
		juleica = p?.juleica ?? false;
		const se = (p as { subsidyEligible?: boolean | null } | null)?.subsidyEligible;
		subsidy = se === true ? 'yes' : se === false ? 'no' : 'auto';
		diet = p?.diet ?? null;
		allergies = p?.allergies ?? '';
		notes = p?.notes ?? '';
		member = null;
		error = '';
		fieldErrors = {};
		busy = false;
	});

	const ids: Record<string, string> = {
		name: 'p-name',
		groupLabel: 'p-group',
		birthDate: 'p-birth',
		bremenResident: 'p-bremen',
		role: 'p-role',
		diet: 'p-diet',
		allergies: 'p-allergies',
		notes: 'p-notes'
	};

	async function focusFirstError() {
		await tick();
		for (const [k, id] of Object.entries(ids)) {
			if (!fieldErrors[k]) continue;
			const el = document.getElementById(id);
			if (el) {
				el.focus();
				return;
			}
		}
	}

	function applyDetails(details: unknown) {
		const out: Record<string, string> = {};
		const issues = (details as { issues?: { path?: (string | number)[]; message?: string }[] })
			?.issues;
		if (Array.isArray(issues)) {
			for (const i of issues) {
				const key = String(i.path?.[0] ?? '');
				if (key && i.message && !out[key]) out[key] = i.message;
			}
		} else if (details && typeof details === 'object') {
			for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
				const msg = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '';
				if (msg) out[k] = msg;
			}
		}
		fieldErrors = out;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		fieldErrors = {};
		const parsed = participantInput.safeParse({
			name,
			groupLabel: groupLabel || null,
			birthDate: birthDate || null,
			bremenResident: bremen === 'yes' ? true : bremen === 'no' ? false : null,
			role: role ?? 'participant',
			juleica: role === 'team' ? juleica : false,
			diet: diet || null,
			allergies: allergies || null,
			notes: notes || null,
			memberId: !participant && member ? member.id : null
		});
		if (!parsed.success) {
			const errs: Record<string, string> = {};
			for (const i of parsed.error.issues) {
				const key = String(i.path[0] ?? '');
				if (key && !errs[key]) errs[key] = i.message;
			}
			fieldErrors = errs;
			error = 'Bitte die markierten Felder prüfen.';
			void focusFirstError();
			return;
		}
		busy = true;
		const payload = {
			...parsed.data,
			subsidyEligible: subsidy === 'yes' ? true : subsidy === 'no' ? false : null
		};
		try {
			const base = `/modules/actions/actions/${actionId}/participants`;
			if (participant) {
				await apiFetch(`${base}/${participant.id}`, {
					method: 'PUT',
					body: JSON.stringify(payload)
				});
			} else {
				await apiFetch(base, { method: 'POST', body: JSON.stringify(payload) });
			}
			toast.success(participant ? 'Teilnehmende*r gespeichert' : 'Teilnehmende*r hinzugefügt');
			open = false;
			await onsaved();
		} catch (err) {
			if (err instanceof ApiClientError) {
				error = err.message;
				applyDetails(err.details);
				void focusFirstError();
			} else {
				error = 'Speichern fehlgeschlagen';
			}
		} finally {
			busy = false;
		}
	}

	const roleOptions = PARTICIPANT_ROLES.map((r) => ({
		value: r,
		label: PARTICIPANT_ROLE_LABELS[r]
	}));
	const dietOptions = DIETS.map((d) => ({ value: d, label: DIET_LABELS[d] }));
	// Bei gespeicherten Teilnehmenden ohne Festlegung das automatische Ergebnis zeigen
	const autoLabel = $derived(
		participant && participant.subsidyEligible === null
			? `Automatisch (${participant.subsidyEffective ? 'ja' : 'nein'})`
			: 'Automatisch'
	);
	const subsidyOptions = $derived([
		{ value: 'auto', label: autoLabel },
		{ value: 'yes', label: 'Ja, zuschussberechtigt' },
		{ value: 'no', label: 'Nein, nicht berechtigt' }
	]);
	// Vorschläge aus der Mitgliederdatenbank nur beim Anlegen und mit Recht `members.member.view`
	const canSuggestMembers = $derived(
		!participant && can((page.data.permissions ?? []) as string[], 'members.member.view')
	);

	function loadMembers(search: string): Promise<MemberSuggestion[]> {
		return apiFetch<MemberSuggestion[]>(
			`/modules/actions/actions/${actionId}/member-suggestions?search=${encodeURIComponent(search)}`
		);
	}

	function memberDetail(m: MemberSuggestion): string {
		const birth = m.birthDate ? m.birthDate.split('-').reverse().join('.') : null;
		return [m.groupLabel, birth].filter(Boolean).join(' · ') || 'Mitglied';
	}

	function pickMember(m: MemberSuggestion) {
		name = m.name;
		groupLabel = m.groupLabel ?? '';
		birthDate = m.birthDate ?? '';
		bremen = m.bremenResident === true ? 'yes' : m.bremenResident === false ? 'no' : null;
		if (m.diet) diet = m.diet;
		if (m.allergies) allergies = m.allergies;
		member = { id: m.id, name: m.name };
		fieldErrors = {};
	}

	const bremenOptions = [
		{ value: 'yes', label: 'Ja' },
		{ value: 'no', label: 'Nein' }
	];
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title
				>{participant ? 'Teilnehmende*n bearbeiten' : 'Teilnehmende*n hinzufügen'}</Dialog.Title
			>
			<Dialog.Description>Pflichtfelder sind mit * markiert.</Dialog.Description>
		</Dialog.Header>

		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField label="Name *" id="p-name" error={fieldErrors.name}>
				<SuggestInput
					id="p-name"
					bind:value={name}
					required
					maxlength={150}
					active={canSuggestMembers && !member}
					invalid={!!fieldErrors.name}
					describedby={fieldErrors.name ? 'p-name-error' : undefined}
					load={loadMembers}
					keyOf={(m) => m.id}
					title={(m) => m.name}
					detail={memberDetail}
					badge={(m) => (m.registered ? 'bereits angemeldet' : null)}
					onpick={pickMember}
				/>
			</FormField>
			{#if member}
				<p class="-mt-2 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
					Aus der Mitgliederdatenbank übernommen – die Teilnahme wird mit dem Mitglied verknüpft.
					<button
						type="button"
						class="underline underline-offset-2"
						onclick={() => (member = null)}
					>
						Verknüpfung lösen
					</button>
				</p>
			{:else if canSuggestMembers}
				<p class="-mt-2 text-xs text-muted-foreground">
					Namen eintippen, um ein Mitglied aus der Mitgliederdatenbank zu übernehmen.
				</p>
			{/if}
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Gruppe / Herkunft" id="p-group" error={fieldErrors.groupLabel}>
					<Input
						id="p-group"
						bind:value={groupLabel}
						maxlength={150}
						aria-invalid={!!fieldErrors.groupLabel}
						aria-describedby={fieldErrors.groupLabel ? 'p-group-error' : undefined}
					/>
				</FormField>
				<FormField label="Geburtsdatum" id="p-birth" error={fieldErrors.birthDate}>
					<Input
						id="p-birth"
						type="date"
						max={today}
						bind:value={birthDate}
						aria-invalid={!!fieldErrors.birthDate}
						aria-describedby={fieldErrors.birthDate ? 'p-birth-error' : undefined}
					/>
				</FormField>
				<FormField
					label="Wohnort Bremen/Bremerhaven"
					id="p-bremen"
					error={fieldErrors.bremenResident}
				>
					<SelectField
						id="p-bremen"
						label="Wohnort Bremen oder Bremerhaven"
						emptyLabel="Keine Angabe"
						options={bremenOptions}
						bind:value={bremen}
						invalid={!!fieldErrors.bremenResident}
					/>
				</FormField>
				<FormField label="Rolle" id="p-role" error={fieldErrors.role}>
					<SelectField
						id="p-role"
						label="Rolle"
						options={roleOptions}
						bind:value={role}
						invalid={!!fieldErrors.role}
					/>
				</FormField>
			</div>

			{#if role === 'team'}
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						class="size-4 rounded border-input accent-primary"
						bind:checked={juleica}
					/>
					Juleica vorhanden
				</label>
			{/if}

			<FormField
				label="Zuschuss"
				id="p-subsidy"
				hint="Automatisch: Wohnort Bremen/Bremerhaven und Alter bis 27 zum Aktionsstart"
			>
				<SelectField
					id="p-subsidy"
					label="Zuschuss"
					options={subsidyOptions}
					bind:value={subsidy}
				/>
			</FormField>

			{#if !healthVisible}
				<p class="text-sm text-muted-foreground">
					Ernährung, Allergien und Sonstiges sind Gesundheitsdaten. Sie sind nur mit dem Recht für
					Datenblätter und Teilnehmendenlisten (members.data.export) sichtbar und bleiben beim
					Speichern unverändert.
				</p>
			{:else}
				<FormField label="Ernährung" id="p-diet" error={fieldErrors.diet}>
					<SelectField
						id="p-diet"
						label="Ernährung"
						emptyLabel="Keine Angabe"
						options={dietOptions}
						bind:value={diet}
						invalid={!!fieldErrors.diet}
					/>
				</FormField>
				<FormField
					label="Allergien / Unverträglichkeiten"
					id="p-allergies"
					error={fieldErrors.allergies}
				>
					<Textarea
						id="p-allergies"
						bind:value={allergies}
						rows={3}
						maxlength={1000}
						aria-invalid={!!fieldErrors.allergies}
						aria-describedby={fieldErrors.allergies ? 'p-allergies-error' : undefined}
					/>
				</FormField>
				<FormField label="Sonstiges" id="p-notes" error={fieldErrors.notes}>
					<Textarea
						id="p-notes"
						bind:value={notes}
						rows={3}
						maxlength={2000}
						aria-invalid={!!fieldErrors.notes}
						aria-describedby={fieldErrors.notes ? 'p-notes-error' : undefined}
					/>
				</FormField>
			{/if}

			{#if error}
				<p class="text-sm text-destructive" role="alert">{error}</p>
			{/if}
			<Dialog.Footer sticky>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
