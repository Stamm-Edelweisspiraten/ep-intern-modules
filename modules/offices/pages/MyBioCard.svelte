<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { MAX_BIO, bioInput, type MyOffices } from '../schemas';
	import { BASE, errorText, issuesToErrors } from './helpers';

	/** Persönliche Beschreibung für alle eigenen Ämter: Entwurf + Speichern (kein Autosave). */
	let {
		my,
		onsaved,
		ondirty
	}: {
		my: MyOffices;
		onsaved?: (my: MyOffices) => void;
		ondirty?: (dirty: boolean) => void;
	} = $props();

	const uid = $props.id();
	const fieldId = `${uid}-bio`;

	let draft = $state(untrack(() => my.bio ?? ''));
	let saved = $state(untrack(() => my.bio ?? ''));
	let busy = $state(false);
	let error = $state('');

	const dirty = $derived(draft.trim() !== saved.trim());
	const officeNames = $derived(my.offices.map((o) => o.name).join(', '));
	const length = $derived(draft.length);

	$effect(() => {
		ondirty?.(dirty);
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		error = '';
		const parsed = bioInput.safeParse({ bio: draft });
		if (!parsed.success) {
			error = Object.values(issuesToErrors(parsed.error.issues))[0] ?? 'Ungültige Eingabe';
			return;
		}
		busy = true;
		try {
			const next = await apiFetch<MyOffices>(`${BASE}/me/bio`, {
				method: 'PUT',
				body: JSON.stringify(parsed.data)
			});
			saved = next.bio ?? '';
			draft = saved;
			toast.success('Beschreibung gespeichert');
			onsaved?.(next);
		} catch (err) {
			error = errorText(err, 'Speichern fehlgeschlagen');
		} finally {
			busy = false;
		}
	}

	function reset() {
		draft = saved;
		error = '';
	}
</script>

<Card>
	<CardHeader>
		<CardTitle>Meine Beschreibung</CardTitle>
		<CardDescription>
			Gilt für alle deine Ämter{officeNames ? `: ${officeNames}` : ''}. Sie erscheint bei deinem
			Namen in der Ämter-Übersicht.
		</CardDescription>
	</CardHeader>
	<CardContent>
		<form class="space-y-3" onsubmit={save} novalidate>
			<div class="grid gap-1.5">
				<Label for={fieldId} class="sr-only">Meine Beschreibung</Label>
				<Textarea
					id={fieldId}
					bind:value={draft}
					rows={5}
					maxlength={MAX_BIO}
					placeholder="Z. B. was du in deinem Amt machst und wie man dich erreicht."
					aria-invalid={!!error}
					aria-describedby="{fieldId}-count{error ? ` ${fieldId}-error` : ''}"
				/>
				<div class="flex items-start justify-between gap-3">
					{#if error}
						<p id="{fieldId}-error" role="alert" class="text-xs text-destructive">{error}</p>
					{:else}
						<span></span>
					{/if}
					<p
						id="{fieldId}-count"
						class={[
							'shrink-0 text-xs tabular-nums',
							length >= MAX_BIO ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
						]}
					>
						{length.toLocaleString('de-DE')} / {MAX_BIO.toLocaleString('de-DE')} Zeichen
					</p>
				</div>
			</div>
			<div class="flex flex-wrap justify-end gap-2">
				{#if dirty}
					<Button type="button" variant="outline" onclick={reset} disabled={busy}>Verwerfen</Button>
				{/if}
				<Button type="submit" disabled={busy || !dirty}>
					{busy ? 'Speichert …' : 'Speichern'}
				</Button>
			</div>
		</form>
	</CardContent>
</Card>
