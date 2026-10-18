<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import CheckCheck from '@lucide/svelte/icons/check-check';
	import Copy from '@lucide/svelte/icons/copy';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Switch } from '$lib/components/ui/switch';
	import * as Table from '$lib/components/ui/table';
	import { ConfirmDialog, DataTable, formatEuro } from '$lib/components/layout';
	import {
		CALC_CATEGORY_LABELS,
		EXPENSE_SUBMISSION_STATUS_LABELS,
		type ExpenseLinkConfig,
		type ExpenseSubmission
	} from '../schemas';
	import ExpenseSubmissionDialog from './ExpenseSubmissionDialog.svelte';
	import { fmtDate } from './format';

	let {
		actionId,
		editable,
		closed,
		onchanged
	}: { actionId: string; editable: boolean; closed: boolean; onchanged: () => void } = $props();

	const base = $derived(`/modules/actions/actions/${actionId}`);

	let config = $state<ExpenseLinkConfig | null>(null);
	let submissions = $state<ExpenseSubmission[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let toggling = $state(false);
	let rotating = $state(false);
	let rotateOpen = $state(false);

	let selected = $state<ExpenseSubmission | null>(null);
	let dialogOpen = $state(false);
	/** Gruppe, deren Auslagen gerade nacheinander angenommen werden */
	let acceptingBatch = $state<string | null>(null);

	type Row =
		| { kind: 'single'; s: ExpenseSubmission }
		| { kind: 'group'; batchId: string; items: ExpenseSubmission[] };

	/** Einreichungen derselben `batchId` (ab 2 Auslagen) als Gruppe, an der Stelle der ersten */
	const rows = $derived.by<Row[]>(() => {
		const byBatch = new Map<string, ExpenseSubmission[]>();
		for (const s of submissions) {
			if (!s.batchId) continue;
			const list = byBatch.get(s.batchId);
			if (list) list.push(s);
			else byBatch.set(s.batchId, [s]);
		}
		const out: Row[] = [];
		const seen = new Set<string>();
		for (const s of submissions) {
			const group = s.batchId ? byBatch.get(s.batchId) : undefined;
			if (!group || group.length < 2) {
				out.push({ kind: 'single', s });
				continue;
			}
			if (seen.has(s.batchId!)) continue;
			seen.add(s.batchId!);
			out.push({ kind: 'group', batchId: s.batchId!, items: group });
		}
		return out;
	});

	/** Position der ausgewählten Auslage in ihrer Einreichung (für den Prüfdialog) */
	const selectedBatch = $derived.by(() => {
		if (!selected?.batchId) return null;
		const group = submissions.filter((s) => s.batchId === selected!.batchId);
		if (group.length < 2) return null;
		return { index: group.findIndex((s) => s.id === selected!.id) + 1, count: group.length };
	});

	const fullUrl = $derived(
		config?.publicPath && typeof window !== 'undefined'
			? `${window.location.origin}${config.publicPath}`
			: (config?.publicPath ?? '')
	);
	const pending = $derived(submissions.filter((s) => s.status === 'pending').length);
	const linkClosed = $derived(closed || !!config?.accountingClosed);

	async function load() {
		loadError = '';
		try {
			const [cfg, list] = await Promise.all([
				apiFetch<ExpenseLinkConfig>(`${base}/expense-link`),
				apiFetch<ExpenseSubmission[]>(`${base}/expense-submissions`)
			]);
			config = cfg;
			submissions = list;
			if (selected) selected = list.find((s) => s.id === selected!.id) ?? null;
		} catch (e) {
			loadError =
				e instanceof ApiClientError ? e.message : 'Kosten-Link konnte nicht geladen werden.';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void actionId;
		void closed;
		untrack(() => void load());
	});

	async function setEnabled(enabled: boolean) {
		if (toggling) return;
		toggling = true;
		try {
			config = await apiFetch<ExpenseLinkConfig>(`${base}/expense-link`, {
				method: 'PUT',
				body: JSON.stringify({ enabled })
			});
			toast.success(enabled ? 'Kosten-Link aktiviert' : 'Kosten-Link deaktiviert');
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Speichern fehlgeschlagen.');
		} finally {
			toggling = false;
		}
	}

	async function copyLink() {
		try {
			await navigator.clipboard.writeText(fullUrl);
			toast.success('Link kopiert');
		} catch {
			toast.error('Link konnte nicht kopiert werden.');
		}
	}

	async function rotate() {
		if (rotating) return;
		rotating = true;
		try {
			config = await apiFetch<ExpenseLinkConfig>(`${base}/expense-link/rotate`, {
				method: 'POST'
			});
			toast.success('Neuer Link erzeugt');
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Link konnte nicht erneuert werden.');
		} finally {
			rotating = false;
		}
	}

	function openSubmission(s: ExpenseSubmission) {
		selected = s;
		dialogOpen = true;
	}

	/** Alle offenen Auslagen einer Einreichung ohne Korrekturen nacheinander annehmen */
	async function acceptAll(batchId: string, items: ExpenseSubmission[]) {
		if (acceptingBatch) return;
		const open = items.filter((s) => s.status === 'pending');
		if (open.length === 0) return;
		acceptingBatch = batchId;
		let ok = 0;
		try {
			for (const s of open) {
				await apiFetch(`${base}/expense-submissions/${s.id}/accept`, {
					method: 'POST',
					body: JSON.stringify({})
				});
				ok++;
			}
			toast.success(
				ok === 1
					? 'Auslage in die Abrechnung übernommen'
					: `${ok} Auslagen in die Abrechnung übernommen`
			);
		} catch (e) {
			const msg = e instanceof ApiClientError ? e.message : 'Übernehmen fehlgeschlagen.';
			toast.error(ok > 0 ? `${ok} von ${open.length} übernommen – danach: ${msg}` : msg);
		} finally {
			acceptingBatch = null;
			await decided();
		}
	}

	const sumCents = (list: ExpenseSubmission[]) => list.reduce((t, s) => t + s.amountCents, 0);
	const pendingIn = (list: ExpenseSubmission[]) =>
		list.filter((s) => s.status === 'pending').length;

	async function decided() {
		await load();
		onchanged();
	}

	const statusVariant = (s: ExpenseSubmission['status']) =>
		s === 'pending' ? 'secondary' : s === 'accepted' ? 'default' : 'destructive';
</script>

<div class="space-y-4">
	<Card.Root>
		<Card.Header>
			<Card.Title class="flex items-center gap-2">
				Kosten-Link
				{#if pending > 0}
					<Badge variant="secondary">{pending} zu prüfen</Badge>
				{/if}
			</Card.Title>
			<Card.Description>
				Über diesen Link reichen Personen ohne Anmeldung Auslagen mit Beleg und Kontodaten ein. Du
				prüfst jede Einreichung, bevor sie in die Abrechnung übernommen wird.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if loading}
				<Skeleton class="h-9 w-full" />
			{:else if loadError}
				<div class="flex flex-wrap items-center gap-3 text-sm">
					<span class="text-destructive">{loadError}</span>
					<Button size="sm" variant="outline" onclick={load}>Erneut versuchen</Button>
				</div>
			{:else if config}
				{#if editable}
					<div class="flex items-center justify-between gap-4">
						<div class="grid gap-0.5">
							<Label for="expense-link-enabled">Link aktiv</Label>
							<p class="text-muted-foreground text-xs">
								Deaktiviert nimmt der Link keine Einreichungen an.
							</p>
						</div>
						<Switch
							id="expense-link-enabled"
							checked={config.enabled}
							onCheckedChange={setEnabled}
							disabled={toggling}
						/>
					</div>
					{#if config.publicPath}
						<div class="grid gap-2">
							<Label for="expense-link-url">Link zum Weitergeben</Label>
							<Input
								id="expense-link-url"
								value={fullUrl}
								readonly
								onfocus={(e) => e.currentTarget.select()}
							/>
							<div class="flex flex-wrap gap-2">
								<Button size="sm" variant="outline" onclick={copyLink}>
									<Copy /> Link kopieren
								</Button>
								<Button
									size="sm"
									variant="outline"
									href={config.publicPath}
									target="_blank"
									rel="noopener noreferrer"
								>
									<ExternalLink /> Öffnen
								</Button>
								<Button
									size="sm"
									variant="outline"
									disabled={rotating}
									onclick={() => (rotateOpen = true)}
								>
									<RefreshCw /> Link erneuern
								</Button>
							</div>
						</div>
					{:else}
						<p class="text-muted-foreground text-sm">Der Link entsteht beim ersten Aktivieren.</p>
					{/if}
				{:else}
					<p class="text-muted-foreground text-sm">
						Nur Ansicht – {config.exists && config.enabled
							? 'der Kosten-Link ist aktiv.'
							: 'der Kosten-Link ist nicht aktiv.'}
					</p>
				{/if}
				{#if linkClosed}
					<p
						class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
						role="note"
					>
						Die Abrechnung ist abgeschlossen – der Link nimmt derzeit keine Auslagen an.
					</p>
				{/if}
			{/if}
		</Card.Content>
	</Card.Root>

	{#if !loading && !loadError && (submissions.length > 0 || config?.exists)}
		<DataTable
			caption="Eingereichte Auslagen"
			title="Eingereichte Auslagen"
			description="Zeile anklicken, um Angaben und Beleg zu prüfen."
			empty={submissions.length === 0}
			emptyTitle="Noch keine Einreichungen"
			emptyDescription="Sobald jemand über den Kosten-Link eine Auslage einreicht, erscheint sie hier."
			mobile="cards"
		>
			{#snippet head()}
				<Table.Row>
					<Table.Head>Name</Table.Head>
					<Table.Head>Datum</Table.Head>
					<Table.Head>Kategorie</Table.Head>
					<Table.Head>Wofür</Table.Head>
					<Table.Head class="text-right">Betrag</Table.Head>
					<Table.Head>Status</Table.Head>
				</Table.Row>
			{/snippet}
			{#each rows as row (row.kind === 'group' ? `batch:${row.batchId}` : row.s.id)}
				{#if row.kind === 'group'}
					{@const first = row.items[0]!}
					{@const openCount = pendingIn(row.items)}
					<Table.Row class="bg-muted/40 hover:bg-muted/40">
						<Table.Cell colspan={6} data-label-manual="" class="py-2">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<p class="text-sm">
									<span class="font-medium">{first.submitterName}</span>
									<span class="text-muted-foreground">
										· {row.items.length} Auslagen ·
										<span class="tabular-nums">{formatEuro(sumCents(row.items))}</span>
										· <span class="tabular-nums">{fmtDate(first.createdAt)}</span>
										{#if openCount > 0 && openCount < row.items.length}
											· {openCount} zu prüfen
										{/if}
									</span>
								</p>
								{#if editable && !linkClosed && openCount > 0}
									<Button
										size="sm"
										variant="outline"
										disabled={acceptingBatch !== null}
										onclick={() => acceptAll(row.batchId, row.items)}
									>
										<CheckCheck />
										{acceptingBatch === row.batchId
											? 'Übernimmt …'
											: openCount === 1
												? 'Offene annehmen'
												: `Alle ${openCount} annehmen`}
									</Button>
								{/if}
							</div>
						</Table.Cell>
					</Table.Row>
					{#each row.items as s (s.id)}
						{@render submissionRow(s, true)}
					{/each}
				{:else}
					{@render submissionRow(row.s, false)}
				{/if}
			{/each}
		</DataTable>
	{/if}
</div>

{#snippet submissionRow(s: ExpenseSubmission, grouped: boolean)}
	<Table.Row
		class="cursor-pointer"
		tabindex={0}
		onclick={() => openSubmission(s)}
		onkeydown={(e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				openSubmission(s);
			}
		}}
	>
		<Table.Cell class={grouped ? 'border-primary/30 border-l-2 pl-4 font-medium' : 'font-medium'}>
			{s.submitterName}
		</Table.Cell>
		<Table.Cell class="tabular-nums">{fmtDate(s.expenseDate)}</Table.Cell>
		<Table.Cell>{CALC_CATEGORY_LABELS[s.category]}</Table.Cell>
		<Table.Cell class="max-w-56 truncate" title={s.description}>{s.description}</Table.Cell>
		<Table.Cell class="text-right tabular-nums">{formatEuro(s.amountCents)}</Table.Cell>
		<Table.Cell>
			<Badge variant={statusVariant(s.status)}>
				{EXPENSE_SUBMISSION_STATUS_LABELS[s.status]}
			</Badge>
		</Table.Cell>
	</Table.Row>
{/snippet}

<ExpenseSubmissionDialog
	bind:open={dialogOpen}
	{actionId}
	submission={selected}
	batch={selectedBatch}
	{editable}
	closed={linkClosed}
	ondone={decided}
/>

<ConfirmDialog
	bind:open={rotateOpen}
	title="Link erneuern?"
	description="Der alte Link funktioniert danach nicht mehr. Bereits verschickte Links müssen ersetzt werden."
	confirmLabel="Link erneuern"
	destructive
	onconfirm={rotate}
/>
