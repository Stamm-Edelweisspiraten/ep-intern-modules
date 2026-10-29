<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { AssistButton } from '$lib/components/layout';
	import { DISCLAIMER_PLACEHOLDERS } from '../schemas';

	let {
		value = $bindable(''),
		preview,
		actionId,
		disabled = false
	}: {
		value: string;
		/** Aktion für die Schreibhilfe (Eckdaten) */
		actionId?: string;
		/** Gerenderter Text des letzten Serverstands */
		preview: string;
		disabled?: boolean;
	} = $props();

	let el = $state<HTMLTextAreaElement | null>(null);

	function insert(key: string) {
		if (disabled) return;
		const token = `{{${key}}}`;
		const start = el?.selectionStart ?? value.length;
		const end = el?.selectionEnd ?? value.length;
		value = value.slice(0, start) + token + value.slice(end);
		const pos = start + token.length;
		queueMicrotask(() => {
			el?.focus();
			el?.setSelectionRange(pos, pos);
		});
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex flex-col gap-1.5">
		<div class="flex items-center justify-between gap-2">
			<Label for="disclaimer-text">Text</Label>
			<AssistButton
				config={{
					module: 'actions',
					purpose: 'registration-disclaimer',
					context: actionId ? { module: 'actions', kind: 'action', id: actionId } : undefined
				}}
				{disabled}
				text={() => value}
				onapply={(v) => (value = v)}
			/>
		</div>
		<Textarea
			id="disclaimer-text"
			bind:ref={el}
			bind:value
			rows={9}
			maxlength={5000}
			{disabled}
			aria-describedby="disclaimer-hint"
		/>
		<p id="disclaimer-hint" class="text-muted-foreground text-xs">
			Die Kontodaten stehen in den Einstellungen des Moduls „Aktionen“.
		</p>
	</div>

	{#if !disabled}
		<div class="flex flex-col gap-1.5">
			<span class="text-muted-foreground text-xs">Platzhalter einfügen</span>
			<div class="flex flex-wrap gap-1.5" role="group" aria-label="Platzhalter einfügen">
				{#each DISCLAIMER_PLACEHOLDERS as ph (ph.key)}
					<button
						type="button"
						title={ph.label}
						class="hover:bg-muted focus-visible:ring-ring/50 rounded-md border px-2 py-1 font-mono text-xs transition-colors outline-none focus-visible:ring-3"
						onclick={() => insert(ph.key)}
					>
						{`{{${ph.key}}}`}
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<div class="flex flex-col gap-1.5">
		<span class="text-sm font-medium">Vorschau</span>
		<div class="bg-muted/50 rounded-lg px-3 py-2 text-sm whitespace-pre-line" aria-live="polite">
			{preview || 'Keine Vorschau verfügbar.'}
		</div>
		<p class="text-muted-foreground text-xs">Vorschau aktualisiert sich nach dem Speichern.</p>
	</div>
</div>
