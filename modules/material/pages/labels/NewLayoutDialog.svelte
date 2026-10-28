<script lang="ts">
	// Neues Etikett: Startpunkt wählen → Designer (`labels/new?starter=…`), gespeichert wird dort.
	import { goto } from '$app/navigation';
	import { LABEL_FORMAT_PRESETS } from '$lib/sdk/labels';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { BASE_PATH, LABEL_TARGET_LABELS } from '../../schemas';
	import LabelPreview from '../shared/LabelPreview.svelte';
	import { sampleValues } from './designer';
	import { LABEL_STARTERS, starterLayout } from './starters';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const starters = LABEL_STARTERS.map((s) => {
		const preset = LABEL_FORMAT_PRESETS.find((p) => p.key === s.formatKey);
		return {
			starter: s,
			formatName: preset?.name ?? s.formatKey,
			layout: starterLayout(s, s.widthMm, s.heightMm)
		};
	});

	async function choose(id: string) {
		open = false;
		await goto(`${BASE_PATH}/labels/new?starter=${encodeURIComponent(id)}`);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>Neues Etikett</Dialog.Title>
			<Dialog.Description>
				Wähle einen Startpunkt – Größe, Ziel und alle Elemente kannst du danach im Designer ändern.
			</Dialog.Description>
		</Dialog.Header>
		<ul class="grid gap-3 sm:grid-cols-2">
			{#each starters as s (s.starter.id)}
				<li>
					<button
						type="button"
						class="flex h-full w-full flex-col gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
						onclick={() => choose(s.starter.id)}
					>
						<div class="flex h-28 w-full items-center justify-center rounded-md bg-muted/60 p-2">
							{#if s.layout.elements.length}
								<LabelPreview
									layout={s.layout}
									values={sampleValues(s.starter.target)}
									maxWidth={220}
									maxHeight={96}
									class="shadow-sm"
								/>
							{:else}
								<span class="text-sm text-muted-foreground">Leer</span>
							{/if}
						</div>
						<span class="font-medium">{s.starter.name}</span>
						<span class="text-xs text-muted-foreground">{s.starter.description}</span>
						<span class="mt-auto flex flex-wrap gap-1">
							<Badge variant="secondary">{LABEL_TARGET_LABELS[s.starter.target]}</Badge>
							<Badge variant="outline" class="max-w-full truncate">{s.formatName}</Badge>
						</span>
					</button>
				</li>
			{/each}
		</ul>
	</Dialog.Content>
</Dialog.Root>
