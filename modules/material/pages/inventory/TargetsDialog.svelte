<script lang="ts">
	// Packliste (Soll-Inhalt) einer Kiste bearbeiten: Artikel × Anzahl.
	// Der Aufrufer rendert per `{#key}` neu.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Plus from '@lucide/svelte/icons/plus';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { SelectField } from '$lib/components/ui/select-field';
	import { BUSY_SAVE, NumberStepper } from '$lib/components/layout';
	import { targetsInput, type Article, type ContainerTarget } from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';

	let {
		open = $bindable(false),
		unitId,
		name,
		targets,
		articles,
		onsaved
	}: {
		open?: boolean;
		unitId: string;
		name: string;
		targets: ContainerTarget[];
		articles: Article[];
		onsaved: () => void | Promise<void>;
	} = $props();

	type Row = { key: number; articleId: string | null; quantity: number };
	let nextKey = 0;
	let rows = $state<Row[]>(
		untrack(() => targets).map((t) => ({
			key: nextKey++,
			articleId: t.articleId,
			quantity: t.target
		}))
	);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	const options = $derived(
		articles
			.filter((a) => !a.archived || rows.some((r) => r.articleId === a.id))
			.map((a) => ({ value: a.id, label: `${a.name} (${a.unitLabel})` }))
	);

	function add() {
		rows = [...rows, { key: nextKey++, articleId: null, quantity: 1 }];
	}

	async function save() {
		const data = {
			targets: rows
				.filter((r) => r.articleId)
				.map((r) => ({ articleId: r.articleId!, quantity: r.quantity }))
		};
		const parsed = targetsInput.safeParse(data);
		if (!parsed.success) {
			errors = fieldErrors(parsed.error.issues);
			return;
		}
		errors = {};
		busy = true;
		try {
			await apiFetch(`${API}/units/${unitId}/targets`, {
				method: 'PUT',
				body: JSON.stringify(data)
			});
			toast.success('Packliste gespeichert');
			open = false;
			await onsaved();
		} catch (e) {
			errors = apiFieldErrors(e);
			toast.error(errorText(e, 'Packliste konnte nicht gespeichert werden'));
		} finally {
			busy = false;
		}
	}

	const firstError = $derived(Object.values(errors)[0] ?? null);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Packliste</Dialog.Title>
			<Dialog.Description>
				Was soll in „{name}“ sein? Die Ansicht vergleicht Soll und Ist.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-3">
			{#if !rows.length}
				<p class="text-sm text-muted-foreground">Noch keine Einträge.</p>
			{/if}
			{#each rows as row, i (row.key)}
				<div class="grid grid-cols-[1fr_auto] items-start gap-2 sm:grid-cols-[1fr_auto_auto]">
					<SelectField
						{options}
						bind:value={row.articleId}
						label={`Artikel ${i + 1}`}
						placeholder="Artikel wählen …"
						class="col-span-2 sm:col-span-1"
					/>
					<NumberStepper bind:value={row.quantity} min={1} max={100000} label={`Anzahl ${i + 1}`} />
					<Button
						variant="ghost"
						size="icon"
						aria-label={`Eintrag ${i + 1} entfernen`}
						onclick={() => (rows = rows.filter((r) => r.key !== row.key))}
					>
						<X />
					</Button>
				</div>
			{/each}
			<Button variant="outline" size="sm" onclick={add} disabled={rows.length >= 100}>
				<Plus /> Eintrag
			</Button>
			{#if firstError}
				<p class="text-xs text-destructive" role="alert">{firstError}</p>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button onclick={save} disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
