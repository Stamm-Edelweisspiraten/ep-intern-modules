<script lang="ts">
	import { untrack } from 'svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import type { PublicLinkInfo } from '../schemas';

	let { params }: { params: Record<string, string>; path?: string } = $props();

	const token = $derived(params.token ?? '');
	const base = '/api/v1/modules/members/public/link';
	const pagePath = $derived(`/p/members/verknuepfen/${token}`);
	const loginHref = $derived(`/login?redirectTo=${encodeURIComponent(pagePath)}`);
	const storeKey = $derived(`members-link-code:${token}`);

	let info = $state<PublicLinkInfo | null>(null);
	let loading = $state(true);
	let unavailable = $state(false);
	let loadError = $state('');

	let mode = $state<'existing' | 'new'>('existing');
	let code = $state('');
	let relation = $state('');
	let name = $state('');
	let email = $state('');
	let password = $state('');
	let password2 = $state('');
	let busy = $state(false);
	let error = $state('');
	let done = $state<null | 'claimed' | 'registered'>(null);

	interface ErrBody {
		error?: { message?: string };
	}

	async function load() {
		loading = true;
		try {
			const res = await fetch(`${base}/${encodeURIComponent(token)}`, {
				headers: { accept: 'application/json' }
			});
			if (res.status === 404) {
				unavailable = true;
				return;
			}
			if (!res.ok) {
				loadError = 'Die Seite konnte nicht geladen werden.';
				return;
			}
			info = ((await res.json()) as { data: PublicLinkInfo }).data;
			try {
				code = sessionStorage.getItem(storeKey) ?? '';
			} catch {
				// Speicher nicht verfügbar
			}
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

	const codeDigits = $derived(code.replace(/\D/g, ''));
	const codeOk = $derived(codeDigits.length === 6);

	function rememberCode() {
		try {
			sessionStorage.setItem(storeKey, code);
		} catch {
			// egal
		}
	}

	async function send(
		path: string,
		body: Record<string, unknown>,
		result: 'claimed' | 'registered'
	) {
		error = '';
		busy = true;
		try {
			const res = await fetch(`${base}/${encodeURIComponent(token)}/${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify(body)
			});
			if (res.ok) {
				try {
					sessionStorage.removeItem(storeKey);
				} catch {
					// egal
				}
				done = result;
				return;
			}
			const b = (await res.json().catch(() => null)) as ErrBody | null;
			error =
				res.status === 429
					? 'Zu viele Versuche. Bitte warte kurz und versuche es erneut.'
					: (b?.error?.message ?? 'Das hat leider nicht geklappt.');
		} catch {
			error = 'Das hat leider nicht geklappt. Bitte prüfe deine Verbindung.';
		} finally {
			busy = false;
		}
	}

	function claim(e: SubmitEvent) {
		e.preventDefault();
		if (!codeOk) {
			error = 'Bitte gib den 6-stelligen Code aus dem Brief ein.';
			return;
		}
		void send('claim', { code: codeDigits, relation: relation || null }, 'claimed');
	}

	function register(e: SubmitEvent) {
		e.preventDefault();
		if (!codeOk) {
			error = 'Bitte gib den 6-stelligen Code aus dem Brief ein.';
			return;
		}
		if (password.length < 12) {
			error = 'Das Passwort braucht mindestens 12 Zeichen.';
			return;
		}
		if (password !== password2) {
			error = 'Die Passwörter stimmen nicht überein.';
			return;
		}
		void send(
			'register',
			{ code: codeDigits, name, email, password, relation: relation || null },
			'registered'
		);
	}
</script>

<svelte:head><title>Konto verknüpfen</title></svelte:head>

<div class="mx-auto w-full max-w-md space-y-4 px-4 py-8">
	{#if loading}
		<Skeleton class="h-64 w-full" />
	{:else if unavailable}
		<Card.Root>
			<Card.Content class="flex items-start gap-3 pt-6">
				<CircleAlert class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
				<div>
					<p class="font-medium">Dieser Link ist nicht mehr gültig.</p>
					<p class="text-sm text-muted-foreground">
						Bitte wende dich an deinen Stamm – wir schicken dir einen neuen Brief.
					</p>
				</div>
			</Card.Content>
		</Card.Root>
	{:else if loadError || !info}
		<p class="text-sm text-destructive" role="alert">{loadError}</p>
	{:else if done}
		<Card.Root>
			<Card.Content class="flex items-start gap-3 pt-6">
				<CircleCheck class="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
				<div class="space-y-3">
					{#if done === 'claimed'}
						<p class="font-medium">Dein Konto ist jetzt mit {info.memberFirstName} verknüpft.</p>
						<Button href="/dashboard">Zur Startseite</Button>
					{:else}
						<p class="font-medium">
							Dein Konto wurde angelegt und mit {info.memberFirstName} verknüpft.
						</p>
						<p class="text-sm text-muted-foreground">Du kannst dich jetzt anmelden.</p>
						<Button href="/login?redirectTo=%2Fdashboard">Zur Anmeldung</Button>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title>Konto verknüpfen</Card.Title>
				<Card.Description>
					Verknüpfe dein Konto mit {info.memberFirstName}. Den Code findest du in dem Brief, den du
					erhalten hast.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-5">
				<div class="space-y-1.5">
					<Label for="link-code">Code (6 Ziffern)</Label>
					<Input
						id="link-code"
						bind:value={code}
						inputmode="numeric"
						autocomplete="one-time-code"
						maxlength={7}
						placeholder="123 456"
						class="text-center font-mono text-lg tracking-widest"
					/>
				</div>
				<div class="space-y-1.5">
					<Label for="link-relation">Beziehung (optional)</Label>
					<Input
						id="link-relation"
						bind:value={relation}
						maxlength={50}
						placeholder="z. B. Mutter, Vater"
					/>
				</div>

				{#if info.viewer}
					<form class="space-y-3" onsubmit={claim}>
						<p class="text-sm text-muted-foreground">Angemeldet als {info.viewer.name}.</p>
						<Button type="submit" disabled={busy} class="w-full">
							{busy ? 'Verknüpfe …' : `Mit ${info.memberFirstName} verknüpfen`}
						</Button>
					</form>
				{:else}
					<div class="grid grid-cols-2 gap-1 rounded-lg border p-1" role="tablist">
						{#each [{ id: 'existing', label: 'Ich habe ein Konto' }, { id: 'new', label: 'Neues Konto' }] as t (t.id)}
							<button
								type="button"
								role="tab"
								aria-selected={mode === t.id}
								class="rounded-md px-3 py-2 text-sm font-medium transition-colors {mode === t.id
									? 'bg-primary text-primary-foreground'
									: 'text-muted-foreground hover:text-foreground'}"
								onclick={() => {
									mode = t.id as 'existing' | 'new';
									error = '';
								}}>{t.label}</button
							>
						{/each}
					</div>

					{#if mode === 'existing'}
						<div class="space-y-3">
							<p class="text-sm text-muted-foreground">
								Melde dich an. Danach kommst du hierher zurück und kannst die Verknüpfung
								abschließen.
							</p>
							<Button href={loginHref} class="w-full" onclick={rememberCode}>Anmelden</Button>
						</div>
					{:else}
						<form class="space-y-4" onsubmit={register}>
							<div class="space-y-1.5">
								<Label for="link-name">Dein Name</Label>
								<Input
									id="link-name"
									bind:value={name}
									required
									maxlength={120}
									autocomplete="name"
								/>
							</div>
							<div class="space-y-1.5">
								<Label for="link-email">E-Mail-Adresse</Label>
								<Input
									id="link-email"
									type="email"
									bind:value={email}
									required
									maxlength={200}
									autocomplete="email"
								/>
							</div>
							<div class="space-y-1.5">
								<Label for="link-pw">Passwort (mindestens 12 Zeichen)</Label>
								<Input
									id="link-pw"
									type="password"
									bind:value={password}
									required
									minlength={12}
									maxlength={128}
									autocomplete="new-password"
								/>
							</div>
							<div class="space-y-1.5">
								<Label for="link-pw2">Passwort wiederholen</Label>
								<Input
									id="link-pw2"
									type="password"
									bind:value={password2}
									required
									autocomplete="new-password"
								/>
							</div>
							<Button type="submit" disabled={busy} class="w-full">
								{busy ? 'Lege Konto an …' : 'Konto anlegen und verknüpfen'}
							</Button>
						</form>
					{/if}
				{/if}

				{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</div>
