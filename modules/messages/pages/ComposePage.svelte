<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Mail from '@lucide/svelte/icons/mail';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Send from '@lucide/svelte/icons/send';
	import X from '@lucide/svelte/icons/x';
	import { toast } from 'svelte-sonner';
	import { apiFetch, can } from '$lib/sdk/client';
	import { assistStatus } from '$lib/sdk/client/assist';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { contrastTextColor } from '$lib/components/ui/color-picker/color';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		AssistInput,
		AssistRichTextEditor,
		type AssistConfig,
		BUSY_SEND,
		ConfirmDialog,
		FormField,
		LoadingState,
		PageHeader,
		PageTitle
	} from '$lib/components/layout';
	import {
		type ComposePrefill,
		emailAddress,
		type InboxAttachmentInfo,
		LAYOUTS,
		LAYOUT_LABELS,
		type MessageLayout,
		MAX_ADDRESSES,
		MAX_FILES,
		MAX_FILE_BYTES,
		MAX_TOTAL_BYTES,
		type MessageDetail,
		type MessagePreview,
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
	/** Frei eingegebene Adressen (klein geschrieben) */
	let addresses = $state<string[]>([]);
	let excluded = $state<string[]>([]);
	let files = $state<File[]>([]);
	/** Antwort/Weiterleitung aus dem Posteingang (`?reply=<id>&mode=…` bzw. `?forward=<id>`) */
	let composeMode = $state<ComposePrefill['mode'] | null>(null);
	let replyOf = $state<string | null>(null);
	let forwardOf = $state<string | null>(null);
	/** Anhänge der weitergeleiteten Mail, die mitgehen */
	let forwarded = $state<InboxAttachmentInfo[]>([]);
	const inboxRef = $derived(replyOf ?? forwardOf);
	/** Aktion, aus der die Schreibhilfe Eckdaten holt (`?action=<id>`, z. B. Info-Mail an Teilnehmende) */
	let actionId = $state<string | null>(null);
	/** Eingegangene Mail darf als Kontext an die KI (Einstellung der Verwaltung) */
	let assistInbox = $state(false);
	void assistStatus().then((st) => (assistInbox = st.allowInbox));
	const bodyAssist = $derived<AssistConfig>(
		replyOf && assistInbox
			? {
					module: 'messages',
					purpose: 'inbox-reply',
					context: { module: 'messages', kind: 'inbox-message', id: replyOf }
				}
			: {
					module: 'messages',
					purpose: 'mail',
					context: actionId ? { module: 'actions', kind: 'action', id: actionId } : undefined
				}
	);
	const subjectAssist = $derived<AssistConfig>({
		module: 'messages',
		purpose: 'mail-subject',
		context: actionId ? { module: 'actions', kind: 'action', id: actionId } : undefined
	});
	const pageTitle = $derived(
		composeMode === 'forward' ? 'Weiterleiten' : composeMode ? 'Antworten' : 'Neue Nachricht'
	);

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
			await applyInboxPrefill(s);
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
				addresses = [...new Set((preset.addresses ?? []).map((a) => a.trim().toLowerCase()))]
					.filter(Boolean)
					.slice(0, 100);
				if (preset.actionId) actionId = preset.actionId;
			}
		} catch {
			// Auswahl nicht lesbar – leer starten
		}
		const action = new URLSearchParams(location.search).get('action');
		if (action && /^[0-9a-f-]{36}$/i.test(action)) actionId = action;
		const fromUrl = new URLSearchParams(location.search).get('group');
		if (fromUrl && !groupIds.includes(fromUrl)) groupIds = [...groupIds, fromUrl];
	}
	/** Vorbelegung für Antworten/Weiterleiten aus dem Posteingang laden */
	async function applyInboxPrefill(s: SendersResponse) {
		const params = new URLSearchParams(location.search);
		const reply = params.get('reply');
		const forward = params.get('forward');
		const id = forward ?? reply;
		if (!id) return;
		const mode = forward ? 'forward' : params.get('mode') === 'reply-all' ? 'reply-all' : 'reply';
		const pre = await apiFetch<ComposePrefill>(
			`${BASE}/inbox/${encodeURIComponent(id)}/compose?mode=${mode}`
		);
		composeMode = pre.mode;
		replyOf = pre.replyOf;
		forwardOf = pre.forwardOf;
		forwarded = pre.attachments;
		subject = pre.subject;
		bodyHtml = pre.bodyHtml;
		addresses = pre.addresses;
		// Absender des Postfachs vorwählen (falls die Person ihn verwenden darf)
		if (pre.senderKey && s.senders.some((x) => x.key === pre.senderKey)) senderKey = pre.senderKey;
	}
	void load();

	// --- Absender / Antwortadresse -----------------------------------------------------------
	const senderOptions = $derived(
		(senders?.senders ?? []).map((s) => ({ value: s.key, label: s.label }))
	);
	const chosenSender = $derived(senders?.senders.find((s) => s.key === senderKey) ?? null);
	const replyToPlaceholder = $derived(
		senders?.inboxEnabled || senders?.replyToDefault === 'sender'
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
			excludeMemberIds: [...excluded],
			addresses: [...addresses]
		};
		clearTimeout(timer);
		if (!body.groupIds.length && !body.memberIds.length && !body.addresses.length) {
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
		| { kind: 'address'; id: string; label: string }
		| { kind: 'group'; id: string; label: string; color: string | null }
		| { kind: 'member'; id: string; label: string };

	const OPTION_HEADINGS: Record<Option['kind'], string> = {
		address: 'E-Mail-Adresse',
		group: 'Gruppen',
		member: 'Mitglieder'
	};

	/** Gültige, normalisierte Adresse oder `null` (gleiche Regel wie der Server) */
	function asAddress(v: string): string | null {
		const r = emailAddress.safeParse(v.trim().replace(/^<|>$/g, ''));
		return r.success ? r.data : null;
	}
	function addAddresses(list: string[]): boolean {
		const next = [...addresses];
		for (const a of list) {
			if (next.length >= MAX_ADDRESSES) {
				toast.error(`Höchstens ${MAX_ADDRESSES} einzelne Adressen`);
				break;
			}
			if (!next.includes(a)) next.push(a);
		}
		const changed = next.length !== addresses.length;
		addresses = next;
		return changed;
	}
	/** Getippte Adresse übernehmen (Enter, Komma, Semikolon, Verlassen des Felds) */
	function commitTypedAddress(): boolean {
		const a = asAddress(search);
		if (!a) return false;
		addAddresses([a]);
		search = '';
		memberResults = [];
		return true;
	}
	/** Mehrere eingefügte Adressen (z. B. aus einer Mail-Liste) auf einmal übernehmen */
	function onPaste(e: ClipboardEvent) {
		const text = e.clipboardData?.getData('text') ?? '';
		const parts = text.split(/[\s,;]+/).filter(Boolean);
		if (parts.length < 2) return;
		const valid = parts.map(asAddress).filter((a): a is string => !!a);
		if (!valid.length) return;
		e.preventDefault();
		addAddresses(valid);
		const rest = parts.filter((p) => !asAddress(p));
		search = rest.join(' ');
		if (rest.length) toast.warning(`Keine gültige Adresse: ${rest.join(', ')}`);
	}

	const fold = (v: string) =>
		v.toLocaleLowerCase('de').replace(/ß/g, 'ss').normalize('NFD').replace(/\p{M}/gu, '');

	const options = $derived.by<Option[]>(() => {
		const q = fold(search.trim());
		const typed = asAddress(search);
		const addressHit: Option[] =
			typed && !addresses.includes(typed)
				? [{ kind: 'address', id: typed, label: `„${typed}“ hinzufügen` }]
				: [];
		const groupHits = groups
			.filter((g) => !groupIds.includes(g.id) && (!q || fold(g.name).includes(q)))
			.map((g): Option => ({ kind: 'group', id: g.id, label: g.name, color: g.color }));
		const memberHits = memberResults.map((m): Option => ({
			kind: 'member',
			id: m.id,
			label: m.name
		}));
		return [...addressHit, ...groupHits, ...memberHits];
	});
	const open = $derived(focused && options.length > 0);

	$effect(() => {
		const q = search.trim();
		clearTimeout(searchTimer);
		// Adressen (mit @) suchen keine Mitglieder
		if (q.length < 2 || q.includes('@')) {
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
		if (o.kind === 'address') addAddresses([o.id]);
		else if (o.kind === 'group') groupIds = [...groupIds, o.id];
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
	function removeAddress(address: string) {
		addresses = addresses.filter((a) => a !== address);
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
		} else if ((e.key === ',' || e.key === ';') && commitTypedAddress()) {
			e.preventDefault();
		} else if (e.key === 'Enter' && search.trim()) {
			e.preventDefault();
			commitTypedAddress();
		} else if (e.key === 'Escape') {
			focused = false;
		} else if (e.key === 'Backspace' && !search) {
			if (addresses.length) removeAddress(addresses[addresses.length - 1]!);
			else if (members.length) removeMember(members[members.length - 1]!.id);
			else if (groupIds.length) removeGroup(groupIds[groupIds.length - 1]!);
		}
	}
	const groupById = (id: string) => groups.find((g) => g.id === id);

	// --- Anhänge ---------------------------------------------------------------------------------
	let fileError = $state('');
	const forwardedBytes = $derived(forwarded.reduce((s, f) => s + f.size, 0));
	const totalBytes = $derived(files.reduce((s, f) => s + f.size, 0) + forwardedBytes);
	const attachmentCount = $derived(files.length + forwarded.length);

	function addFiles(list: FileList | null) {
		fileError = '';
		const next = [...files];
		for (const f of Array.from(list ?? [])) {
			if (f.size === 0) fileError = `„${f.name}“ ist leer.`;
			else if (f.size > MAX_FILE_BYTES)
				fileError = `„${f.name}“ ist zu groß (höchstens ${formatSize(MAX_FILE_BYTES)}).`;
			else if (next.length + forwarded.length >= MAX_FILES)
				fileError = `Höchstens ${MAX_FILES} Anhänge.`;
			else if (next.reduce((s, x) => s + x.size, 0) + forwardedBytes + f.size > MAX_TOTAL_BYTES)
				fileError = `Die Anhänge dürfen zusammen höchstens ${formatSize(MAX_TOTAL_BYTES)} groß sein.`;
			else next.push(f);
		}
		files = next;
	}

	const confirmText = $derived(
		`Die Nachricht „${subject.trim()}“ geht als eigene Mail an ${preview?.recipients.length ?? 0} Adressen${
			attachmentCount
				? `, mit ${attachmentCount} ${attachmentCount === 1 ? 'Anhang' : 'Anhängen'}`
				: ''
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

	// --- Vorschau (Reiter in „Nachricht“) --------------------------------------------------------
	let messageTab = $state<'write' | 'preview'>('write');
	let mailPreview = $state<MessagePreview | null>(null);
	let mailPreviewError = $state('');
	let mailPreviewTimer: ReturnType<typeof setTimeout> | undefined;
	let mailPreviewSeq = 0;

	// Nur bei geöffnetem Reiter und nach kurzer Pause neu rendern lassen (Server bereinigt wie beim Senden)
	$effect(() => {
		if (messageTab !== 'preview') return;
		const body = { senderKey: senderKey ?? undefined, layout, subject, bodyHtml };
		clearTimeout(mailPreviewTimer);
		const seq = ++mailPreviewSeq;
		mailPreviewTimer = setTimeout(
			async () => {
				try {
					const res = await apiFetch<MessagePreview>(`${BASE}/preview`, {
						method: 'POST',
						body: JSON.stringify(body)
					});
					if (seq === mailPreviewSeq) {
						mailPreview = res;
						mailPreviewError = '';
					}
				} catch (e) {
					if (seq === mailPreviewSeq) {
						mailPreviewError = errorText(e, 'Die Vorschau konnte nicht erstellt werden.');
					}
				}
			},
			// untrack: das Ergebnis selbst darf den Effekt nicht erneut auslösen (Endlosschleife → 429)
			untrack(() => mailPreview) ? 400 : 0
		);
		return () => clearTimeout(mailPreviewTimer);
	});

	const previewTo = $derived.by(() => {
		const list = preview?.recipients ?? [];
		const first = list[0];
		if (!first) return 'Noch keine Empfänger';
		const label = first.name ? `${first.name} <${first.address}>` : first.address;
		return list.length > 1 ? `${label} und ${list.length - 1} weitere (je eigene Mail)` : label;
	});

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
		// Fehler im Text sichtbar machen, auch wenn gerade die Vorschau offen ist
		else if (errors.subject || errors.bodyHtml) messageTab = 'write';
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
					excludeMemberIds: excluded,
					addresses,
					...(replyOf ? { replyOf } : {}),
					...(forwardOf ? { forwardOf, forwardAttachmentIds: forwarded.map((a) => a.id) } : {})
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

<PageTitle title={pageTitle} />

<div class="space-y-6">
	<a
		href={inboxRef ? `${BASE}/inbox/${inboxRef}` : BASE}
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" />
		{inboxRef ? 'Zur Nachricht' : 'Zum Posteingang'}
	</a>
	<PageHeader
		title={pageTitle}
		description="E-Mail an Mitglieder, Gruppen oder einzelne Adressen. Jede Person bekommt ihre eigene Mail – die Empfänger sehen einander nicht."
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
		<!-- overflow-visible: die Trefferliste darf über die Karte hinausragen -->
		<Card.Root class="overflow-visible">
			<Card.Header><Card.Title level={2}>Empfänger</Card.Title></Card.Header>
			<Card.Content class="space-y-4">
				<div class="space-y-2">
					<FormField
						label="An"
						id="m-to"
						error={errors.recipients}
						hint="Gruppe, Name oder E-Mail-Adresse eingeben und mit Enter übernehmen – mehrere Adressen lassen sich auch einfügen"
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
								placeholder="Gruppe, Mitglied oder E-Mail-Adresse …"
								autocomplete="off"
								onfocus={() => (focused = true)}
								onblur={() =>
									setTimeout(() => {
										focused = false;
										commitTypedAddress();
									}, 120)}
								onkeydown={onKey}
								onpaste={onPaste}
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
												{OPTION_HEADINGS[o.kind]}
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
											{#if o.kind === 'address'}
												<Mail class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
											{:else if o.kind === 'group'}
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
					{#if groupIds.length || members.length || addresses.length}
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
							{#each addresses as a (a)}
								<li>
									<Badge variant="outline" class="gap-1">
										<Mail class="size-3" aria-hidden="true" />
										{a}
										<button
											type="button"
											class="focus-ring rounded-sm"
											aria-label={`${a} entfernen`}
											onclick={() => removeAddress(a)}
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
							<strong>{preview.recipients.length}</strong> Adressen
							{#if preview.members}von <strong>{preview.members}</strong> Mitgliedern{/if}
							{#if preview.external}
								{preview.members ? '+' : '–'}
								<strong>{preview.external}</strong>
								{preview.external === 1 ? 'einzelne Adresse' : 'einzelne Adressen'}
							{/if}
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
										<span class="min-w-0 truncate">
											{r.name ? `${r.name} · ${r.address}` : r.address}
										</span>
										{#if r.memberId}
											{@const memberId = r.memberId}
											<button
												type="button"
												class="shrink-0 text-xs text-muted-foreground underline"
												onclick={() => excludeMember(memberId)}
											>
												Mitglied ausschließen
											</button>
										{:else}
											<button
												type="button"
												class="shrink-0 text-xs text-muted-foreground underline"
												onclick={() => removeAddress(r.address)}
											>
												Entfernen
											</button>
										{/if}
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
					hint="Leer = {senders.inboxEnabled || senders.replyToDefault === 'sender'
						? 'Absenderadresse (Antworten landen im Posteingang)'
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
				<Tabs.Root
					value={messageTab}
					onValueChange={(v) => (messageTab = v === 'preview' ? 'preview' : 'write')}
				>
					<Tabs.List variant="line" aria-label="Ansicht der Nachricht">
						<Tabs.Trigger value="write">Schreiben</Tabs.Trigger>
						<Tabs.Trigger value="preview">Vorschau</Tabs.Trigger>
					</Tabs.List>
				</Tabs.Root>

				{#if messageTab === 'preview'}
					<div class="space-y-3">
						<dl
							class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm"
						>
							<dt class="text-muted-foreground">Von</dt>
							<dd class="min-w-0 break-words">{mailPreview?.from ?? chosenSender?.label ?? '–'}</dd>
							<dt class="text-muted-foreground">An</dt>
							<dd class="min-w-0 break-words">{previewTo}</dd>
							<dt class="text-muted-foreground">Antwort an</dt>
							<dd class="min-w-0 break-words">{replyTo.trim() || replyToPlaceholder || '–'}</dd>
							<dt class="text-muted-foreground">Betreff</dt>
							<dd class="min-w-0 font-medium break-words">
								{subject.trim() || '(kein Betreff)'}
							</dd>
							{#if attachmentCount}
								<dt class="text-muted-foreground">Anhänge</dt>
								<dd class="min-w-0 break-words">
									{[...forwarded.map((f) => f.filename), ...files.map((f) => f.name)].join(', ')}
								</dd>
							{/if}
						</dl>
						{#if mailPreviewError}
							<p class="text-sm text-destructive" role="alert">{mailPreviewError}</p>
						{:else if !mailPreview}
							<LoadingState label="Vorschau wird erstellt …" rows={3} />
						{:else}
							<!-- Mail-HTML ohne Skripte; Links öffnen in einem neuen Tab -->
							<iframe
								title="Vorschau der E-Mail"
								srcdoc={mailPreview.html}
								sandbox="allow-popups allow-popups-to-escape-sandbox"
								class="h-[36rem] w-full rounded-md border bg-white"
							></iframe>
							<p class="text-xs text-muted-foreground">
								So sieht die Mail ungefähr aus – jedes Mailprogramm stellt sie etwas anders dar.
							</p>
						{/if}
					</div>
				{/if}

				<!-- Bleibt beim Wechsel zur Vorschau eingehängt (Editor-Zustand, Datei-Auswahl) -->
				<div class="space-y-4" hidden={messageTab !== 'write'}>
					<FormField
						label="Betreff"
						id="m-subject"
						error={errors.subject}
						hint={subjectHint || undefined}
						required
					>
						<AssistInput
							id="m-subject"
							bind:value={subject}
							maxlength={200}
							autocomplete="off"
							assist={subjectAssist}
							source={() => bodyHtml}
						/>
					</FormField>
					<div class="space-y-1.5">
						<span class="text-sm font-medium" id="m-body-label">Text</span>
						<AssistRichTextEditor
							id="m-body"
							label="Nachrichtentext"
							bind:value={bodyHtml}
							assist={bodyAssist}
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
						{#if attachmentCount}
							<ul class="divide-y rounded-md border" aria-label="Anhänge">
								{#each forwarded as f (f.id)}
									<li class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
										<span class="flex min-w-0 items-center gap-2">
											<span class="truncate">{f.filename}</span>
											<Badge variant="secondary">aus der Nachricht</Badge>
										</span>
										<span class="flex shrink-0 items-center gap-2">
											<span class="text-xs text-muted-foreground tabular-nums">
												{formatSize(f.size)}
											</span>
											<button
												type="button"
												class="focus-ring rounded-sm"
												aria-label={`${f.filename} entfernen`}
												onclick={() => (forwarded = forwarded.filter((x) => x.id !== f.id))}
											>
												<X class="size-4" />
											</button>
										</span>
									</li>
								{/each}
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
