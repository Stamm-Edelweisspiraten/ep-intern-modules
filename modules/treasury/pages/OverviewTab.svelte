<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Info from '@lucide/svelte/icons/info';
	import Landmark from '@lucide/svelte/icons/landmark';
	import Plus from '@lucide/svelte/icons/plus';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Upload from '@lucide/svelte/icons/upload';
	import Wallet from '@lucide/svelte/icons/wallet';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { EmptyState, FormField } from '$lib/components/layout';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		ACCOUNT_KIND_LABELS,
		type ActionReceivables,
		type Overview,
		type OverviewTask,
		type Transaction
	} from '../schemas';
	import {
		BASE,
		errorMessage,
		fmtDate,
		fmtDateTime,
		signedEuro,
		transactionTitle,
		type SharedData
	} from './helpers';

	let {
		perm,
		version,
		onopen,
		onallocate,
		onsuggestions,
		oncreate,
		onimport,
		onchanged
	}: SharedData & {
		onopen: (tab: string) => void;
		onallocate: (t: Transaction) => void;
		onsuggestions: () => void;
		/** Neue Buchung erfassen */
		oncreate: () => void;
		/** CSV-Import öffnen */
		onimport: () => void;
		onchanged: () => void | Promise<void>;
	} = $props();

	let data = $state<Overview | null>(null);
	let receivables = $state<ActionReceivables[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = !data;
		error = '';
		try {
			[data, receivables] = await Promise.all([
				apiFetch<Overview>(`${BASE}/overview`),
				apiFetch<ActionReceivables[]>(`${BASE}/actions`)
			]);
		} catch (e) {
			error = errorMessage(e, 'Übersicht konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	// Nur `version` ist Abhängigkeit; `load` liest Zustand, der sonst eine Schleife auslösen würde
	$effect(() => {
		void version;
		untrack(() => void load());
	});

	let settingsFor = $state<ActionReceivables | null>(null);
	let settingsOpen = $state(false);
	let dueOn = $state('');
	let busy = $state(false);

	function openSettings(a: ActionReceivables) {
		settingsFor = a;
		dueOn = a.dueOn ?? '';
		settingsOpen = true;
	}

	async function saveSettings(excluded: boolean, due: string | null) {
		if (!settingsFor) return;
		busy = true;
		try {
			await apiFetch(`${BASE}/actions/${settingsFor.actionId}/settings`, {
				method: 'PUT',
				body: JSON.stringify({ excluded, dueOn: due || null })
			});
			toast.success(excluded ? 'Aktion aus der Kasse ausgeschlossen' : 'Gespeichert');
			settingsOpen = false;
			await onchanged();
		} catch (e) {
			toast.error(errorMessage(e, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

	/** Titel, Erklärung und Knopf einer Aufgabe */
	function taskView(t: OverviewTask): { title: string; hint: string; action: string } {
		const money = t.cents != null ? ` (${formatEuro(t.cents)})` : '';
		switch (t.kind) {
			case 'bank-missing':
				return {
					title: 'Kontodaten fehlen',
					hint: 'Ohne Kontoinhaber und IBAN enthalten Rechnungen, Mails und Bestätigungen keine Zahlungsdaten.',
					action: 'Einstellungen öffnen'
				};
			case 'unallocated':
				return {
					title: `${plural(t.count, 'Einnahme wartet', 'Einnahmen warten')} auf Zuordnung${money}`,
					hint: 'Ordne die Zahlung einer Rechnung zu, damit sie als bezahlt gilt.',
					action: perm.editTx ? 'Vorschläge prüfen' : 'Buchungen ansehen'
				};
			case 'overdue':
				return {
					title: `${plural(t.count, 'Rechnung ist', 'Rechnungen sind')} überfällig${money}`,
					hint: 'Erinnerungen laufen automatisch; du kannst auch selbst erinnern.',
					action: 'Offene Posten'
				};
			case 'payables-overdue':
				return {
					title: `${plural(t.count, 'Überweisung ist', 'Überweisungen sind')} überfällig${money}`,
					hint: 'Diese Auszahlungen sollten schnell raus.',
					action: 'Auszahlungen'
				};
			case 'payables-no-iban':
				return {
					title: `${plural(t.count, 'Überweisung hat', 'Überweisungen haben')} keine IBAN${money}`,
					hint: 'Ohne IBAN lässt sich nicht überweisen.',
					action: 'Auszahlungen'
				};
			case 'annual-draft':
				return {
					title: `Beitragslauf ${t.year} ist noch nicht versendet`,
					hint: t.date
						? `Zahlungsfrist ${fmtDate(t.date)}.`
						: 'Sätze prüfen und Rechnungen senden.',
					action: 'Beitragslauf öffnen'
				};
			case 'annual-scheduled':
				return {
					title: `Beitragslauf ${t.year} ist geplant`,
					hint: t.date ? `Versand am ${fmtDate(t.date)}.` : 'Der Versand ist geplant.',
					action: 'Ansehen'
				};
			case 'annual-missing':
				return {
					title: `Für ${t.year} gibt es noch keinen Beitragslauf`,
					hint: 'Lege den Lauf an, wenn die Jahresbeiträge berechnet werden sollen.',
					action: 'Beitragslauf anlegen'
				};
		}
	}

	function runTask(t: OverviewTask) {
		if (t.kind === 'unallocated' && perm.editTx) onsuggestions();
		else if (t.tab) onopen(t.tab);
	}

	const pct = (a: ActionReceivables) =>
		a.totalCents > 0 ? Math.min(100, Math.round((a.paidCents / a.totalCents) * 100)) : 0;
</script>

{#if loading}
	<div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
		{#each [1, 2, 3, 4] as i (i)}<Skeleton class="h-24" />{/each}
	</div>
{:else if error}
	<Card.Root>
		<Card.Content class="space-y-3">
			<p class="text-sm text-destructive" role="alert">{error}</p>
			<Button variant="outline" onclick={load}>Erneut versuchen</Button>
		</Card.Content>
	</Card.Root>
{:else if data}
	<div class="space-y-6">
		<Card.Root
			class={data.tasks.some((t) => t.severity === 'critical') ? 'border-destructive/40' : ''}
		>
			<Card.Header class="flex flex-row flex-wrap items-center justify-between gap-2">
				<div class="space-y-1">
					<Card.Title>Das ist zu tun</Card.Title>
					<Card.Description
						>Offene Aufgaben der Kasse – ein Klick führt direkt hin.</Card.Description
					>
				</div>
				{#if perm.editTx}
					<div class="flex flex-wrap gap-2">
						<Button onclick={oncreate}><Plus /> Zahlung erfassen</Button>
						<Button variant="outline" onclick={onimport}><Upload /> CSV importieren</Button>
					</div>
				{/if}
			</Card.Header>
			<Card.Content>
				{#if !data.tasks.length}
					<div class="flex items-center gap-3 text-sm" role="status">
						<CircleCheck class="size-5 shrink-0 text-emerald-600" aria-hidden="true" />
						<span><strong>Alles erledigt.</strong> Im Moment ist nichts offen.</span>
					</div>
				{:else}
					<ul class="divide-y">
						{#each data.tasks as t (t.kind)}
							{@const v = taskView(t)}
							<li class="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
								{#if t.severity === 'critical'}
									<CircleAlert class="size-5 shrink-0 text-destructive" aria-label="Dringend" />
								{:else if t.severity === 'warning'}
									<TriangleAlert class="size-5 shrink-0 text-amber-600" aria-label="Wichtig" />
								{:else}
									<Info class="size-5 shrink-0 text-muted-foreground" aria-label="Hinweis" />
								{/if}
								<div class="min-w-48 flex-1">
									<div class="font-medium">{v.title}</div>
									<div class="text-xs text-muted-foreground">{v.hint}</div>
								</div>
								{#if t.kind === 'bank-missing'}
									<Button size="sm" variant="outline" href="/modules/treasury/settings">
										{v.action}
										<ArrowRight />
									</Button>
								{:else}
									<Button size="sm" variant="outline" onclick={() => runTask(t)}>
										{v.action}
										<ArrowRight />
									</Button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Content>
		</Card.Root>
		<div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
			<Card.Root>
				<Card.Content>
					<div class="text-xs text-muted-foreground">Kontostand gesamt</div>
					<div class="text-xl font-semibold tabular-nums sm:text-2xl">
						{formatEuro(data.balanceCents)}
					</div>
					<div class="text-xs text-muted-foreground">{data.accounts.length} Konten</div>
				</Card.Content>
			</Card.Root>
			<button type="button" class="text-left" onclick={() => onopen('open')}>
				<Card.Root class="h-full transition-colors hover:bg-muted/40">
					<Card.Content>
						<div class="text-xs text-muted-foreground">Noch offen</div>
						<div class="text-xl font-semibold tabular-nums sm:text-2xl">
							{formatEuro(data.openCents)}
						</div>
						{#if data.creditCents > 0}
							<div class="text-xs text-muted-foreground">
								Guthaben/Überzahlungen {formatEuro(data.creditCents)}
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
			</button>
			<button type="button" class="text-left" onclick={() => onopen('open')}>
				<Card.Root
					class="h-full transition-colors hover:bg-muted/40 {data.overdueCount
						? 'border-destructive/40'
						: ''}"
				>
					<Card.Content>
						<div class="text-xs text-muted-foreground">Überfällig</div>
						<div
							class="text-xl font-semibold tabular-nums sm:text-2xl {data.overdueCount
								? 'text-destructive'
								: ''}"
						>
							{formatEuro(data.overdueCents)}
						</div>
						<div class="text-xs text-muted-foreground">{data.overdueCount} Rechnungen</div>
					</Card.Content>
				</Card.Root>
			</button>
			<button type="button" class="text-left" onclick={() => onopen('payables')}>
				<Card.Root class="h-full transition-colors hover:bg-muted/40">
					<Card.Content>
						<div class="text-xs text-muted-foreground">Auszuzahlen</div>
						<div class="text-xl font-semibold tabular-nums sm:text-2xl">
							{formatEuro(data.payableCents)}
						</div>
						<div class="text-xs text-muted-foreground">
							{data.payableCount} Überweisungen · nach Abzug {formatEuro(
								data.balanceCents - data.payableCents
							)}
						</div>
					</Card.Content>
				</Card.Root>
			</button>
			<Card.Root class={data.unallocatedCount ? 'border-amber-500/40' : ''}>
				<Card.Content class="space-y-2">
					<div class="text-xs text-muted-foreground">Einnahmen ohne Zuordnung</div>
					<div class="text-xl font-semibold tabular-nums sm:text-2xl">
						{formatEuro(data.unallocatedCents)}
					</div>
					<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						{data.unallocatedCount} Buchungen
						{#if data.unallocatedCount && perm.editTx}
							<Button size="sm" variant="outline" class="h-7" onclick={onsuggestions}>
								Vorschläge prüfen
							</Button>
						{/if}
					</div>
				</Card.Content>
			</Card.Root>
		</div>

		<div class="grid gap-6 lg:grid-cols-2">
			<Card.Root>
				<Card.Header>
					<Card.Title>Konten</Card.Title>
				</Card.Header>
				<Card.Content>
					{#if !data.accounts.length}
						<EmptyState
							title="Noch kein Konto"
							description="Lege unter „Einstellungen“ das Girokonto und die Barkasse an."
						>
							{#if perm.accounts}
								<Button variant="outline" href="/modules/treasury/settings">Konto anlegen</Button>
							{/if}
						</EmptyState>
					{:else}
						<ul class="divide-y">
							{#each data.accounts as a (a.id)}
								<li class="flex items-center gap-3 py-2">
									{#if a.kind === 'cash'}
										<Wallet class="size-4 text-muted-foreground" aria-hidden="true" />
									{:else}
										<Landmark class="size-4 text-muted-foreground" aria-hidden="true" />
									{/if}
									<div class="min-w-0 flex-1">
										<div class="truncate font-medium">{a.name}</div>
										<div class="text-xs text-muted-foreground">
											{ACCOUNT_KIND_LABELS[a.kind]} · letzte Buchung {fmtDate(a.lastBookedOn)}
										</div>
									</div>
									<span class="font-semibold tabular-nums">{formatEuro(a.balanceCents)}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Beiträge aus Aktionen</Card.Title>
					<Card.Description>
						Sobald in einer Aktion ein Beitrag übernommen ist, entsteht je Teilnehmende*r eine
						Rechnung.
						{#if data.lastSyncAt}Zuletzt abgeglichen: {fmtDateTime(data.lastSyncAt)}.{/if}
					</Card.Description>
				</Card.Header>
				<Card.Content>
					{#if !receivables.length}
						<p class="text-sm text-muted-foreground">Noch keine Aktion mit übernommenem Beitrag.</p>
					{:else}
						<ul class="space-y-4">
							{#each receivables as a (a.actionId)}
								<li class="space-y-1.5">
									<div class="flex items-center gap-2">
										<div class="min-w-0 flex-1">
											<div class="truncate font-medium">{a.name}</div>
											<div class="text-xs text-muted-foreground">
												ab {fmtDate(a.startsOn)} · {formatEuro(a.feeCents)} je Person
												{#if a.dueOn}· fällig {fmtDate(a.dueOn)}{/if}
											</div>
										</div>
										{#if a.excluded}<Badge variant="outline">ausgeschlossen</Badge>{/if}
										{#if a.isPast}<Badge variant="outline">vergangen</Badge>{/if}
										{#if a.overdueCents > 0}
											<Badge variant="destructive">{formatEuro(a.overdueCents)} überfällig</Badge>
										{/if}
										{#if perm.editInvoice}
											<DropdownMenu.Root>
												<DropdownMenu.Trigger>
													{#snippet child({ props })}
														<Button
															{...props}
															variant="ghost"
															size="icon"
															aria-label={`Einstellungen für ${a.name}`}
														>
															<Ellipsis />
														</Button>
													{/snippet}
												</DropdownMenu.Trigger>
												<DropdownMenu.Content align="end">
													<DropdownMenu.Item onclick={() => openSettings(a)}>
														Fälligkeit festlegen
													</DropdownMenu.Item>
													<DropdownMenu.Item
														onclick={() => {
															settingsFor = a;
															void saveSettings(!a.excluded, a.dueOn);
														}}
													>
														{a.excluded
															? 'Wieder in die Kasse aufnehmen'
															: 'Aus der Kasse ausschließen'}
													</DropdownMenu.Item>
												</DropdownMenu.Content>
											</DropdownMenu.Root>
										{/if}
									</div>
									{#if !a.excluded}
										<div
											class="h-2 overflow-hidden rounded-full bg-muted"
											role="progressbar"
											aria-valuemin={0}
											aria-valuemax={100}
											aria-valuenow={pct(a)}
											aria-label={`${a.name}: ${pct(a)} % bezahlt`}
										>
											<div class="h-full bg-primary" style="width: {pct(a)}%"></div>
										</div>
										<div class="flex justify-between text-xs text-muted-foreground tabular-nums">
											<span>{formatEuro(a.paidCents)} von {formatEuro(a.totalCents)} bezahlt</span>
											<span>offen {formatEuro(a.openCents)}</span>
										</div>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>

		<Card.Root>
			<Card.Header class="flex flex-row items-center justify-between gap-2">
				<Card.Title>Letzte Buchungen</Card.Title>
				<Button variant="ghost" size="sm" onclick={() => onopen('transactions')}
					>Alle Buchungen</Button
				>
			</Card.Header>
			<Card.Content>
				{#if !data.recent.length}
					<p class="text-sm text-muted-foreground">Noch keine Buchungen.</p>
				{:else}
					<ul class="divide-y">
						{#each data.recent as t (t.id)}
							<li class="flex flex-wrap items-center gap-3 py-2 text-sm">
								<span class="w-20 text-muted-foreground tabular-nums">{fmtDate(t.bookedOn)}</span>
								<div class="min-w-0 flex-1">
									<div class="truncate font-medium">
										{transactionTitle(t)}
									</div>
									<div class="truncate text-xs text-muted-foreground">
										{t.accountName}{t.purpose && (t.counterparty || t.transferId)
											? ` · ${t.purpose}`
											: ''}
									</div>
								</div>
								{#if t.needsAllocation && perm.editTx}
									<Button size="sm" variant="outline" class="h-7" onclick={() => onallocate(t)}>
										Zuordnen
									</Button>
								{/if}
								<span
									class="font-medium tabular-nums {t.amountCents < 0 ? 'text-destructive' : ''}"
								>
									{signedEuro(t.amountCents)}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
{/if}

<Dialog.Root bind:open={settingsOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Fälligkeit festlegen</Dialog.Title>
			<Dialog.Description>
				{settingsFor?.name}: gilt für alle offenen Rechnungen der Aktion. Leer = automatisch (Tage
				vor Beginn laut Einstellungen).
			</Dialog.Description>
		</Dialog.Header>
		<FormField label="Fällig am" id="ov-due">
			<Input id="ov-due" type="date" bind:value={dueOn} />
		</FormField>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (settingsOpen = false)}>Abbrechen</Button>
			<Button
				disabled={busy}
				onclick={() => saveSettings(settingsFor?.excluded ?? false, dueOn || null)}
			>
				{busy ? 'Speichert …' : 'Speichern'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
