<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { formatDateDe, todayBerlin } from '$lib/sdk/dates';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		BUSY_SAVE,
		EmptyState,
		ErrorState,
		FormField,
		LoadingState,
		toastWithUndo
	} from '$lib/components/layout';
	import { SENDER_RULE_LABELS, type SenderRule, type SenderRuleKindValue } from '../schemas';
	import { BASE, errorText } from './helpers';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let rules = $state<SenderRule[] | null>(null);
	let loadError = $state('');
	let kind = $state<SenderRuleKindValue>('block');
	let value = $state('');
	let search = $state('');
	let fieldError = $state<string | null>(null);
	let busy = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);

	async function load() {
		try {
			rules = await apiFetch<SenderRule[]>(`${BASE}/spam/rules`);
			loadError = '';
		} catch (e) {
			loadError = errorText(e, 'Die Liste konnte nicht geladen werden.');
		}
	}

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			untrack(() => {
				rules = null;
				loadError = '';
				value = '';
				search = '';
				fieldError = null;
				void load();
			});
		}
		wasOpen = open;
	});

	const counts = $derived({
		block: rules?.filter((r) => r.kind === 'block').length ?? 0,
		allow: rules?.filter((r) => r.kind === 'allow').length ?? 0
	});
	const visible = $derived(
		(rules ?? []).filter(
			(r) => r.kind === kind && (!search.trim() || r.pattern.includes(search.trim().toLowerCase()))
		)
	);

	async function create(body: { kind: SenderRuleKindValue; value: string }) {
		return apiFetch<SenderRule>(`${BASE}/spam/rules`, {
			method: 'POST',
			body: JSON.stringify(body)
		});
	}

	async function add(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		fieldError = null;
		if (value.trim().length < 3) {
			fieldError = 'Bitte eine Adresse oder Domain eingeben';
			inputEl?.focus();
			return;
		}
		busy = true;
		try {
			const rule = await create({ kind, value });
			toast.success(
				`${rule.pattern} ${kind === 'block' ? 'gesperrt' : 'als vertrauenswürdig eingetragen'}`
			);
			value = '';
			await load();
			await tick();
			inputEl?.focus();
		} catch (err) {
			if (err instanceof ApiClientError && (err.status === 409 || err.status === 422)) {
				fieldError = err.message;
				inputEl?.focus();
			} else {
				toast.error(errorText(err, 'Speichern fehlgeschlagen'));
			}
		} finally {
			busy = false;
		}
	}

	async function remove(rule: SenderRule) {
		try {
			await apiFetch(`${BASE}/spam/rules/${rule.id}`, { method: 'DELETE' });
			toastWithUndo({
				message: `${rule.pattern} von der Liste entfernt`,
				undo: () => create({ kind: rule.kind, value: rule.pattern }),
				onundone: load
			});
			await load();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Spam-Schutz</Dialog.Title>
			<Dialog.Description>
				Gilt für alle Postfächer. Gesperrte Absender landen immer im Spam. Vertrauenswürdige nie –
				außer die Absenderprüfung des Mailservers schlägt fehl. Mitglieder, Konten und Adressen, an
				die schon geschrieben wurde, gelten automatisch als vertrauenswürdig.
			</Dialog.Description>
		</Dialog.Header>

		<Tabs.Root bind:value={kind}>
			<Tabs.List variant="line" class="w-full justify-start">
				<Tabs.Trigger value="block" class="flex-none">
					{SENDER_RULE_LABELS.block} ({counts.block})
				</Tabs.Trigger>
				<Tabs.Trigger value="allow" class="flex-none">
					{SENDER_RULE_LABELS.allow} ({counts.allow})
				</Tabs.Trigger>
			</Tabs.List>
		</Tabs.Root>

		<form class="flex flex-col gap-2 sm:flex-row sm:items-start" onsubmit={add} novalidate>
			<div class="min-w-0 flex-1">
				<FormField
					label={kind === 'block' ? 'Absender sperren' : 'Absender vertrauen'}
					id="spam-rule-value"
					hint="Adresse (name@example.org) oder ganze Domain (example.org)"
					error={fieldError}
				>
					<Input
						id="spam-rule-value"
						bind:ref={inputEl}
						bind:value
						maxlength={254}
						autocomplete="off"
						placeholder="name@example.org oder example.org"
						oninput={() => (fieldError = null)}
					/>
				</FormField>
			</div>
			<Button type="submit" class="sm:mt-6" disabled={busy}>
				<Plus class="size-4" />
				{busy ? BUSY_SAVE : kind === 'block' ? 'Sperren' : 'Hinzufügen'}
			</Button>
		</form>

		<div class="min-h-40">
			{#if !rules && !loadError}
				<LoadingState label="Lädt …" rows={3} />
			{:else if loadError}
				<ErrorState message={loadError} onretry={load} compact />
			{:else if (kind === 'block' ? counts.block : counts.allow) === 0}
				<EmptyState
					title={kind === 'block' ? 'Niemand gesperrt' : 'Keine Einträge'}
					description={kind === 'block'
						? 'Klicke an einer Mail auf „Spam“, um den Absender zu sperren, oder trage ihn oben ein.'
						: 'Klicke an einer Mail im Spam auf „Kein Spam“, um dem Absender zu vertrauen, oder trage ihn oben ein.'}
				/>
			{:else}
				{#if (kind === 'block' ? counts.block : counts.allow) > 8}
					<Input
						class="mb-2"
						type="search"
						bind:value={search}
						placeholder="Liste durchsuchen …"
						aria-label="Liste durchsuchen"
					/>
				{/if}
				<ul class="max-h-80 divide-y overflow-y-auto rounded-md border">
					{#each visible as r (r.id)}
						<li class="flex items-center gap-3 px-3 py-2">
							<div class="min-w-0 flex-1">
								<p class="flex flex-wrap items-center gap-2 text-sm font-medium break-all">
									{r.pattern}
									{#if r.matchType === 'domain'}<Badge variant="secondary">Domain</Badge>{/if}
								</p>
								<p class="text-xs text-muted-foreground">
									{r.origin === 'button'
										? r.kind === 'block'
											? 'Über „Spam“ an einer Mail'
											: 'Über „Kein Spam“ an einer Mail'
										: 'Von Hand eingetragen'}
									{r.createdByName ? ` · ${r.createdByName}` : ''} · {formatDateDe(
										todayBerlin(new Date(r.createdAt))
									)}
								</p>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`${r.pattern} entfernen`}
								onclick={() => remove(r)}
							>
								<Trash2 class="size-4" />
							</Button>
						</li>
					{:else}
						<li class="px-3 py-4 text-sm text-muted-foreground">Keine Treffer</li>
					{/each}
				</ul>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Schließen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
