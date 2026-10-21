<script lang="ts">
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import Mail from '@lucide/svelte/icons/mail';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { ConfirmDialog, EmptyState, EntityAvatar, PageHeader } from '$lib/components/layout';
	import type { MyOffices, Office } from '../schemas';
	import ExpandableText from './ExpandableText.svelte';
	import MyBioCard from './MyBioCard.svelte';
	import OfficeDialog from './OfficeDialog.svelte';
	import { BASE, errorText, formatDate, moveItem } from './helpers';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canManage = $derived(can(permissions, 'offices.office.manage'));

	// --- Laden -----------------------------------------------------------------------------
	let offices = $state<Office[]>([]);
	let my = $state<MyOffices | null>(null);
	let loading = $state(true);
	let loadError = $state('');

	async function load() {
		loading = offices.length === 0;
		loadError = '';
		try {
			const [list, me] = await Promise.all([
				apiFetch<Office[]>(`${BASE}/offices`),
				apiFetch<MyOffices>(`${BASE}/me`).catch(() => null)
			]);
			offices = list;
			my = me;
		} catch (e) {
			loadError = errorText(e, 'Die Ämter konnten nicht geladen werden.');
		} finally {
			loading = false;
		}
	}
	void load();

	// --- Anlegen / Bearbeiten / Löschen ----------------------------------------------------
	let dialogOpen = $state(false);
	let editing = $state<Office | null>(null);

	function openCreate() {
		editing = null;
		dialogOpen = true;
	}

	function openEdit(o: Office) {
		editing = o;
		dialogOpen = true;
	}

	let deleteOpen = $state(false);
	let deleting = $state<Office | null>(null);

	function askDelete(o: Office) {
		deleting = o;
		deleteOpen = true;
	}

	const deleteDescription = $derived.by(() => {
		const o = deleting;
		if (!o) return '';
		const n = o.holders.length;
		const who =
			n === 0
				? 'Das Amt hat derzeit keine Inhaber*innen.'
				: n === 1
					? `${o.holders[0]!.name} verliert die Rechte, die über dieses Amt vergeben wurden.`
					: `${n} Personen verlieren die Rechte, die über dieses Amt vergeben wurden.`;
		const source = o.source
			? ` Benachrichtigungen von ${o.source.moduleName} erreichen danach niemanden; das Amt wird nicht neu angelegt.`
			: '';
		return `„${o.name}“ wird endgültig gelöscht. ${who}${source}`;
	});

	async function confirmDelete() {
		const o = deleting;
		if (!o) return;
		try {
			await apiFetch(`${BASE}/offices/${encodeURIComponent(o.id)}`, { method: 'DELETE' });
			toast.success(`„${o.name}“ gelöscht`);
			offices = offices.filter((x) => x.id !== o.id);
			void load();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen'));
		}
	}

	// --- Reihenfolge -----------------------------------------------------------------------
	let sorting = $state(false);
	let draft = $state<Office[]>([]);
	let savingOrder = $state(false);
	let dragIndex = $state<number | null>(null);
	let liveMessage = $state('');

	function startSorting() {
		draft = [...offices];
		sorting = true;
	}

	function cancelSorting() {
		sorting = false;
		draft = [];
		dragIndex = null;
	}

	function move(from: number, to: number, focus = false) {
		if (to < 0 || to >= draft.length) return;
		draft = moveItem(draft, from, to);
		const item = draft[to];
		if (item) liveMessage = `${item.name}: Position ${to + 1} von ${draft.length}`;
		if (focus) {
			// Fokus bleibt auf dem Knopf des verschobenen Eintrags
			void tick().then(() => {
				const dir = to < from ? 'up' : 'down';
				const btn =
					document.querySelector<HTMLButtonElement>(
						`[data-sort-id="${item?.id}"] [data-move="${dir}"]:not(:disabled)`
					) ??
					document.querySelector<HTMLButtonElement>(
						`[data-sort-id="${item?.id}"] [data-move]:not(:disabled)`
					);
				btn?.focus();
			});
		}
	}

	const orderChanged = $derived(
		sorting && draft.map((o) => o.id).join() !== offices.map((o) => o.id).join()
	);

	async function saveOrder() {
		if (!orderChanged) {
			cancelSorting();
			return;
		}
		const previous = offices;
		const next = draft;
		// Optimistisch übernehmen, bei Fehler zurücksetzen
		offices = next;
		sorting = false;
		savingOrder = true;
		try {
			offices = await apiFetch<Office[]>(`${BASE}/offices/order`, {
				method: 'PUT',
				body: JSON.stringify({ ids: next.map((o) => o.id) })
			});
			toast.success('Reihenfolge gespeichert');
		} catch (e) {
			offices = previous;
			toast.error(errorText(e, 'Reihenfolge konnte nicht gespeichert werden'));
		} finally {
			savingOrder = false;
			draft = [];
		}
	}

	function onDragStart(e: DragEvent, i: number) {
		dragIndex = i;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', String(i));
		}
	}

	function onDragOver(e: DragEvent, i: number) {
		if (dragIndex === null) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		if (i !== dragIndex) {
			draft = moveItem(draft, dragIndex, i);
			dragIndex = i;
		}
	}

	function onDragEnd() {
		dragIndex = null;
	}

	function mailHref(email: string) {
		return `mailto:${email}`;
	}
</script>

<div class="space-y-6">
	<PageHeader
		title="Ämter"
		description="Wer im Stamm wofür zuständig ist und wie man das Amt erreicht."
	>
		{#snippet actions()}
			{#if canManage && !sorting}
				<Button onclick={openCreate}><Plus /> Amt anlegen</Button>
				{#if offices.length > 1}
					<Button variant="outline" onclick={startSorting} disabled={savingOrder}>
						<ArrowUpDown /> Reihenfolge ändern
					</Button>
				{/if}
			{/if}
		{/snippet}
	</PageHeader>

	{#if my?.canEditBio && !sorting}
		<MyBioCard {my} onsaved={(next) => ((my = next), void load())} />
	{/if}

	{#if loading}
		<div class="grid gap-4 lg:grid-cols-2">
			<Skeleton class="h-48 w-full" />
			<Skeleton class="h-48 w-full" />
		</div>
	{:else if loadError}
		<div class="space-y-3 rounded-lg border p-4" role="alert">
			<p class="text-sm text-destructive">{loadError}</p>
			<Button variant="outline" size="sm" onclick={load}>Erneut versuchen</Button>
		</div>
	{:else if offices.length === 0}
		<EmptyState
			title="Noch keine Ämter"
			description={canManage
				? 'Lege Ämter wie Stammesführung oder Kasse an, ordne Personen zu und verknüpfe Rollen.'
				: 'Hier erscheinen die Ämter des Stamms, sobald sie angelegt wurden.'}
		>
			{#if canManage}
				<Button onclick={openCreate}><Plus /> Amt anlegen</Button>
			{/if}
		</EmptyState>
	{:else if sorting}
		<Card.Root>
			<Card.Header>
				<Card.Title>Reihenfolge ändern</Card.Title>
				<Card.Description>
					Ziehe die Einträge an die gewünschte Stelle oder nutze die Pfeile. Die Reihenfolge gilt
					auch für die Website.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<ol class="space-y-2">
					{#each draft as o, i (o.id)}
						<li
							data-sort-id={o.id}
							draggable="true"
							ondragstart={(e) => onDragStart(e, i)}
							ondragover={(e) => onDragOver(e, i)}
							ondrop={(e) => e.preventDefault()}
							ondragend={onDragEnd}
							class={[
								'flex items-center gap-2 rounded-lg border bg-background p-2 transition-shadow',
								dragIndex === i && 'opacity-60 shadow-md ring-2 ring-ring'
							]}
						>
							<GripVertical
								class="size-4 shrink-0 cursor-grab text-muted-foreground"
								aria-hidden="true"
							/>
							<span class="w-6 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
								{i + 1}.
							</span>
							<span class="min-w-0 flex-1 truncate font-medium">{o.name}</span>
							<Button
								variant="ghost"
								size="icon-sm"
								data-move="up"
								aria-label="{o.name} nach oben"
								disabled={i === 0}
								onclick={() => move(i, i - 1, true)}
							>
								<ArrowUp />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								data-move="down"
								aria-label="{o.name} nach unten"
								disabled={i === draft.length - 1}
								onclick={() => move(i, i + 1, true)}
							>
								<ArrowDown />
							</Button>
						</li>
					{/each}
				</ol>
				<p class="sr-only" aria-live="polite">{liveMessage}</p>
				<div class="flex flex-wrap justify-end gap-2">
					<Button variant="outline" onclick={cancelSorting}>Abbrechen</Button>
					<Button onclick={saveOrder} disabled={!orderChanged}>Reihenfolge speichern</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{:else}
		<div class="grid items-start gap-4 lg:grid-cols-2">
			{#each offices as o (o.id)}
				<Card.Root>
					<Card.Header>
						<Card.Title>{o.name}</Card.Title>
						{#if o.source}
							<Card.Description>
								<Badge
									variant="secondary"
									class="font-normal"
									title="Dieses Amt wurde als Vorlage aus dem Modul {o.source.moduleName} angelegt."
								>
									Vorlage: {o.source.moduleName}
								</Badge>
							</Card.Description>
						{/if}
						{#if canManage}
							<Card.Action>
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button
												{...props}
												variant="ghost"
												size="icon-sm"
												aria-label="Aktionen für {o.name}"
											>
												<Ellipsis />
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end" class="w-44">
										<DropdownMenu.Item onclick={() => openEdit(o)}>
											<Pencil /> Bearbeiten
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
										<DropdownMenu.Item variant="destructive" onclick={() => askDelete(o)}>
											<Trash2 /> Löschen
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</Card.Action>
						{/if}
					</Card.Header>
					<Card.Content class="space-y-4">
						{#if o.description}
							<ExpandableText text={o.description} class="text-muted-foreground" />
						{/if}

						{#if o.emails.length > 0}
							<ul class="space-y-1" aria-label="E-Mail-Adressen">
								{#each o.emails as m (m.id)}
									<li class="flex min-w-0 items-center gap-2">
										<Mail class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
										{#if m.label}
											<span class="shrink-0 text-muted-foreground">{m.label}:</span>
										{/if}
										<a
											href={mailHref(m.email)}
											class="min-w-0 truncate text-link underline-offset-4 hover:underline"
										>
											{m.email}
										</a>
									</li>
								{/each}
							</ul>
						{/if}

						{#if canManage && o.roles.length > 0}
							<div class="flex flex-wrap items-center gap-1.5">
								<span class="text-xs text-muted-foreground">Rollen:</span>
								{#each o.roles as r (r.id)}
									<Badge variant="outline">{r.name}</Badge>
								{/each}
							</div>
						{/if}

						<section aria-label="Inhaber*innen von {o.name}">
							{#if o.holders.length === 0}
								<p class="text-sm text-muted-foreground italic">Derzeit nicht besetzt.</p>
							{:else}
								<ul class="divide-y">
									{#each o.holders as h (h.userId)}
										<li class="flex gap-3 py-3 first:pt-0 last:pb-0">
											<EntityAvatar name={h.name} src={h.image} size={40} />
											<div class="min-w-0 flex-1">
												<p class="font-medium">{h.name}</p>
												{#if h.since}
													<p class="text-xs text-muted-foreground">seit {formatDate(h.since)}</p>
												{/if}
												{#if h.bio}
													<ExpandableText text={h.bio} limit={200} class="mt-1" />
												{/if}
											</div>
										</li>
									{/each}
								</ul>
							{/if}
						</section>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>

{#if canManage}
	<OfficeDialog bind:open={dialogOpen} office={editing} onsaved={load} />
	<ConfirmDialog
		bind:open={deleteOpen}
		title="Amt löschen?"
		description={deleteDescription}
		confirmLabel="Löschen"
		destructive
		onconfirm={confirmDelete}
	/>
{/if}
