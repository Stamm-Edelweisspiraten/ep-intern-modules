<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { formatEuro } from '$lib/components/layout/money';
	import PdfEmbed from '$lib/components/layout/PdfEmbed.svelte';
	import type { AnnualMailPreview, AnnualPreviewInvoice } from '../schemas';
	import { BASE, errorMessage } from './helpers';

	let {
		runId,
		invoices,
		mode,
		loading = false,
		stamp,
		showEmails = true
	}: {
		runId: string;
		invoices: AnnualPreviewInvoice[];
		mode: 'run' | 'catch-up';
		/** Empfängerliste lädt noch */
		loading?: boolean;
		/** steigt nach jedem Speichern – Vorschau neu laden */
		stamp: number;
		/** E-Mail-Adressen sichtbar (`treasury.invoice.send` oder `.edit`); sonst liefert der Server keine */
		showEmails?: boolean;
	} = $props();

	let key = $state<string | null>(null);
	const keys = $derived(invoices.map((i) => i.key).join('|'));

	// Auswahl gültig halten: unbekannter Schlüssel → erste Rechnung
	$effect(() => {
		void keys;
		untrack(() => {
			if (!invoices.length) key = null;
			else if (!key || !invoices.some((i) => i.key === key)) key = invoices[0]!.key;
		});
	});

	const options = $derived(
		invoices.map((i) => ({
			value: i.key,
			label: `${i.recipientName} · ${formatEuro(i.totalCents)}`
		}))
	);

	let mail = $state<AnnualMailPreview | null>(null);
	let mailError = $state('');
	let pdfUrl = $state<string | null>(null);
	let pdfError = $state('');
	let busy = $state(false);
	let req = 0;

	function setPdfUrl(url: string | null) {
		if (pdfUrl) URL.revokeObjectURL(pdfUrl);
		pdfUrl = url;
	}

	/** Gleicher Modus wie die Empfängerliste (`run` vor, `catch-up` nach dem Versand) */
	const query = (m: 'run' | 'catch-up', k: string) =>
		new URLSearchParams({ mode: m, key: k }).toString();

	async function fetchPdf(id: string, q: string): Promise<string> {
		const res = await fetch(`/api/v1${BASE}/annual-fees/${id}/preview.pdf?${q}`, {
			credentials: 'same-origin'
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as {
				error?: { message?: string };
			} | null;
			throw new Error(body?.error?.message ?? 'PDF konnte nicht erstellt werden');
		}
		// Nur echte PDFs anzeigen; Typ fest setzen statt ihn vom Server zu übernehmen
		if (!res.headers.get('content-type')?.toLowerCase().startsWith('application/pdf')) {
			throw new Error('PDF konnte nicht erstellt werden');
		}
		return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'application/pdf' }));
	}

	async function load(id: string, m: 'run' | 'catch-up', k: string) {
		const my = ++req;
		busy = true;
		mailError = '';
		pdfError = '';
		const q = query(m, k);
		const [mailRes, p] = await Promise.allSettled([
			apiFetch<AnnualMailPreview>(`${BASE}/annual-fees/${id}/preview-mail?${q}`),
			fetchPdf(id, q)
		]);
		if (my !== req) {
			if (p.status === 'fulfilled') URL.revokeObjectURL(p.value);
			return;
		}
		if (mailRes.status === 'fulfilled') mail = mailRes.value;
		else {
			mail = null;
			mailError = errorMessage(mailRes.reason, 'Mail-Vorschau konnte nicht erstellt werden');
		}
		if (p.status === 'fulfilled') setPdfUrl(p.value);
		else {
			setPdfUrl(null);
			pdfError = p.reason instanceof Error ? p.reason.message : 'PDF konnte nicht erstellt werden';
		}
		busy = false;
	}

	$effect(() => {
		const id = runId;
		const m = mode;
		const k = key;
		void stamp;
		if (!k) {
			untrack(() => {
				req++;
				mail = null;
				setPdfUrl(null);
				busy = false;
			});
			return;
		}
		untrack(() => void load(id, m, k));
	});

	onDestroy(() => {
		if (pdfUrl) URL.revokeObjectURL(pdfUrl);
	});

	function openPdf() {
		if (pdfUrl) window.open(pdfUrl, '_blank', 'noopener');
	}

	/** Mail-Text ohne Core-Layout: Grundschrift wie in der versendeten Mail */
	const mailDoc = (html: string) =>
		`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:12px;font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2937;background:#fff}</style></head><body>${html}</body></html>`;
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Vorschau</Card.Title>
		<Card.Description>
			{mode === 'catch-up'
				? 'So sieht die Rechnung für nachberechnete Mitglieder aus.'
				: 'So kommen Mail und Rechnungs-PDF bei der gewählten Familie an.'}
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if loading && !invoices.length}
			<Skeleton class="h-64 w-full" />
		{:else if !invoices.length}
			<p class="text-sm text-muted-foreground">
				{mode === 'catch-up'
					? 'Keine Mitglieder offen – alle sind abgerechnet.'
					: 'Keine Rechnungen – es gibt niemanden abzurechnen.'}
			</p>
		{:else}
			<div class="flex flex-wrap items-center gap-2">
				<SelectField
					class="w-full sm:w-96"
					label="Familie für die Vorschau"
					{options}
					bind:value={key}
				/>
				{#if busy}<span class="text-xs text-muted-foreground" aria-live="polite">Lädt …</span>{/if}
			</div>
			<div class="grid min-w-0 gap-4 lg:grid-cols-2">
				<section class="min-w-0 space-y-2" aria-label="Mail-Vorschau">
					<h3 class="text-sm font-semibold">Mail</h3>
					{#if mailError}
						<p class="text-sm text-destructive" role="alert">{mailError}</p>
					{:else if mail}
						<dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-sm">
							<dt class="text-muted-foreground">Betreff</dt>
							<dd class="min-w-0 font-medium break-words">{mail.subject}</dd>
							<dt class="text-muted-foreground">An</dt>
							<dd class="min-w-0 break-all">
								{#if !showEmails}
									<span class="text-muted-foreground">–</span>
								{:else if mail.to.length}
									{mail.to.join(', ')}
								{:else}
									<span class="text-warning">keine E-Mail-Adresse – nur Rechnung, keine Mail</span>
								{/if}
							</dd>
						</dl>
						<iframe
							title="Mail-Vorschau"
							sandbox=""
							srcdoc={mailDoc(mail.html)}
							class="h-[60dvh] w-full rounded-md border bg-white"
						></iframe>
					{:else}
						<Skeleton class="h-[60dvh] w-full" />
					{/if}
				</section>
				<section class="min-w-0 space-y-2" aria-label="PDF-Vorschau">
					<div class="flex items-center justify-between gap-2">
						<h3 class="text-sm font-semibold">Rechnungs-PDF</h3>
						<Button size="sm" variant="outline" onclick={openPdf} disabled={!pdfUrl}>
							<ExternalLink /> PDF öffnen
						</Button>
					</div>
					{#if pdfError}
						<p class="text-sm text-destructive" role="alert">{pdfError}</p>
					{:else if pdfUrl}
						<PdfEmbed
							url={pdfUrl}
							title="Rechnungs-PDF"
							fileName="Rechnung.pdf"
							class="h-[70dvh]"
						/>
					{:else}
						<Skeleton class="h-[70dvh] w-full" />
					{/if}
				</section>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
