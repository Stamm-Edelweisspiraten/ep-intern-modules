<script lang="ts">
	/** Mehrzeiliger Text (Zeilenumbrüche bleiben), lange Texte eingeklappt mit „Mehr anzeigen“. */
	let {
		text,
		limit = 280,
		lines = 4,
		class: className = ''
	}: { text: string; limit?: number; lines?: number; class?: string } = $props();

	const uid = $props.id();
	let expanded = $state(false);

	const long = $derived(text.length > limit || text.split('\n').length > lines);
</script>

<div class={className}>
	<p
		id="{uid}-text"
		class={['break-words whitespace-pre-line', long && !expanded && 'line-clamp-4']}
	>
		{text}
	</p>
	{#if long}
		<button
			type="button"
			class="mt-1 text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
			aria-expanded={expanded}
			aria-controls="{uid}-text"
			onclick={() => (expanded = !expanded)}
		>
			{expanded ? 'Weniger anzeigen' : 'Mehr anzeigen'}
		</button>
	{/if}
</div>
