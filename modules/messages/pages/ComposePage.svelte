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
	import { contrastTextColor } from '$lib/components/ui/color-picker/color';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
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
		LAYOUTS,
		LAYOUT_LABELS,
		type MessageLayout,
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
		id: string;
		name: string;
		/** #rrggbb oder null */
		color: string | null;
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
	let layout = $state<MessageLayout>('stamm');
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
				apiFetch<{ id: string; name: string; color: string | null }[]>(
					`${membersBase}/groups`
				).catch(() => [])
			]);
			senders = s;
			groups = g.map((x) => ({ id: x.id, name: x.name, color: x.color ?? null }));
			senderKey = s.senders[0]?.key ?? null;
			layout = s.layoutDefault;
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

	// --- Ein Eingabefeld für Gruppen und Mitglieder ---------------------------------------------
	let search = $state('');
	let focused = $state(false);
	let memberResults = $state<PickedMember[]>([]);
	let activeIndex = $state(0);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchSeq = 0;

	type Option =
		| { kind: 'group'; id: string; label: string; color: string | null }
		| { kind: 'member'; id: string; label: string };

	const fold = (v: string) =>
		v.toLocaleLowerCase('de').replace(/ß/g, 'ss').normalize('NFD').replace(/\p{M}/gu, '');

	const options = $derived.by<Option[]>(() => {
		const q = fold(search.trim());
		const groupHits = groups
			.filter((g) => !groupIds.includes(g.id) && (!q || fold(g.name).includes(q)))
			.map((g): Option => ({ kind: 'group', id: g.id, label: g.name, color: g.color }));
		const memberHits = memberResults.map((m): Option => ({
			kind: 'member',
			id: m.id,
			label: m.name
		}));
		return [...groupHits, ...memberHits];
	});
	const open = $derived(focused && options.length > 0);

	$effect(() => {
		const q = search.trim();
		clearTimeout(searchTimer);
		if (q.length < 2) {
			memberResults = [];
			return;
		}
		const seq = ++searchSeq;
		searchTimer = setTimeout(async () => {
			try {
				const res = await apiFetch<{
					items: { id: string; firstName: string; lastName: string }[];
				}>(`${membersBase}/members?search=${encodeURIComponent(q)}&limit=8`);
				if (seq === searchSeq) {
					memberResults = res.items
						.filter((m) => !members.some((x) => x.id === m.id))
						.map((m) => ({ id: m.id, name: `${m.firstName} ${m.lastName}`.trim() }));
				}
			} catch {
				if (seq === searchSeq) memberResults = [];
			}
		}, 250);
		return () => clearTimeout(searchTimer);
	});
	// Treffer ändern sich: Auswahl zurück an den Anfang
	$effect(() => {
		void options.length;
		activeIndex = 0;
	});

	function choose(o: Option) {
		if (o.kind === 'group') groupIds = [...groupIds, o.id];
		else members = [...members, { id: o.id, name: o.label }];
		search = '';
		memberResults = [];
	}
	function removeMember(id: string) {
		members = members.filter((m) => m.id !== id);
	}
	function removeGroup(id: string) {
		groupIds = groupIds.filter((g) => g !== id);
	}
	function excludeMember(id: string) {
		excluded = [...excluded, id];
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' && options.length) {
			e.preventDefault();
			activeIndex = (activeIndex + 1) % options.length;
		} else if (e.key === 'ArrowUp' && options.length) {
			e.preventDefault();
			activeIndex = (activeIndex - 1 + options.length) % options.length;
		} else if (e.key === 'Enter' && open) {
			e.preventDefault();
			const o = options[activeIndex];
			if (o) choose(o);
		} else if (e.key === 'Escape') {
			focused = false;
		} else if (e.key === 'Backspace' && !search) {
			if (members.length) removeMember(members[members.length - 1]!.id);
			else if (groupIds.length) removeGroup(groupIds[groupIds.length - 1]!);
		}
	}
	const groupById = (id: string) => groups.find((g) => g.id === id);

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
	const layoutOptions = LAYOUTS.map((l) => ({ value: l, label: LAYOUT_LABELS[l] }));

	/** Betreff, der Spam-Filter eher auslöst: Großbuchstaben, viele Ausrufezeichen, Reizwörter */
	const subjectHint = $derived.by(() => {
		const t = subject.trim();
		if (!t) return '';
		const letters = t.replace(/[^\p{L}]/gu, '');
		if (letters.length >= 6 && letters === letters.toUpperCase()) {
			return 'Ein Betreff in Großbuchstaben landet eher im Spam – besser normal schreiben.';
		}
		if ((t.match(/[!?]/g) ?? []).length > 2) {
			return 'Viele Ausrufe- oder Fragezeichen im Betreff erhöhen den Spam-Wert.';
		}
		return '';
	});

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
					layout,
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
				<div class="space-y-2">
					<FormField
						label="An"
						id="m-to"
						error={errors.recipients}
						hint="Gruppe oder Name eingeben und mit Enter übernehmen"
					>
						<div class="relative">
							<Input
								id="m-to"
								role="combobox"
								aria-expanded={open}
								aria-controls="m-to-list"
								aria-autocomplete="list"
								aria-activedescendant={open ? `m-to-opt-${activeIndex}` : undefined}
								bind:value={search}
								placeholder="Gruppe oder Mitglied suchen …"
								autocomplete="off"
								onfocus={() => (focused = true)}
								onblur={() => setTimeout(() => (focused = false), 120)}
								onkeydown={onKey}
							/>
							{#if open}
								<ul
									id="m-to-list"
									role="listbox"
									aria-label="Vorschläge"
									class="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
								>
									{#each options as o, i (o.kind + o.id)}
										{#if i === 0 || options[i - 1]!.kind !== o.kind}
											<li
												role="presentation"
												class="px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground"
											>
												{o.kind === 'group' ? 'Gruppen' : 'Mitglieder'}
											</li>
										{/if}
										<li
											id={`m-to-opt-${i}`}
											role="option"
											aria-selected={i === activeIndex}
											class="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm {i ===
											activeIndex
												? 'bg-muted'
												: ''}"
											onmousedown={(e) => {
												e.preventDefault();
												choose(o);
											}}
											onmouseenter={() => (activeIndex = i)}
										>
											{#if o.kind === 'group'}
												<span
													class="size-3 shrink-0 rounded-full border"
													style:background-color={o.color ?? 'transparent'}
													aria-hidden="true"
												></span>
											{/if}
											{o.label}
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					</FormField>
					{#if groupIds.length || members.length}
						<ul class="flex flex-wrap gap-2" aria-label="Empfänger">
							{#each groupIds as gid (gid)}
								{@const g = groupById(gid)}
								<li>
									<Badge
										variant="outline"
										class="gap-1"
										style={g?.color
											? `background-color:${g.color};color:${contrastTextColor(g.color)};border-color:${g.color}`
											: ''}
									>
										{g?.name ?? 'Gruppe'}
										<button
											type="button"
											class="focus-ring rounded-sm"
											aria-label={`Gruppe ${g?.name ?? ''} entfernen`}
											onclick={() => removeGroup(gid)}
										>
											<X class="size-3" />
										</button>
									</Badge>
								</li>
							{/each}
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
				</div>

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
				<FormField
					label="Aussehen"
					id="m-layout"
					hint="Einfach sieht aus wie eine Mail aus dem Mailprogramm und hat den geringsten Spam-Wert"
				>
					<SelectField
						id="m-layout"
						label="Aussehen"
						options={layoutOptions}
						value={layout}
						onchange={(v) => (layout = (v as MessageLayout) ?? 'stamm')}
					/>
				</FormField>
				{#if senders.deliverabilityHint}
					<p class="text-xs text-warning sm:col-span-2" role="note">
						{senders.deliverabilityHint}
					</p>
				{/if}
				{#if senders.personalHint}
					<p class="text-xs text-muted-foreground sm:col-span-2">{senders.personalHint}</p>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header><Card.Title level={2}>Nachricht</Card.Title></Card.Header>
			<Card.Content class="space-y-4">
				<FormField
					label="Betreff"
					id="m-subject"
					error={errors.subject}
					hint={subjectHint || undefined}
					required
				>
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
