<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { page } from '$app/state';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { FormBuilder } from '$lib/components/forms';
	import { PageHeader } from '$lib/components/layout';
	import type { FormDefinition, FieldType } from '$lib/forms';
	import { MEMBER_FIELD_TYPES, type MemberFieldDef } from '../schemas';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canManage = $derived(can(permissions, 'members.field.manage'));

	let definition = $state<FormDefinition>({ version: 1, fields: [] });
	let loading = $state(true);
	let loadError = $state('');
	let busy = $state(false);
	let dirty = $state(false);
	let fieldErrors = $state<Record<string, string>>({});

	/**
	 * Vorlagen sind `locked` (nicht löschbar, Typ/Schlüssel fix); „deaktiviert“ wird im Builder als
	 * `hidden` („Nicht anzeigen“) bearbeitet und beim Speichern als `active: false` gesendet.
	 */
	async function load() {
		loading = true;
		loadError = '';
		try {
			const r = await apiFetch<{ fields: MemberFieldDef[] }>('/modules/members/fields');
			definition = {
				version: 1,
				fields: r.fields.map((d) => ({
					...d.field,
					locked: d.preset || undefined,
					hidden: !d.active || undefined
				}))
			};
			dirty = false;
		} catch (e) {
			loadError = e instanceof ApiClientError ? e.message : 'Laden fehlgeschlagen';
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void load();
	});

	async function save() {
		busy = true;
		fieldErrors = {};
		try {
			await apiFetch('/modules/members/fields', {
				method: 'PUT',
				body: JSON.stringify({
					fields: definition.fields.map((f) => ({ active: !f.hidden, field: f }))
				})
			});
			toast.success('Zusatzfelder gespeichert');
			await load();
		} catch (e) {
			if (e instanceof ApiClientError) {
				toast.error(e.message);
				if (e.details && typeof e.details === 'object' && !Array.isArray(e.details)) {
					fieldErrors = Object.fromEntries(
						Object.entries(e.details as Record<string, unknown>).map(([k, v]) => [k, String(v)])
					);
				}
			} else toast.error('Speichern fehlgeschlagen');
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Zusatzfelder</title></svelte:head>

<PageHeader
	title="Zusatzfelder"
	description="Weitere Angaben zu Mitgliedern, z. B. Ernährung, Allergien oder Medikamente. Sie werden bei Anmeldungen vorausgefüllt."
>
	{#snippet actions()}
		{#if canManage}
			<Button onclick={save} disabled={busy || loading || !dirty}>
				{busy ? 'Speichert …' : 'Speichern'}
			</Button>
		{/if}
	{/snippet}
</PageHeader>

<Card.Root>
	<Card.Content class="pt-6">
		{#if loading}
			<Skeleton class="h-40 w-full" />
		{:else if loadError}
			<p class="text-sm text-destructive" role="alert">{loadError}</p>
			<Button variant="outline" class="mt-2" onclick={load}>Erneut versuchen</Button>
		{:else}
			<p class="mb-4 text-sm text-muted-foreground">
				Vordefinierte Felder lassen sich nicht löschen, aber umbenennen oder mit „Nicht anzeigen“
				ausblenden. Bereits gespeicherte Angaben bleiben auch bei ausgeblendeten Feldern erhalten.
			</p>
			<FormBuilder
				bind:definition
				allowedTypes={[...MEMBER_FIELD_TYPES] as FieldType[]}
				maxFields={40}
				disabled={!canManage}
				errors={fieldErrors}
				onchange={() => (dirty = true)}
			/>
		{/if}
	</Card.Content>
</Card.Root>
