<script lang="ts">
	import { page } from '$app/state';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Send from '@lucide/svelte/icons/send';
	import X from '@lucide/svelte/icons/x';
	import { toast } from 'svelte-sonner';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { RichTextEditor } from '$lib/components/ui/rich-text-editor';
	import { SelectField } from '$lib/components/ui/select-field';
	import {
		BUSY_SEND,
		ConfirmDialog,
		FormField,
		LoadingState,
		PageHeader,
		PageTitle
	} from '$lib/components/layout';
	import {
		MAX_FILES,
		MAX_FILE_BYTES,
		MAX_TOTAL_BYTES,
		type MessageDetail,
		type RecipientsResult,
		type SendersResponse
	} from '../schemas';
	import { BASE, COMPOSE_KEY, errorText, formatSize, type ComposePreset } from './helpers';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	/** Wer alle Mitglieder sehen darf, nutzt `/members`; Gruppenleitungen den eigenen Bereich `/led` */
	const membersBase = $derived(
		can(permissions, 'members.member.view') ? '/modules/members' : '/modules/members/led'
	);

	interface GroupOption {
		value: string;
		label: string;
		description?: string;
	}
	interface PickedMember {
		id: string;
		name: string;
	}

	let senders = $state<SendersResponse | null>(null);
	let groups = $state<GroupOption[]>([]);
	let loading = $state(true);
	let loadError = $state('');

	let senderKey = $state<string | null>(null);
	let replyTo = $state('');
	let subject = $state('');
	let bodyHtml = $state('');
	let groupIds = $state<string[]>([]);
	let members = $state<PickedMember[]>([]);
	let excluded = $state<string[]>([]);
	let files = $state<File[]>([]);

	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let busy = $state(false);
	let confirmOpen = $state(false);

	// --- Laden -----------------------------------------------------------------------------
	async function load() {
		try {
			const [s, g] = await Promise.all([
				apiFetch<SendersResponse>(`${BASE}/senders`),
				apiFetch<{ id: string; name: string }[]>(`${membersBase}/groups`).catch(() => [])
			]);
			senders = s;
			groups = g.map((x) => ({ value: x.id, label: x.name }));
			senderKey = s.senders[0]?.key ?? null;
			applyPreset();
			loadError = '';
		} catch (e) {
			loadError = errorText(e, 'Die Absender konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}

	/** Auswahl aus der Mitglieder- bzw. Gruppenliste übernehmen (einmalig) */
	function applyPreset() {
		try {
			const raw = sessionStorage.getItem(COMPOSE_KEY);
			if (raw) {
				sessionStorage.removeItem(COMPOSE_KEY);
				const preset = JSON.parse(raw) as ComposePreset;
				groupIds = [...new Set(preset.groupIds ?? [])];
				members = (preset.members ?? []).map((m) => ({ id: m.id, name: m.name }));
			}
		} catch {
			// Auswahl nicht lesbar – leer starten
		}
		const fromUrl = new URLSearchParams(location.search).get('group');
		if (fromUrl && !groupIds.includes(fromUrl)) groupIds = [...groupIds, fromUrl];
	}
	void load();

	// --- Absender / Antwortadresse -----------------------------------------------------------
	const senderOptions = $derived(
		(senders?.senders ?? []).map((s) => ({ value: s.key, label: s.label }))
	);
	const chosenSender = $derived(senders?.senders.find((s) => s.key === senderKey) ?? null);
	const replyToPlaceholder = $derived(
		senders?.replyToDefault === 'sender'
			? (chosenSender?.address ?? '')
			: (senders?.accountEmail ?? chosenSender?.address ?? '')
	);

	// --- Empfänger (Vorschau) ----------------------------------------------------------------
	let preview = $state<RecipientsResult | null>(null);
	let previewError = $state('');
	let previewBusy = $state(false);
	let showAddresses = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let previewSeq = 0;

	$effect(() => {
		const body = {
			groupIds: [...groupIds],
			memberIds: members.map((m) => m.id),
			excludeMemberIds: [...excluded]
		};
		clearTimeout(timer);
		if (!body.groupIds.length && !body.memberIds.length) {
			preview = null;
			previewError = '';
			return;
		}
		const seq = ++previewSeq;
		timer = setTimeout(async () => {
			previewBusy = true;
			try {
				const res = await apiFetch<RecipientsResult>(`${BASE}/recipients/resolve`, {
					method: 'POST',
					body: JSON.stringify(body)
				});
				if (seq === previewSeq) {
					preview = res;
					previewError = '';
				}
			} catch (e) {
				if (seq === previewSeq) {
					preview = null;
					previewError = errorText(e, 'Die Empfänger konnten nicht ermittelt werden.');
				}
			} finally {
				if (seq === previewSeq) previewBusy = false;
			}
		}, 250);
		return () => clearTimeout(timer);
	});

	// --- Einzelne Mitglieder suchen ------------------------------------------------------------
	let search = $state('');
	let results = $state<PickedMember[]>([]);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchSeq = 0;

	$effect(() => {
		const q = search.trim();
		clearTimeout(searchTimer);
		if (q.length < 2) {
			results = [];
			return;
		}
		const seq = ++searchSeq;
		searchTimer = setTimeout(async () => {
			try {
				const res = await apiFetch<{
					items: { id: string; firstName: string; lastName: string }[];
				}>(`${membersBase}/members?search=${encodeURIComponent(q)}&limit=8`);
				if (seq === searchSeq) {
					results = res.items
						.filter((m) => !members.some((x) => x.id === m.id))
						.map((m) => ({ id: m.id, name: `${m.firstName} ${m.lastName}`.trim() }));
				}
			} catch {
				if (seq === searchSeq) results = [];
			}
		}, 250);
		return () => clearTimeout(searchTimer);
	});

	function addMember(m: PickedMember) {
		members = [...members, m];
		search = '';
		results = [];
	}
	function removeMember(id: string) {
		members = members.filter((m) => m.id !== id);
	}
	function excludeMember(id: string) {
		excluded = [...excluded, id];
	}

	// --- Anhänge ---------------------------------------------------------------------------------
	let fileError = $state('');
	const totalBytes = $derived(files.reduce((s, f) => s + f.size, 0));

	function addFiles(list: FileList | null) {
		fileError = '';
		const next = [...files];
		for (const f of Array.from(list ?? [])) {
			if (f.size === 0) fileError = `„${f.name}“ ist leer.`;
			else if (f.size > MAX_FILE_BYTES)
				fileError = `„${f.name}“ ist zu groß (höchstens ${formatSize(MAX_FILE_BYTES)}).`;
			else if (next.length >= MAX_FILES) fileError = `Höchstens ${MAX_FILES} Anhänge.`;
			else if (next.reduce((s, x) => s + x.size, 0) + f.size > MAX_TOTAL_BYTES)
				fileError = `Die Anhänge dürfen zusammen höchstens ${formatSize(MAX_TOTAL_BYTES)} groß sein.`;
			else next.push(f);
		}
		files = next;
	}

	const confirmText = $derived(
		`Die Nachricht „${subject.trim()}“ geht als eigene Mail an ${preview?.recipients.length ?? 0} Adressen${
			files.length ? `, mit ${files.length} ${files.length === 1 ? 'Anhang' : 'Anhängen'}` : ''
		}. Das lässt sich nicht zurückholen.`
	);

	// --- Senden ---------------------------------------------------------------------------------
	const bodyEmpty = $derived(!bodyHtml.replace(/<[^>]*>/g, '').trim());

	function validate(): boolean {
		const e: Record<string, string> = {};
		if (!senderKey) e.senderKey = 'Bitte einen Absender wählen';
		if (!preview || preview.recipients.length === 0) e.recipients = 'Bitte Empfänger auswählen';
		else if (preview.recipients.length > preview.maxRecipients)
			e.recipients = `Höchstens ${preview.maxRecipients} Empfänger auf einmal`;
		if (!subject.trim()) e.subject = 'Bitte einen Betreff eingeben';
		if (bodyEmpty) e.bodyHtml = 'Bitte einen Text eingeben';
		errors = e;
		return Object.keys(e).length === 0;
	}

	function askSend() {
		formError = '';
		if (validate()) confirmOpen = true;
	}

	async function send() {
		busy = true;
		formError = '';
		try {
			const form = new FormData();
			form.set(
				'data',
				JSON.stringify({
					senderKey,
					replyTo: replyTo.trim(),
					subject: subject.trim(),
					bodyHtml,
					groupIds,
					memberIds: members.map((m) => m.id),
					excludeMemberIds: excluded
				})
			);
			for (const f of files) form.append('files', f);
			const created = await apiFetch<MessageDetail>(`${BASE}/messages`, {
				method: 'POST',
				body: form
			});
			toast.success('Nachricht wird gesendet');
			location.assign(`${BASE}/${created.id}`);
		} catch (e) {
			formError = errorText(e, 'Die Nachricht konnte nicht gesendet werden.');
			toast.error(formError);
		} finally {
			busy = false;
		}
	}
</script>

<PageTitle title="Neue Nachricht" />

<div class="space-y-6">
	<a
		href={BASE}
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" /> Zum Verlauf
	</a>
	<PageHeader
		title="Neue Nachricht"
		description="E-Mail an Mitglieder oder Gruppen. Jede Person bekommt ihre eigene Mail – die Empfänger sehen einander nicht."
	/>

	{#if loading}
		<LoadingState label="Lädt …" rows={4} />
	{:else if loadError}
		<Alert variant="destructive"><AlertDescription>{loadError}</AlertDescription></Alert>
	{:else if senders && senders.senders.length === 0}
		<Alert variant="warning">
			<AlertDescription>
				Du hast keine Absenderadresse.
				{senders.personalHint ?? ''}
				Bitte wende dich an die Administration.
			</AlertDescription>
		</Alert>
	{:else if senders}
		<Card.Root>
			<Card.Header><Card.Title level={2}>Empfänger</Card.Title></Card.Header>
			<Card.Content class="space-y-4">
				<FormField label="Gruppen" id="m-groups" error={errors.recipients}>
					<MultiSelect
						id="m-groups"
						label="Gruppen"
						options={groups}
						bind:value={groupIds}
						placeholder="Gruppen wählen …"
						searchPlaceholder="Gruppe suchen …"
						emptyText="Keine Gruppen gefunden"
					/>
				</FormField>
				<FormField label="Einzelne Mitglieder" id="m-search" hint="Name eingeben (ab 2 Zeichen)">
					<Input
						id="m-search"
						bind:value={search}
						placeholder="Mitglied suchen …"
						autocomplete="off"
					/>
				</FormField>
				{#if results.length}
					<ul class="divide-y rounded-md border" aria-label="Suchergebnisse">
						{#each results as r (r.id)}
							<li class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
								<span>{r.name}</span>
								<Button type="button" size="sm" variant="outline" onclick={() => addMember(r)}>
									Hinzufügen
								</Button>
							</li>
						{/each}
					</ul>
				{/if}
				{#if members.length}
					<ul class="flex flex-wrap gap-2" aria-label="Ausgewählte Mitglieder">
						{#each members as m (m.id)}
							<li>
								<Badge variant="secondary" class="gap-1">
									{m.name}
									<button
										type="button"
										class="focus-ring rounded-sm"
										aria-label={`${m.name} entfernen`}
										onclick={() => removeMember(m.id)}
									>
										<X class="size-3" />
									</button>
								</Badge>
							</li>
						{/each}
					</ul>
				{/if}

				<div aria-live="polite" class="space-y-2 text-sm">
					{#if previewBusy && !preview}
						<p class="text-muted-foreground">Empfänger werden ermittelt …</p>
					{:else if previewError}
						<p class="text-destructive" role="alert">{previewError}</p>
					{:else if preview}
						<p>
							<strong>{preview.recipients.length}</strong> Adressen von
							<strong>{preview.members}</strong> Mitgliedern
							{#if preview.recipients.length > 0}
								<button
									type="button"
									class="ml-1 text-link underline"
									onclick={() => (showAddresses = !showAddresses)}
								>
									{showAddresses ? 'Liste ausblenden' : 'Liste anzeigen'}
								</button>
							{/if}
						</p>
						{#if preview.withoutEmail.length}
							<Alert variant="warning">
								<AlertDescription>
									Ohne E-Mail-Adresse (werden nicht angeschrieben):
									{preview.withoutEmail.map((m) => m.name).join(', ')}
								</AlertDescription>
							</Alert>
						{/if}
						{#if preview.exited}
							<p class="text-muted-foreground">
								{preview.exited} ausgetretene Mitglieder werden übersprungen.
							</p>
						{/if}
						{#if showAddresses}
							<ul class="max-h-56 divide-y overflow-auto rounded-md border">
								{#each preview.recipients as r (r.address)}
									<li class="flex items-center justify-between gap-2 px-3 py-1">
										<span class="min-w-0 truncate">{r.name} · {r.address}</span>
										<button
											type="button"
											class="shrink-0 text-xs text-muted-foreground underline"
											onclick={() => excludeMember(r.memberId)}
										>
											Mitglied ausschließen
										</button>
									</li>
								{/each}
							</ul>
						{/if}
						{#if excluded.length}
							<p class="text-muted-foreground">
								{excluded.length} Mitglieder ausgeschlossen.
								<button type="button" class="text-link underline" onclick={() => (excluded = [])}>
									Zurücksetzen
								</button>
							</p>
						{/if}
					{:else}
						<p class="text-muted-foreground">Noch keine Empfänger gewählt.</p>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header><Card.Title level={2}>Absender</Card.Title></Card.Header>
			<Card.Content class="grid gap-4 sm:grid-cols-2">
				<FormField label="Gesendet von" id="m-sender" error={errors.senderKey} required>
					<SelectField
						id="m-sender"
						label="Gesendet von"
						options={senderOptions}
						bind:value={senderKey}
					/>
				</FormField>
				<FormField
					label="Antworten gehen an"
					id="m-reply"
					hint="Leer = {senders.replyToDefault === 'sender'
						? 'Absenderadresse'
						: 'E-Mail-Adresse deines Kontos'}"
				>
					<Input
						id="m-reply"
						type="email"
						bind:value={replyTo}
						placeholder={replyToPlaceholder}
						autocomplete="off"
					/>
				</FormField>
				{#if senders.personalHint}
					<p class="text-xs text-muted-foreground sm:col-span-2">{senders.personalHint}</p>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header><Card.Title level={2}>Nachricht</Card.Title></Card.Header>
			<Card.Content class="space-y-4">
				<FormField label="Betreff" id="m-subject" error={errors.subject} required>
					<Input id="m-subject" bind:value={subject} maxlength={200} autocomplete="off" />
				</FormField>
				<div class="space-y-1.5">
					<span class="text-sm font-medium" id="m-body-label">Text</span>
					<RichTextEditor
						id="m-body"
						label="Nachrichtentext"
						bind:value={bodyHtml}
						invalid={!!errors.bodyHtml}
						describedby={errors.bodyHtml ? 'm-body-error' : undefined}
						placeholder="Liebe Eltern, liebe Pfadfinder*innen …"
						minHeight="16rem"
					/>
					{#if errors.bodyHtml}
						<p id="m-body-error" class="text-xs text-destructive" role="alert">
							{errors.bodyHtml}
						</p>
					{/if}
				</div>

				<div class="space-y-2">
					<div class="flex flex-wrap items-center gap-3">
						<label
							class="focus-within:ring-ring inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted focus-within:ring-2"
						>
							<Paperclip class="size-4" />
							Dateien anhängen
							<input
								type="file"
								multiple
								class="sr-only"
								aria-label="Dateien anhängen"
								onchange={(e) => {
									addFiles(e.currentTarget.files);
									e.currentTarget.value = '';
								}}
							/>
						</label>
						<span class="text-xs text-muted-foreground">
							Bis zu {MAX_FILES} Dateien, je {formatSize(MAX_FILE_BYTES)}, zusammen {formatSize(
								MAX_TOTAL_BYTES
							)} (PDF, Bilder, Office, Text, ZIP)
						</span>
					</div>
					{#if fileError}<p class="text-xs text-destructive" role="alert">{fileError}</p>{/if}
					{#if files.length}
						<ul class="divide-y rounded-md border" aria-label="Anhänge">
							{#each files as f, i (f.name + i)}
								<li class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
									<span class="min-w-0 truncate">{f.name}</span>
									<span class="flex shrink-0 items-center gap-2">
										<span class="text-xs text-muted-foreground tabular-nums">
											{formatSize(f.size)}
										</span>
										<button
											type="button"
											class="focus-ring rounded-sm"
											aria-label={`${f.name} entfernen`}
											onclick={() => (files = files.filter((_, j) => j !== i))}
										>
											<X class="size-4" />
										</button>
									</span>
								</li>
							{/each}
						</ul>
						<p class="text-xs text-muted-foreground tabular-nums">
							Gesamt {formatSize(totalBytes)}
						</p>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>

		{#if formError}<p class="text-sm text-destructive" role="alert">{formError}</p>{/if}
		<div class="flex flex-wrap justify-end gap-2">
			<Button variant="outline" href={BASE}>Abbrechen</Button>
			<Button onclick={askSend} disabled={busy}>
				<Send class="size-4" />
				{busy ? BUSY_SEND : 'Senden'}
			</Button>
		</div>
	{/if}
</div>

<ConfirmDialog
	bind:open={confirmOpen}
	title="Nachricht senden?"
	description={confirmText}
	confirmLabel="Jetzt senden"
	onconfirm={send}
/>
