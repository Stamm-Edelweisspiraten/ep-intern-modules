<script lang="ts">
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Heart from '@lucide/svelte/icons/heart';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { MoneyInput } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import { formatDateDe } from '$lib/sdk/dates';
	import { validateDonation, type DonationChoice } from '../refund';
	import type { PublicRefundChoice } from '../schemas';

	/**
	 * Öffentliche Seite hinter dem QR-Code im Rückzahlungsbrief: Rückzahlung auszahlen lassen oder ganz bzw.
	 * teilweise (ganze Euro) dem Stamm spenden. Ohne Anmeldung, nur über den geheimen Link.
	 */
	let { params }: { params: Record<string, string>; path?: string } = $props();

	const token = $derived(params.token ?? '');
	const api = $derived(
		`/api/v1/modules/actions/public/refund-choices/${encodeURIComponent(token)}`
	);

	let info = $state<PublicRefundChoice | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let choice = $state<DonationChoice>('payout');
	let partialCents = $state(0);
	let note = $state('');
	let website = $state('');
	let busy = $state(false);
	let error = $state('');
	let saved = $state(false);

	interface ErrBody {
		error?: { message?: string };
	}

	async function load() {
		loading = true;
		loadError = '';
		try {
			const res = await fetch(api, { headers: { accept: 'application/json' } });
			if (!res.ok) {
				const b = (await res.json().catch(() => null)) as ErrBody | null;
				loadError =
					res.status === 429
						? 'Zu viele Aufrufe. Bitte warte kurz und lade die Seite neu.'
						: (b?.error?.message ?? 'Dieser Link ist nicht mehr gültig.');
				return;
			}
			info = ((await res.json()) as { data: PublicRefundChoice }).data;
			choice = info.choice;
			partialCents =
				info.choice === 'partial'
					? info.donatedCents
					: Math.floor(info.amountCents / 2 / 100) * 100;
		} catch {
			loadError = 'Die Seite konnte nicht geladen werden. Bitte prüfe deine Verbindung.';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void token;
		void load();
	});

	const partialProblem = $derived(
		info && choice === 'partial'
			? partialCents < 100
				? 'Bitte mindestens 1 € angeben.'
				: validateDonation(info.amountCents, partialCents)
			: null
	);

	async function submit() {
		if (!info || busy || partialProblem) return;
		busy = true;
		error = '';
		try {
			const res = await fetch(api, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({
					choice,
					...(choice === 'partial' ? { donatedCents: partialCents } : {}),
					...(note.trim() ? { note: note.trim() } : {}),
					...(website ? { website } : {})
				})
			});
			if (res.ok) {
				info = ((await res.json()) as { data: PublicRefundChoice }).data;
				saved = true;
				return;
			}
			const b = (await res.json().catch(() => null)) as ErrBody | null;
			error =
				res.status === 429
					? 'Zu viele Versuche. Bitte warte kurz und versuche es erneut.'
					: (b?.error?.message ?? 'Die Auswahl konnte nicht gespeichert werden.');
		} catch {
			error = 'Die Auswahl konnte nicht gespeichert werden. Bitte prüfe deine Verbindung.';
		} finally {
			busy = false;
		}
	}

	const period = $derived(
		info
			? info.endsOn && info.endsOn !== info.startsOn
				? `${formatDateDe(info.startsOn)} – ${formatDateDe(info.endsOn)}`
				: formatDateDe(info.startsOn)
			: ''
	);

	const options: { value: DonationChoice; title: string; text: string }[] = [
		{ value: 'payout', title: 'Auszahlen', text: 'Den ganzen Betrag zurücküberweisen.' },
		{ value: 'donate', title: 'Alles spenden', text: 'Der ganze Betrag bleibt beim Stamm.' },
		{ value: 'partial', title: 'Einen Teil spenden', text: 'Den Rest zurücküberweisen.' }
	];

	const summary = $derived.by(() => {
		if (!info) return '';
		if (info.donatedCents <= 0) return `Wir zahlen ${formatEuro(info.amountCents)} aus.`;
		if (info.donatedCents >= info.amountCents) {
			return `Du spendest ${formatEuro(info.amountCents)} an den Stamm.`;
		}
		return `Du spendest ${formatEuro(info.donatedCents)}, wir zahlen ${formatEuro(info.amountCents - info.donatedCents)} aus.`;
	});
</script>

<svelte:head>
	<title>Rückzahlung</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8 sm:py-12">
	{#if loading && !info}
		<div class="space-y-3" role="status" aria-label="Lädt …">
			<Skeleton class="h-10 w-2/3" />
			<Skeleton class="h-40 w-full" />
		</div>
	{:else if loadError || !info}
		<Card.Root>
			<Card.Content class="flex flex-col items-center gap-3 py-8 text-center">
				<CircleAlert class="size-10 text-muted-foreground" aria-hidden="true" />
				<h1 class="text-section">Link nicht verfügbar</h1>
				<p class="text-sm text-muted-foreground" role="alert">
					{loadError || 'Dieser Link ist nicht mehr gültig.'}
				</p>
			</Card.Content>
		</Card.Root>
	{:else if saved}
		<Card.Root>
			<Card.Content class="flex flex-col items-center gap-3 py-8 text-center">
				{#if info.donatedCents > 0}
					<Heart class="size-12 text-success" aria-hidden="true" />
					<h1 class="text-title">Vielen Dank!</h1>
				{:else}
					<CircleCheck class="size-12 text-success" aria-hidden="true" />
					<h1 class="text-title">Gespeichert</h1>
				{/if}
				<p class="text-sm text-muted-foreground" role="status">{summary}</p>
				<Button variant="outline" onclick={() => (saved = false)}>Auswahl ändern</Button>
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title level={1} class="text-section">Rückzahlung – {info.actionName}</Card.Title>
				<Card.Description>{period}</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-5">
				<div class="rounded-lg bg-muted/50 px-4 py-3">
					<div class="text-sm text-muted-foreground">Rückzahlung für {info.name}</div>
					<div class="text-2xl font-semibold tabular-nums">{formatEuro(info.amountCents)}</div>
				</div>

				{#if info.locked}
					<p class="text-sm" role="status">
						{summary} Die Überweisung ist schon erfolgt – die Auswahl lässt sich nicht mehr ändern.
					</p>
				{:else}
					<fieldset class="space-y-2" disabled={busy}>
						<legend class="mb-2 text-sm font-medium">Was sollen wir mit dem Betrag machen?</legend>
						<div class="grid gap-2" role="radiogroup" aria-label="Auswahl">
							{#each options as opt (opt.value)}
								<button
									type="button"
									role="radio"
									aria-checked={choice === opt.value}
									class="flex items-start gap-3 rounded-lg border px-4 py-3 text-left {choice ===
									opt.value
										? 'border-primary bg-primary/10'
										: 'hover:bg-accent'}"
									onclick={() => (choice = opt.value)}
								>
									<span
										class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border {choice ===
										opt.value
											? 'border-primary'
											: 'border-muted-foreground'}"
										aria-hidden="true"
									>
										{#if choice === opt.value}<span class="size-2 rounded-full bg-primary"
											></span>{/if}
									</span>
									<span>
										<span class="block text-sm font-medium">{opt.title}</span>
										<span class="block text-xs text-muted-foreground">{opt.text}</span>
									</span>
								</button>
							{/each}
						</div>
						{#if choice === 'partial'}
							<div class="space-y-1 pt-2">
								<label class="text-sm" for="refund-partial">Davon spenden (ganze Euro)</label>
								<MoneyInput
									id="refund-partial"
									class="w-40"
									label="Spendenbetrag in Euro"
									max={info.amountCents}
									invalid={!!partialProblem}
									bind:cents={partialCents}
								/>
								{#if partialProblem}
									<p class="text-xs text-destructive" role="alert">{partialProblem}</p>
								{:else}
									<p class="text-xs text-muted-foreground">
										Wir zahlen {formatEuro(info.amountCents - partialCents)} aus.
									</p>
								{/if}
							</div>
						{/if}
						{#if choice !== 'payout'}
							<div class="space-y-1 pt-2">
								<label class="text-sm" for="refund-note">Nachricht an den Stamm (freiwillig)</label>
								<Input id="refund-note" bind:value={note} maxlength={300} autocomplete="off" />
							</div>
						{/if}
						<!-- Honeypot: für Menschen unsichtbar -->
						<div class="hidden" aria-hidden="true">
							<label for="refund-website">Website</label>
							<input id="refund-website" tabindex="-1" autocomplete="off" bind:value={website} />
						</div>
					</fieldset>
					{#if error}
						<p class="flex items-start gap-2 text-sm text-destructive" role="alert">
							<CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
							{error}
						</p>
					{/if}
					<Button class="self-start" disabled={busy || !!partialProblem} onclick={submit}>
						{busy ? 'Speichert …' : 'Auswahl speichern'}
					</Button>
					<p class="text-xs text-muted-foreground">
						Die Auszahlung erfolgt in der Regel auf das Konto, von dem der Beitrag überwiesen wurde.
						Du kannst die Auswahl ändern, bis überwiesen wurde.
					</p>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</main>
