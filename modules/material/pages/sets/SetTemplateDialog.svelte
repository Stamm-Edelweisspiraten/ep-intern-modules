<script lang="ts">
	// Set-Vorlage (Zelttyp) anlegen/bearbeiten: Name, Beschreibung, Teile (Einzelstück-Artikel × Anzahl).
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SelectField } from '$lib/components/ui/select-field';
	import { BUSY_SAVE, FormField, NumberStepper } from '$lib/components/layout';
	import {
		MAX_NAME,
		MAX_TEXT,
		setTemplateInput,
		type Article,
		type SetTemplate
	} from '../../schemas';
	import { API, apiFieldErrors, errorText, fieldErrors } from '../helpers';

	let {
		open = $bindable(false),
		template = null,
		articles,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neue Vorlage */
		template?: SetTemplate | null;
		/** Artikel mit Einzelstücken (Teile) */
		articles: Article[];
		onsaved?: (t: SetTemplate) => void | Promise<void>;
	} = $props();

	type Part = { key: string; articleId: string | null; quantity: number };
	let name = $state('');
	let description = $state('');
	let parts = $state<Part[]>([]);
	let busy = $state(false);
	let error = $state('');
	let errors = $state<Record<string, string>>({});

	const newKey = () => crypto.randomUUID();

	let initFor: string | null = null;
	$effect(() => {
		if (!open) {
			initFor = null;
			return;
		}
		const key = template?.id ?? 'new';
		if (initFor === key) return;
		initFor = key;
		name = template?.name ?? '';
		description = template?.description ?? '';
		parts = template?.parts.map((p) => ({
			key: newKey(),
			articleId: p.articleId,
			quantity: p.quantity
		})) ?? [{ key: newKey(), articleId: null, quantity: 1 }];
		error = '';
		errors = {};
	});

	const options = $derived(
		articles
			.filter((a) => !a.archived || parts.some((p) => p.articleId === a.id))
			.map((a) => ({
				value: a.id,
				label: `${a.name}${a.kind === 'bulk' ? ' (Menge)' : ''}${a.categoryName ? ` · ${a.categoryName}` : ''}`
			}))
	);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const parsed = setTemplateInput.safeParse({
			name,
			description,
			parts: parts
				.filter((p) => p.articleId)
				.map((p) => ({ articleId: p.articleId, quantity: p.quantity }))
		});
		if (!parsed.success) {
			errors = fieldErrors(parsed.error);
			error = errors['parts'] ?? '';
			return;
		}
		busy = true;
		error = '';
		errors = {};
		try {
			const saved = template
				? await apiFetch<SetTemplate>(`${API}/set-templates/${template.id}`, {
						method: 'PATCH',
						body: JSON.stringify(parsed.data)
					})
				: await apiFetch<SetTemplate>(`${API}/set-templates`, {
						method: 'POST',
						body: JSON.stringify(parsed.data)
					});
			toast.success(template ? 'Set-Typ gespeichert' : 'Set-Typ angelegt');
			open = false;
			await onsaved?.(saved);
		} catch (err) {
			errors = apiFieldErrors(err);
			error = errorText(err, 'Speichern fehlgeschlagen');
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{template ? 'Set-Typ bearbeiten' : 'Neuer Set-Typ'}</Dialog.Title>
			<Dialog.Description>
				Ein Set-Typ beschreibt, woraus ein Set besteht – z. B. „Kohte“ = 4 × Kohtenbahn, 1 ×
				Kohtenkreuz.
			</Dialog.Description>
		</Dialog.Header>
		<form id="set-template-form" class="space-y-4" onsubmit={submit}>
			<FormField label="Name" id="tpl-name" required error={errors['name']}>
				<Input id="tpl-name" bind:value={name} maxlength={MAX_NAME} placeholder="z. B. Kohte" />
			</FormField>
			<FormField label="Beschreibung" id="tpl-description" error={errors['description']}>
				<Textarea id="tpl-description" bind:value={description} maxlength={MAX_TEXT} rows={2} />
			</FormField>
			<fieldset class="space-y-2">
				<legend class="text-sm font-medium">Teile <span class="text-destructive">*</span></legend>
				{#if !articles.length}
					<p class="text-sm text-muted-foreground">
						Es gibt noch keine Artikel mit Einzelstücken. Lege sie zuerst im Bestand an.
					</p>
				{/if}
				<ul class="space-y-2">
					{#each parts as p, i (p.key)}
						<li class="flex flex-wrap items-start gap-2 sm:flex-nowrap">
							<div class="min-w-0 flex-1">
								<SelectField
									label={`Artikel für Teil ${i + 1}`}
									placeholder="Artikel wählen …"
									{options}
									bind:value={p.articleId}
									invalid={!!errors[`parts.${i}.articleId`]}
								/>
								{#if errors[`parts.${i}.articleId`]}
									<p class="mt-1 text-xs text-destructive" role="alert">
										{errors[`parts.${i}.articleId`]}
									</p>
								{/if}
							</div>
							<NumberStepper
								label={`Anzahl für Teil ${i + 1}`}
								bind:value={p.quantity}
								min={1}
								max={999}
							/>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label={`Teil ${i + 1} entfernen`}
								disabled={parts.length <= 1}
								onclick={() => (parts = parts.filter((x) => x.key !== p.key))}
							>
								<Trash2 />
							</Button>
						</li>
					{/each}
				</ul>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={parts.length >= 50}
					onclick={() => (parts = [...parts, { key: newKey(), articleId: null, quantity: 1 }])}
				>
					<Plus aria-hidden="true" /> Teil hinzufügen
				</Button>
			</fieldset>
		</form>
		{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button type="submit" form="set-template-form" disabled={busy}>
				{busy ? BUSY_SAVE : 'Speichern'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
