<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { FormField, AssistRichTextEditor } from '$lib/components/layout';
	import { BUSY_SAVE } from '$lib/components/layout/busy';
	import { MAX_FAQ_QUESTION, faqInput, type Faq } from '../schemas';
	import { BASE, detailsToErrors, errorText, issuesToErrors } from './helpers';

	let {
		open = $bindable(false),
		faq = null,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neue Frage anlegen */
		faq?: Faq | null;
		onsaved: () => void;
	} = $props();

	let question = $state('');
	let answerHtml = $state('');
	let featured = $state(true);
	let active = $state(true);
	let busy = $state(false);
	let errors = $state<Record<string, string>>({});

	$effect(() => {
		if (!open) return;
		const f = untrack(() => faq);
		question = f?.question ?? '';
		answerHtml = f?.answerHtml ?? '';
		featured = f?.featured ?? true;
		active = f?.active ?? true;
		errors = {};
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const parsed = faqInput.safeParse({ question, answerHtml, featured, active });
		if (!parsed.success) {
			errors = issuesToErrors(parsed.error.issues);
			return;
		}
		if (!answerHtml.replace(/<[^>]*>/g, '').trim()) {
			errors = { answerHtml: 'Pflichtfeld' };
			return;
		}
		busy = true;
		try {
			await apiFetch(faq ? `${BASE}/faqs/${faq.id}` : `${BASE}/faqs`, {
				method: faq ? 'PUT' : 'POST',
				body: JSON.stringify(parsed.data)
			});
			toast.success(faq ? 'Frage gespeichert' : 'Frage angelegt');
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
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{faq ? 'Frage bearbeiten' : 'Frage anlegen'}</Dialog.Title>
			<Dialog.Description>Erscheint unter „Häufige Fragen“ auf der Stammeswebsite.</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField label="Frage" id="faq-question" required error={errors.question}>
				<Input id="faq-question" bind:value={question} maxlength={MAX_FAQ_QUESTION} />
			</FormField>
			<div class="space-y-1.5">
				<Label for="faq-answer">Antwort *</Label>
				<AssistRichTextEditor
					id="faq-answer"
					label="Antwort"
					bind:value={answerHtml}
					assist={{ module: 'website', purpose: 'faq-answer', extra: () => ({ question }) }}
					minHeight="8rem"
					invalid={!!errors.answerHtml}
					describedby={errors.answerHtml ? 'faq-answer-error' : undefined}
				/>
				{#if errors.answerHtml}
					<p id="faq-answer-error" class="text-xs text-destructive" role="alert">
						{errors.answerHtml}
					</p>
				{/if}
			</div>
			<div class="flex flex-col gap-3 sm:flex-row sm:gap-6">
				<div class="flex items-center gap-2">
					<Switch id="faq-active" bind:checked={active} />
					<Label for="faq-active">Auf der Website zeigen</Label>
				</div>
				<div class="flex items-center gap-2">
					<Switch id="faq-featured" bind:checked={featured} disabled={!active} />
					<Label for="faq-featured">Auch auf der Startseite</Label>
				</div>
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
