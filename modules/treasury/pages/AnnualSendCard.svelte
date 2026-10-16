<script lang="ts">
	import { toast } from 'svelte-sonner';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import Send from '@lucide/svelte/icons/send';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { ConfirmDialog, FormField } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { AnnualPreview, AnnualRun, AnnualSendResult } from '../schemas';
	import {
		addDaysIso,
		BASE,
		errorMessage,
		fieldErrorsFrom,
		fmtDate,
		fmtDateTime,
		todayIso
	} from './helpers';

	let {
		run,
		preview,
		dueOn = $bindable(),
		dueError = null,
		canManage,
		canSend,
		editable,
		flush,
		onrun,
		onchanged,
		onopeninvoices
	}: {
		run: AnnualRun;
		/** `mode=run` vor dem Versand, `mode=catch-up` danach */
		preview: AnnualPreview | null;
		dueOn: string;
		dueError?: string | null;
		canManage: boolean;
		/** `treasury.invoice.send` (zusätzlich zu `manage` für Versand, Planen, Nachberechnung) */
		canSend: boolean;
		editable: boolean;
		/** Ausstehende Änderungen speichern */
		flush: () => Promise<void>;
		/** Geänderter Lauf aus der Antwort von schedule/unschedule */
		onrun: (run: AnnualRun) => void;
		/** Nach Versand/Nachberechnung oder Konflikt: alles neu laden */
		onchanged: () => void | Promise<void>;
		onopeninvoices: () => void;
	} = $props();

	/** Senden, Planen, Nachberechnen: `annual-fee.manage` + `invoice.send`; Planung aufheben: nur `manage` */
	const mayAct = $derived(canManage && canSend);
	const today = $derived(todayIso());
	let sendOn = $state(addDaysIso(todayIso(), 1));
	let sendOnServerError = $state<string | null>(null);
	let busy = $state(false);
	let sendOpen = $state(false);
	let catchUpOpen = $state(false);

	const invoiceCount = $derived(preview?.invoices.length ?? 0);
	const addressCount = $derived(
		new Set((preview?.invoices ?? []).flatMap((i) => i.emails.map((e) => e.toLowerCase()))).size
	);
	const sendOnValid = $derived(/^\d{4}-\d{2}-\d{2}$/.test(sendOn) && sendOn >= today);
	const sendOnError = $derived(
		!sendOn
			? 'Bitte ein Datum angeben'
			: !sendOnValid
				? 'Das Versanddatum liegt in der Vergangenheit'
				: sendOnServerError
	);

	function resultText(r: AnnualSendResult): string {
		const parts = [
			`${r.invoicesCreated} ${r.invoicesCreated === 1 ? 'Rechnung' : 'Rechnungen'}`,
			`${r.mailsSent} ${r.mailsSent === 1 ? 'Mail' : 'Mails'}`
		];
		if (r.mailErrors) parts.push(`${r.mailErrors} Fehler`);
		if (r.withoutAddress) parts.push(`${r.withoutAddress} ohne Adresse`);
		return parts.join(' · ');
	}

	/** POST auf den Lauf; 409 (z. B. inzwischen versendet) → Stand neu laden */
	async function post<T>(path: string, body?: unknown): Promise<T> {
		await flush();
		try {
			return await apiFetch<T>(`${BASE}/annual-fees/${run.id}/${path}`, {
				method: 'POST',
				body: body === undefined ? undefined : JSON.stringify(body)
			});
		} catch (e) {
			if (e instanceof ApiClientError && e.status === 409) await onchanged();
			throw e;
		}
	}

	async function sendRun(path: 'send' | 'catch-up' | 'resend', label: string, fail: string) {
		busy = true;
		try {
			const r = await post<AnnualSendResult>(path);
			toast.success(`${label}: ${resultText(r)}`);
			await onchanged();
		} catch (e) {
			toast.error(errorMessage(e, fail));
		} finally {
			busy = false;
		}
	}

	const sendNow = () => sendRun('send', 'Versendet', 'Versand fehlgeschlagen');
	const catchUp = () => sendRun('catch-up', 'Nachberechnet', 'Nachberechnung fehlgeschlagen');
	const resend = () => sendRun('resend', 'Erneut versendet', 'Erneuter Versand fehlgeschlagen');

	async function schedule() {
		busy = true;
		sendOnServerError = null;
		try {
			const updated = await post<AnnualRun>('schedule', { sendOn });
			onrun(updated);
			toast.success(`Versand am ${fmtDate(updated.sendOn)} geplant`);
		} catch (e) {
			const field =
				e instanceof ApiClientError && e.status === 422 ? fieldErrorsFrom(e.details).sendOn : null;
			if (field) sendOnServerError = field;
			else toast.error(errorMessage(e, 'Planen fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function unschedule() {
		busy = true;
		try {
			onrun(await post<AnnualRun>('unschedule'));
			toast.success('Planung aufgehoben');
		} catch (e) {
			toast.error(errorMessage(e, 'Aufheben fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

{#snippet permHint(text: string, keys: string[])}
	<p class="text-xs text-muted-foreground">
		{text}
		{#each keys as k, i (k)}{i ? ' und ' : ''}<code class="text-[0.7rem]">{k}</code>{/each}.
	</p>
{/snippet}

<Card.Root>
	<Card.Header>
		<Card.Title>Versand</Card.Title>
		<Card.Description>
			{#if run.status === 'sent'}
				Versendet am {fmtDateTime(run.sentAt)}.
			{:else if run.status === 'scheduled'}
				Versand geplant am {fmtDate(run.sendOn)}.
			{:else}
				Rechnungen jetzt senden oder einen Tag festlegen.
			{/if}
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		<FormField
			label="Zahlungsfrist"
			id="annual-due"
			error={dueError}
			hint={run.status === 'sent' ? undefined : 'Steht auf Rechnung und Mail ({faellig}).'}
		>
			<Input
				id="annual-due"
				type="date"
				bind:value={dueOn}
				class="w-full sm:w-44"
				disabled={!editable}
				aria-invalid={!!dueError}
			/>
		</FormField>

		{#if run.status === 'draft'}
			{#if mayAct}
				<div class="space-y-3 border-t pt-4">
					<div class="flex flex-wrap items-center gap-2">
						<Button onclick={() => (sendOpen = true)} disabled={busy || !preview || !invoiceCount}>
							<Send />
							{busy ? 'Sendet …' : 'Jetzt senden'}
						</Button>
						{#if preview}
							<span class="text-xs text-muted-foreground">
								{invoiceCount}
								{invoiceCount === 1 ? 'Rechnung' : 'Rechnungen'} · {formatEuro(preview.totalCents)}
							</span>
						{/if}
					</div>
					<div class="flex flex-wrap items-end gap-2">
						<FormField label="Oder Versand planen am" id="annual-send-on" error={sendOnError}>
							<Input
								id="annual-send-on"
								type="date"
								min={today}
								bind:value={sendOn}
								oninput={() => (sendOnServerError = null)}
								class="w-full sm:w-44"
								aria-invalid={!!sendOnError}
							/>
						</FormField>
						<Button variant="outline" onclick={schedule} disabled={busy || !sendOnValid}>
							<CalendarClock /> Versand planen
						</Button>
					</div>
					<p class="text-xs text-muted-foreground">
						Der Versand läuft am gewählten Tag automatisch (stündlicher Job). Änderungen an
						Beiträgen, Frist oder Texten heben eine Planung wieder auf.
					</p>
				</div>
			{:else}
				{#if canManage}
					{@render permHint('Versenden und Planen braucht zusätzlich die Berechtigung', [
						'treasury.invoice.send'
					])}
				{:else}
					{@render permHint('Zum Versenden und Planen brauchst du die Berechtigungen', [
						'treasury.annual-fee.manage',
						'treasury.invoice.send'
					])}
				{/if}
			{/if}
		{:else if run.status === 'scheduled'}
			<div class="space-y-3 border-t pt-4">
				<p class="text-sm">
					Versand am <strong>{fmtDate(run.sendOn)}</strong>
					{#if preview}
						· {invoiceCount}
						{invoiceCount === 1 ? 'Rechnung' : 'Rechnungen'}
						<!-- E-Mail-Adressen liefert der Server nur mit invoice.send/-edit -->
						{#if canSend}
							an {addressCount}
							{addressCount === 1 ? 'Adresse' : 'Adressen'}
						{/if}
					{/if}
				</p>
				{#if editable}
					<p class="text-xs text-amber-700 dark:text-amber-400">
						Änderungen heben die Planung auf.
					</p>
				{/if}
				{#if canManage}
					<div class="flex flex-wrap gap-2">
						<Button variant="outline" onclick={unschedule} disabled={busy}>Planung aufheben</Button>
						{#if mayAct}
							<Button
								variant="ghost"
								onclick={() => (sendOpen = true)}
								disabled={busy || !invoiceCount}
							>
								<Send /> Stattdessen jetzt senden
							</Button>
						{/if}
					</div>
					{#if !canSend}
						{@render permHint('Sofort senden braucht zusätzlich die Berechtigung', [
							'treasury.invoice.send'
						])}
					{/if}
				{/if}
			</div>
		{:else}
			<div class="space-y-3 border-t pt-4">
				{#if run.lastResult}
					<dl class="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
						<div>
							<dt class="text-xs text-muted-foreground">Rechnungen</dt>
							<dd class="font-semibold tabular-nums">{run.lastResult.invoicesCreated}</dd>
						</div>
						<div>
							<dt class="text-xs text-muted-foreground">Mails</dt>
							<dd class="font-semibold tabular-nums">{run.lastResult.mailsSent}</dd>
						</div>
						<div>
							<dt class="text-xs text-muted-foreground">Fehler</dt>
							<dd
								class="font-semibold tabular-nums {run.lastResult.mailErrors
									? 'text-destructive'
									: ''}"
							>
								{run.lastResult.mailErrors}
							</dd>
						</div>
						<div>
							<dt class="text-xs text-muted-foreground">Ohne Adresse</dt>
							<dd class="font-semibold tabular-nums">{run.lastResult.withoutAddress}</dd>
						</div>
					</dl>
					<p class="text-xs text-muted-foreground">Ergebnis des letzten Versands.</p>
					{#if run.lastResult.mailErrors && mayAct}
						<Button variant="outline" onclick={resend} disabled={busy}>
							{busy ? 'Sendet …' : 'Versand wiederholen'}
						</Button>
						<p class="text-xs text-muted-foreground">
							Schickt alle Rechnungen dieses Laufs erneut, die noch nicht zugestellt wurden.
						</p>
					{/if}
				{/if}
				<p class="text-sm">
					{run.invoiceCount}
					{run.invoiceCount === 1 ? 'Rechnung' : 'Rechnungen'} aus diesem Lauf.
					<button type="button" class="text-primary underline" onclick={onopeninvoices}>
						Zu den Rechnungen
					</button>
				</p>
				{#if mayAct}
					<div class="flex flex-wrap items-center gap-2">
						<Button
							variant="outline"
							onclick={() => (catchUpOpen = true)}
							disabled={busy || !preview || !invoiceCount}
						>
							<UserPlus />
							{busy ? 'Berechnet …' : `Neumitglieder nachberechnen (${preview?.memberCount ?? 0})`}
						</Button>
					</div>
					<p class="text-xs text-muted-foreground">
						Rechnet Mitglieder ab, die seit dem Versand dazugekommen sind, und schickt ihnen die
						Rechnung.
					</p>
				{:else if canManage}
					{@render permHint('Nachberechnen braucht zusätzlich die Berechtigung', [
						'treasury.invoice.send'
					])}
				{/if}
			</div>
		{/if}
	</Card.Content>
</Card.Root>

<ConfirmDialog
	bind:open={sendOpen}
	title="Jahresbeitrag {run.year} senden?"
	description={`${invoiceCount} ${invoiceCount === 1 ? 'Rechnung' : 'Rechnungen'} an ${addressCount} ${addressCount === 1 ? 'Adresse' : 'Adressen'} senden? Die Rechnungen werden angelegt und per Mail mit PDF verschickt; danach lassen sich Beiträge und Texte nicht mehr ändern.`}
	confirmLabel="Jetzt senden"
	onconfirm={sendNow}
/>
<ConfirmDialog
	bind:open={catchUpOpen}
	title="Neumitglieder nachberechnen?"
	description={`${preview?.memberCount ?? 0} ${preview?.memberCount === 1 ? 'Mitglied' : 'Mitglieder'} in ${invoiceCount} ${invoiceCount === 1 ? 'Rechnung' : 'Rechnungen'} abrechnen und an ${addressCount} ${addressCount === 1 ? 'Adresse' : 'Adressen'} senden?`}
	confirmLabel="Nachberechnen"
	onconfirm={catchUp}
/>
