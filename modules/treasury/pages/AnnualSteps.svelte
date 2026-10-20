<script module lang="ts">
	export type StepState = 'done' | 'todo' | 'warn';
	export interface Step {
		label: string;
		hint: string;
		state: StepState;
	}
</script>

<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	/** Schrittleiste des Beitragslaufs: Sätze → Texte → Vorschau → Senden */
	let {
		steps,
		current,
		onselect
	}: {
		steps: Step[];
		current: number;
		onselect: (index: number) => void;
	} = $props();
</script>

<nav aria-label="Schritte des Beitragslaufs">
	<ol class="grid grid-cols-2 gap-2 sm:grid-cols-4">
		{#each steps as s, i (s.label)}
			<li>
				<button
					type="button"
					class="flex h-full w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50 {i ===
					current
						? 'border-primary bg-primary/5'
						: ''}"
					aria-current={i === current ? 'step' : undefined}
					onclick={() => onselect(i)}
				>
					<span
						class="flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold {s.state ===
						'done'
							? 'bg-emerald-600 text-white'
							: s.state === 'warn'
								? 'bg-amber-500 text-white'
								: i === current
									? 'bg-primary text-primary-foreground'
									: 'bg-muted text-muted-foreground'}"
					>
						{#if s.state === 'done'}
							<Check class="size-3.5" aria-label="Erledigt" />
						{:else if s.state === 'warn'}
							<TriangleAlert class="size-3.5" aria-label="Bitte prüfen" />
						{:else}
							{i + 1}
						{/if}
					</span>
					<span class="min-w-0">
						<span class="block truncate font-medium">{s.label}</span>
						<span class="block truncate text-xs text-muted-foreground">{s.hint}</span>
					</span>
				</button>
			</li>
		{/each}
	</ol>
</nav>
