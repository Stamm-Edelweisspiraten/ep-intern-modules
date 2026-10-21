<script lang="ts">
	import { untrack } from 'svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Loader from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { FormRenderer } from '$lib/components/forms';
	import { emptyValues, validateFormValues, type FormValues } from '$lib/forms';
	import type { PublicForm, PublicSubmitResult } from '../schemas';
	import { withoutIdentityFields } from '../form-support';
	import { fmtPeriod } from './format';

	let { params }: { params: Record<string, string>; path?: string } = $props();

	const token = $derived(params.token ?? '');
	const base = '/api/v1/modules/actions/public/forms';

	let form = $state<PublicForm | null>(null);
	let loading = $state(true);
	let unavailable = $state(false);
	let loadError = $state('');

	let values = $state<FormValues>({});
	/** Gewähltes verknüpftes Mitglied (`null` = andere Person / Gast) */
	let memberId = $state<string | null>(null);
	const NONE = '__none__';
	const loginHref = $derived(
		`/login?redirectTo=${encodeURIComponent(`/p/actions/anmeldung/${token}`)}`
	);
	const member = $derived(form?.members.find((m) => m.id === memberId) ?? null);
	/** Mit Mitglied entfallen die Stammdatenfelder (kommen vom Server aus dem Mitgliedsprofil) */
	const renderDef = $derived(
		form ? (member ? withoutIdentityFields(form.definition) : form.definition) : null
	);
	const memberOptions = $derived([
		...(form?.members ?? []).map((m) => ({
			value: m.id,
			label: m.registered ? `${m.name} (bereits angemeldet)` : m.name
		})),
		...(form && !form.requireLogin ? [{ value: NONE, label: 'Andere Person (ohne Mitglied)' }] : [])
	]);
	function pickMember(id: string | null) {
		memberId = id && id !== NONE ? id : null;
		const m = form?.members.find((x) => x.id === memberId);
		if (m) values = { ...values, ...m.prefill };
	}
	let errors = $state<Record<string, string>>({});
	let honeypot = $state('');
	let submitting = $state(false);
	let submitError = $state('');
	let result = $state<PublicSubmitResult | null>(null);
	let renderer = $state<{ focusFirstError: () => void } | null>(null);

	interface ErrBody {
		error?: { message?: string; details?: unknown };
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
				loadError = b?.error?.message ?? 'Die Anmeldung konnte nicht geladen werden.';
				return;
			}
			const json = (await res.json()) as { data: PublicForm };
			form = json.data;
			values = emptyValues(json.data.definition);
			// Genau ein Mitglied und Anmeldung erzwungen: direkt vorauswählen
			if (json.data.requireLogin && json.data.members.length === 1) {
				pickMember(json.data.members[0]!.id);
			}
		} catch {
			loadError = 'Die Anmeldung konnte nicht geladen werden. Bitte prüfe deine Verbindung.';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void token;
		untrack(() => void load());
	});

	function reset() {
		if (!form) return;
		values = emptyValues(form.definition);
		memberId = null;
		if (form.requireLogin && form.members.length === 1) pickMember(form.members[0]!.id);
		errors = {};
		honeypot = '';
		submitError = '';
		result = null;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!form || submitting) return;
		submitError = '';
		if (form.requireLogin && !memberId) {
			submitError = 'Bitte wähle das Mitglied, das angemeldet werden soll.';
			return;
		}
		// Nur Felder des angezeigten Formulars senden (bei Mitglied entfallen die Stammdatenfelder)
		const shown = new Set((renderDef ?? form.definition).fields.map((f) => f.key));
		const current = Object.fromEntries(Object.entries(values).filter(([k]) => shown.has(k)));
		const check = validateFormValues(renderDef ?? form.definition, current);
		if (!check.ok) {
			errors = check.errors;
			submitError = 'Bitte prüfe die markierten Felder.';
			queueMicrotask(() => renderer?.focusFirstError());
			return;
		}
		errors = {};
		submitting = true;
		try {
			const res = await fetch(`${base}/${encodeURIComponent(token)}/submit`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({
					values: check.values,
					website: honeypot,
					...(memberId ? { memberId } : {})
				})
			});
			if (res.ok) {
				const json = (await res.json()) as { data: PublicSubmitResult };
				result = json.data;
				if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
				return;
			}
			const b = (await res.json().catch(() => null)) as ErrBody | null;
			const details = b?.error?.details;
			if (res.status === 422 && details && typeof details === 'object' && !Array.isArray(details)) {
				errors = Object.fromEntries(
					Object.entries(details as Record<string, unknown>).map(([k, v]) => [k, String(v)])
				);
				submitError = 'Bitte prüfe die markierten Felder.';
				queueMicrotask(() => renderer?.focusFirstError());
			} else if (res.status === 429) {
				submitError =
					b?.error?.message ?? 'Zu viele Versuche. Bitte warte kurz und versuche es erneut.';
			} else {
				submitError = b?.error?.message ?? 'Die Anmeldung konnte nicht gesendet werden.';
			}
		} catch {
			submitError = 'Die Anmeldung konnte nicht gesendet werden. Bitte prüfe deine Verbindung.';
		} finally {
			submitting = false;
		}
	}

	const closedText = $derived.by(() => {
		if (!form) return '';
		switch (form.status) {
			case 'closed':
				return 'Die Anmeldung ist geschlossen.';
			case 'not_open':
				return 'Die Anmeldung ist noch nicht geöffnet.';
			case 'full':
				return 'Leider sind alle Plätze vergeben.';
			default:
				return '';
		}
	});
	const period = $derived(
		form
			? fmtPeriod({
					startsOn: form.startsOn,
					startsTime: null,
					endsOn: form.endsOn,
					endsTime: null
				})
			: ''
	);
</script>

<svelte:head>
	<title>{form ? `Anmeldung: ${form.actionName}` : 'Anmeldung'}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8 sm:py-12">
	{#if loading}
		<div class="flex flex-col gap-4" aria-busy="true" aria-label="Anmeldung wird geladen">
			<Skeleton class="h-9 w-3/4" />
			<Skeleton class="h-5 w-1/2" />
			<Skeleton class="h-72 w-full" />
		</div>
	{:else if unavailable || loadError || !form}
		<Card.Root>
			<Card.Header>
				<Card.Title level={1} class="text-section">
					{unavailable ? 'Diese Anmeldung ist nicht verfügbar' : 'Anmeldung nicht geladen'}
				</Card.Title>
				<Card.Description>
					{unavailable
						? 'Der Link ist ungültig oder wurde erneuert. Bitte frage bei den Veranstaltenden nach dem aktuellen Link.'
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
			<h1 class="text-title">{form.actionName}</h1>
			<p class="text-muted-foreground text-sm">
				{period}{form.location ? ` · ${form.location}` : ''}
			</p>
		</header>

		{#if result}
			<Card.Root>
				<Card.Content class="flex flex-col gap-5">
					<div class="flex flex-col items-center gap-3 text-center">
						<CircleCheck class="size-12 text-success" aria-hidden="true" />
						{#if result.confirmationRequired}
							<h2 class="text-section">Fast geschafft!</h2>
							<p class="text-muted-foreground text-sm" role="status">
								Wir haben dir eine E-Mail geschickt. Bitte bestätige die Anmeldung über den Link
								darin innerhalb von 7 Tagen – erst dann ist sie gültig und du erhältst die
								Anmeldebestätigung.
							</p>
						{:else}
							<h2 class="text-section">Vielen Dank, {result.name}!</h2>
							{#if result.memberUpdated}
								<p class="text-muted-foreground text-sm">
									Dein Mitgliedsprofil wurde aktualisiert.
								</p>
							{/if}
							<p class="text-muted-foreground text-sm" role="status">
								{result.emailSent
									? 'Wir haben dir eine Bestätigung per E-Mail geschickt.'
									: 'Wir konnten keine Bestätigung per E-Mail senden. Bitte notiere dir die folgenden Angaben.'}
							</p>
						{/if}
					</div>
					{#if result.disclaimer}
						<div class="bg-muted/50 rounded-lg px-4 py-3 text-sm whitespace-pre-line">
							{result.disclaimer}
						</div>
					{/if}
					<Button variant="outline" class="self-center" onclick={reset}>
						Weitere Person anmelden
					</Button>
				</Card.Content>
			</Card.Root>
		{:else if form.status !== 'open'}
			<Card.Root>
				<Card.Header>
					<Card.Title class="text-section">{closedText}</Card.Title>
					<Card.Description>
						{#if form.status === 'not_open' && form.opensAt}
							Die Anmeldung öffnet am {new Date(form.opensAt).toLocaleString('de-DE', {
								dateStyle: 'medium',
								timeStyle: 'short'
							})} Uhr.
						{:else}
							Bitte wende dich bei Fragen an die Veranstaltenden.
						{/if}
					</Card.Description>
				</Card.Header>
			</Card.Root>
		{:else}
			{#if form.intro}
				<p class="text-sm whitespace-pre-line">{form.intro}</p>
			{/if}
			{#if form.requireLogin && !form.viewer}
				<Card.Root>
					<Card.Header>
						<Card.Title class="text-section">Anmeldung mit Konto</Card.Title>
						<Card.Description>
							Für diese Aktion melden sich Mitglieder mit ihrem Konto an. Deine Daten werden dann
							aus dem Mitgliedsprofil übernommen.
						</Card.Description>
					</Card.Header>
					<Card.Content class="flex flex-col gap-2">
						<Button href={loginHref} size="lg">Anmelden</Button>
						<p class="text-muted-foreground text-xs">
							Noch kein Konto? Verknüpfe es mit dem Code aus deinem Brief (Link auf dem Brief).
						</p>
					</Card.Content>
				</Card.Root>
			{:else if form.requireLogin && !form.members.length}
				<Card.Root>
					<Card.Header>
						<Card.Title class="text-section">Konto noch nicht verknüpft</Card.Title>
						<Card.Description>
							Dein Konto ist mit keinem Mitglied verknüpft. Nutze dafür den Link und den Code aus
							dem Brief deines Stammes, danach kannst du dich hier anmelden.
						</Card.Description>
					</Card.Header>
				</Card.Root>
			{:else}
				<form class="flex flex-col gap-6" onsubmit={submit} novalidate>
					{#if form.viewer && form.members.length}
						<Card.Root>
							<Card.Content class="flex flex-col gap-2">
								<Label for="reg-member">Für wen meldest du an?</Label>
								<SelectField
									id="reg-member"
									label="Mitglied"
									placeholder="Mitglied wählen …"
									options={memberOptions}
									value={memberId ?? (form.requireLogin ? null : NONE)}
									onchange={pickMember}
								/>
								{#if member}
									<p class="text-muted-foreground text-xs">
										Name, Geburtsdatum und weitere Stammdaten kommen aus dem Mitgliedsprofil.
										Änderungen an den Angaben unten werden dort für das nächste Mal gespeichert.
									</p>
								{/if}
							</Card.Content>
						</Card.Root>
					{:else if !form.viewer}
						<p class="text-muted-foreground text-xs">
							Mitglied? <a href={loginHref} class="underline underline-offset-2">Melde dich an</a>,
							dann werden deine Daten übernommen.
						</p>
					{/if}
					<Card.Root>
						<Card.Content class="flex flex-col gap-5">
							<FormRenderer
								bind:this={renderer}
								definition={renderDef ?? form.definition}
								bind:values
								{errors}
								disabled={submitting}
								honeypot
								bind:honeypotValue={honeypot}
								idPrefix="reg"
							/>
						</Card.Content>
					</Card.Root>

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
						{#if submitting}<Loader class="animate-spin" /> Wird gesendet …{:else}Verbindlich
							anmelden{/if}
					</Button>

					{#if form.privacyUrl}
						<p class="text-muted-foreground text-center text-xs">
							<a
								href={form.privacyUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="underline-offset-2 hover:underline"
							>
								Datenschutzerklärung
							</a>
						</p>
					{/if}
				</form>
			{/if}
		{/if}
	{/if}
</main>
