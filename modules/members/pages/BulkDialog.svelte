<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { SelectField } from '$lib/components/ui/select-field';
	import { STAGES, STAGE_LABELS, type BulkResult, type Group, type Stage } from '../schemas';

	export type BulkMode = 'add-groups' | 'remove-groups' | 'set-stage' | 'set-consent';

	let {
		open = $bindable(false),
		mode,
		ids,
		groups,
		ondone
	}: {
		open?: boolean;
		mode: BulkMode;
		ids: string[];
		groups: Group[];
		ondone: (result: BulkResult) => void;
	} = $props();

	const TITLES: Record<BulkMode, string> = {
		'add-groups': 'Zu Gruppen hinzufügen',
		'remove-groups': 'Aus Gruppen entfernen',
		'set-stage': 'Stand setzen',
		'set-consent': 'Einwilligungen setzen'
	};
	const CONSENTS = [
		{ key: 'consentSocialMedia', label: 'Socialmedia' },
		{ key: 'consentWebsite', label: 'Stammeswebsite' },
		{ key: 'consentPrint', label: 'Print' }
	] as const;
	const YES_NO = [
		{ value: 'yes', label: 'Darf gezeigt werden' },
		{ value: 'no', label: 'Darf nicht gezeigt werden' }
	];

	let groupIds = $state<string[]>([]);
	let stage = $state<string | null>(null);
	let consent = $state<Record<string, string | null>>({});
	let busy = $state(false);
	let error = $state('');

	// Bei jedem Oeffnen zuruecksetzen
	$effect(() => {
		if (open) {
			groupIds = [];
			stage = null;
			consent = {};
			error = '';
		}
	});

	const groupOptions = $derived(groups.map((g) => ({ value: g.id, label: g.name })));
	const stageOptions = STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }));

	function payload(): Record<string, unknown> | null {
		if (mode === 'add-groups' || mode === 'remove-groups') {
			if (!groupIds.length) {
				error = 'Bitte mindestens eine Gruppe wählen';
				return null;
			}
			return { action: mode, ids, groupIds };
		}
		if (mode === 'set-stage') {
			if (!stage) {
				error = 'Bitte einen Stand wählen';
				return null;
			}
			return { action: mode, ids, stage: stage as Stage };
		}
		const set: Record<string, boolean> = {};
		for (const c of CONSENTS) {
			const v = consent[c.key];
			if (v) set[c.key] = v === 'yes';
		}
		if (!Object.keys(set).length) {
			error = 'Bitte mindestens eine Einwilligung ändern';
			return null;
		}
		return { action: mode, ids, consent: set };
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		const body = payload();
		if (!body) return;
		busy = true;
		try {
			const result = await apiFetch<BulkResult>('/modules/members/members/bulk', {
				method: 'POST',
				body: JSON.stringify(body)
			});
			open = false;
			ondone(result);
		} catch (err) {
			error = err instanceof ApiClientError ? err.message : 'Speichern fehlgeschlagen';
			toast.error(error);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{TITLES[mode]}</Dialog.Title>
			<Dialog.Description>
				Gilt für {ids.length}
				{ids.length === 1 ? 'ausgewähltes Mitglied' : 'ausgewählte Mitglieder'}.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit}>
			{#if mode === 'add-groups' || mode === 'remove-groups'}
				<div class="space-y-1.5">
					<Label for="bulk-groups">Gruppen</Label>
					<MultiSelect
						id="bulk-groups"
						label="Gruppen"
						options={groupOptions}
						bind:value={groupIds}
						placeholder="Gruppen wählen …"
					/>
				</div>
			{:else if mode === 'set-stage'}
				<div class="space-y-1.5">
					<Label for="bulk-stage">Stand</Label>
					<SelectField id="bulk-stage" label="Stand" options={stageOptions} bind:value={stage} />
				</div>
			{:else}
				{#each CONSENTS as c (c.key)}
					<div class="space-y-1.5">
						<Label for={`bulk-${c.key}`}>{c.label}</Label>
						<SelectField
							id={`bulk-${c.key}`}
							label={c.label}
							emptyLabel="Unverändert"
							options={YES_NO}
							bind:value={() => consent[c.key] ?? null, (v) => (consent[c.key] = v)}
						/>
					</div>
				{/each}
			{/if}
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? 'Speichert …' : 'Übernehmen'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
