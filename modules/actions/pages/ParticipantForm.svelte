<script lang="ts">
	import { todayBerlin } from '$lib/sdk/dates';
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField, BUSY_SAVE } from '$lib/components/layout';
	import {
		DIETS,
		DIET_LABELS,
		PARTICIPANT_ROLES,
		PARTICIPANT_ROLE_LABELS,
		participantInput,
		type Participant
	} from '../schemas';

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
			notes: notes || null
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
				<Input
					id="p-name"
					bind:value={name}
					required
					maxlength={150}
					aria-invalid={!!fieldErrors.name}
					aria-describedby={fieldErrors.name ? 'p-name-error' : undefined}
				/>
			</FormField>
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

			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer sticky>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
