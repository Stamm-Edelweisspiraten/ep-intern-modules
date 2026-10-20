<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField } from '$lib/components/layout';
	import { ANNUAL_PLACEHOLDERS } from '../schemas';

	let {
		subject = $bindable(''),
		body = $bindable(''),
		pdfText = $bindable(''),
		disabled = false,
		errors = {}
	}: {
		subject: string;
		body: string;
		pdfText: string;
		disabled?: boolean;
		errors?: Record<string, string>;
	} = $props();

	type Field = 'subject' | 'body' | 'pdfText';
	let subjectEl = $state<HTMLInputElement | null>(null);
	let bodyEl = $state<HTMLTextAreaElement | null>(null);
	let pdfEl = $state<HTMLTextAreaElement | null>(null);
	/** Zuletzt fokussiertes Feld – dort werden Platzhalter eingefügt */
	let active = $state<Field>('body');

	function insert(token: string) {
		if (disabled) return;
		const el = active === 'subject' ? subjectEl : active === 'body' ? bodyEl : pdfEl;
		const current = active === 'subject' ? subject : active === 'body' ? body : pdfText;
		const start = el?.selectionStart ?? current.length;
		const end = el?.selectionEnd ?? current.length;
		const next = current.slice(0, start) + token + current.slice(end);
		if (active === 'subject') subject = next;
		else if (active === 'body') body = next;
		else pdfText = next;
		const pos = start + token.length;
		queueMicrotask(() => {
			el?.focus();
			el?.setSelectionRange(pos, pos);
		});
	}

	const activeLabel = $derived(
		active === 'subject' ? 'Betreff' : active === 'body' ? 'Mail-Text' : 'PDF-Text'
	);
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Nachricht</Card.Title>
		<Card.Description>
			Text der Mail und des Rechnungs-PDFs. Platzhalter werden je Familie ersetzt.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		<FormField label="Betreff *" id="annual-subject" error={errors.mailSubject}>
			<Input
				id="annual-subject"
				bind:ref={subjectEl}
				bind:value={subject}
				maxlength={150}
				{disabled}
				aria-invalid={!!errors.mailSubject}
				onfocus={() => (active = 'subject')}
			/>
		</FormField>
		<div class="grid gap-4 lg:grid-cols-2">
			<FormField label="Mail-Text *" id="annual-body" error={errors.mailBody}>
				<Textarea
					id="annual-body"
					bind:ref={bodyEl}
					bind:value={body}
					rows={10}
					maxlength={5000}
					{disabled}
					aria-invalid={!!errors.mailBody}
					onfocus={() => (active = 'body')}
				/>
			</FormField>
			<FormField
				label="PDF-Text *"
				id="annual-pdf"
				error={errors.pdfText}
				hint="Steht im PDF über der Aufschlüsselung."
			>
				<Textarea
					id="annual-pdf"
					bind:ref={pdfEl}
					bind:value={pdfText}
					rows={10}
					maxlength={3000}
					{disabled}
					aria-invalid={!!errors.pdfText}
					aria-describedby="annual-pdf-hint"
					onfocus={() => (active = 'pdfText')}
				/>
			</FormField>
		</div>
		{#if !disabled}
			<div class="space-y-1.5">
				<span class="text-xs text-muted-foreground">
					Platzhalter einfügen in: <strong class="text-foreground">{activeLabel}</strong>
				</span>
				<div class="flex flex-wrap gap-1.5" role="group" aria-label="Platzhalter einfügen">
					{#each ANNUAL_PLACEHOLDERS as [token, description] (token)}
						<button
							type="button"
							title={description}
							class="rounded-md border px-2 py-1 font-mono text-xs transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
							onmousedown={(e) => e.preventDefault()}
							onclick={() => insert(token)}
						>
							{token}
						</button>
					{/each}
				</div>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
