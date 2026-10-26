<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import type { PrincipalInfo } from '$lib/sdk/types/sharing';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, SharePanel } from '$lib/components/layout';
	import type { ShareCandidate, ShareEntry } from '$lib/components/layout';
	import { shareKey } from '$lib/components/layout/share-types';
	import {
		EXTRA_SHARE_LEVELS,
		EXTRA_SHARE_LEVEL_LABELS,
		MAX_EXTRA_DESCRIPTION,
		MAX_EXTRA_NAME,
		extraMailboxInput,
		type ExtraMailbox
	} from '../schemas';
	import { BASE, errorText } from './helpers';

	let {
		open = $bindable(false),
		mailbox = null,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neues Postfach anlegen */
		mailbox?: ExtraMailbox | null;
		onsaved: (saved: ExtraMailbox) => void;
	} = $props();

	const LEVELS = EXTRA_SHARE_LEVELS.map((value) => ({
		value,
		label: EXTRA_SHARE_LEVEL_LABELS[value]
	}));
	const ids = {
		name: 'extra-mailbox-name',
		address: 'extra-mailbox-address',
		description: 'extra-mailbox-description',
		shares: 'extra-mailbox-shares'
	};

	let name = $state('');
	let address = $state('');
	let description = $state('');
	let shares = $state<ShareEntry[]>([]);
	let fieldErrors = $state<Record<string, string>>({});
	let formError = $state<string | null>(null);
	let busy = $state(false);

	let wasOpen = false;
	$effect(() => {
		const isOpen = open;
		if (isOpen && !wasOpen) {
			untrack(() => {
				name = mailbox?.name ?? '';
				address = mailbox?.address ?? '';
				description = mailbox?.description ?? '';
				shares = (mailbox?.shares ?? []).map((s) => ({
					userId: s.id,
					type: s.type,
					name: s.name,
					detail: s.detail ?? null,
					color: s.color ?? null,
					image: s.image ?? null,
					level: s.level
				}));
				fieldErrors = {};
				formError = null;
				busy = false;
			});
		}
		wasOpen = isOpen;
	});

	async function searchPrincipals(q: string): Promise<ShareCandidate[]> {
		const found = await apiFetch<PrincipalInfo[]>(
			`${BASE}/admin/principals?search=${encodeURIComponent(q)}`
		);
		return found.map((p) => ({
			id: p.id,
			type: p.type,
			name: p.name,
			detail: p.detail ?? null,
			color: p.color ?? null,
			image: p.image ?? null
		}));
	}

	// Freigaben lokal ändern – gespeichert wird erst mit dem Formular
	async function addShare(c: ShareCandidate, level: string) {
		const entry: ShareEntry = {
			userId: c.id,
			type: c.type,
			name: c.name,
			detail: c.detail ?? null,
			color: c.color ?? null,
			image: c.image ?? null,
			level
		};
		if (shares.some((s) => shareKey(s) === shareKey(entry))) return;
		shares = [...shares, entry];
	}
	async function changeShare(key: string, level: string) {
		shares = shares.map((s) => (shareKey(s) === key ? { ...s, level } : s));
	}
	async function removeShare(key: string) {
		shares = shares.filter((s) => shareKey(s) !== key);
	}

	function issuesOf(details: unknown): { path: unknown[]; message: string }[] {
		const issues = Array.isArray(details)
			? details
			: (details as { issues?: unknown[] } | null)?.issues;
		return Array.isArray(issues)
			? (issues as { path?: unknown; message?: unknown }[])
					.filter((i) => typeof i.message === 'string')
					.map((i) => ({
						path: Array.isArray(i.path) ? i.path : [],
						message: String(i.message)
					}))
			: [];
	}

	function applyIssues(list: { path: unknown[]; message: string }[]) {
		const next: Record<string, string> = {};
		for (const i of list) {
			const field = String(i.path[0] ?? '');
			const key = field in ids ? field : 'form';
			next[key] ??= i.message;
		}
		formError = next.form ?? null;
		delete next.form;
		fieldErrors = next;
		const first = Object.keys(next)[0] as keyof typeof ids | undefined;
		if (first) document.getElementById(ids[first])?.focus();
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		fieldErrors = {};
		formError = null;
		const payload = {
			name,
			address,
			description,
			shares: shares.map((s) => ({ type: s.type ?? 'user', id: s.userId, level: s.level }))
		};
		const parsed = extraMailboxInput.safeParse(payload);
		if (!parsed.success) {
			applyIssues(parsed.error.issues.map((i) => ({ path: i.path, message: i.message })));
			return;
		}
		busy = true;
		try {
			const saved = mailbox
				? await apiFetch<ExtraMailbox>(`${BASE}/admin/mailboxes/${mailbox.id}`, {
						method: 'PATCH',
						body: JSON.stringify(parsed.data)
					})
				: await apiFetch<ExtraMailbox>(`${BASE}/admin/mailboxes`, {
						method: 'POST',
						body: JSON.stringify(parsed.data)
					});
			toast.success(mailbox ? 'Postfach gespeichert' : 'Postfach angelegt');
			open = false;
			onsaved(saved);
		} catch (err) {
			if (err instanceof ApiClientError && err.status === 409) {
				fieldErrors = { address: err.message };
				document.getElementById(ids.address)?.focus();
			} else if (err instanceof ApiClientError && issuesOf(err.details).length) {
				applyIssues(issuesOf(err.details));
			} else {
				formError = errorText(err, 'Speichern fehlgeschlagen');
			}
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{mailbox ? 'Postfach bearbeiten' : 'Postfach anlegen'}</Dialog.Title>
			<Dialog.Description>
				Mails an diese Adresse landen im Posteingang aller freigegebenen Personen.
			</Dialog.Description>
		</Dialog.Header>
		<form class="grid gap-4" onsubmit={submit} novalidate>
			<FormField label="Name" id={ids.name} error={fieldErrors.name} required>
				<Input
					id={ids.name}
					bind:value={name}
					maxlength={MAX_EXTRA_NAME}
					autocomplete="off"
					placeholder="z. B. Herbstlager"
				/>
			</FormField>
			<FormField
				label="E-Mail-Adresse"
				id={ids.address}
				error={fieldErrors.address}
				hint="Muss beim Mailserver im Catch-all-Postfach ankommen."
				required
			>
				<Input
					id={ids.address}
					type="email"
					bind:value={address}
					maxlength={254}
					autocomplete="off"
					placeholder="herbstlager@beispiel.de"
				/>
			</FormField>
			<FormField label="Beschreibung" id={ids.description} error={fieldErrors.description}>
				<Textarea
					id={ids.description}
					bind:value={description}
					maxlength={MAX_EXTRA_DESCRIPTION}
					rows={2}
				/>
			</FormField>
			<section class="space-y-2" aria-labelledby="extra-mailbox-shares-heading">
				<h3 id="extra-mailbox-shares-heading" class="font-semibold">Zugriff</h3>
				<p class="text-xs text-muted-foreground">
					„Lesen“ zeigt das Postfach im Posteingang, „Lesen und senden“ erlaubt zusätzlich diese
					Adresse als Absender. Gruppen wirken über die verknüpften Konten ihrer Mitglieder und
					Leitungen. Zugriff bekommen nur Konten mit dem Recht „Nachrichten senden“.
				</p>
				<div
					id={ids.shares}
					tabindex="-1"
					class="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<SharePanel
						{shares}
						levels={LEVELS}
						defaultLevel="read"
						placeholder="Gruppe, Mitglied oder Benutzer*in suchen …"
						searchLabel="Freigabe suchen"
						emptyResultText="Keine passenden Einträge"
						search={searchPrincipals}
						onadd={addShare}
						onchange={changeShare}
						onremove={removeShare}
					/>
				</div>
				{#if fieldErrors.shares}
					<p role="alert" class="text-xs text-destructive">{fieldErrors.shares}</p>
				{/if}
			</section>
			{#if formError}
				<p role="alert" class="text-sm text-destructive">{formError}</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)} disabled={busy}>
					Abbrechen
				</Button>
				<Button type="submit" disabled={busy}>
					{busy ? 'Speichert …' : mailbox ? 'Speichern' : 'Anlegen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
