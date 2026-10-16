<script lang="ts">
	import { toast } from 'svelte-sonner';
	import FileDown from '@lucide/svelte/icons/file-down';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Unlink from '@lucide/svelte/icons/unlink';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ConfirmDialog } from '$lib/components/layout';
	import type { LinkedUser, Member, MemberLinks } from '../schemas';
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
			void load();
		}
	});

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
	<Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Verknüpfte Konten</Dialog.Title>
			<Dialog.Description>
				{member ? `${member.firstName} ${member.lastName}` : ''} – Benutzerkonten, die mit diesem Mitglied
				verknüpft sind (z. B. Eltern).
			</Dialog.Description>
		</Dialog.Header>

		{#if loading && !links}
			<p class="text-sm text-muted-foreground">Lade …</p>
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
				{:else}
					<p class="text-muted-foreground">
						Gültig bis {fmt(links.code.expiresAt)}{links.code.locked
							? ' · wegen Fehlversuchen vorübergehend gesperrt'
							: ''}. Mehrere Personen können denselben Code nutzen.
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
