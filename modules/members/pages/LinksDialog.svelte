<script lang="ts">
	import { toast } from 'svelte-sonner';
	import FileDown from '@lucide/svelte/icons/file-down';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Search from '@lucide/svelte/icons/search';
	import Unlink from '@lucide/svelte/icons/unlink';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { ConfirmDialog, EntityAvatar, BUSY_LOAD } from '$lib/components/layout';
	import type { LinkedUser, LinkUserRef, Member, MemberLinks } from '../schemas';
	import { downloadPdf } from './download';

	let {
		open = $bindable(false),
		member,
		canManage,
		onchanged
	}: {
		open?: boolean;
		member: Member | null;
		canManage: boolean;
		onchanged: () => void;
	} = $props();

	let links = $state<MemberLinks | null>(null);
	let loading = $state(false);
	let error = $state('');
	let busy = $state(false);
	let removeOpen = $state(false);
	let removeUser = $state<LinkedUser | null>(null);

	const fmt = (iso: string) =>
		new Date(iso).toLocaleDateString('de-DE', {
			day: '2-digit',
			month: '2-digit',
			year: 'numeric'
		});

	async function load() {
		if (!member) return;
		loading = true;
		error = '';
		try {
			links = await apiFetch<MemberLinks>(`/modules/members/members/${member.id}/links`);
		} catch (e) {
			error = e instanceof ApiClientError ? e.message : 'Laden fehlgeschlagen';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open && member) {
			links = null;
			search = '';
			results = [];
			relation = '';
			void load();
		}
	});

	// --- Konto per Hand verknüpfen -------------------------------------------
	let search = $state('');
	let relation = $state('');
	let results = $state<LinkUserRef[]>([]);
	let searching = $state(false);
	let searchError = $state('');
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchSeq = 0;

	/** Bereits verknüpfte Konten nicht noch einmal anbieten */
	const visibleResults = $derived(results.filter((r) => !links?.users.some((u) => u.id === r.id)));

	function onSearchInput() {
		clearTimeout(searchTimer);
		const q = search.trim();
		searchError = '';
		if (q.length < 2) {
			results = [];
			searching = false;
			return;
		}
		searching = true;
		const seq = ++searchSeq;
		searchTimer = setTimeout(async () => {
			try {
				const found = await apiFetch<LinkUserRef[]>(
					`/modules/members/link-users?search=${encodeURIComponent(q)}`
				);
				if (seq === searchSeq) results = found;
			} catch (e) {
				if (seq === searchSeq) {
					results = [];
					searchError = e instanceof ApiClientError ? e.message : 'Suche fehlgeschlagen';
				}
			} finally {
				if (seq === searchSeq) searching = false;
			}
		}, 250);
	}

	async function linkUser(u: LinkUserRef) {
		if (!member || busy) return;
		busy = true;
		try {
			links = await apiFetch<MemberLinks>(`/modules/members/members/${member.id}/links`, {
				method: 'POST',
				body: JSON.stringify({ userId: u.id, relation: relation.trim() || null })
			});
			toast.success(`${u.name} verknüpft`);
			search = '';
			results = [];
			relation = '';
			onchanged();
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Verknüpfen fehlgeschlagen');
		} finally {
			busy = false;
		}
	}

	async function newCode() {
		if (!member) return;
		busy = true;
		try {
			await apiFetch(`/modules/members/members/${member.id}/link-code`, { method: 'POST' });
			toast.success('Neuer Code erzeugt – der alte Link und Code sind ungültig');
			await load();
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Code konnte nicht erzeugt werden');
		} finally {
			busy = false;
		}
	}

	async function letter() {
		if (!member) return;
		busy = true;
		try {
			await downloadPdf(
				`/api/v1/modules/members/members/${member.id}/link-letter.pdf`,
				{ method: 'GET' },
				`Konto-Verknuepfung-${member.lastName}.pdf`
			);
			await load();
			onchanged();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'PDF konnte nicht erzeugt werden');
		} finally {
			busy = false;
		}
	}

	async function confirmRemove() {
		if (!member || !removeUser) return;
		try {
			await apiFetch(
				`/modules/members/members/${member.id}/links/${encodeURIComponent(removeUser.id)}`,
				{ method: 'DELETE' }
			);
			toast.success('Verknüpfung gelöst');
			await load();
			onchanged();
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Lösen fehlgeschlagen');
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Verknüpfte Konten</Dialog.Title>
			<Dialog.Description>
				{member ? `${member.firstName} ${member.lastName}` : ''} – Benutzerkonten, die mit diesem Mitglied
				verknüpft sind (z. B. Eltern).
			</Dialog.Description>
		</Dialog.Header>

		{#if loading && !links}
			<p class="text-sm text-muted-foreground">{BUSY_LOAD}</p>
		{:else if error}
			<p class="text-sm text-destructive" role="alert">{error}</p>
		{:else if links}
			{#if links.users.length}
				<ul class="divide-y rounded-md border">
					{#each links.users as u (u.id)}
						<li class="flex items-center justify-between gap-3 px-3 py-2">
							<div class="min-w-0">
								<p class="truncate text-sm font-medium">
									{u.name}
									{#if u.relation}<Badge variant="secondary" class="ml-1">{u.relation}</Badge>{/if}
								</p>
								<p class="truncate text-xs text-muted-foreground">
									{u.email ?? '–'} · verknüpft am {fmt(u.linkedAt)}
								</p>
							</div>
							{#if canManage}
								<Button
									size="icon"
									variant="outline"
									aria-label={`Verknüpfung mit ${u.name} lösen`}
									onclick={() => {
										removeUser = u;
										removeOpen = true;
									}}><Unlink /></Button
								>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
					Noch kein Konto verknüpft.
				</p>
			{/if}

			{#if canManage}
				<fieldset class="space-y-3 rounded-md border p-3">
					<legend class="px-1 text-sm font-medium">Konto direkt verknüpfen</legend>
					<div class="grid gap-3 sm:grid-cols-2">
						<div class="grid gap-1.5">
							<Label for="link-user-search">Benutzerkonto</Label>
							<div class="relative">
								<Search
									class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
									aria-hidden="true"
								/>
								<Input
									id="link-user-search"
									type="search"
									class="pl-8"
									bind:value={search}
									oninput={onSearchInput}
									autocomplete="off"
									placeholder="Name oder E-Mail"
									disabled={busy}
								/>
							</div>
						</div>
						<div class="grid gap-1.5">
							<Label for="link-relation">Beziehung (optional)</Label>
							<Input
								id="link-relation"
								bind:value={relation}
								maxlength={50}
								placeholder="z. B. Mutter, Vater, selbst"
								disabled={busy}
							/>
						</div>
					</div>
					{#if search.trim().length >= 2}
						<div class="rounded-md border" aria-live="polite">
							{#if searching}
								<p class="p-3 text-xs text-muted-foreground">Sucht …</p>
							{:else if searchError}
								<p class="p-3 text-xs text-destructive" role="alert">{searchError}</p>
							{:else if visibleResults.length === 0}
								<p class="p-3 text-xs text-muted-foreground">Kein passendes Konto gefunden.</p>
							{:else}
								<ul class="max-h-56 divide-y overflow-y-auto">
									{#each visibleResults as u (u.id)}
										<li>
											<button
												type="button"
												class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none disabled:opacity-60"
												disabled={busy}
												onclick={() => linkUser(u)}
											>
												<EntityAvatar name={u.name} size={28} />
												<span class="min-w-0 flex-1">
													<span class="block truncate text-sm font-medium">{u.name}</span>
													<span class="block truncate text-xs text-muted-foreground">{u.email}</span
													>
												</span>
												<UserPlus class="size-4 text-muted-foreground" aria-hidden="true" />
												<span class="sr-only">verknüpfen</span>
											</button>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					{:else}
						<p class="text-xs text-muted-foreground">
							Nur aktive Konten. Im Profil erscheint das Mitglied, wenn das Konto die Rolle
							„Mitglied“ (oder das Recht für eigene Mitglieder) hat.
						</p>
					{/if}
				</fieldset>
			{/if}

			<div class="space-y-1 text-sm">
				<p class="font-medium">Verknüpfungscode</p>
				{#if !links.code}
					<p class="text-muted-foreground">
						Noch kein Code erzeugt. Der Brief erzeugt ihn automatisch.
					</p>
				{:else if links.code.expired}
					<p class="text-muted-foreground">
						Abgelaufen am {fmt(links.code.expiresAt)}. Der nächste Brief erzeugt einen neuen Code.
					</p>
				{:else if links.code.exhausted}
					<p class="text-muted-foreground">
						Verbraucht: {links.code.uses} von {links.code.maxUses} Konten verknüpft. Der nächste Brief
						erzeugt einen neuen Code.
					</p>
				{:else}
					<p class="text-muted-foreground">
						Gültig bis {fmt(links.code.expiresAt)}{links.code.locked
							? ' · wegen Fehlversuchen vorübergehend gesperrt'
							: ''}. Bisher {links.code.uses} von {links.code.maxUses} Konten über diesen Code verknüpft.
					</p>
				{/if}
			</div>

			{#if canManage}
				<Dialog.Footer class="gap-2 sm:justify-between">
					<Button variant="outline" disabled={busy} onclick={newCode}>
						<RefreshCw /> Neuen Code erzeugen
					</Button>
					<Button disabled={busy} onclick={letter}><FileDown /> Brief als PDF</Button>
				</Dialog.Footer>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={removeOpen}
	title="Verknüpfung lösen?"
	description={removeUser
		? `${removeUser.name} kann danach nicht mehr für dieses Mitglied handeln. Das Konto bleibt bestehen.`
		: undefined}
	confirmLabel="Lösen"
	destructive
	onconfirm={confirmRemove}
/>
