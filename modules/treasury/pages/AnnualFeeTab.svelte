<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { ConfirmDialog, EmptyState } from '$lib/components/layout';
	import {
		ANNUAL_RUN_STATUS_LABELS,
		FEE_LEVELS,
		annualRunUpdate,
		type AnnualPreview,
		type AnnualRun,
		type AnnualRunStatus,
		type AnnualRunUpdate,
		type FeeRates
	} from '../schemas';
	import {
		BASE,
		errorMessage,
		fieldErrorsFrom,
		fmtDate,
		issuesToErrors,
		todayIso,
		type SharedData
	} from './helpers';
	import AnnualChecklist from './AnnualChecklist.svelte';
	import AnnualMessageCard from './AnnualMessageCard.svelte';
	import AnnualPreviewCard from './AnnualPreviewCard.svelte';
	import AnnualRatesCard from './AnnualRatesCard.svelte';
	import AnnualRecipientsCard from './AnnualRecipientsCard.svelte';
	import AnnualSendCard from './AnnualSendCard.svelte';
	import AnnualSteps, { type Step } from './AnnualSteps.svelte';

	let {
		version,
		perm,
		canManage,
		onopen,
		onchanged
	}: SharedData & {
		/** `treasury.annual-fee.manage` */
		canManage: boolean;
		/** Anderen Tab der Kasse öffnen (z. B. Rechnungen) */
		onopen: (tab: string) => void;
		onchanged: () => void | Promise<void>;
	} = $props();

	type Draft = {
		rates: FeeRates;
		mailSubject: string;
		mailBody: string;
		pdfText: string;
		dueOn: string;
	};

	const currentYear = new Date().getFullYear();

	let runs = $state<AnnualRun[]>([]);
	let loading = $state(true);
	let error = $state('');
	let selectedId = $state<string | null>(null);
	const run = $derived(runs.find((r) => r.id === selectedId) ?? null);
	const runId = $derived(run?.id ?? null);
	const runStatus = $derived<AnnualRunStatus | null>(run?.status ?? null);
	const editable = $derived(!!run && run.status !== 'sent' && canManage);
	/** Der Server liefert E-Mail-Adressen der Empfänger*innen nur mit `invoice.send` oder `invoice.edit` */
	const showEmails = $derived(perm.send || perm.editInvoice);

	/** Jahr für einen neuen Lauf: nächstes Jahr, sonst das laufende – falls noch keiner existiert */
	const newYear = $derived(
		[currentYear + 1, currentYear].find((y) => !runs.some((r) => r.year === y)) ?? null
	);

	function defaultRunId(list: AnnualRun[]): string | null {
		return (list.find((r) => r.year === currentYear + 1) ?? list[0])?.id ?? null;
	}

	async function loadRuns() {
		loading = !runs.length;
		error = '';
		try {
			const list = await apiFetch<AnnualRun[]>(`${BASE}/annual-fees`);
			runs = [...list].sort((a, b) => b.year - a.year);
			if (!selectedId || !runs.some((r) => r.id === selectedId)) selectedId = defaultRunId(runs);
		} catch (e) {
			error = errorMessage(e, 'Beitragsläufe konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void version;
		untrack(() => void loadRuns());
	});

	function replaceRun(updated: AnnualRun) {
		runs = runs.map((r) => (r.id === updated.id ? updated : r));
	}

	// --- Lauf anlegen / löschen -------------------------------------------------------

	let creating = $state(false);
	async function createRun(year: number) {
		creating = true;
		try {
			const created = await apiFetch<AnnualRun>(`${BASE}/annual-fees`, {
				method: 'POST',
				body: JSON.stringify({ year })
			});
			runs = [...runs.filter((r) => r.id !== created.id), created].sort((a, b) => b.year - a.year);
			await selectRun(created.id);
			toast.success(`Beitragslauf ${year} angelegt`);
		} catch (e) {
			toast.error(errorMessage(e, 'Beitragslauf konnte nicht angelegt werden'));
			// 409: Für das Jahr gibt es schon einen Lauf (z. B. von jemand anderem angelegt)
			if (e instanceof ApiClientError && e.status === 409) await loadRuns();
		} finally {
			creating = false;
		}
	}

	let deleteOpen = $state(false);
	async function deleteRun() {
		if (!run) return;
		const r = run;
		clearTimeout(timer);
		try {
			await apiFetch(`${BASE}/annual-fees/${r.id}`, { method: 'DELETE' });
			runs = runs.filter((x) => x.id !== r.id);
			selectedId = defaultRunId(runs);
			toast.success(`Beitragslauf ${r.year} gelöscht`);
		} catch (e) {
			toast.error(errorMessage(e, 'Löschen fehlgeschlagen'));
			// 409: inzwischen versendet → Stand neu laden
			if (e instanceof ApiClientError && e.status === 409) await onchanged();
		}
	}

	async function selectRun(id: string | null) {
		if (id === selectedId) return;
		await flush();
		selectedId = id;
	}

	// --- Entwurf + Autosave -----------------------------------------------------------

	let draft = $state<Draft | null>(null);
	let draftFor: string | null = null;

	function fromRun(r: AnnualRun): Draft {
		return {
			rates: { ...r.rates },
			mailSubject: r.mailSubject,
			mailBody: r.mailBody,
			pdfText: r.pdfText,
			dueOn: r.dueOn
		};
	}

	// Entwurf nur beim Wechsel des Laufs neu befüllen – Server-Antworten überschreiben keine Eingabe
	$effect(() => {
		const id = runId;
		untrack(() => {
			if (id === draftFor) return;
			draftFor = id;
			draft = run ? fromRun(run) : null;
			saveState = 'idle';
			saveError = '';
			serverErrors = {};
		});
	});

	/** Feldfehler aus der letzten Server-Antwort (422); gelten, bis das Feld geändert wird */
	let serverErrors = $state<Record<string, string>>({});

	const errors = $derived.by(() => {
		if (!draft) return {} as Record<string, string>;
		const parsed = annualRunUpdate.safeParse({
			rates: draft.rates,
			mailSubject: draft.mailSubject,
			mailBody: draft.mailBody,
			pdfText: draft.pdfText,
			dueOn: draft.dueOn
		});
		const out: Record<string, string> = parsed.success ? {} : issuesToErrors(parsed.error.issues);
		// Wie der Server: eine geänderte Frist darf nicht in der Vergangenheit liegen
		if (!out.dueOn && run && draft.dueOn !== run.dueOn && draft.dueOn < todayIso()) {
			out.dueOn = 'Die Frist liegt in der Vergangenheit';
		}
		return { ...serverErrors, ...out };
	});

	/** Serverfehler eines Feldes verwerfen, sobald sich der Wert gegenüber dem Fehlversuch ändert */
	let failedPatch: AnnualRunUpdate | null = null;
	function dropStaleServerErrors(patch: AnnualRunUpdate) {
		if (!failedPatch || !Object.keys(serverErrors).length) return;
		const prev = failedPatch;
		const keep = Object.fromEntries(
			Object.entries(serverErrors).filter(([k]) => {
				const field = k.split('.')[0] as keyof AnnualRunUpdate;
				return JSON.stringify(patch[field]) === JSON.stringify(prev[field]);
			})
		);
		if (Object.keys(keep).length !== Object.keys(serverErrors).length) serverErrors = keep;
	}

	function patchOf(d: Draft, r: AnnualRun): AnnualRunUpdate {
		const p: AnnualRunUpdate = {};
		if (FEE_LEVELS.some((l) => d.rates[l] !== r.rates[l])) p.rates = { ...d.rates };
		if (d.mailSubject.trim() !== r.mailSubject) p.mailSubject = d.mailSubject.trim();
		if (d.mailBody.trim() !== r.mailBody) p.mailBody = d.mailBody.trim();
		if (d.pdfText.trim() !== r.pdfText) p.pdfText = d.pdfText.trim();
		if (d.dueOn !== r.dueOn) p.dueOn = d.dueOn;
		return p;
	}

	type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'invalid' | 'error';
	let saveState = $state<SaveState>('idle');
	let saveError = $state('');
	let saving = false;
	let again = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** steigt nach jedem Speichern – Vorschauen laden dann neu */
	let stamp = $state(0);

	$effect(() => {
		if (!draft || !run || !editable) return;
		// alle Felder des Entwurfs und den Serverstand verfolgen
		void JSON.stringify(draft);
		const r = run;
		untrack(() => {
			clearTimeout(timer);
			if (!draft) return;
			const patch = patchOf(draft, r);
			dropStaleServerErrors(patch);
			if (!Object.keys(patch).length) {
				if (saveState === 'pending' || saveState === 'invalid') saveState = 'idle';
				return;
			}
			if (Object.keys(errors).length) {
				saveState = 'invalid';
				return;
			}
			saveState = 'pending';
			timer = setTimeout(() => void save(), 800);
		});
	});

	async function save() {
		clearTimeout(timer);
		timer = undefined;
		if (!run || !draft || !editable) return;
		if (saving) {
			again = true;
			return;
		}
		const r = run;
		const patch = patchOf(draft, r);
		if (!Object.keys(patch).length || Object.keys(errors).length) return;
		saving = true;
		saveState = 'saving';
		saveError = '';
		try {
			const updated = await apiFetch<AnnualRun>(`${BASE}/annual-fees/${r.id}`, {
				method: 'PUT',
				body: JSON.stringify(patch)
			});
			// Antwort = frischer Stand; Inhaltsänderung an einem geplanten Lauf hebt die Planung auf
			if (r.status === 'scheduled' && updated.status !== 'scheduled') {
				toast.info('Geplanter Versand aufgehoben – bitte neu planen');
			}
			replaceRun(updated);
			saveState = 'saved';
			serverErrors = {};
			failedPatch = null;
			stamp++;
		} catch (e) {
			const fields =
				e instanceof ApiClientError && e.status === 422 ? fieldErrorsFrom(e.details) : {};
			if (Object.keys(fields).length) {
				// z. B. Frist in der Vergangenheit → am Feld zeigen
				serverErrors = fields;
				failedPatch = patch;
				saveState = 'invalid';
			} else if (e instanceof ApiClientError && e.status === 409) {
				// Inzwischen versendet (z. B. geplanter Versand): Stand neu laden, Entwurf verwerfen
				saveState = 'error';
				saveError = errorMessage(e, 'Speichern fehlgeschlagen');
				again = false;
				await loadRuns();
				const fresh = runs.find((x) => x.id === r.id);
				if (fresh && fresh.id === selectedId) draft = fromRun(fresh);
				await onchanged();
			} else {
				saveState = 'error';
				saveError = errorMessage(e, 'Speichern fehlgeschlagen');
			}
		} finally {
			saving = false;
			if (again) {
				again = false;
				void save();
			}
		}
	}

	/** Ausstehende Änderungen sofort speichern (vor Versand, Laufwechsel, Verlassen) */
	async function flush() {
		if (timer !== undefined || saveState === 'pending') await save();
	}

	onDestroy(() => {
		if (timer !== undefined) void save();
	});

	// --- Vorschau (Empfänger) ---------------------------------------------------------

	const previewMode = $derived<'run' | 'catch-up'>(runStatus === 'sent' ? 'catch-up' : 'run');
	let preview = $state<AnnualPreview | null>(null);
	let previewLoading = $state(false);
	let previewError = $state('');
	let previewReq = 0;

	async function loadPreview(id: string, mode: 'run' | 'catch-up') {
		const req = ++previewReq;
		previewLoading = !preview || preview.mode !== mode;
		previewError = '';
		try {
			const p = await apiFetch<AnnualPreview>(`${BASE}/annual-fees/${id}/preview?mode=${mode}`);
			if (req === previewReq) preview = p;
		} catch (e) {
			if (req === previewReq) {
				preview = null;
				previewError = errorMessage(e, 'Vorschau konnte nicht erstellt werden');
			}
		} finally {
			if (req === previewReq) previewLoading = false;
		}
	}

	$effect(() => {
		const id = runId;
		const mode = previewMode;
		void stamp;
		void version;
		if (!id) {
			untrack(() => (preview = null));
			return;
		}
		untrack(() => void loadPreview(id, mode));
	});

	/** Nach Versand/Nachberechnung/Konflikt: `onchanged` erhöht `version` → Läufe und Vorschau laden neu */
	async function afterAction() {
		await onchanged();
	}

	// --- Geführter Ablauf: Sätze → Texte → Vorschau → Senden ----------------------------

	/** 0 Sätze · 1 Texte · 2 Vorschau · 3 Senden */
	let step = $state(0);
	const LAST_STEP = 3;
	// Beim Wechsel des Laufs: neuer Lauf beginnt vorn, bereits versendeter beim Senden-Schritt (Status, Nachberechnung)
	$effect(() => {
		const id = runId;
		const sent = untrack(() => runStatus === 'sent');
		untrack(() => (step = id && sent ? LAST_STEP : 0));
	});

	const previewWarns = $derived(
		!!preview &&
			previewMode === 'run' &&
			(preview.withoutEmail.length > 0 || preview.payerSuggestions > 0 || !preview.invoices.length)
	);
	const steps = $derived.by<Step[]>(() => {
		const sent = runStatus === 'sent';
		const done = (i: number): Step['state'] => (sent || step > i ? 'done' : 'todo');
		return [
			{ label: 'Beiträge', hint: 'Sätze je Ebene', state: done(0) },
			{ label: 'Texte', hint: 'Mail und PDF', state: done(1) },
			{
				label: 'Vorschau',
				hint: preview ? `${preview.invoices.length} Rechnungen` : 'Empfänger prüfen',
				state: previewWarns && !sent ? 'warn' : done(2)
			},
			{
				label: 'Senden',
				hint: run ? ANNUAL_RUN_STATUS_LABELS[run.status] : '',
				state: sent ? 'done' : 'todo'
			}
		];
	});

	const runOptions = $derived(
		runs.map((r) => ({
			value: r.id,
			label: `Beitragsjahr ${r.year} · ${ANNUAL_RUN_STATUS_LABELS[r.status]}`
		}))
	);

	function statusVariant(s: AnnualRunStatus) {
		return s === 'sent' ? 'secondary' : s === 'scheduled' ? 'default' : 'outline';
	}
</script>

{#if loading}
	<div class="space-y-4">
		<Skeleton class="h-24 w-full" />
		<Skeleton class="h-64 w-full" />
	</div>
{:else if error}
	<Card.Root>
		<Card.Content class="flex flex-wrap items-center gap-3">
			<p class="text-sm text-destructive" role="alert">{error}</p>
			<Button size="sm" variant="outline" onclick={() => void loadRuns()}>Erneut versuchen</Button>
		</Card.Content>
	</Card.Root>
{:else if !runs.length}
	<EmptyState
		title="Noch kein Beitragslauf"
		description="Mit einem Beitragslauf rechnest du den Jahresbeitrag ab: Alle, die am Tag der Erstellung Mitglied sind, bekommen eine Sammelrechnung je Familie – mit Aufschlüsselung nach Stamm, Gau, Landesmark und Bund als PDF im Anhang."
	>
		{#if canManage && newYear}
			<Button onclick={() => newYear && createRun(newYear)} disabled={creating}>
				<Plus />
				{creating ? 'Legt an …' : `Lauf für ${newYear} anlegen`}
			</Button>
		{/if}
	</EmptyState>
{:else}
	<div class="space-y-6">
		<Card.Root>
			<Card.Content class="space-y-3">
				<div class="flex flex-wrap items-center gap-2">
					<SelectField
						class="w-full sm:w-72"
						label="Beitragsjahr"
						options={runOptions}
						value={selectedId}
						onchange={(v) => void selectRun(v)}
					/>
					{#if run}
						<Badge variant={statusVariant(run.status)}>{ANNUAL_RUN_STATUS_LABELS[run.status]}</Badge
						>
					{/if}
					<span class="text-xs text-muted-foreground" aria-live="polite">
						{#if saveState === 'pending' || saveState === 'saving'}
							Speichert …
						{:else if saveState === 'saved'}
							<span class="text-emerald-700 dark:text-emerald-400">Gespeichert</span>
						{:else if saveState === 'invalid'}
							<span class="text-amber-700 dark:text-amber-400"
								>Nicht gespeichert – Eingaben prüfen</span
							>
						{:else if saveState === 'error'}
							<span class="text-destructive">{saveError}</span>
							<button type="button" class="ml-1 underline" onclick={() => void save()}>
								Erneut versuchen
							</button>
						{/if}
					</span>
					<div class="ml-auto flex flex-wrap gap-2">
						{#if canManage && newYear}
							<Button
								size="sm"
								variant="outline"
								onclick={() => newYear && createRun(newYear)}
								disabled={creating}
							>
								<Plus />
								{creating ? 'Legt an …' : `Neuer Lauf für ${newYear}`}
							</Button>
						{/if}
						{#if canManage && run && run.status !== 'sent'}
							<Button
								size="sm"
								variant="ghost"
								class="text-destructive"
								onclick={() => (deleteOpen = true)}
							>
								<Trash2 /> Lauf löschen
							</Button>
						{/if}
					</div>
				</div>
				{#if run}
					<p class="text-sm text-muted-foreground">
						Abgerechnet werden alle, die am <strong class="text-foreground"
							>{fmtDate(run.createdOn)}</strong
						>
						Mitglied sind. Eintritt im Beitragsjahr nach dem 28.02.: nur Stammesbeitrag.
					</p>
					{#if !canManage}
						<p class="text-xs text-muted-foreground">
							Nur Ansicht – Ändern braucht die Berechtigung
							<code class="text-[0.7rem]">treasury.annual-fee.manage</code>.
						</p>
					{/if}
				{/if}
			</Card.Content>
		</Card.Root>

		{#if run && draft}
			<AnnualSteps {steps} current={step} onselect={(i) => (step = i)} />

			{#if step === 0}
				<AnnualRatesCard bind:rates={draft.rates} disabled={!editable} />
			{:else if step === 1}
				<AnnualMessageCard
					bind:subject={draft.mailSubject}
					bind:body={draft.mailBody}
					bind:pdfText={draft.pdfText}
					disabled={!editable}
					{errors}
				/>
			{:else if step === 2}
				<AnnualPreviewCard
					runId={run.id}
					invoices={preview?.invoices ?? []}
					mode={previewMode}
					loading={previewLoading}
					{stamp}
					{showEmails}
				/>
				<AnnualRecipientsCard
					{preview}
					mode={previewMode}
					loading={previewLoading}
					error={previewError}
					{showEmails}
					onretry={() => runId && void loadPreview(runId, previewMode)}
				/>
			{:else}
				{#if run.status !== 'sent'}
					<AnnualChecklist {preview} loading={previewLoading} onreview={() => (step = 2)} />
				{/if}
				<AnnualSendCard
					{run}
					{preview}
					bind:dueOn={draft.dueOn}
					dueError={errors.dueOn ?? null}
					{canManage}
					canSend={perm.send}
					{editable}
					{flush}
					onrun={replaceRun}
					onchanged={afterAction}
					onopeninvoices={() => onopen('invoices')}
				/>
			{/if}

			<div class="flex items-center justify-between gap-2">
				<Button variant="outline" disabled={step === 0} onclick={() => (step -= 1)}>
					<ArrowLeft /> Zurück
				</Button>
				{#if step < LAST_STEP}
					<Button onclick={() => (step += 1)}>
						Weiter: {steps[step + 1]?.label}
						<ArrowRight />
					</Button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<ConfirmDialog
	bind:open={deleteOpen}
	title={`Beitragslauf ${run?.year ?? ''} löschen?`}
	description="Der Entwurf mit Beiträgen und Texten wird gelöscht. Rechnungen gibt es noch keine."
	confirmLabel="Löschen"
	destructive
	onconfirm={deleteRun}
/>
