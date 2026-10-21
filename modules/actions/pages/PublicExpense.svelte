<script lang="ts">
	import { tick, untrack } from 'svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Loader from '@lucide/svelte/icons/loader-circle';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, MoneyInput, formatEuro } from '$lib/components/layout';
	import { isValidIban } from '../iban';
	import {
		MAX_EXPENSE_BATCH_BYTES,
		MAX_EXPENSE_BATCH_ITEMS,
		publicExpenseBatchInput,
		type PublicExpenseBatchResult,
		type PublicExpenseLink
	} from '../schemas';
	import DateInputDe, { todayIso } from './DateInputDe.svelte';
	import ReceiptPicker from './ReceiptPicker.svelte';
	import { fmtPeriod } from './format';

	let { params }: { params: Record<string, string>; path?: string } = $props();

	const token = $derived(params.token ?? '');
	const base = '/api/v1/modules/actions/public/expense-links';
	const ITEM_FIELDS = [
		'category',
		'description',
		'amountCents',
		'expenseDate',
		'file',
		'note'
	] as const;
	const MAX_BATCH_MB = Math.round(MAX_EXPENSE_BATCH_BYTES / 1024 / 1024);

	interface ItemDraft {
		key: number;
		category: string | null;
		description: string;
		amountCents: number;
		expenseDate: string;
		/** Formatfehler aus dem Datumsfeld */
		dateError: string;
		file: File | null;
		note: string;
	}

	let nextKey = 0;
	const newItem = (): ItemDraft => ({
		key: nextKey++,
		category: null,
		description: '',
		amountCents: 0,
		expenseDate: todayIso(),
		dateError: '',
		file: null,
		note: ''
	});

	let link = $state<PublicExpenseLink | null>(null);
	let loading = $state(true);
	let unavailable = $state(false);
	let loadError = $state('');

	// Gemeinsame Angaben
	let name = $state('');
	let email = $state('');
	let accountHolder = $state('');
	let iban = $state('');
	let bic = $state('');
	let privacy = $state(false);
	let honeypot = $state('');
	let items = $state<ItemDraft[]>([newItem()]);

	/** Feldfehler; Schlüssel wie die Server-Pfade (`name`, `items.1.amountCents`, `items.0.file` …) */
	let errors = $state<Record<string, string>>({});
	let submitting = $state(false);
	let submitError = $state('');
	let done = $state<{ count: number; totalCents: number; emailSent: boolean } | null>(null);

	interface ErrBody {
		error?: { message?: string; details?: unknown };
	}

	const totalCents = $derived(items.reduce((s, i) => s + (i.amountCents || 0), 0));
	const totalBytes = $derived(items.reduce((s, i) => s + (i.file?.size ?? 0), 0));
	const canAdd = $derived(items.length < MAX_EXPENSE_BATCH_ITEMS);

	const fieldId = (key: string) => `exp-${key.replaceAll('.', '-')}`;
	const describedBy = (key: string) => (errors[key] ? `${fieldId(key)}-error` : undefined);
	const itemKey = (i: number, f: (typeof ITEM_FIELDS)[number]) => `items.${i}.${f}`;

	/** Reihenfolge der Felder auf der Seite (für den Fokus auf den ersten Fehler) */
	const fieldOrder = $derived([
		'name',
		'email',
		...items.flatMap((_, i) => ITEM_FIELDS.map((f) => itemKey(i, f))),
		'accountHolder',
		'iban',
		'bic',
		'privacy'
	]);

	/** 422-Details (Zod-Issues oder Objekt) → Feldfehler mit Punkt-Pfaden */
	function toFieldErrors(details: unknown): Record<string, string> {
		const out: Record<string, string> = {};
		if (Array.isArray(details)) {
			for (const i of details as { path?: unknown[]; message?: string }[]) {
				const key = (i.path ?? []).map(String).join('.');
				if (key && !out[key]) out[key] = i.message ?? 'Ungültig';
			}
		} else if (details && typeof details === 'object') {
			for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
				if (!out[k]) out[k] = String(v);
			}
		}
		return out;
	}

	/** Fehler ohne passendes Feld (z. B. `items` als Ganzes) als Gesamtmeldung */
	function unmatchedMessage(errs: Record<string, string>): string {
		const known = new Set(fieldOrder);
		const other = Object.entries(errs).find(([k]) => !known.has(k));
		return other ? other[1] : '';
	}

	async function focusFirstError() {
		const first = fieldOrder.find((k) => errors[k]);
		if (!first) return;
		await tick();
		const el = document.getElementById(fieldId(first));
		if (!el) return;
		el.focus();
		// Versteckte Datei-Eingabe: sichtbaren Container einblenden
		const target = el.classList.contains('sr-only') ? (el.parentElement ?? el) : el;
		target.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}

	async function load() {
		loading = true;
		unavailable = false;
		loadError = '';
		try {
			const res = await fetch(`${base}/${encodeURIComponent(token)}`, {
				headers: { accept: 'application/json' }
			});
			if (res.status === 404) {
				unavailable = true;
				return;
			}
			if (!res.ok) {
				const b = (await res.json().catch(() => null)) as ErrBody | null;
				loadError = b?.error?.message ?? 'Die Seite konnte nicht geladen werden.';
				return;
			}
			link = ((await res.json()) as { data: PublicExpenseLink }).data;
		} catch {
			loadError = 'Die Seite konnte nicht geladen werden. Bitte prüfe deine Verbindung.';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void token;
		untrack(() => void load());
	});

	const itemPayload = () =>
		items.map((i) => ({
			category: i.category ?? '',
			description: i.description,
			amountCents: i.amountCents,
			expenseDate: i.expenseDate,
			note: i.note.trim() || null
		}));

	const textFields = () => ({
		name,
		email,
		accountHolder,
		iban,
		bic,
		privacy: privacy ? 'true' : '',
		website: honeypot,
		items: JSON.stringify(itemPayload())
	});

	function validate(): boolean {
		const next: Record<string, string> = {};
		const check = publicExpenseBatchInput.safeParse(textFields());
		if (!check.success) Object.assign(next, toFieldErrors(check.error.issues));
		if (!next.iban && iban.trim() && !isValidIban(iban)) next.iban = 'Ungültige IBAN';
		items.forEach((it, i) => {
			if (it.dateError) next[itemKey(i, 'expenseDate')] = it.dateError;
			else if (!it.expenseDate) next[itemKey(i, 'expenseDate')] = 'Bitte ein Datum eingeben';
			if (!it.file) next[itemKey(i, 'file')] = 'Bitte einen Beleg hochladen';
		});
		errors = next;
		return Object.keys(next).length === 0;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!link || submitting) return;
		// MoneyInput übernimmt den Betrag beim Verlassen des Felds
		(document.activeElement as HTMLElement | null)?.blur?.();
		await tick();
		submitError = '';
		if (!validate()) {
			submitError = unmatchedMessage(errors) || 'Bitte prüfe die markierten Felder.';
			void focusFirstError();
			return;
		}
		if (totalBytes > MAX_EXPENSE_BATCH_BYTES) {
			submitError = `Alle Belege zusammen sind zu groß (höchstens ${MAX_BATCH_MB} MB). Bitte verkleinere die Fotos oder reiche die Auslagen in zwei Durchgängen ein.`;
			return;
		}
		submitting = true;
		try {
			const fd = new FormData();
			for (const [k, v] of Object.entries(textFields())) fd.append(k, v);
			// Je Auslage genau eine Datei – in derselben Reihenfolge wie `items`
			for (const it of items) if (it.file) fd.append('file', it.file, it.file.name);
			const res = await fetch(`${base}/${encodeURIComponent(token)}/submit`, {
				method: 'POST',
				headers: { accept: 'application/json' },
				body: fd
			});
			if (res.ok) {
				const json = (await res.json()) as { data: PublicExpenseBatchResult };
				done = {
					count: json.data.count ?? items.length,
					totalCents,
					emailSent: json.data.emailSent
				};
				if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
				return;
			}
			const b = (await res.json().catch(() => null)) as ErrBody | null;
			if (res.status === 422) {
				errors = toFieldErrors(b?.error?.details);
				submitError =
					unmatchedMessage(errors) || b?.error?.message || 'Bitte prüfe die markierten Felder.';
				void focusFirstError();
			} else if (res.status === 413) {
				submitError = `Die Belege sind zu groß (je Beleg höchstens ${maxMb} MB, zusammen höchstens ${MAX_BATCH_MB} MB).`;
			} else if (res.status === 404) {
				unavailable = true;
			} else if (res.status === 429) {
				submitError = 'Zu viele Versuche. Bitte warte ein paar Minuten und versuche es erneut.';
			} else {
				submitError = b?.error?.message ?? 'Die Auslagen konnten nicht gesendet werden.';
			}
		} catch {
			submitError = 'Die Auslagen konnten nicht gesendet werden. Bitte prüfe deine Verbindung.';
		} finally {
			submitting = false;
		}
	}

	/** Fehler der Auslagen nach Entfernen/Hinzufügen verwerfen (Indizes verschieben sich) */
	function clearItemErrors() {
		errors = Object.fromEntries(Object.entries(errors).filter(([k]) => !k.startsWith('items')));
	}

	async function addItem() {
		if (!canAdd) return;
		items.push(newItem());
		await tick();
		document.getElementById(fieldId(itemKey(items.length - 1, 'category')))?.focus();
	}

	async function removeItem(index: number) {
		if (items.length <= 1) return;
		items.splice(index, 1);
		clearItemErrors();
		await tick();
		const nextIndex = Math.min(index, items.length - 1);
		document.getElementById(`exp-item-${nextIndex}-title`)?.focus();
	}

	/** Weitere Auslagen: Karten leeren, Name/E-Mail/Konto behalten */
	function another() {
		items = [newItem()];
		honeypot = '';
		errors = {};
		submitError = '';
		done = null;
	}

	const period = $derived(
		link
			? fmtPeriod({
					startsOn: link.startsOn,
					startsTime: null,
					endsOn: link.endsOn,
					endsTime: null
				})
			: ''
	);
	const maxMb = $derived(link ? Math.round(link.maxReceiptBytes / 1024 / 1024) : 10);
	const countLabel = (n: number) => (n === 1 ? '1 Auslage' : `${n} Auslagen`);
</script>

<svelte:head>
	<title>{link ? `Auslagen einreichen: ${link.actionName}` : 'Auslagen einreichen'}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8 sm:py-12">
	{#if loading}
		<div class="flex flex-col gap-4" aria-busy="true" aria-label="Seite wird geladen">
			<Skeleton class="h-9 w-3/4" />
			<Skeleton class="h-5 w-1/2" />
			<Skeleton class="h-72 w-full" />
		</div>
	{:else if unavailable || loadError || !link}
		<Card.Root>
			<Card.Header>
				<Card.Title level={1} class="text-section">
					{unavailable ? 'Dieser Link ist nicht verfügbar' : 'Seite nicht geladen'}
				</Card.Title>
				<Card.Description>
					{unavailable
						? 'Der Link ist ungültig, wurde erneuert oder die Abrechnung ist bereits abgeschlossen. Bitte frage bei den Verantwortlichen nach.'
						: loadError}
				</Card.Description>
			</Card.Header>
			{#if !unavailable}
				<Card.Content>
					<Button variant="outline" onclick={load}>Erneut versuchen</Button>
				</Card.Content>
			{/if}
		</Card.Root>
	{:else}
		<header class="flex flex-col gap-1">
			<p class="text-muted-foreground text-sm">Auslagen einreichen</p>
			<h1 class="text-title">{link.actionName}</h1>
			<p class="text-muted-foreground text-sm">{period}</p>
		</header>

		{#if done}
			<Card.Root>
				<Card.Content class="flex flex-col items-center gap-4 text-center">
					<CircleCheck class="size-12 text-success" aria-hidden="true" />
					<h2 class="text-section">Vielen Dank, {name.trim()}!</h2>
					<p class="text-sm font-medium tabular-nums" role="status">
						{countLabel(done.count)} über {formatEuro(done.totalCents)} eingereicht.
					</p>
					<p class="text-muted-foreground text-sm">
						{done.count === 1 ? 'Deine Auslage wird' : 'Deine Auslagen werden'} geprüft. Nach der Freigabe
						überweisen wir den Betrag auf dein Konto.
						{#if email.trim()}
							{done.emailSent
								? 'Eine Bestätigung ist per E-Mail unterwegs.'
								: 'Eine Bestätigung per E-Mail konnte leider nicht gesendet werden.'}
						{/if}
					</p>
					<Button variant="outline" onclick={another}>Weitere Auslagen einreichen</Button>
				</Card.Content>
			</Card.Root>
		{:else}
			<p class="text-sm">
				Du hast für diese Aktion etwas bezahlt? Trage hier deine Auslagen ein und lade je einen
				Beleg hoch. Bis zu {MAX_EXPENSE_BATCH_ITEMS} Auslagen kannst du auf einmal einreichen. Nach der
				Prüfung bekommst du das Geld überwiesen.
			</p>
			<form class="flex flex-col gap-6" onsubmit={submit} novalidate>
				<Card.Root>
					<Card.Header>
						<Card.Title>Deine Angaben</Card.Title>
					</Card.Header>
					<Card.Content class="flex flex-col gap-4">
						<FormField label="Name *" id="exp-name" error={errors.name}>
							<Input
								id="exp-name"
								bind:value={name}
								autocomplete="name"
								maxlength={100}
								disabled={submitting}
								aria-invalid={!!errors.name}
								aria-describedby={describedBy('name')}
							/>
						</FormField>
						<FormField
							label="E-Mail"
							id="exp-email"
							error={errors.email}
							hint="Optional – für eine Bestätigung."
						>
							<Input
								id="exp-email"
								type="email"
								bind:value={email}
								autocomplete="email"
								maxlength={200}
								disabled={submitting}
								aria-invalid={!!errors.email}
								aria-describedby={errors.email ? 'exp-email-error' : 'exp-email-hint'}
							/>
						</FormField>
					</Card.Content>
				</Card.Root>

				<section class="flex flex-col gap-4" aria-labelledby="exp-items-heading">
					<h2 id="exp-items-heading" class="text-section">Auslagen</h2>
					{#each items as item, i (item.key)}
						<Card.Root>
							<Card.Header class="flex flex-row items-center justify-between gap-2">
								<Card.Title level={3} id="exp-item-{i}-title" class="outline-none" tabindex={-1}>
									Auslage {i + 1}
								</Card.Title>
								{#if items.length > 1}
									<Button
										type="button"
										variant="ghost"
										size="sm"
										class="text-destructive hover:text-destructive -my-1"
										disabled={submitting}
										aria-label="Auslage {i + 1} entfernen"
										onclick={() => removeItem(i)}
									>
										<Trash /> Entfernen
									</Button>
								{/if}
							</Card.Header>
							<Card.Content class="flex flex-col gap-4">
								<FormField
									label="Kategorie *"
									id={fieldId(itemKey(i, 'category'))}
									error={errors[itemKey(i, 'category')]}
								>
									<SelectField
										id={fieldId(itemKey(i, 'category'))}
										label="Kategorie von Auslage {i + 1}"
										placeholder="Kategorie wählen …"
										options={link.categories}
										bind:value={item.category}
										disabled={submitting}
										invalid={!!errors[itemKey(i, 'category')]}
									/>
								</FormField>
								<FormField
									label="Wofür? *"
									id={fieldId(itemKey(i, 'description'))}
									error={errors[itemKey(i, 'description')]}
									hint="z. B. „Einkauf Lebensmittel Supermarkt“"
								>
									<Input
										id={fieldId(itemKey(i, 'description'))}
										bind:value={item.description}
										maxlength={200}
										disabled={submitting}
										aria-invalid={!!errors[itemKey(i, 'description')]}
										aria-describedby={errors[itemKey(i, 'description')]
											? `${fieldId(itemKey(i, 'description'))}-error`
											: `${fieldId(itemKey(i, 'description'))}-hint`}
									/>
								</FormField>
								<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
									<FormField
										label="Betrag (€) *"
										id={fieldId(itemKey(i, 'amountCents'))}
										error={errors[itemKey(i, 'amountCents')]}
									>
										<MoneyInput
											id={fieldId(itemKey(i, 'amountCents'))}
											label="Betrag von Auslage {i + 1} in Euro"
											bind:cents={item.amountCents}
											disabled={submitting}
											invalid={!!errors[itemKey(i, 'amountCents')]}
										/>
									</FormField>
									<FormField
										label="Datum *"
										id={fieldId(itemKey(i, 'expenseDate'))}
										error={errors[itemKey(i, 'expenseDate')]}
									>
										<DateInputDe
											id={fieldId(itemKey(i, 'expenseDate'))}
											bind:value={item.expenseDate}
											bind:error={item.dateError}
											required
											disabled={submitting}
											invalid={!!errors[itemKey(i, 'expenseDate')]}
											describedBy={describedBy(itemKey(i, 'expenseDate'))}
										/>
									</FormField>
								</div>
								<div class="grid gap-1.5">
									<Label for={fieldId(itemKey(i, 'file'))}>Beleg *</Label>
									<ReceiptPicker
										id={fieldId(itemKey(i, 'file'))}
										bind:file={item.file}
										maxBytes={link.maxReceiptBytes}
										label="Beleg von Auslage {i + 1}"
										disabled={submitting}
										invalid={!!errors[itemKey(i, 'file')]}
										describedBy={describedBy(itemKey(i, 'file'))}
									/>
									{#if errors[itemKey(i, 'file')]}
										<p
											id="{fieldId(itemKey(i, 'file'))}-error"
											role="alert"
											class="text-destructive text-xs"
										>
											{errors[itemKey(i, 'file')]}
										</p>
									{/if}
								</div>
								<FormField
									label="Hinweis"
									id={fieldId(itemKey(i, 'note'))}
									error={errors[itemKey(i, 'note')]}
								>
									<Textarea
										id={fieldId(itemKey(i, 'note'))}
										bind:value={item.note}
										rows={2}
										maxlength={500}
										disabled={submitting}
										aria-invalid={!!errors[itemKey(i, 'note')]}
										aria-describedby={describedBy(itemKey(i, 'note'))}
									/>
								</FormField>
							</Card.Content>
						</Card.Root>
					{/each}

					<div class="flex flex-col gap-3">
						{#if canAdd}
							<Button
								type="button"
								variant="outline"
								class="w-full border-dashed"
								disabled={submitting}
								onclick={addItem}
							>
								<Plus /> Weitere Auslage hinzufügen
							</Button>
						{:else}
							<p class="text-muted-foreground text-xs" role="note">
								Höchstens {MAX_EXPENSE_BATCH_ITEMS} Auslagen auf einmal. Weitere kannst du nach dem Absenden
								in einem neuen Durchgang einreichen.
							</p>
						{/if}
						<div
							class="bg-muted/50 flex items-baseline justify-between gap-4 rounded-lg border px-4 py-3"
							aria-live="polite"
						>
							<span class="text-sm">
								Summe <span class="text-muted-foreground">({countLabel(items.length)})</span>
							</span>
							<span class="text-lg font-semibold tabular-nums">{formatEuro(totalCents)}</span>
						</div>
						{#if totalBytes > MAX_EXPENSE_BATCH_BYTES}
							<p class="text-destructive text-xs" role="alert">
								Alle Belege zusammen sind größer als {MAX_BATCH_MB} MB. Bitte verkleinere die Fotos oder
								reiche die Auslagen in zwei Durchgängen ein.
							</p>
						{/if}
					</div>
				</section>

				<Card.Root>
					<Card.Header>
						<Card.Title>Konto für die Erstattung</Card.Title>
						<Card.Description>
							Deine Kontodaten werden verschlüsselt gespeichert und nur für die Erstattung genutzt.
						</Card.Description>
					</Card.Header>
					<Card.Content class="flex flex-col gap-4">
						<FormField
							label="Kontoinhaber*in *"
							id="exp-accountHolder"
							error={errors.accountHolder}
						>
							<Input
								id="exp-accountHolder"
								bind:value={accountHolder}
								autocomplete="name"
								maxlength={100}
								disabled={submitting}
								aria-invalid={!!errors.accountHolder}
								aria-describedby={describedBy('accountHolder')}
							/>
						</FormField>
						<FormField label="IBAN *" id="exp-iban" error={errors.iban}>
							<Input
								id="exp-iban"
								bind:value={iban}
								inputmode="text"
								autocomplete="off"
								spellcheck={false}
								placeholder="DE00 0000 0000 0000 0000 00"
								maxlength={50}
								disabled={submitting}
								aria-invalid={!!errors.iban}
								aria-describedby={describedBy('iban')}
								onblur={() => {
									if (iban.trim() && !isValidIban(iban))
										errors = { ...errors, iban: 'Ungültige IBAN' };
									else if (errors.iban) {
										const { iban: _drop, ...rest } = errors;
										void _drop;
										errors = rest;
									}
								}}
							/>
						</FormField>
						<FormField label="BIC" id="exp-bic" error={errors.bic} hint="Optional">
							<Input
								id="exp-bic"
								bind:value={bic}
								autocomplete="off"
								spellcheck={false}
								maxlength={11}
								disabled={submitting}
								aria-invalid={!!errors.bic}
								aria-describedby={errors.bic ? 'exp-bic-error' : 'exp-bic-hint'}
							/>
						</FormField>
					</Card.Content>
				</Card.Root>

				<div class="grid gap-1.5">
					<div class="flex items-start gap-2">
						<Checkbox
							id="exp-privacy"
							checked={privacy}
							onCheckedChange={(v) => (privacy = v === true)}
							disabled={submitting}
							aria-invalid={!!errors.privacy}
							aria-describedby={describedBy('privacy')}
							class="mt-0.5"
						/>
						<Label for="exp-privacy" class="leading-snug font-normal">
							<span>
								Ich bin einverstanden, dass meine Angaben zur Abrechnung dieser Aktion gespeichert
								werden.{#if link.privacyUrl}
									Details in der
									<a
										href={link.privacyUrl}
										target="_blank"
										rel="noopener noreferrer"
										class="underline underline-offset-2">Datenschutzerklärung</a
									>.{/if} *
							</span>
						</Label>
					</div>
					{#if errors.privacy}
						<p id="exp-privacy-error" role="alert" class="text-destructive text-xs">
							{errors.privacy}
						</p>
					{/if}
				</div>

				<!-- Honeypot: für Menschen unsichtbar -->
				<div class="absolute -left-[10000px] h-px w-px overflow-hidden" aria-hidden="true">
					<label for="exp-website">Website</label>
					<input
						id="exp-website"
						type="text"
						tabindex="-1"
						autocomplete="off"
						bind:value={honeypot}
					/>
				</div>

				{#if submitError}
					<div
						class="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
						role="alert"
					>
						<CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						<span>{submitError}</span>
					</div>
				{/if}

				<Button type="submit" size="lg" class="w-full" disabled={submitting}>
					{#if submitting}
						<Loader class="animate-spin" /> Wird gesendet …
					{:else}
						{items.length === 1
							? 'Auslage einreichen'
							: `${items.length} Auslagen einreichen (${formatEuro(totalCents)})`}
					{/if}
				</Button>
			</form>
		{/if}
	{/if}
</main>
