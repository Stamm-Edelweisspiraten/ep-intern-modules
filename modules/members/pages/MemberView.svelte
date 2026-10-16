<script lang="ts">
	import Download from '@lucide/svelte/icons/download';
	import Link2 from '@lucide/svelte/icons/link-2';
	import Mail from '@lucide/svelte/icons/mail';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Phone from '@lucide/svelte/icons/phone';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Sheet from '$lib/components/ui/sheet';
	import { ColorBadge, EntityAvatar, SummaryList, type SummaryRow } from '$lib/components/layout';
	import type { FieldDefinition, FormValue } from '$lib/forms';
	import { countryLabel } from './countries';
	import {
		DOCUMENT_KINDS,
		DOCUMENT_LABELS,
		FEE_LEVEL_LABELS,
		STAGE_LABELS,
		ageFromBirthDate,
		type ContactEntry,
		type Member
	} from '../schemas';

	let {
		open = $bindable(false),
		member,
		canEdit,
		canLinkView,
		onedit,
		onlinks
	}: {
		open?: boolean;
		member: Member | null;
		canEdit: boolean;
		canLinkView: boolean;
		onedit: (m: Member) => void;
		onlinks: (m: Member) => void;
	} = $props();

	const base = '/api/v1/modules/members/members';
	const today = new Date().toISOString().slice(0, 10);

	let fields = $state<FieldDefinition[]>([]);
	let fieldsLoaded = false;
	$effect(() => {
		if (!open || fieldsLoaded) return;
		fieldsLoaded = true;
		apiFetch<{ fields: { active: boolean; field: FieldDefinition }[] }>('/modules/members/fields')
			.then(
				(r) => (fields = r.fields.filter((d) => d.active && !d.field.hidden).map((d) => d.field))
			)
			.catch(() => {
				fieldsLoaded = false;
			});
	});

	function fmtDate(iso: string | null): string {
		if (!iso) return '–';
		const [y, m, d] = iso.split('-');
		return `${d}.${m}.${y}`;
	}

	function fmtCustom(f: FieldDefinition, v: FormValue | undefined): string {
		if (v === null || v === undefined || v === '') return '';
		if (Array.isArray(v)) {
			if (!v.length) return '';
			const opts = 'options' in f ? f.options : [];
			return v.map((x) => opts.find((o) => o.value === x)?.label ?? x).join(', ');
		}
		if (typeof v === 'boolean') return v ? 'Ja' : 'Nein';
		if (typeof v === 'number') return v.toLocaleString('de-DE');
		if ('options' in f) return f.options.find((o) => o.value === v)?.label ?? String(v);
		if (f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) return fmtDate(String(v));
		return String(v);
	}

	const m = $derived(member);
	const left = $derived(!!m?.exitDate && m.exitDate <= today);
	const age = $derived(m ? ageFromBirthDate(m.birthDate) : null);

	const personRows = $derived<SummaryRow[]>(
		m
			? [
					{
						label: 'Geburtsdatum',
						value: `${fmtDate(m.birthDate)}${age !== null && age >= 0 ? ` (${age} ${age === 1 ? 'Jahr' : 'Jahre'})` : ''}`
					},
					...(m.scoutName ? [{ label: 'Fahrtenname', value: m.scoutName }] : [])
				]
			: []
	);
	const addressLines = $derived(
		m
			? [
					m.street,
					`${m.postalCode} ${m.city}`.trim(),
					m.country && m.country !== 'DE' ? countryLabel(m.country) : ''
				].filter(Boolean)
			: []
	);
	const membershipRows = $derived<SummaryRow[]>(
		m
			? [
					{ label: 'Stand', value: STAGE_LABELS[m.stage] },
					{ label: 'Eintritt', value: fmtDate(m.entryDate) },
					{ label: 'Austritt', value: fmtDate(m.exitDate) },
					{
						label: 'Zweitmitglied',
						value: m.secondaryMember ? 'Ja' : 'Nein'
					},
					...(m.secondaryMember
						? [
								{
									label: 'Beitrag bei uns für',
									value: m.feeLevels.map((l) => FEE_LEVEL_LABELS[l]).join(', ') || '–'
								}
							]
						: [])
				]
			: []
	);
	const customRows = $derived<SummaryRow[]>(
		m
			? fields
					.map((f) => ({ label: f.label, value: fmtCustom(f, m.custom?.[f.key]) }))
					.filter((r) => r.value !== '')
			: []
	);
	const consentRows = $derived<SummaryRow[]>(
		m
			? [
					{ label: 'Socialmedia', value: m.consentSocialMedia ? 'Ja' : 'Nein' },
					{ label: 'Stammeswebsite', value: m.consentWebsite ? 'Ja' : 'Nein' },
					{ label: 'Print', value: m.consentPrint ? 'Ja' : 'Nein' }
				]
			: []
	);
	const documents = $derived(
		m
			? DOCUMENT_KINDS.map((kind) => ({
					kind,
					label: DOCUMENT_LABELS[kind],
					name: (kind === 'privacy' ? m.privacyConsent : m.registration)?.name ?? null
				}))
			: []
	);
	const telHref = (v: string) => `tel:${v.replace(/[^\d+]/g, '')}`;

	/** Download per fetch, damit Fehler (z. B. 503 ohne S3) als Hinweis statt als JSON-Seite erscheinen. */
	let downloading = $state<string | null>(null);
	async function download(memberId: string, kind: string, fallbackName: string) {
		const key = `${memberId}/${kind}`;
		downloading = key;
		try {
			const res = await fetch(`${base}/${memberId}/documents/${kind}`, {
				credentials: 'same-origin'
			});
			if (!res.ok) {
				if (res.status === 503) {
					throw new Error(
						'Die Dokumentenablage ist gerade nicht verfügbar (Speicher nicht eingerichtet oder nicht erreichbar).'
					);
				}
				if (res.status === 404) throw new Error('Das Dokument wurde nicht gefunden.');
				const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
				throw new Error(b?.error?.message ?? 'Download fehlgeschlagen');
			}
			const name =
				/filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
				fallbackName;
			const href = URL.createObjectURL(await res.blob());
			const a = document.createElement('a');
			a.href = href;
			a.download = name;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(href), 10_000);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Download fehlgeschlagen');
		} finally {
			if (downloading === key) downloading = null;
		}
	}
</script>

{#snippet section(title: string)}
	<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
{/snippet}

{#snippet contactList(list: ContactEntry[], kind: 'tel' | 'mail')}
	{#if list.length}
		<ul class="divide-y divide-border/60 text-sm">
			{#each list as c, i (i)}
				<li class="flex items-center justify-between gap-3 py-1.5">
					<span class="min-w-0 truncate text-muted-foreground">
						{c.name || (kind === 'tel' ? 'Telefon' : 'E-Mail')}
					</span>
					<a
						class="flex min-w-0 items-center gap-1.5 truncate text-primary underline-offset-4 hover:underline"
						href={kind === 'tel' ? telHref(c.value) : `mailto:${c.value}`}
					>
						{#if kind === 'tel'}<Phone class="size-3.5 shrink-0" aria-hidden="true" />{:else}<Mail
								class="size-3.5 shrink-0"
								aria-hidden="true"
							/>{/if}
						<span class="truncate">{c.value}</span>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-muted-foreground">
			{kind === 'tel' ? 'Keine Telefonnummer hinterlegt.' : 'Keine E-Mail-Adresse hinterlegt.'}
		</p>
	{/if}
{/snippet}

<Sheet.Root bind:open>
	<Sheet.Content
		side="right"
		class="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
	>
		{#if m}
			<Sheet.Header class="border-b p-4 pr-12">
				<div class="flex items-start gap-3">
					<EntityAvatar
						name={`${m.firstName} ${m.lastName}`}
						color={m.groups[0]?.color ?? null}
						size={48}
					/>
					<div class="min-w-0 space-y-1">
						<Sheet.Title class="text-lg leading-tight">{m.firstName} {m.lastName}</Sheet.Title>
						{#if m.scoutName}
							<Sheet.Description>„{m.scoutName}“</Sheet.Description>
						{:else}
							<Sheet.Description class="sr-only">Mitglied</Sheet.Description>
						{/if}
						<div class="flex flex-wrap gap-1 pt-1">
							<Badge variant="secondary">{STAGE_LABELS[m.stage]}</Badge>
							{#if m.secondaryMember}<Badge variant="outline">Zweitmitglied</Badge>{/if}
							{#if left}<Badge variant="destructive">ausgetreten</Badge>{/if}
						</div>
					</div>
				</div>
				{#if canEdit || canLinkView}
					<div class="flex flex-wrap gap-2 pt-3">
						{#if canEdit}
							<Button size="sm" onclick={() => m && onedit(m)}><Pencil /> Bearbeiten</Button>
						{/if}
						{#if canLinkView}
							<Button size="sm" variant="outline" onclick={() => m && onlinks(m)}>
								<Link2 /> Verknüpfte Konten ({m.linkCount})
							</Button>
						{/if}
					</div>
				{/if}
			</Sheet.Header>

			<div class="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
				<section class="space-y-2">
					{@render section('Person')}
					<SummaryList rows={personRows} />
					<div class="flex items-baseline justify-between gap-4 text-sm">
						<span>Anschrift</span>
						<address class="min-w-0 text-right break-words not-italic">
							{#each addressLines as line, i (i)}<span class="block">{line}</span>{:else}<span
									class="text-muted-foreground">–</span
								>{/each}
						</address>
					</div>
				</section>

				<section class="space-y-2">
					{@render section('Kontakt')}
					{@render contactList(m.phones, 'tel')}
					{@render contactList(m.emails, 'mail')}
				</section>

				<section class="space-y-2">
					{@render section('Mitgliedschaft')}
					<div class="flex items-baseline justify-between gap-4 text-sm">
						<span>Gruppen</span>
						<div class="flex flex-wrap justify-end gap-1">
							{#each m.groups as g (g.id)}
								<ColorBadge color={g.color}>{g.name}</ColorBadge>
							{:else}
								<span class="text-muted-foreground">–</span>
							{/each}
						</div>
					</div>
					<SummaryList rows={membershipRows} />
				</section>

				{#if customRows.length}
					<section class="space-y-2">
						{@render section('Weitere Angaben')}
						<SummaryList rows={customRows} />
					</section>
				{/if}

				<section class="space-y-2">
					{@render section('Einwilligungen – darf gezeigt werden auf')}
					<SummaryList rows={consentRows} />
				</section>

				<section class="space-y-2">
					{@render section('Dokumente')}
					<ul class="space-y-2 text-sm">
						{#each documents as d (d.kind)}
							<li class="flex items-center justify-between gap-3">
								<span>{d.label}</span>
								{#if d.name}
									<Button
										size="sm"
										variant="outline"
										class="max-w-[60%]"
										title={d.name}
										aria-label={`${d.label} herunterladen: ${d.name}`}
										disabled={downloading === `${m.id}/${d.kind}`}
										onclick={() => m && d.name && download(m.id, d.kind, d.name)}
									>
										<Download /> <span class="truncate">{d.name}</span>
									</Button>
								{:else}
									<span class="text-muted-foreground">nicht hinterlegt</span>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>
