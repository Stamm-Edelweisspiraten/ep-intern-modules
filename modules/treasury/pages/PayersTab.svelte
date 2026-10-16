<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { ConfirmDialog, EmptyState } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import type { Payer, PayerFormInput, PayerSuggestion } from '../schemas';
	import { BASE, errorMessage, type SharedData } from './helpers';
	import PayerDialog from './PayerDialog.svelte';

	let {
		payers,
		members,
		perm,
		version,
		onchanged
	}: SharedData & { onchanged: () => void | Promise<void> } = $props();

	let suggestions = $state<PayerSuggestion[]>([]);
	let dialogOpen = $state(false);
	let edit = $state<Payer | null>(null);
	let preset = $state<PayerFormInput | null>(null);
	let deleteOpen = $state(false);
	let toDelete = $state<Payer | null>(null);
	let busy = $state(false);

	async function loadSuggestions() {
		try {
			suggestions = await apiFetch<PayerSuggestion[]>(`${BASE}/payers/suggestions`);
		} catch {
			suggestions = [];
		}
	}

	$effect(() => {
		void version;
		void loadSuggestions();
	});

	function create(p: PayerFormInput | null = null) {
		edit = null;
		preset = p;
		dialogOpen = true;
	}

	async function quickCreate(s: PayerSuggestion) {
		busy = true;
		try {
			await apiFetch(`${BASE}/payers`, {
				method: 'POST',
				body: JSON.stringify({ name: s.name, memberIds: s.members.map((m) => m.id) })
			});
			toast.success(`${s.name} angelegt`);
			await onchanged();
		} catch (e) {
			toast.error(errorMessage(e, 'Anlegen fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function showIban(p: Payer) {
		try {
			const r = await apiFetch<{ iban: string }>(`${BASE}/payers/${p.id}/iban`);
			await navigator.clipboard?.writeText(r.iban.replace(/\s/g, '')).catch(() => undefined);
			toast.info(`IBAN ${p.name}: ${r.iban} (kopiert)`, { duration: 10000 });
		} catch (e) {
			toast.error(errorMessage(e, 'IBAN nicht verfügbar'));
		}
	}

	async function remove() {
		if (!toDelete) return;
		try {
			await apiFetch(`${BASE}/payers/${toDelete.id}`, { method: 'DELETE' });
			toast.success('Zahler gelöscht');
			await onchanged();
		} catch (e) {
			toast.error(errorMessage(e, 'Löschen fehlgeschlagen'));
		}
	}
</script>

<div class="space-y-6">
	{#if suggestions.length && perm.editInvoice}
		<Card.Root class="border-primary/30">
			<Card.Header>
				<Card.Title>Geschwister erkannt</Card.Title>
				<Card.Description>
					Diese Mitglieder haben dieselbe E-Mail-Adresse oder Anschrift. Als Zahler zusammengefasst
					erscheinen ihre offenen Posten gemeinsam und Sammelüberweisungen werden erkannt.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<ul class="divide-y">
					{#each suggestions as s (s.members.map((m) => m.id).join())}
						<li class="flex flex-wrap items-center gap-3 py-2">
							<div class="min-w-0 flex-1">
								<div class="font-medium">{s.name}</div>
								<div class="text-xs text-muted-foreground">
									{s.members.map((m) => m.name).join(', ')} · {s.reason}
								</div>
							</div>
							<Button
								size="sm"
								variant="ghost"
								onclick={() => create({ name: s.name, memberIds: s.members.map((m) => m.id) })}
							>
								Anpassen
							</Button>
							<Button size="sm" onclick={() => quickCreate(s)} disabled={busy}>Übernehmen</Button>
						</li>
					{/each}
				</ul>
			</Card.Content>
		</Card.Root>
	{/if}

	<div class="flex items-center justify-between gap-2">
		<h2 class="text-lg font-semibold">Zahler ({payers.length})</h2>
		{#if perm.editInvoice}
			<Button onclick={() => create()}><Plus /> Zahler</Button>
		{/if}
	</div>

	{#if !payers.length}
		<Card.Root>
			<Card.Content>
				<EmptyState
					title="Noch keine Zahler"
					description="Fasse Geschwister zu einer Familie zusammen – z. B. über die Vorschläge oben."
				/>
			</Card.Content>
		</Card.Root>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each payers as p (p.id)}
				<Card.Root>
					<Card.Header class="flex flex-row items-start gap-2 space-y-0">
						<div class="min-w-0 flex-1">
							<Card.Title class="truncate text-base">{p.name}</Card.Title>
							{#if p.email}<Card.Description class="truncate">{p.email}</Card.Description>{/if}
						</div>
						{#if perm.editInvoice}
							<Button
								variant="ghost"
								size="icon"
								aria-label={`${p.name} bearbeiten`}
								onclick={() => {
									edit = p;
									preset = null;
									dialogOpen = true;
								}}
							>
								<Pencil />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								aria-label={`${p.name} löschen`}
								onclick={() => {
									toDelete = p;
									deleteOpen = true;
								}}
							>
								<Trash2 />
							</Button>
						{/if}
					</Card.Header>
					<Card.Content class="space-y-3">
						<div class="flex flex-wrap gap-1">
							{#each p.members as m (m.id)}<Badge variant="outline">{m.name}</Badge>{/each}
							{#if !p.members.length}
								<span class="text-xs text-muted-foreground">Keine Mitglieder zugeordnet</span>
							{/if}
						</div>
						{#if p.ibanMasked || p.accountHolder}
							<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								<span>{p.accountHolder ?? 'Bankverbindung'}</span>
								{#if p.ibanMasked}<span class="font-mono">{p.ibanMasked}</span>{/if}
								{#if p.ibanMasked && perm.bank}
									<Button size="sm" variant="ghost" class="h-6 px-2" onclick={() => showIban(p)}>
										anzeigen
									</Button>
								{/if}
							</div>
						{/if}
						<div class="flex flex-wrap gap-x-4 text-sm tabular-nums">
							<span>Offen <strong>{formatEuro(p.openCents)}</strong></span>
							{#if p.overdueCents}
								<span class="text-destructive">überfällig {formatEuro(p.overdueCents)}</span>
							{/if}
							{#if p.creditCents}<span>Guthaben {formatEuro(p.creditCents)}</span>{/if}
						</div>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>

<PayerDialog bind:open={dialogOpen} payer={edit} {preset} {members} onsaved={onchanged} />
<ConfirmDialog
	bind:open={deleteOpen}
	title="Zahler löschen?"
	description="Rechnungen und Zahlungen bleiben erhalten; nur die Zusammenfassung entfällt."
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
