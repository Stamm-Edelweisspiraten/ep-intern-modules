<script lang="ts">
	// Warenkorb zum Reservieren (wie `orders/CartPanel`): Zeilen mit Anzahl/Entfernen und Warnung,
	// darunter Titel, Zweck (Aktion/Gruppe/Sonstiges), Notiz und Absenden. Absenden übernimmt der Aufrufer.
	import Boxes from '@lucide/svelte/icons/boxes';
	import Info from '@lucide/svelte/icons/info';
	import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { FormField, NumberStepper } from '$lib/components/layout';
	import {
		MAX_NAME,
		MAX_QUANTITY,
		MAX_TEXT,
		PURPOSE_LABELS,
		PURPOSES,
		type Purpose,
		type PurposeOptions
	} from '../../schemas';
	import { formatPeriod } from '../helpers';
	import { cartCount, lineKey, removeLine, setQuantity, type CartDraft } from './cart';

	let {
		draft = $bindable(),
		issues,
		notes = {},
		errors,
		options,
		optionsError,
		onretryoptions,
		busy,
		editing,
		canReserve,
		onsubmit,
		oncancel
	}: {
		draft: CartDraft;
		/** Warnung je Zeile (`lineKey` → Text) */
		issues: Record<string, string>;
		/** Voraussichtliche Zuteilung je Zeile (`lineKey` → Text, z. B. „aus Set KJ1“) */
		notes?: Record<string, string>;
		/** Feldfehler (`title`, `actionId`, `groupId`, `notes`, …) */
		errors: Record<string, string>;
		options: PurposeOptions | null;
		optionsError: string;
		onretryoptions: () => void;
		busy: boolean;
		/** Bearbeiten einer bestehenden Reservierung */
		editing: boolean;
		canReserve: boolean;
		onsubmit: () => void;
		oncancel?: () => void;
	} = $props();

	const count = $derived(cartCount(draft.lines));
	const issueCount = $derived(draft.lines.filter((l) => issues[lineKey(l)]).length);

	const purposeOptions = PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABELS[p] }));
	const actionOptions = $derived(
		(options?.actions ?? []).map((a) => ({
			value: a.id,
			label: `${a.name} (${formatPeriod(a.startsOn, a.endsOn ?? a.startsOn)})`
		}))
	);
	const groupOptions = $derived(
		(options?.groups ?? []).map((g) => ({ value: g.id, label: g.name }))
	);
	const actionsActive = $derived(options?.actionsActive ?? false);
	const groupsActive = $derived(options?.groupsActive ?? false);

	function setPurpose(v: string | null) {
		draft.purpose = (v ?? 'other') as Purpose;
	}
</script>

<section class="space-y-4" aria-labelledby="material-cart-title">
	<h2 id="material-cart-title" class="flex items-center gap-2 font-semibold">
		<ShoppingCart class="size-4" aria-hidden="true" />
		{editing ? 'Reservierung' : 'Warenkorb'}
		{#if count}<span class="text-sm font-normal text-muted-foreground tabular-nums">({count})</span
			>{/if}
	</h2>

	{#if !draft.lines.length}
		<p class="text-sm text-muted-foreground">
			Noch leer. Wähle Material aus oder scanne einen Code, um es in den Warenkorb zu legen.
		</p>
	{:else}
		<ul class="divide-y">
			{#each draft.lines as line (lineKey(line))}
				{@const key = lineKey(line)}
				{@const issue = issues[key]}
				<li class="flex gap-3 py-3 first:pt-0">
					<div class="size-12 shrink-0 overflow-hidden rounded-md bg-muted">
						{#if line.thumbUrl}
							<img src={line.thumbUrl} alt="" loading="lazy" class="size-full object-cover" />
						{:else}
							<span class="flex size-full items-center justify-center text-muted-foreground">
								<Boxes class="size-4" aria-hidden="true" />
							</span>
						{/if}
					</div>
					<div class="min-w-0 flex-1 space-y-1.5">
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<p class="truncate text-sm font-medium" title={line.name}>{line.name}</p>
								<p class="text-xs text-muted-foreground">
									{#if line.kind === 'type'}
										beliebige
									{:else if line.kind === 'tent'}
										Zelt
									{:else}
										<span class="font-mono">{line.code ?? ''}</span>
									{/if}
								</p>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								class="shrink-0"
								aria-label={`${line.name} entfernen`}
								disabled={busy}
								onclick={() => (draft.lines = removeLine(draft.lines, key))}
							>
								<Trash2 />
							</Button>
						</div>
						{#if line.kind !== 'item' || (line.max ?? 2) > 1}
							<NumberStepper
								label={`Anzahl ${line.name}`}
								value={line.quantity}
								min={1}
								max={line.kind === 'item' ? (line.max ?? MAX_QUANTITY) : MAX_QUANTITY}
								disabled={busy}
								invalid={!!issue}
								onchange={(v) => (draft.lines = setQuantity(draft.lines, key, v))}
							/>
						{/if}
						{#if issue}
							<p class="flex items-start gap-1 text-xs text-warning" role="alert">
								<TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
								{issue}
							</p>
						{:else if notes[key]}
							<p class="flex items-start gap-1 text-xs text-muted-foreground">
								<Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
								{notes[key]}
							</p>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
		{#if errors.lines}
			<p class="text-xs text-destructive" role="alert">{errors.lines}</p>
		{/if}
	{/if}

	{#if !canReserve}
		<p class="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
			Du darfst das Material ansehen, aber nicht reservieren.
		</p>
	{:else}
		<FormField label="Titel" id="material-cart-title-input" required error={errors.title}>
			<Input
				id="material-cart-title-input"
				maxlength={MAX_NAME}
				placeholder="z. B. Sommerlager Wölflinge"
				bind:value={draft.title}
			/>
		</FormField>

		<FormField label="Zweck" id="material-cart-purpose" error={errors.purpose}>
			<SelectField
				id="material-cart-purpose"
				label="Zweck"
				options={purposeOptions}
				value={draft.purpose}
				onchange={setPurpose}
			/>
		</FormField>

		{#if optionsError && draft.purpose !== 'other'}
			<p class="text-xs text-destructive" role="alert">
				{optionsError}
				<button type="button" class="underline underline-offset-2" onclick={onretryoptions}>
					Erneut versuchen
				</button>
			</p>
		{:else if draft.purpose === 'action'}
			<FormField
				label="Aktion"
				id="material-cart-action"
				required
				error={errors.actionId}
				hint={!actionsActive
					? 'Das Modul „Aktionen“ ist nicht aktiv. Wähle einen anderen Zweck.'
					: !actionOptions.length
						? 'Du siehst keine Aktion. Wähle einen anderen Zweck.'
						: undefined}
			>
				<SelectField
					id="material-cart-action"
					label="Aktion"
					options={actionOptions}
					bind:value={draft.actionId}
					placeholder="Aktion wählen …"
					disabled={!actionsActive || !actionOptions.length}
				/>
			</FormField>
		{:else if draft.purpose === 'group'}
			<FormField
				label="Gruppe"
				id="material-cart-group"
				required
				error={errors.groupId}
				hint={!groupsActive
					? 'Das Modul „Mitglieder & Gruppen“ ist nicht aktiv. Wähle einen anderen Zweck.'
					: !groupOptions.length
						? 'Es gibt noch keine Gruppen.'
						: 'z. B. Material für die Gruppenstunden'}
			>
				<SelectField
					id="material-cart-group"
					label="Gruppe"
					options={groupOptions}
					bind:value={draft.groupId}
					placeholder="Gruppe wählen …"
					disabled={!groupsActive || !groupOptions.length}
				/>
			</FormField>
		{/if}

		<FormField label="Notiz (optional)" id="material-cart-notes" error={errors.notes}>
			<Textarea
				id="material-cart-notes"
				rows={2}
				maxlength={MAX_TEXT}
				placeholder="z. B. Abholung Freitag ab 17 Uhr"
				bind:value={draft.notes}
			/>
		</FormField>

		{#if issueCount}
			<p class="text-xs text-warning" role="status">
				{issueCount === 1
					? 'Eine Position ist im Zeitraum nicht mehr frei.'
					: `${issueCount} Positionen sind im Zeitraum nicht mehr frei.`}
			</p>
		{/if}

		<div class="flex flex-col gap-2">
			<Button class="w-full" disabled={!draft.lines.length || busy} onclick={onsubmit}>
				{busy ? 'Speichert …' : editing ? 'Änderungen speichern' : 'Reservieren'}
			</Button>
			{#if oncancel}
				<Button variant="outline" class="w-full" disabled={busy} onclick={oncancel}>
					Bearbeiten abbrechen
				</Button>
			{/if}
		</div>
	{/if}
</section>
