<script lang="ts">
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Info from '@lucide/svelte/icons/info';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { formatEuro } from '$lib/components/layout/money';
	import type { AnnualPreview } from '../schemas';

	/** „Vor dem Versand“: bündelt die Warnungen der Vorschau direkt am Senden-Schritt */
	let {
		preview,
		loading,
		onreview
	}: {
		preview: AnnualPreview | null;
		loading: boolean;
		/** Zurück zur Vorschau (Schritt 3) */
		onreview: () => void;
	} = $props();

	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

	type Item = { level: 'ok' | 'warn' | 'info'; text: string };
	const items = $derived.by<Item[]>(() => {
		if (!preview) return [];
		const out: Item[] = [];
		if (!preview.invoices.length) {
			out.push({ level: 'warn', text: 'Keine Empfänger – es gibt nichts zu versenden.' });
			return out;
		}
		out.push({
			level: 'ok',
			text: `${plural(preview.invoices.length, 'Rechnung', 'Rechnungen')} für ${plural(preview.memberCount, 'Mitglied', 'Mitglieder')}, zusammen ${formatEuro(preview.totalCents)}.`
		});
		if (preview.withoutEmail.length) {
			out.push({
				level: 'warn',
				text: `${plural(preview.withoutEmail.length, 'Mitglied hat', 'Mitglieder haben')} keine E-Mail-Adresse – die Rechnung entsteht, aber es geht keine Mail raus.`
			});
		}
		if (preview.payerSuggestions > 0) {
			out.push({
				level: 'warn',
				text: `${plural(preview.payerSuggestions, 'Mitglied hat', 'Mitglieder haben')} Geschwister ohne gemeinsamen Zahler – unter „Mehr → Zahler & Familien“ zusammenfassen, sonst gibt es mehrere Rechnungen.`
			});
		}
		if (preview.skipped.length) {
			out.push({
				level: 'info',
				text: `${plural(preview.skipped.length, 'Mitglied hat', 'Mitglieder haben')} keinen Beitrag (0 €) und ${preview.skipped.length === 1 ? 'wird' : 'werden'} übersprungen.`
			});
		}
		return out;
	});
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Vor dem Versand</Card.Title>
		<Card.Description>Das passiert, wenn du jetzt sendest.</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-3">
		{#if loading && !preview}
			<p class="text-sm text-muted-foreground">Prüft die Empfänger …</p>
		{:else if !preview}
			<p class="text-sm text-muted-foreground">Die Vorschau ist nicht verfügbar.</p>
		{:else}
			<ul class="space-y-2 text-sm">
				{#each items as it, i (i)}
					<li class="flex items-start gap-2">
						{#if it.level === 'ok'}
							<CircleCheck class="mt-0.5 size-4 shrink-0 text-success" aria-label="In Ordnung" />
						{:else if it.level === 'warn'}
							<TriangleAlert
								class="mt-0.5 size-4 shrink-0 text-warning"
								aria-label="Bitte prüfen"
							/>
						{:else}
							<Info class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Hinweis" />
						{/if}
						<span>{it.text}</span>
					</li>
				{/each}
			</ul>
			<Button size="sm" variant="outline" onclick={onreview}>Empfänger ansehen</Button>
		{/if}
	</Card.Content>
</Card.Root>
