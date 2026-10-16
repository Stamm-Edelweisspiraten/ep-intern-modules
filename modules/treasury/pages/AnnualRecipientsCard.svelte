<script lang="ts">
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import * as Table from '$lib/components/ui/table';
	import { DataTable } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { FEE_LEVEL_LABELS, type AnnualPreview, type AnnualPreviewMember } from '../schemas';

	let {
		preview,
		mode,
		loading = false,
		error = '',
		onretry,
		showEmails = true
	}: {
		preview: AnnualPreview | null;
		mode: 'run' | 'catch-up';
		loading?: boolean;
		error?: string;
		onretry?: () => void;
		/** E-Mail-Adressen sichtbar (`treasury.invoice.send` oder `.edit`); sonst liefert der Server keine */
		showEmails?: boolean;
	} = $props();

	function memberNote(m: AnnualPreviewMember): string | null {
		if (m.note === 'late-entry') return 'nur Stamm (Eintritt nach 28.02.)';
		if (m.note === 'secondary') {
			const levels = m.levels.map((l) => FEE_LEVEL_LABELS[l]).join(', ');
			return `Zweitmitglied: ${levels || 'keine Ebene'}`;
		}
		return null;
	}

	const addressCount = $derived(
		new Set((preview?.invoices ?? []).flatMap((i) => i.emails.map((e) => e.toLowerCase()))).size
	);
	const names = (list: { name: string }[]) => list.map((m) => m.name).join(', ');
</script>

<DataTable
	caption="Empfänger des Jahresbeitrags"
	title={mode === 'catch-up' ? 'Noch nicht abgerechnet' : 'Empfänger'}
	description={mode === 'catch-up'
		? 'Mitglieder, die seit dem Versand dazugekommen sind und noch keine Rechnung für dieses Jahr haben.'
		: 'Eine Sammelrechnung je Familie bzw. Mitglied ohne Zahler.'}
	{loading}
	{error}
	empty={!preview?.invoices.length}
	emptyTitle={mode === 'catch-up' ? 'Alle abgerechnet' : 'Keine Empfänger'}
	emptyDescription={mode === 'catch-up'
		? 'Es gibt keine neuen Mitglieder für dieses Beitragsjahr.'
		: 'Zum Stichtag gibt es keine Mitglieder mit Beitrag.'}
>
	{#snippet toolbar()}
		{#if preview}
			<div class="w-full space-y-3">
				<dl class="grid grid-cols-3 gap-2 text-sm sm:max-w-md">
					<div>
						<dt class="text-xs text-muted-foreground">Rechnungen</dt>
						<dd class="text-lg font-semibold tabular-nums">{preview.invoices.length}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Mitglieder</dt>
						<dd class="text-lg font-semibold tabular-nums">{preview.memberCount}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Summe</dt>
						<dd class="text-lg font-semibold tabular-nums">{formatEuro(preview.totalCents)}</dd>
					</div>
				</dl>
				{#if preview.invoices.length && showEmails}
					<p class="text-xs text-muted-foreground">
						Mails gehen an {addressCount}
						{addressCount === 1 ? 'Adresse' : 'Adressen'}.
					</p>
				{/if}
				{#if preview.withoutEmail.length || preview.skipped.length || preview.payerSuggestions > 0}
					<ul
						class="space-y-1.5 rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
					>
						{#if preview.withoutEmail.length}
							<li class="flex gap-2">
								<TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
								<span>
									<strong>Ohne E-Mail</strong> ({preview.withoutEmail.length}): {names(
										preview.withoutEmail
									)} – die Rechnung entsteht trotzdem, die Mail nicht.
								</span>
							</li>
						{/if}
						{#if preview.skipped.length}
							<li class="flex gap-2">
								<TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
								<span>
									<strong>Ohne Beitrag</strong> ({preview.skipped.length}): {names(preview.skipped)}
									– keine Rechnung (0 €).
								</span>
							</li>
						{/if}
						{#if preview.payerSuggestions > 0}
							<li class="flex gap-2">
								<TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
								<span>
									{preview.payerSuggestions}
									{preview.payerSuggestions === 1 ? 'Mitglied hat' : 'Mitglieder haben'} Geschwister ohne
									Zahler – unter <strong>Mehr → Zahler &amp; Familien</strong> zusammenfassen, dann gibt
									es eine Sammelrechnung.
								</span>
							</li>
						{/if}
					</ul>
				{/if}
			</div>
		{/if}
	{/snippet}
	{#snippet head()}
		<Table.Row>
			<Table.Head>Empfänger / Familie</Table.Head>
			<Table.Head>Mitglieder</Table.Head>
			<Table.Head>E-Mail</Table.Head>
			<Table.Head class="text-right">Betrag</Table.Head>
		</Table.Row>
	{/snippet}
	{#each preview?.invoices ?? [] as inv (inv.key)}
		<Table.Row>
			<Table.Cell class="max-w-56 align-top">
				<div class="truncate font-medium">{inv.recipientName}</div>
				{#if inv.payerId}<div class="text-xs text-muted-foreground">Zahler</div>{/if}
			</Table.Cell>
			<Table.Cell class="min-w-48 align-top">
				<ul class="space-y-0.5">
					{#each inv.members as m (m.memberId)}
						{@const note = memberNote(m)}
						<li>
							<span>{m.name}</span>
							<span class="text-xs text-muted-foreground tabular-nums">
								· {formatEuro(m.totalCents)}</span
							>
							{#if note}<div class="text-xs text-muted-foreground">{note}</div>{/if}
						</li>
					{/each}
				</ul>
			</Table.Cell>
			<Table.Cell class="max-w-64 align-top">
				{#if !showEmails}
					<span class="text-xs text-muted-foreground">–</span>
				{:else if inv.emails.length}
					{#each inv.emails as email (email)}
						<div class="truncate text-xs">{email}</div>
					{/each}
				{:else}
					<span class="text-xs text-amber-700 dark:text-amber-400">keine</span>
				{/if}
			</Table.Cell>
			<Table.Cell class="text-right align-top font-medium tabular-nums">
				{formatEuro(inv.totalCents)}
			</Table.Cell>
		</Table.Row>
	{/each}
	{#snippet footer()}
		{#if error && onretry}
			<button type="button" class="text-sm underline" onclick={onretry}>Erneut versuchen</button>
		{/if}
	{/snippet}
</DataTable>
