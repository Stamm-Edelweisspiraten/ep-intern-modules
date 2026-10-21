<script lang="ts">
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { PublicConfirmResult } from '../schemas';

	/**
	 * Bestätigung einer Anmeldung über den Link aus der E-Mail (Double-Opt-in). Bestätigt wird erst per
	 * Knopfdruck (POST) – Link-Vorschauen und Virenscanner, die Links nur aufrufen, bestätigen nichts.
	 */
	let { params }: { params: Record<string, string>; path?: string } = $props();

	const token = $derived(params.token ?? '');
	let busy = $state(false);
	let result = $state<PublicConfirmResult | null>(null);
	let error = $state('');

	interface ErrBody {
		error?: { message?: string };
	}

	async function confirm() {
		if (busy) return;
		busy = true;
		error = '';
		try {
			const res = await fetch(
				`/api/v1/modules/actions/public/registrations/${encodeURIComponent(token)}/confirm`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: '{}'
				}
			);
			if (res.ok) {
				result = ((await res.json()) as { data: PublicConfirmResult }).data;
				return;
			}
			const b = (await res.json().catch(() => null)) as ErrBody | null;
			error =
				res.status === 429
					? 'Zu viele Versuche. Bitte warte kurz und versuche es erneut.'
					: (b?.error?.message ?? 'Die Anmeldung konnte nicht bestätigt werden.');
		} catch {
			error = 'Die Anmeldung konnte nicht bestätigt werden. Bitte prüfe deine Verbindung.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Anmeldung bestätigen</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8 sm:py-12">
	{#if result}
		<Card.Root>
			<Card.Content class="flex flex-col gap-5">
				<div class="flex flex-col items-center gap-3 text-center">
					<CircleCheck class="size-12 text-success" aria-hidden="true" />
					<h1 class="text-title">Vielen Dank, {result.name}!</h1>
					<p class="text-muted-foreground text-sm" role="status">
						Die Anmeldung zu „{result.actionName}“ ist bestätigt.
						{result.emailSent
							? 'Die Anmeldebestätigung haben wir dir per E-Mail geschickt.'
							: 'Die Anmeldebestätigung konnte nicht per E-Mail gesendet werden. Bitte notiere dir die folgenden Angaben.'}
					</p>
				</div>
				{#if result.disclaimer}
					<div class="bg-muted/50 rounded-lg px-4 py-3 text-sm whitespace-pre-line">
						{result.disclaimer}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title level={1} class="text-section">Anmeldung bestätigen</Card.Title>
				<Card.Description>
					Mit dem Knopf bestätigst du deine E-Mail-Adresse und die Anmeldung. Erst danach ist sie
					gültig.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				{#if error}
					<p class="text-destructive flex items-start gap-2 text-sm" role="alert">
						<CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						{error}
					</p>
				{/if}
				<Button onclick={confirm} disabled={busy || !token} class="self-start">
					{busy ? 'Bestätigt …' : 'Anmeldung bestätigen'}
				</Button>
			</Card.Content>
		</Card.Root>
	{/if}
</main>
