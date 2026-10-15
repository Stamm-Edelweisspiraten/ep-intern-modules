<script lang="ts">
	import { untrack } from 'svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Loader from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { FormRenderer } from '$lib/components/forms';
	import { emptyValues, validateFormValues, type FormValues } from '$lib/forms';
	import type { PublicForm, PublicSubmitResult } from '../schemas';
	import { fmtPeriod } from './format';

	let { params }: { params: Record<string, string>; path?: string } = $props();

	const token = $derived(params.token ?? '');
	const base = '/api/v1/modules/actions/public/forms';

	let form = $state<PublicForm | null>(null);
	let loading = $state(true);
	let unavailable = $state(false);
	let loadError = $state('');

	let values = $state<FormValues>({});
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
		errors = {};
		honeypot = '';
		submitError = '';
		result = null;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!form || submitting) return;
		submitError = '';
		const check = validateFormValues(form.definition, values);
		if (!check.ok) {
			errors = check.errors;
			queueMicrotask(() => renderer?.focusFirstError());
			return;
		}
		errors = {};
		submitting = true;
		try {
			const res = await fetch(`${base}/${encodeURIComponent(token)}/submit`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ values: check.values, website: honeypot })
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
				<Card.Title class="text-lg">
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
			<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{form.actionName}</h1>
			<p class="text-muted-foreground text-sm">
				{period}{form.location ? ` · ${form.location}` : ''}
			</p>
		</header>

		{#if result}
			<Card.Root>
				<Card.Content class="flex flex-col gap-5">
					<div class="flex flex-col items-center gap-3 text-center">
						<CircleCheck class="size-12 text-green-600" aria-hidden="true" />
						<h2 class="text-xl font-semibold">Vielen Dank, {result.name}!</h2>
						<p class="text-muted-foreground text-sm" role="status">
							{result.emailSent
								? 'Wir haben dir eine Bestätigung per E-Mail geschickt.'
								: 'Wir konnten keine Bestätigung per E-Mail senden. Bitte notiere dir die folgenden Angaben.'}
						</p>
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
					<Card.Title class="text-lg">{closedText}</Card.Title>
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
			<form class="flex flex-col gap-6" onsubmit={submit} novalidate>
				<Card.Root>
					<Card.Content class="flex flex-col gap-5">
						<FormRenderer
							bind:this={renderer}
							definition={form.definition}
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
					{#if submitting}<Loader class="animate-spin" /> Wird gesendet …{:else}Verbindlich anmelden{/if}
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
</main>
