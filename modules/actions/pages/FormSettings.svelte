<script lang="ts" module>
	import type { FormDefinition } from '$lib/forms';

	/** Bearbeitbarer Stand der Formular-Konfiguration (Autosave in RegistrationTab). */
	export interface FormDraft {
		enabled: boolean;
		opensAt: string | null;
		closesAt: string | null;
		maxParticipants: number | null;
		intro: string;
		disclaimerTemplate: string;
		privacyUrl: string;
		requireLogin: boolean;
		definition: FormDefinition;
	}
</script>

<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Copy from '@lucide/svelte/icons/copy';
	import Download from '@lucide/svelte/icons/download';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { AssistTextarea, ConfirmDialog, NumberStepper } from '$lib/components/layout';
	import type { FormConfig, FormStatus } from '../schemas';

	let {
		actionId,
		draft = $bindable(),
		server,
		canEdit,
		onsavenow,
		onrotated,
		onopenparticipants
	}: {
		actionId: string;
		draft: FormDraft;
		server: FormConfig;
		canEdit: boolean;
		/** Speichert sofort (ohne Debounce) */
		onsavenow?: () => void;
		onrotated?: (config: FormConfig) => void;
		onopenparticipants?: () => void;
	} = $props();

	const disabled = $derived(!canEdit);
	const base = $derived(`/modules/actions/actions/${encodeURIComponent(actionId)}`);
	const csvHref = $derived(`/api/v1${base}/participants.csv`);

	const fullUrl = $derived(
		server.publicPath && typeof location !== 'undefined'
			? `${location.origin}${server.publicPath}`
			: (server.publicPath ?? '')
	);

	const STATUS: Record<FormStatus, { label: string; cls: string }> = {
		open: { label: 'Offen', cls: 'border-success-border bg-success-muted' },
		closed: { label: 'Geschlossen', cls: 'border-border' },
		not_open: { label: 'Noch nicht geöffnet', cls: 'border-warning-border bg-warning-muted' },
		full: { label: 'Ausgebucht', cls: 'border-warning-border bg-warning-muted' }
	};
	const status = $derived(STATUS[server.status]);

	// datetime-local <-> ISO
	function toLocal(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const p = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
	}
	function fromLocal(v: string): string | null {
		if (!v) return null;
		const d = new Date(v);
		return Number.isNaN(d.getTime()) ? null : d.toISOString();
	}

	async function copyLink() {
		try {
			await navigator.clipboard.writeText(fullUrl);
			toast.success('Link kopiert');
		} catch {
			toast.error('Link konnte nicht kopiert werden.');
		}
	}

	let rotateOpen = $state(false);
	let rotating = $state(false);
	async function rotate() {
		if (rotating) return;
		rotating = true;
		try {
			const cfg = await apiFetch<FormConfig>(`${base}/form/rotate-token`, { method: 'POST' });
			onrotated?.(cfg);
			toast.success('Neuer Link erzeugt');
		} catch (e) {
			toast.error(e instanceof ApiClientError ? e.message : 'Link konnte nicht erneuert werden.');
		} finally {
			rotating = false;
		}
	}

	function setEnabled(v: boolean) {
		draft.enabled = v;
		onsavenow?.();
	}

	const limited = $derived(draft.maxParticipants !== null);
	function setLimited(v: boolean) {
		draft.maxParticipants = v ? Math.max(1, server.submissions || 20) : null;
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-center justify-between gap-3">
		<Label for="reg-enabled" class="flex flex-col items-start gap-0.5">
			<span>Anmeldung geöffnet</span>
			<span class="text-muted-foreground text-xs font-normal">
				Über den Link können sich Personen anmelden.
			</span>
		</Label>
		<Switch id="reg-enabled" checked={draft.enabled} onCheckedChange={setEnabled} {disabled} />
	</div>

	<div class="flex items-center justify-between gap-3">
		<Label for="reg-require-login" class="flex flex-col items-start gap-0.5">
			<span>Anmeldung erzwingen</span>
			<span class="text-muted-foreground text-xs font-normal">
				Nur mit Login und verknüpftem Mitglied. Aus: Mitglieder können sich anmelden, Gäste (z. B.
				anderer Stämme) auch ohne Konto.
			</span>
		</Label>
		<Switch id="reg-require-login" bind:checked={draft.requireLogin} {disabled} />
	</div>

	<div class="flex flex-col gap-1.5">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<Label for="reg-link">Anmeldelink</Label>
			{#if server.persisted}
				<Badge variant="outline" class={status.cls}>{status.label}</Badge>
			{/if}
		</div>
		{#if server.publicPath}
			<Input id="reg-link" value={fullUrl} readonly onfocus={(e) => e.currentTarget.select()} />
			<div class="flex flex-wrap gap-2">
				<Button size="sm" variant="outline" onclick={copyLink}><Copy /> Link kopieren</Button>
				<Button
					size="sm"
					variant="outline"
					href={server.publicPath}
					target="_blank"
					rel="noopener noreferrer"
				>
					<ExternalLink /> Öffnen
				</Button>
				{#if canEdit}
					<Button
						size="sm"
						variant="outline"
						disabled={rotating}
						onclick={() => (rotateOpen = true)}
					>
						<RefreshCw /> Link erneuern
					</Button>
				{/if}
			</div>
		{:else}
			<p class="text-muted-foreground text-sm">Der Link entsteht beim ersten Speichern.</p>
		{/if}
	</div>

	<div class="grid gap-4 sm:grid-cols-2">
		<div class="flex flex-col gap-1.5">
			<Label for="reg-opens">Beginn der Anmeldung</Label>
			<Input
				id="reg-opens"
				type="datetime-local"
				value={toLocal(draft.opensAt)}
				onchange={(e) => (draft.opensAt = fromLocal(e.currentTarget.value))}
				{disabled}
			/>
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="reg-closes">Ende der Anmeldung</Label>
			<Input
				id="reg-closes"
				type="datetime-local"
				value={toLocal(draft.closesAt)}
				onchange={(e) => (draft.closesAt = fromLocal(e.currentTarget.value))}
				{disabled}
			/>
		</div>
		{#if draft.opensAt && draft.closesAt && draft.closesAt < draft.opensAt}
			<p class="text-destructive text-xs sm:col-span-2" role="alert">
				Das Ende liegt vor dem Beginn.
			</p>
		{/if}
	</div>

	<div class="flex flex-col gap-2">
		<div class="flex items-center justify-between gap-3">
			<Label for="reg-limited" class="flex flex-col items-start gap-0.5">
				<span>Teilnehmerzahl begrenzen</span>
				<span class="text-muted-foreground text-xs font-normal">
					Ohne Begrenzung ist die Anmeldung unbegrenzt.
				</span>
			</Label>
			<Switch id="reg-limited" checked={limited} onCheckedChange={setLimited} {disabled} />
		</div>
		{#if draft.maxParticipants !== null}
			<div class="flex flex-wrap items-center gap-2">
				<Label for="reg-max">Maximale Teilnehmerzahl</Label>
				<NumberStepper
					id="reg-max"
					bind:value={draft.maxParticipants}
					min={1}
					max={1000}
					label="Maximale Teilnehmerzahl"
					{disabled}
				/>
			</div>
		{/if}
	</div>

	<div class="flex flex-col gap-1.5">
		<Label for="reg-privacy">Datenschutz-URL</Label>
		<Input
			id="reg-privacy"
			type="url"
			placeholder="https://…"
			bind:value={draft.privacyUrl}
			{disabled}
		/>
		<p class="text-muted-foreground text-xs">
			Wird im Formular als Link zur Datenschutzerklärung gezeigt.
		</p>
	</div>

	<div class="flex flex-col gap-1.5">
		<Label for="reg-intro">Einleitungstext</Label>
		<AssistTextarea
			id="reg-intro"
			rows={3}
			maxlength={2000}
			placeholder="Hinweise für Eltern, die über dem Formular stehen"
			bind:value={draft.intro}
			{disabled}
			assist={{
				module: 'actions',
				purpose: 'registration-intro',
				context: { module: 'actions', kind: 'action', id: actionId }
			}}
		/>
	</div>

	<div
		class="bg-muted/50 flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm"
	>
		<span class="tabular-nums">
			{server.submissions}
			{server.submissions === 1 ? 'Anmeldung' : 'Anmeldungen'}
		</span>
		<span class="flex flex-wrap items-center gap-2">
			{#if onopenparticipants}
				<button
					type="button"
					class="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
					onclick={onopenparticipants}
				>
					Anmeldungen ansehen
				</button>
			{/if}
			<Button size="sm" variant="outline" href={csvHref} download>
				<Download /> CSV exportieren
			</Button>
		</span>
	</div>
</div>

<ConfirmDialog
	bind:open={rotateOpen}
	title="Link erneuern?"
	description="Der alte Link funktioniert danach nicht mehr. Bereits verschickte Links müssen ersetzt werden."
	confirmLabel="Link erneuern"
	destructive
	onconfirm={rotate}
/>
