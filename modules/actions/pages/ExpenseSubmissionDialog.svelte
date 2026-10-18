<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Loader from '@lucide/svelte/icons/loader-circle';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, MoneyInput, formatEuro, openProtectedFile } from '$lib/components/layout';
	import {
		CALC_CATEGORIES,
		CALC_CATEGORY_LABELS,
		EXPENSE_SUBMISSION_STATUS_LABELS,
		expenseAcceptInput,
		type AccountingState,
		type CalcCategory,
		type ExpenseSubmission
	} from '../schemas';
	import { fmtDate } from './format';

	let {
		open = $bindable(false),
		actionId,
		submission,
		batch = null,
		editable,
		closed,
		ondone
	}: {
		open?: boolean;
		actionId: string;
		submission: ExpenseSubmission | null;
		/** Position in einer gemeinsamen Einreichung mehrerer Auslagen (`null` = einzeln) */
		batch?: { index: number; count: number } | null;
		editable: boolean;
		closed: boolean;
		ondone: () => void;
	} = $props();

	const base = $derived(`/modules/actions/actions/${actionId}`);
	const receiptHref = $derived(
		submission ? `/api/v1${base}/expense-submissions/${submission.id}/receipt` : ''
	);
	const categoryOptions = CALC_CATEGORIES.map((c) => ({
		value: c,
		label: CALC_CATEGORY_LABELS[c]
	}));

	// Korrigierbare Werte
	let category = $state<string | null>(null);
	let description = $state('');
	let amountCents = $state(0);
	let expenseDate = $state('');
	let payeeId = $state<string | null>(null);
	let payees = $state<{ value: string; label: string }[]>([]);
	let errors = $state<Record<string, string>>({});
	let busy = $state<'' | 'accept' | 'reject'>('');

	// Ablehnen
	let rejecting = $state(false);
	let reason = $state('');
	let notify = $state(false);

	// Beleg-Vorschau
	let previewUrl = $state<string | null>(null);
	let previewType = $state('');
	let previewError = $state('');
	let previewLoading = $state(false);

	const pending = $derived(submission?.status === 'pending');
	const canDecide = $derived(editable && pending);

	let loadedFor = '';
	$effect(() => {
		if (!open || !submission) return;
		if (loadedFor === submission.id) return;
		loadedFor = submission.id;
		const s = submission;
		untrack(() => {
			category = s.category;
			description = s.description;
			amountCents = s.amountCents;
			expenseDate = s.expenseDate;
			payeeId = null;
			errors = {};
			rejecting = false;
			reason = '';
			notify = !!s.submitterEmail;
			void loadPreview(s);
			if (editable && s.status === 'pending') void loadPayees();
		});
	});

	$effect(() => {
		if (open) return;
		loadedFor = '';
		untrack(clearPreview);
	});

	function clearPreview() {
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = null;
		previewType = '';
		previewError = '';
	}

	async function loadPreview(s: ExpenseSubmission) {
		clearPreview();
		if (!s.receipt) return;
		previewLoading = true;
		try {
			const res = await fetch(`/api/v1${base}/expense-submissions/${s.id}/receipt`, {
				credentials: 'same-origin'
			});
			if (!res.ok) {
				previewError =
					res.status === 403
						? 'Keine Berechtigung, Belege anzusehen.'
						: res.status === 503
							? 'Die Belegablage ist gerade nicht erreichbar.'
							: 'Der Beleg konnte nicht geladen werden.';
				return;
			}
			const blob = await res.blob();
			if (loadedFor !== s.id) return;
			previewType = blob.type || s.receipt.contentType;
			previewUrl = URL.createObjectURL(blob);
		} catch {
			previewError = 'Der Beleg konnte nicht geladen werden.';
		} finally {
			previewLoading = false;
		}
	}

	async function loadPayees() {
		try {
			const st = await apiFetch<AccountingState>(`${base}/accounting`);
			const list = st.payees
				? st.payees.map((p) => ({
						value: p.id,
						label: p.ibanMasked ? `${p.name} (${p.ibanMasked})` : p.name
					}))
				: [
						...new Map(
							st.entries
								.filter((e) => e.payee)
								.map((e) => [e.payee!.id, { value: e.payee!.id, label: e.payee!.name }])
						).values()
					];
			payees = list.sort((a, b) => a.label.localeCompare(b.label, 'de'));
		} catch {
			payees = [];
		}
	}

	function toFieldErrors(details: unknown): Record<string, string> {
		const out: Record<string, string> = {};
		if (Array.isArray(details)) {
			for (const i of details as { path?: unknown[]; message?: string }[]) {
				const key = String(i.path?.[0] ?? '');
				if (key && !out[key]) out[key] = i.message ?? 'Ungültig';
			}
		} else if (details && typeof details === 'object') {
			for (const [k, v] of Object.entries(details as Record<string, unknown>)) out[k] = String(v);
		}
		return out;
	}

	async function accept() {
		if (!submission || busy) return;
		const payload = {
			category: (category ?? submission.category) as CalcCategory,
			description,
			amountCents,
			expenseDate,
			payeeId
		};
		const check = expenseAcceptInput.safeParse(payload);
		if (!check.success) {
			errors = toFieldErrors(check.error.issues);
			return;
		}
		errors = {};
		busy = 'accept';
		try {
			await apiFetch(`${base}/expense-submissions/${submission.id}/accept`, {
				method: 'POST',
				body: JSON.stringify(check.data)
			});
			toast.success('Auslage in die Abrechnung übernommen');
			open = false;
			ondone();
		} catch (e) {
			if (e instanceof ApiClientError && e.status === 422) {
				errors = toFieldErrors(e.details);
			}
			toast.error(e instanceof ApiClientError ? e.message : 'Übernehmen fehlgeschlagen.');
			if (e instanceof ApiClientError && e.status === 409) ondone();
		} finally {
			busy = '';
		}
	}

	async function reject() {
		if (!submission || busy) return;
		busy = 'reject';
		try {
			const r = await apiFetch<{ emailSent: boolean }>(
				`${base}/expense-submissions/${submission.id}/reject`,
				{
					method: 'POST',
					body: JSON.stringify({ reason: reason.trim() || null, notify })
				}
			);
			toast.success(
				notify && submission.submitterEmail
					? r.emailSent
						? 'Abgelehnt – die Person wurde per E-Mail informiert'
						: 'Abgelehnt – die E-Mail konnte nicht gesendet werden'
					: 'Auslage abgelehnt'
			);
			open = false;
			ondone();
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Ablehnen fehlgeschlagen.');
			if (e instanceof ApiClientError && e.status === 409) ondone();
		} finally {
			busy = '';
		}
	}

	const fmtStamp = (iso: string) =>
		new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
	const statusVariant = (s: ExpenseSubmission['status']) =>
		s === 'pending' ? 'secondary' : s === 'accepted' ? 'default' : 'destructive';
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		{#if submission}
			<Dialog.Header>
				<Dialog.Title class="flex flex-wrap items-center gap-2">
					Auslage von {submission.submitterName}
					<Badge variant={statusVariant(submission.status)}>
						{EXPENSE_SUBMISSION_STATUS_LABELS[submission.status]}
					</Badge>
				</Dialog.Title>
				<Dialog.Description>
					Eingereicht am {fmtStamp(submission.createdAt)} über den Kosten-Link.
					{#if batch}
						Auslage {batch.index} von {batch.count} aus einer gemeinsamen Einreichung.
					{/if}
				</Dialog.Description>
			</Dialog.Header>

			<div class="grid gap-5">
				<dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
					<div>
						<dt class="text-muted-foreground text-xs">Name</dt>
						<dd>{submission.submitterName}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground text-xs">E-Mail</dt>
						<dd class="break-all">{submission.submitterEmail ?? '—'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground text-xs">Kontoinhaber*in</dt>
						<dd>{submission.accountHolder ?? '—'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground text-xs">IBAN / BIC</dt>
						<dd class="tabular-nums">
							{submission.ibanMasked ?? '—'}{submission.bic ? ` · ${submission.bic}` : ''}
						</dd>
					</div>
					{#if !canDecide}
						<div>
							<dt class="text-muted-foreground text-xs">Kategorie</dt>
							<dd>{CALC_CATEGORY_LABELS[submission.category]}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground text-xs">Betrag · Datum</dt>
							<dd class="tabular-nums">
								{formatEuro(submission.amountCents)} · {fmtDate(submission.expenseDate)}
							</dd>
						</div>
						<div class="sm:col-span-2">
							<dt class="text-muted-foreground text-xs">Wofür</dt>
							<dd>{submission.description}</dd>
						</div>
					{/if}
					{#if submission.note}
						<div class="sm:col-span-2">
							<dt class="text-muted-foreground text-xs">Hinweis der Person</dt>
							<dd class="whitespace-pre-line">{submission.note}</dd>
						</div>
					{/if}
					{#if submission.decidedAt}
						<div class="sm:col-span-2">
							<dt class="text-muted-foreground text-xs">Entscheidung</dt>
							<dd>
								{EXPENSE_SUBMISSION_STATUS_LABELS[submission.status]} am {fmtStamp(
									submission.decidedAt
								)}{submission.decidedBy
									? ` von ${submission.decidedBy.name}`
									: ''}{submission.rejectReason ? ` – ${submission.rejectReason}` : ''}
							</dd>
						</div>
					{/if}
				</dl>

				<section class="grid gap-2" aria-label="Beleg">
					<div class="flex items-center justify-between gap-2">
						<h3 class="text-sm font-semibold">Beleg</h3>
						{#if submission.receipt && !previewError}
							<Button
								size="sm"
								variant="outline"
								onclick={() =>
									openProtectedFile(receiptHref, { fallbackName: submission?.receipt?.name })}
							>
								<ExternalLink /> Öffnen
							</Button>
						{/if}
					</div>
					{#if !submission.receipt}
						<p class="text-muted-foreground text-sm">
							{submission.status === 'rejected'
								? 'Der Beleg wurde beim Ablehnen gelöscht.'
								: 'Kein Beleg vorhanden.'}
						</p>
					{:else if previewLoading}
						<div class="bg-muted/40 flex h-48 items-center justify-center rounded-md border">
							<Loader class="text-muted-foreground size-5 animate-spin" aria-label="Beleg lädt" />
						</div>
					{:else if previewError}
						<p class="text-muted-foreground text-sm">{previewError}</p>
					{:else if previewUrl && previewType.startsWith('image/')}
						<img
							src={previewUrl}
							alt="Beleg {submission.receipt.name}"
							class="bg-muted/30 max-h-96 w-full rounded-md border object-contain"
						/>
					{:else if previewUrl}
						<iframe
							src={previewUrl}
							title="Beleg {submission.receipt.name}"
							class="h-96 w-full rounded-md border"
						></iframe>
					{/if}
				</section>

				{#if canDecide}
					{#if closed}
						<p
							class="bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 text-xs"
							role="note"
						>
							Die Abrechnung ist abgeschlossen. Zum Übernehmen bitte zuerst wieder öffnen; ablehnen
							geht auch so.
						</p>
					{/if}
					<fieldset class="grid gap-4" disabled={closed || !!busy}>
						<legend class="mb-2 text-sm font-semibold">Für die Abrechnung</legend>
						<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<FormField label="Kategorie" id="exs-category" error={errors.category}>
								<SelectField
									id="exs-category"
									label="Kategorie"
									options={categoryOptions}
									bind:value={category}
									disabled={closed || !!busy}
								/>
							</FormField>
							<FormField label="Betrag (€)" id="exs-amount" error={errors.amountCents}>
								<MoneyInput
									id="exs-amount"
									label="Betrag in Euro"
									bind:cents={amountCents}
									disabled={closed || !!busy}
									invalid={!!errors.amountCents}
								/>
							</FormField>
							<FormField label="Beschreibung" id="exs-description" error={errors.description}>
								<Input
									id="exs-description"
									bind:value={description}
									maxlength={200}
									aria-invalid={!!errors.description}
								/>
							</FormField>
							<FormField label="Datum" id="exs-date" error={errors.expenseDate}>
								<Input
									id="exs-date"
									type="date"
									bind:value={expenseDate}
									aria-invalid={!!errors.expenseDate}
								/>
							</FormField>
						</div>
						<FormField
							label="Erstattung an"
							id="exs-payee"
							error={errors.payeeId}
							hint="Ohne Auswahl wird die Person mit den eingereichten Kontodaten angelegt (bzw. eine gleichnamige mit gleicher IBAN wiederverwendet)."
						>
							<SelectField
								id="exs-payee"
								label="Erstattung an"
								options={payees}
								bind:value={payeeId}
								emptyLabel="Aus den eingereichten Kontodaten"
								placeholder="Aus den eingereichten Kontodaten"
								disabled={closed || !!busy}
							/>
						</FormField>
					</fieldset>

					{#if rejecting}
						<div class="grid gap-3 rounded-md border p-3">
							<FormField label="Grund (optional)" id="exs-reason">
								<Textarea id="exs-reason" bind:value={reason} rows={2} maxlength={300} />
							</FormField>
							<div class="flex items-start gap-2">
								<Checkbox
									id="exs-notify"
									checked={notify}
									onCheckedChange={(v) => (notify = v === true)}
									disabled={!submission.submitterEmail}
									class="mt-0.5"
								/>
								<div class="grid gap-0.5">
									<Label for="exs-notify">Person per E-Mail informieren</Label>
									<p class="text-muted-foreground text-xs">
										{submission.submitterEmail
											? 'Die E-Mail enthält den Grund, aber keine Kontodaten.'
											: 'Keine E-Mail-Adresse angegeben.'}
									</p>
								</div>
							</div>
							<p class="text-muted-foreground text-xs">
								Beim Ablehnen werden Kontodaten und Beleg gelöscht.
							</p>
						</div>
					{/if}
				{/if}
			</div>

			<Dialog.Footer class="gap-2">
				{#if canDecide}
					{#if rejecting}
						<Button variant="outline" disabled={!!busy} onclick={() => (rejecting = false)}>
							Zurück
						</Button>
						<Button variant="destructive" disabled={!!busy} onclick={reject}>
							{busy === 'reject' ? 'Lehnt ab …' : 'Endgültig ablehnen'}
						</Button>
					{:else}
						<Button variant="outline" disabled={!!busy} onclick={() => (rejecting = true)}>
							Ablehnen
						</Button>
						<Button disabled={!!busy || closed} onclick={accept}>
							{busy === 'accept' ? 'Übernimmt …' : 'In Abrechnung übernehmen'}
						</Button>
					{/if}
				{:else}
					<Button variant="outline" onclick={() => (open = false)}>Schließen</Button>
				{/if}
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
