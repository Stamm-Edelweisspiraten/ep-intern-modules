<script lang="ts">
	// Reservieren aus der Merkliste: Titel (Pflicht), Aktion (optional), Notiz → POST /reservations.
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField } from '$lib/components/layout';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { reservationInput, type Reservation, type ReservationLineInput } from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors, formatPeriod } from '../helpers';

	let {
		open = $bindable(false),
		from,
		to,
		lines,
		suggestedTitle,
		actionId: initialAction = null,
		actions,
		actionsLoading = false,
		onsaved,
		onconflict
	}: {
		open?: boolean;
		from: string;
		to: string;
		lines: ReservationLineInput[];
		suggestedTitle: string;
		actionId?: string | null;
		/** Sichtbare Aktionen; leer = keine Auswahl anbieten */
		actions: { id: string; name: string }[];
		actionsLoading?: boolean;
		onsaved: (reservation: Reservation) => void | Promise<void>;
		/** 409: Positionen mit Engpass (Index wie `lines`) */
		onconflict: (lines: { index: number; message: string }[]) => void;
	} = $props();

	let title = $state('');
	let actionId = $state<string | null>(null);
	let notes = $state('');
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let busy = $state(false);

	// Beim Öffnen vorbelegen
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			title = suggestedTitle;
			actionId = initialAction;
			notes = '';
			errors = {};
			formError = '';
		}
		wasOpen = open;
	});

	const actionOptions = $derived(actions.map((a) => ({ value: a.id, label: a.name })));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		formError = '';
		const parsed = reservationInput.safeParse({
			title,
			actionId,
			startsOn: from,
			endsOn: to,
			notes,
			lines
		});
		if (!parsed.success) {
			errors = fieldErrors(parsed.error.issues);
			if (errors.title) document.getElementById('reserve-title')?.focus();
			else formError = Object.values(errors)[0] ?? 'Bitte prüfe deine Angaben.';
			return;
		}
		errors = {};
		busy = true;
		try {
			const saved = await apiFetch<Reservation>(`${API}/reservations`, {
				method: 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success('Material reserviert');
			open = false;
			await onsaved(saved);
		} catch (err) {
			if (err instanceof ApiClientError && err.status === 409) {
				const d = err.details as { lines?: { index: number; message: string }[] } | undefined;
				const list = d?.lines ?? [];
				onconflict(list);
				formError = list.length
					? 'Inzwischen ist nicht mehr alles frei. Die betroffenen Positionen sind in der Merkliste markiert.'
					: errorText(err, 'Im Zeitraum ist nicht alles frei.');
			} else {
				errors = apiFieldErrors(err);
				formError = Object.keys(errors).length
					? 'Bitte prüfe die markierten Felder.'
					: errorText(err, 'Reservieren fehlgeschlagen.');
			}
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Reservieren</Dialog.Title>
			<Dialog.Description class="tabular-nums">
				{formatPeriod(from, to)} · {lines.length}
				{lines.length === 1 ? 'Position' : 'Positionen'}
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField label="Titel" id="reserve-title" required error={errors.title}>
				<Input
					id="reserve-title"
					name="title"
					bind:value={title}
					maxlength={150}
					autocomplete="off"
				/>
			</FormField>
			{#if actionOptions.length || actionsLoading}
				<FormField
					label="Aktion"
					id="reserve-action"
					hint="Optional – die Reservierung erscheint dann in der Aktion."
					error={errors.actionId}
				>
					<SelectField
						id="reserve-action"
						label="Aktion"
						options={actionOptions}
						bind:value={actionId}
						emptyLabel="Keine Aktion"
						placeholder={actionsLoading ? 'Lädt …' : 'Keine Aktion'}
						disabled={actionsLoading}
					/>
				</FormField>
			{/if}
			<FormField label="Notiz" id="reserve-notes" error={errors.notes}>
				<Textarea id="reserve-notes" name="notes" rows={3} bind:value={notes} />
			</FormField>
			{#if formError}
				<p class="text-sm text-destructive" role="alert">{formError}</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? 'Reserviert …' : 'Reservieren'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
