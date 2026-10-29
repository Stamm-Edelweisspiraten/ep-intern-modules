<script lang="ts">
	import { todayBerlin } from '$lib/sdk/dates';
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { AssistTextarea, FormField, BUSY_SAVE } from '$lib/components/layout';
	import { actionInput, type ActionSummary } from '../schemas';

	let {
		open = $bindable(false),
		action = null,
		onsaved
	}: {
		open?: boolean;
		action?: ActionSummary | null;
		onsaved: (saved: ActionSummary) => void | Promise<void>;
	} = $props();

	let name = $state('');
	let description = $state('');
	let location = $state('');
	let startsOn = $state('');
	let startsTime = $state('');
	let endsOn = $state('');
	let endsTime = $state('');
	let isPast = $state(false);
	// Nach manueller Wahl keine automatische Vorbelegung mehr
	let pastTouched = $state(false);
	let busy = $state(false);
	let error = $state('');
	let fieldErrors = $state<Record<string, string>>({});

	$effect(() => {
		if (!open) return;
		const a = action;
		name = a?.name ?? '';
		description = a?.description ?? '';
		location = a?.location ?? '';
		startsOn = a?.startsOn ?? '';
		startsTime = a?.startsTime ?? '';
		endsOn = a?.endsOn ?? '';
		endsTime = a?.endsTime ?? '';
		isPast = a?.isPast ?? false;
		pastTouched = !!a;
		error = '';
		fieldErrors = {};
		busy = false;
	});

	const todayIso = () => todayBerlin();
	// Beim Anlegen: liegt die Aktion (Ende, sonst Start) in der Vergangenheit, wird die Checkbox
	// vorgeschlagen – eine laufende mehrtägige Aktion zählt nicht als vergangen
	$effect(() => {
		if (!open || action || pastTouched || !startsOn) return;
		isPast = (endsOn || startsOn) < todayIso();
	});

	const ids: Record<string, string> = {
		name: 'a-name',
		description: 'a-description',
		location: 'a-location',
		startsOn: 'a-starts-on',
		startsTime: 'a-starts-time',
		endsOn: 'a-ends-on',
		endsTime: 'a-ends-time'
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
		const parsed = actionInput.safeParse({
			name,
			description: description || null,
			location: location || null,
			startsOn,
			startsTime: startsTime || null,
			endsOn: endsOn || null,
			endsTime: endsTime || null,
			isPast
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
		try {
			const saved = action
				? await apiFetch<ActionSummary>(`/modules/actions/actions/${action.id}`, {
						method: 'PUT',
						body: JSON.stringify(parsed.data)
					})
				: await apiFetch<ActionSummary>('/modules/actions/actions', {
						method: 'POST',
						body: JSON.stringify(parsed.data)
					});
			toast.success(action ? 'Aktion gespeichert' : 'Aktion angelegt');
			open = false;
			await onsaved(saved);
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
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{action ? 'Aktion bearbeiten' : 'Aktion anlegen'}</Dialog.Title>
			<Dialog.Description>Pflichtfelder sind mit * markiert.</Dialog.Description>
		</Dialog.Header>

		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField label="Name *" id="a-name" error={fieldErrors.name}>
				<Input
					id="a-name"
					bind:value={name}
					required
					maxlength={150}
					aria-invalid={!!fieldErrors.name}
					aria-describedby={fieldErrors.name ? 'a-name-error' : undefined}
				/>
			</FormField>
			<FormField label="Beschreibung" id="a-description" error={fieldErrors.description}>
				<AssistTextarea
					id="a-description"
					bind:value={description}
					rows={4}
					maxlength={5000}
					assist={{
						module: 'actions',
						purpose: 'action-description',
						context: action ? { module: 'actions', kind: 'action', id: action.id } : undefined,
						extra: () => ({ name, location, startsOn, endsOn })
					}}
					aria-invalid={!!fieldErrors.description}
					aria-describedby={fieldErrors.description ? 'a-description-error' : undefined}
				/>
			</FormField>
			<FormField label="Ort" id="a-location" error={fieldErrors.location}>
				<Input
					id="a-location"
					bind:value={location}
					maxlength={200}
					aria-invalid={!!fieldErrors.location}
					aria-describedby={fieldErrors.location ? 'a-location-error' : undefined}
				/>
			</FormField>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Startdatum *" id="a-starts-on" error={fieldErrors.startsOn}>
					<Input
						id="a-starts-on"
						type="date"
						bind:value={startsOn}
						required
						aria-invalid={!!fieldErrors.startsOn}
						aria-describedby={fieldErrors.startsOn ? 'a-starts-on-error' : undefined}
					/>
				</FormField>
				<FormField label="Startuhrzeit" id="a-starts-time" error={fieldErrors.startsTime}>
					<Input
						id="a-starts-time"
						type="time"
						bind:value={startsTime}
						aria-invalid={!!fieldErrors.startsTime}
						aria-describedby={fieldErrors.startsTime ? 'a-starts-time-error' : undefined}
					/>
				</FormField>
				<FormField label="Enddatum" id="a-ends-on" error={fieldErrors.endsOn}>
					<Input
						id="a-ends-on"
						type="date"
						bind:value={endsOn}
						min={startsOn || undefined}
						aria-invalid={!!fieldErrors.endsOn}
						aria-describedby={fieldErrors.endsOn ? 'a-ends-on-error' : undefined}
					/>
				</FormField>
				<FormField label="Enduhrzeit" id="a-ends-time" error={fieldErrors.endsTime}>
					<Input
						id="a-ends-time"
						type="time"
						bind:value={endsTime}
						aria-invalid={!!fieldErrors.endsTime}
						aria-describedby={fieldErrors.endsTime ? 'a-ends-time-error' : undefined}
					/>
				</FormField>
			</div>
			<div class="flex items-start gap-2">
				<Checkbox
					id="a-is-past"
					checked={isPast}
					onCheckedChange={(v) => {
						isPast = v === true;
						pastTouched = true;
					}}
					class="mt-0.5"
				/>
				<div class="grid gap-0.5">
					<Label for="a-is-past">Diese Aktion liegt bereits in der Vergangenheit</Label>
					<p class="text-xs text-muted-foreground">
						Für Anmeldungen werden keine offenen Posten in der Kasse angelegt. Ausgaben kannst du
						direkt als bereits erstattet bzw. bezahlt erfassen.
					</p>
				</div>
			</div>

			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer sticky>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
