<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Search from '@lucide/svelte/icons/search';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import X from '@lucide/svelte/icons/x';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		ContactListField,
		EntityAvatar,
		FormField,
		type ContactRow,
		AssistTextarea
	} from '$lib/components/layout';
	import {
		MAX_DESCRIPTION,
		MAX_EMAILS,
		MAX_HOLDERS,
		MAX_NAME,
		holdersInput,
		officeCreateInput,
		officeUpdateInput,
		type Office,
		type OfficeUpdateInput,
		type RoleRef,
		type UserRef
	} from '../schemas';
	import { BASE, detailsToErrors, errorText, issuesToErrors, moveItem } from './helpers';

	let {
		open = $bindable(false),
		office = null,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neues Amt anlegen */
		office?: Office | null;
		/** Nach jedem erfolgreichen Schreibzugriff (Liste neu laden) */
		onsaved: () => void;
	} = $props();

	type TabId = 'general' | 'emails' | 'roles' | 'holders';
	const TABS: { value: TabId; label: string }[] = [
		{ value: 'general', label: 'Allgemein' },
		{ value: 'emails', label: 'E-Mail-Adressen' },
		{ value: 'roles', label: 'Rollen' },
		{ value: 'holders', label: 'Inhaber*innen' }
	];

	interface HolderRow {
		userId: string;
		name: string;
		image: string | null;
		since: string;
	}

	let tab = $state<TabId>('general');
	let name = $state('');
	let description = $state('');
	let emails = $state<ContactRow[]>([]);
	let roleIds = $state<string[]>([]);
	let holders = $state<HolderRow[]>([]);
	let roles = $state<RoleRef[]>([]);
	let rolesError = $state('');
	let busy = $state(false);
	let error = $state('');
	let fieldErrors = $state<Record<string, string>>({});
	/** Nach Anlegen gesetzt: weitere Speichervorgänge (z. B. nach Fehler bei Personen) ändern statt neu anzulegen */
	let savedOffice = $state<Office | null>(null);
	/** Zuletzt gespeicherte Inhaber*innen (Vergleich, ob `PUT holders` nötig ist) */
	let baseHolders = $state<{ userId: string; since: string | null }[]>([]);
	let formEl = $state<HTMLFormElement | null>(null);

	const current = $derived(savedOffice ?? office);
	const isEdit = $derived(!!current);

	// Beim Öffnen Formular füllen bzw. leeren
	$effect(() => {
		if (!open) return;
		const o = office;
		untrack(() => init(o));
	});

	function init(o: Office | null) {
		tab = 'general';
		error = '';
		fieldErrors = {};
		busy = false;
		savedOffice = null;
		search = '';
		results = [];
		name = o?.name ?? '';
		description = o?.description ?? '';
		emails = (o?.emails ?? []).map((e) => ({ name: e.label ?? '', value: e.email }));
		roleIds = (o?.roles ?? []).map((r) => r.id);
		holders = (o?.holders ?? []).map((h) => ({
			userId: h.userId,
			name: h.name,
			image: h.image,
			since: h.since ?? ''
		}));
		baseHolders = holderPayload(holders);
		void loadRoles();
	}

	async function loadRoles() {
		rolesError = '';
		try {
			roles = await apiFetch<RoleRef[]>(`${BASE}/roles`);
		} catch (e) {
			rolesError = errorText(e, 'Rollen konnten nicht geladen werden.');
		}
	}

	/** Verknüpfte Rollen bleiben wählbar, auch wenn sie nicht (mehr) in der Liste stehen */
	const roleOptions = $derived.by(() => {
		const map = new Map<string, string>();
		for (const r of office?.roles ?? []) map.set(r.id, r.name);
		for (const r of roles) map.set(r.id, r.name);
		return [...map].map(([value, label]) => ({ value, label }));
	});

	// --- Benutzersuche ---------------------------------------------------------------------
	let search = $state('');
	let results = $state<UserRef[]>([]);
	let searching = $state(false);
	let searchError = $state('');
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchSeq = 0;

	const visibleResults = $derived(results.filter((u) => !holders.some((h) => h.userId === u.id)));

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
				const found = await apiFetch<UserRef[]>(`${BASE}/users?search=${encodeURIComponent(q)}`);
				if (seq === searchSeq) results = found;
			} catch (e) {
				if (seq === searchSeq) {
					results = [];
					searchError = errorText(e, 'Suche fehlgeschlagen.');
				}
			} finally {
				if (seq === searchSeq) searching = false;
			}
		}, 250);
	}

	function addHolder(u: UserRef) {
		if (holders.some((h) => h.userId === u.id)) return;
		if (holders.length >= MAX_HOLDERS) {
			fieldErrors = { ...fieldErrors, holders: `Höchstens ${MAX_HOLDERS} Personen` };
			return;
		}
		holders = [...holders, { userId: u.id, name: u.name, image: null, since: '' }];
		search = '';
		results = [];
	}

	function removeHolder(index: number) {
		holders = holders.filter((_, i) => i !== index);
	}

	function moveHolder(index: number, delta: number) {
		holders = moveItem(holders, index, index + delta);
	}

	// --- Fehler ----------------------------------------------------------------------------
	function tabOf(key: string): TabId {
		if (key.startsWith('emails')) return 'emails';
		if (key.startsWith('roleIds')) return 'roles';
		if (key.startsWith('holders')) return 'holders';
		return 'general';
	}

	const tabErrors = $derived(new Set(Object.keys(fieldErrors).map(tabOf)));

	function emailRowErrors(errs: Record<string, string>) {
		const out: Record<number, { name?: string; value?: string }> = {};
		for (const [k, msg] of Object.entries(errs)) {
			const m = /^emails\.(\d+)\.(label|email)$/.exec(k);
			if (m) (out[Number(m[1])] ??= {})[m[2] === 'label' ? 'name' : 'value'] = msg;
		}
		return out;
	}

	function holderError(i: number, field: 'userId' | 'since'): string | undefined {
		return fieldErrors[`holders.${i}.${field}`];
	}

	/** Fehlerpfade gefilterter E-Mail-Zeilen auf die Zeilen im Formular zurückrechnen */
	function remapEmailErrors(errs: Record<string, string>, rowMap: number[]) {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(errs)) {
			const m = /^emails\.(\d+)(\..*)?$/.exec(k);
			out[m ? `emails.${rowMap[Number(m[1])] ?? m[1]}${m[2] ?? ''}` : k] = v;
		}
		return out;
	}

	async function showErrors(next: Record<string, string>, message: string) {
		fieldErrors = next;
		error = message;
		const first = TABS.find((t) => tabErrors.has(t.value));
		if (first) tab = first.value;
		await tick();
		formEl?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
	}

	// --- Speichern -------------------------------------------------------------------------
	const sameList = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b);

	function holderPayload(list: HolderRow[]) {
		return list.map((h) => ({ userId: h.userId, since: h.since || null }));
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		error = '';
		fieldErrors = {};

		// Leere E-Mail-Zeilen verwerfen, Zuordnung zum Formular-Index merken
		const rowMap: number[] = [];
		const emailInputs: { label: string | null; email: string }[] = [];
		emails.forEach((row, i) => {
			if (!row.name.trim() && !row.value.trim()) return;
			rowMap.push(i);
			emailInputs.push({ label: row.name.trim() || null, email: row.value.trim() });
		});

		const base = {
			name,
			description: description.trim() || null,
			emails: emailInputs,
			roleIds
		};
		const parsedOffice = officeCreateInput.safeParse(base);
		const parsedHolders = holdersInput.safeParse({ holders: holderPayload(holders) });
		if (!parsedOffice.success || !parsedHolders.success) {
			const errs = {
				...(parsedOffice.success
					? {}
					: remapEmailErrors(issuesToErrors(parsedOffice.error.issues), rowMap)),
				...(parsedHolders.success ? {} : issuesToErrors(parsedHolders.error.issues))
			};
			await showErrors(errs, 'Bitte die markierten Felder prüfen.');
			return;
		}

		busy = true;
		let target = current;
		let changed = false;
		try {
			if (!target) {
				target = await apiFetch<Office>(`${BASE}/offices`, {
					method: 'POST',
					body: JSON.stringify(parsedOffice.data)
				});
				savedOffice = target;
				baseHolders = holderPayload(target.holders.map((h) => ({ ...h, since: h.since ?? '' })));
				changed = true;
			} else {
				// Nur geänderte Felder senden (Listen ersetzen komplett)
				const orig = target;
				const patch: OfficeUpdateInput = {};
				if (parsedOffice.data.name !== orig.name) patch.name = parsedOffice.data.name;
				if ((base.description ?? null) !== (orig.description ?? null)) {
					patch.description = base.description;
				}
				const origEmails = orig.emails.map((x) => ({ label: x.label, email: x.email }));
				if (!sameList(parsedOffice.data.emails, origEmails)) patch.emails = emailInputs;
				const origRoles = orig.roles.map((r) => r.id);
				if (!sameList([...roleIds].sort(), [...origRoles].sort())) patch.roleIds = roleIds;
				if (Object.keys(patch).length > 0) {
					const checked = officeUpdateInput.safeParse(patch);
					if (!checked.success) {
						await showErrors(
							remapEmailErrors(issuesToErrors(checked.error.issues), rowMap),
							'Bitte die markierten Felder prüfen.'
						);
						return;
					}
					target = await apiFetch<Office>(`${BASE}/offices/${encodeURIComponent(orig.id)}`, {
						method: 'PATCH',
						body: JSON.stringify(checked.data)
					});
					if (savedOffice) savedOffice = target;
					changed = true;
				}
			}

			const nextHolders = parsedHolders.data.holders;
			if (!sameList(nextHolders, baseHolders)) {
				target = await apiFetch<Office>(
					`${BASE}/offices/${encodeURIComponent(target.id)}/holders`,
					{
						method: 'PUT',
						body: JSON.stringify({ holders: nextHolders })
					}
				);
				if (savedOffice) savedOffice = target;
				baseHolders = nextHolders;
				changed = true;
			}

			toast.success(office ? 'Amt gespeichert' : 'Amt angelegt');
			open = false;
			onsaved();
		} catch (err) {
			// Teilerfolg (z. B. Amt angelegt, Personen abgelehnt): Liste trotzdem aktualisieren
			if (changed) onsaved();
			const msg = errorText(err, 'Speichern fehlgeschlagen');
			if (err instanceof ApiClientError) {
				let errs = detailsToErrors(err.details);
				errs = remapEmailErrors(errs, rowMap);
				if (err.status === 403 && Object.keys(errs).length === 0) {
					errs = { roleIds: msg };
				}
				await showErrors(
					errs,
					savedOffice && !office ? `Das Amt wurde angelegt, aber: ${msg}` : msg
				);
			} else {
				error = msg;
			}
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
		<Dialog.Header class="border-b p-4 pr-12">
			<Dialog.Title>{isEdit ? 'Amt bearbeiten' : 'Amt anlegen'}</Dialog.Title>
			<Dialog.Description>Pflichtfelder sind mit * markiert.</Dialog.Description>
		</Dialog.Header>

		<form bind:this={formEl} class="flex min-h-0 flex-1 flex-col" onsubmit={submit} novalidate>
			<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col gap-0">
				<div class="border-b px-4 pt-3 pb-2">
					<Tabs.List variant="line" class="w-full justify-start">
						{#each TABS as t (t.value)}
							<Tabs.Trigger value={t.value} class="flex-none">
								{t.label}
								{#if t.value === 'holders' && holders.length > 0}
									<span class="text-xs text-muted-foreground tabular-nums">{holders.length}</span>
								{/if}
								{#if tabErrors.has(t.value)}
									<span class="size-1.5 rounded-full bg-destructive" aria-hidden="true"></span>
									<span class="sr-only">(enthält Fehler)</span>
								{/if}
							</Tabs.Trigger>
						{/each}
					</Tabs.List>
				</div>

				<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:min-h-[22rem]">
					<Tabs.Content value="general" class="space-y-4">
						{#if current?.source}
							<div
								class="space-y-1.5 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
							>
								<p>
									Dieses Amt kommt aus dem Modul
									<span class="font-medium text-foreground">{current.source.moduleName}</span>.
									{#if current.notifications.length > 0}
										Inhaber*innen erhalten diese Benachrichtigungen:
									{:else}
										Derzeit gibt es keine Benachrichtigungen (z. B. weil das Modul nicht aktiv ist).
									{/if}
								</p>
								{#if current.notifications.length > 0}
									<ul class="list-disc space-y-0.5 pl-5">
										{#each current.notifications as n (n.key)}
											<li>{n.label}</li>
										{/each}
									</ul>
									<p>
										Wie und ob, stellt jede*r Inhaber*in im eigenen Profil unter „Meine Ämter“ ein.
									</p>
								{/if}
							</div>
						{/if}
						<FormField label="Name *" id="office-name" error={fieldErrors.name}>
							<Input
								id="office-name"
								bind:value={name}
								maxlength={MAX_NAME}
								required
								autocomplete="off"
								placeholder="z. B. Stammesführung"
								aria-invalid={!!fieldErrors.name}
								aria-describedby={fieldErrors.name ? 'office-name-error' : undefined}
							/>
						</FormField>
						<FormField
							label="Beschreibung"
							id="office-description"
							error={fieldErrors.description}
							hint="Zeilenumbrüche bleiben in der Anzeige erhalten."
						>
							<AssistTextarea
								id="office-description"
								bind:value={description}
								assist={{
									module: 'offices',
									purpose: 'office-description',
									extra: () => ({ name })
								}}
								rows={6}
								maxlength={MAX_DESCRIPTION}
								placeholder="Aufgaben und Zuständigkeiten des Amts"
								aria-invalid={!!fieldErrors.description}
								aria-describedby={fieldErrors.description
									? 'office-description-error'
									: 'office-description-hint'}
							/>
						</FormField>
					</Tabs.Content>

					<Tabs.Content value="emails" class="space-y-3">
						<p class="text-xs text-muted-foreground">
							Funktionsadressen des Amts, z. B. „Kontakt“ oder „Anmeldung“. Leere Zeilen werden
							ignoriert.
						</p>
						<ContactListField
							id="office-emails"
							label="E-Mail-Adressen"
							type="email"
							valueLabel="E-Mail-Adresse"
							valuePlaceholder="name@example.org"
							namePlaceholder="Bezeichnung, z. B. Kontakt"
							addLabel="E-Mail-Adresse hinzufügen"
							max={MAX_EMAILS}
							bind:items={emails}
							emptyText="Keine E-Mail-Adresse hinterlegt."
							errors={emailRowErrors(fieldErrors)}
							listError={fieldErrors.emails}
						/>
					</Tabs.Content>

					<Tabs.Content value="roles" class="space-y-3">
						<FormField
							label="Verknüpfte Rollen"
							id="office-roles"
							error={fieldErrors.roleIds}
							hint="Inhaber*innen erhalten die Rechte dieser Rollen, solange sie das Amt haben."
						>
							<MultiSelect
								id="office-roles"
								label="Verknüpfte Rollen"
								options={roleOptions}
								bind:value={roleIds}
								placeholder="Rollen auswählen …"
								searchPlaceholder="Rolle suchen …"
								emptyText="Keine passende Rolle"
								invalid={!!fieldErrors.roleIds}
								disabled={busy}
							/>
						</FormField>
						<p class="text-xs text-muted-foreground">
							Du kannst nur Rollen verknüpfen, deren Rechte du selbst hast.
						</p>
						{#if rolesError}
							<div class="flex flex-wrap items-center gap-2" role="alert">
								<p class="text-xs text-destructive">{rolesError}</p>
								<Button type="button" variant="outline" size="sm" onclick={loadRoles}>
									Erneut versuchen
								</Button>
							</div>
						{/if}
					</Tabs.Content>

					<Tabs.Content value="holders" class="space-y-4">
						<div class="grid gap-1.5">
							<Label for="office-holder-search">Person hinzufügen</Label>
							<div class="relative">
								<Search
									class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
									aria-hidden="true"
								/>
								<Input
									id="office-holder-search"
									type="search"
									class="pl-8"
									bind:value={search}
									oninput={onSearchInput}
									onkeydown={(e) => {
										if (e.key === 'Enter') {
											e.preventDefault();
											const first = visibleResults[0];
											if (first) addHolder(first);
										}
									}}
									autocomplete="off"
									placeholder="Name oder E-Mail (ab 2 Zeichen)"
									aria-describedby="office-holder-search-hint"
									disabled={busy}
								/>
							</div>
							<p id="office-holder-search-hint" class="text-xs text-muted-foreground">
								Nur Personen mit Benutzerkonto. Die Reihenfolge der Liste ist die
								Anzeige-Reihenfolge.
							</p>
							{#if search.trim().length >= 2}
								<div class="rounded-md border" aria-live="polite">
									{#if searching}
										<p class="p-3 text-xs text-muted-foreground">Sucht …</p>
									{:else if searchError}
										<p class="p-3 text-xs text-destructive" role="alert">{searchError}</p>
									{:else if visibleResults.length === 0}
										<p class="p-3 text-xs text-muted-foreground">Keine passende Person gefunden.</p>
									{:else}
										<ul class="max-h-56 divide-y overflow-y-auto">
											{#each visibleResults as u (u.id)}
												<li>
													<button
														type="button"
														class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:-outline-offset-2"
														onclick={() => addHolder(u)}
													>
														<EntityAvatar name={u.name} size={28} />
														<span class="min-w-0 flex-1">
															<span class="block truncate font-medium">{u.name}</span>
															<span class="block truncate text-xs text-muted-foreground">
																{u.email}
															</span>
														</span>
														<UserPlus class="size-4 text-muted-foreground" aria-hidden="true" />
														<span class="sr-only">hinzufügen</span>
													</button>
												</li>
											{/each}
										</ul>
									{/if}
								</div>
							{/if}
						</div>

						<fieldset class="min-w-0 space-y-2">
							<legend class="mb-2 text-sm font-medium">
								Inhaber*innen <span class="font-normal text-muted-foreground tabular-nums"
									>({holders.length})</span
								>
							</legend>
							{#if holders.length === 0}
								<p
									class="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground"
								>
									Noch niemand hat dieses Amt.
								</p>
							{:else}
								<ul class="space-y-2">
									{#each holders as h, i (h.userId)}
										<li class="rounded-lg border p-3">
											<div class="flex flex-wrap items-center gap-3">
												<EntityAvatar name={h.name} src={h.image} size={32} />
												<span class="min-w-0 flex-1 truncate font-medium">{h.name}</span>
												<div class="flex items-center gap-1">
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														aria-label="{h.name} nach oben"
														disabled={i === 0 || busy}
														onclick={() => moveHolder(i, -1)}
													>
														<ArrowUp />
													</Button>
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														aria-label="{h.name} nach unten"
														disabled={i === holders.length - 1 || busy}
														onclick={() => moveHolder(i, 1)}
													>
														<ArrowDown />
													</Button>
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														aria-label="{h.name} entfernen"
														disabled={busy}
														onclick={() => removeHolder(i)}
													>
														<X />
													</Button>
												</div>
											</div>
											<div class="mt-2 grid gap-1.5 sm:max-w-56">
												<Label for="office-holder-since-{i}" class="text-xs">Seit (optional)</Label>
												<Input
													id="office-holder-since-{i}"
													type="date"
													bind:value={h.since}
													aria-invalid={!!holderError(i, 'since')}
													aria-describedby={holderError(i, 'since')
														? `office-holder-since-${i}-error`
														: undefined}
												/>
												{#if holderError(i, 'since')}
													<p
														id="office-holder-since-{i}-error"
														role="alert"
														class="text-xs text-destructive"
													>
														{holderError(i, 'since')}
													</p>
												{/if}
												{#if holderError(i, 'userId')}
													<p role="alert" class="text-xs text-destructive">
														{holderError(i, 'userId')}
													</p>
												{/if}
											</div>
										</li>
									{/each}
								</ul>
							{/if}
							{#if fieldErrors.holders}
								<p role="alert" class="text-xs text-destructive">{fieldErrors.holders}</p>
							{/if}
						</fieldset>
					</Tabs.Content>

					{#if error}
						<p role="alert" class="mt-4 text-sm text-destructive">{error}</p>
					{/if}
				</div>
			</Tabs.Root>

			<Dialog.Footer class="mx-0 mb-0">
				<Button type="button" variant="outline" onclick={() => (open = false)} disabled={busy}>
					Abbrechen
				</Button>
				<Button type="submit" disabled={busy}>
					{busy ? 'Speichert …' : isEdit ? 'Speichern' : 'Anlegen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
