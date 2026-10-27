<script lang="ts">
	// Eine Spalte der Seite „Ausgabe & Rückgabe“: anstehende Ausgaben bzw. erwartete Rückgaben als
	// Liste mit Linien. Je Zeile Titel, Fälligkeit, Zeitraum, Positionen, von – Primär-Textaktion
	// („Ausgeben“/„Zurücknehmen“) und „Ausgabeliste (PDF)“.
	import { ErrorState, LoadingState } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import type { ReservationListItem } from '../../schemas';
	import { formatPeriod, reservationHref } from '../helpers';
	import { dueText } from './handout';

	let {
		kind,
		title,
		items,
		today,
		loading = false,
		error = '',
		busyId = null,
		pdfBusyId = null,
		emptyText,
		onretry,
		onaction,
		onpdf
	}: {
		kind: 'issue' | 'return';
		title: string;
		items: ReservationListItem[];
		today: string;
		loading?: boolean;
		error?: string;
		/** Zeile, deren Dialog gerade lädt */
		busyId?: string | null;
		/** Zeile, deren PDF gerade erstellt wird */
		pdfBusyId?: string | null;
		emptyText: string;
		onretry: () => void;
		onaction: (item: ReservationListItem) => void;
		onpdf: (item: ReservationListItem) => void;
	} = $props();

	const headingId = $derived(`handout-${kind}`);
	const actionLabel = $derived(kind === 'issue' ? 'Ausgeben' : 'Zurücknehmen');
</script>

<section class="min-w-0 space-y-2" aria-labelledby={headingId}>
	<h2 id={headingId} class="flex items-baseline gap-2 text-section">
		{title}
		{#if !loading && !error}
			<span class="text-sm font-normal text-muted-foreground tabular-nums">{items.length}</span>
		{/if}
	</h2>

	{#if loading && !items.length}
		<LoadingState label={title} rows={3} rowClass="h-16 w-full" />
	{:else if error}
		<ErrorState message={error} {onretry} compact />
	{:else if !items.length}
		<p class="border-y py-6 text-sm text-muted-foreground">{emptyText}</p>
	{:else}
		<ul class="divide-y border-y">
			{#each items as r (r.id)}
				{@const due = dueText(kind, r, today)}
				<li class={['space-y-1 py-3', r.overdue ? 'border-l-2 border-l-destructive pl-3' : '']}>
					<div class="flex items-baseline justify-between gap-3">
						<a
							href={reservationHref(r.id)}
							class="min-w-0 truncate font-medium underline-offset-4 hover:underline"
						>
							{r.title}
						</a>
						<span
							class={[
								'shrink-0 text-sm tabular-nums',
								due.tone === 'destructive'
									? 'font-medium text-destructive'
									: due.tone === 'warning'
										? 'text-warning'
										: 'text-muted-foreground'
							]}
						>
							{due.text}
						</span>
					</div>
					<p class="text-sm text-muted-foreground">
						<span class="tabular-nums">{formatPeriod(r.startsOn, r.endsOn)}</span>
						· von {r.createdByName}
						{#if r.actionName}· {r.actionName}{/if}
					</p>
					{#if r.itemSummary}
						<p class="line-clamp-2 text-sm" title={r.itemSummary}>{r.itemSummary}</p>
					{/if}
					<div class="-ml-2 flex flex-wrap items-center gap-1 pt-0.5">
						<Button
							variant="link"
							size="sm"
							class="px-2 font-medium"
							disabled={busyId === r.id}
							aria-label={`${actionLabel}: ${r.title}`}
							onclick={() => onaction(r)}
						>
							{busyId === r.id ? 'Lädt …' : actionLabel}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							class="px-2 text-muted-foreground"
							disabled={pdfBusyId === r.id}
							aria-label={`Ausgabeliste (PDF): ${r.title}`}
							onclick={() => onpdf(r)}
						>
							{pdfBusyId === r.id ? 'Erstellt …' : 'Ausgabeliste (PDF)'}
						</Button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
