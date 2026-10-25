<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField } from '$lib/components/layout';
	import { BUSY_SAVE } from '$lib/components/layout/busy';
	import { MAX_BANNER_TEXT, bannerInput, type Banner } from '../schemas';
	import {
		BASE,
		detailsToErrors,
		errorText,
		fromLocalInput,
		issuesToErrors,
		toLocalInput
	} from './helpers';

	let {
		open = $bindable(false),
		banner = null,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neuen Banner anlegen */
		banner?: Banner | null;
		onsaved: () => void;
	} = $props();

	let title = $state('');
	let text = $state('');
	let level = $state<string | null>('info');
	let placement = $state<string | null>('bar');
	let linkUrl = $state('');
	let linkLabel = $state('');
	let startsAt = $state('');
	let endsAt = $state('');
	let dismissible = $state(true);
	let active = $state(true);
	let busy = $state(false);
	let errors = $state<Record<string, string>>({});

	$effect(() => {
		if (!open) return;
		const b = untrack(() => banner);
		title = b?.title ?? '';
		text = b?.text ?? '';
		level = b?.level ?? 'info';
		placement = b?.placement ?? 'bar';
		linkUrl = b?.linkUrl ?? '';
		linkLabel = b?.linkLabel ?? '';
		startsAt = toLocalInput(b?.startsAt);
		endsAt = toLocalInput(b?.endsAt);
		dismissible = b?.dismissible ?? true;
		active = b?.active ?? true;
		errors = {};
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const input = {
			title,
			text,
			level,
			placement,
			linkUrl,
			linkLabel,
			startsAt: fromLocalInput(startsAt),
			endsAt: fromLocalInput(endsAt),
			dismissible,
			active
		};
		const parsed = bannerInput.safeParse(input);
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			document.getElementById(`banner-${Object.keys(errors)[0]}`)?.focus();
			return;
		}
		busy = true;
		try {
			await apiFetch(banner ? `${BASE}/banners/${banner.id}` : `${BASE}/banners`, {
				method: banner ? 'PUT' : 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success(banner ? 'Banner gespeichert' : 'Banner angelegt');
			open = false;
			onsaved();
		} catch (err) {
			if (err instanceof ApiClientError) errors = detailsToErrors(err.details);
			toast.error(errorText(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{banner ? 'Banner bearbeiten' : 'Banner anlegen'}</Dialog.Title>
			<Dialog.Description>
				Kurzer Hinweis auf der Stammeswebsite, z. B. zu Ferien oder Anmeldefristen.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Ort" id="banner-placement" error={errors.placement}>
					<SelectField
						id="banner-placement"
						label="Ort"
						bind:value={placement}
						options={[
							{ value: 'bar', label: 'Leiste oben auf allen Seiten' },
							{ value: 'home', label: 'Kasten auf der Startseite' }
						]}
					/>
				</FormField>
				<FormField label="Stufe" id="banner-level" error={errors.level}>
					<SelectField
						id="banner-level"
						label="Stufe"
						bind:value={level}
						options={[
							{ value: 'info', label: 'Hinweis' },
							{ value: 'important', label: 'Wichtig' }
						]}
					/>
				</FormField>
			</div>
			<FormField label="Überschrift" id="banner-title" error={errors.title} hint="Optional, fett vor dem Text">
				<Input id="banner-title" bind:value={title} maxlength={100} />
			</FormField>
			<FormField
				label="Text"
				id="banner-text"
				required
				error={errors.text}
				hint={`${text.length} / ${MAX_BANNER_TEXT} Zeichen`}
			>
				<Textarea id="banner-text" bind:value={text} rows={3} maxlength={MAX_BANNER_TEXT} />
			</FormField>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField
					label="Link"
					id="banner-linkUrl"
					error={errors.linkUrl}
					hint="z. B. /termine oder https://…"
				>
					<Input id="banner-linkUrl" bind:value={linkUrl} autocomplete="off" />
				</FormField>
				<FormField label="Linktext" id="banner-linkLabel" error={errors.linkLabel} hint="z. B. „Zu den Terminen“">
					<Input id="banner-linkLabel" bind:value={linkLabel} maxlength={60} />
				</FormField>
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Sichtbar ab" id="banner-startsAt" error={errors.startsAt} hint="Leer = sofort">
					<Input id="banner-startsAt" type="datetime-local" bind:value={startsAt} />
				</FormField>
				<FormField label="Sichtbar bis" id="banner-endsAt" error={errors.endsAt} hint="Leer = ohne Ende">
					<Input id="banner-endsAt" type="datetime-local" bind:value={endsAt} />
				</FormField>
			</div>
			<div class="flex flex-col gap-3 sm:flex-row sm:gap-6">
				<div class="flex items-center gap-2">
					<Switch id="banner-active" bind:checked={active} />
					<Label for="banner-active">Eingeschaltet</Label>
				</div>
				<div class="flex items-center gap-2">
					<Switch id="banner-dismissible" bind:checked={dismissible} />
					<Label for="banner-dismissible">Besucher*innen dürfen ihn schließen</Label>
				</div>
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
