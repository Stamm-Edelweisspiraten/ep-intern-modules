<script lang="ts">
	import { toast } from 'svelte-sonner';
	import FileDown from '@lucide/svelte/icons/file-down';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { formatDateDe } from '$lib/sdk/dates';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Alert } from '$lib/components/ui/alert';
	import { SegmentedSlider } from '$lib/components/ui/segmented-slider';
	import { EmptyState, ErrorState, FormField, LoadingState } from '$lib/components/layout';
	import { BUSY_SAVE } from '$lib/components/layout/busy';
	import { formatEuro } from '$lib/components/layout/money';
	import {
		UNASSIGNED_REASON_LABELS,
		subsidyApplicationInput,
		type LeaderGender,
		type SubsidyApplicationDto
	} from '../schemas';
	import { downloadApiFile } from './download';

	let { actionId, canEdit }: { actionId: string; canEdit: boolean } = $props();

	const url = $derived(`/modules/actions/actions/${actionId}/subsidy-application`);

	let dto = $state<SubsidyApplicationDto | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let busy = $state(false);
	let downloading = $state(false);
	let errors = $state<Record<string, string>>({});

	// Entwurf
	let freizeitArt = $state('');
	let topic = $state('');
	let inclusion = $state(false);
	let genders = $state<Record<string, LeaderGender | 'none'>>({});

	function adopt(d: SubsidyApplicationDto) {
		dto = d;
		freizeitArt = d.freizeitArt;
		topic = d.topic;
		inclusion = d.inclusion;
		genders = Object.fromEntries(d.team.map((t) => [t.participantId, t.gender ?? 'none']));
	}

	async function load() {
		loading = true;
		try {
			adopt(await apiFetch<SubsidyApplicationDto>(url));
			loadError = '';
		} catch (e) {
			loadError =
				e instanceof ApiClientError ? e.message : 'Zuschussantrag konnte nicht geladen werden';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void actionId;
		void load();
	});

	const dirty = $derived(
		!!dto &&
			(freizeitArt !== dto.freizeitArt ||
				topic !== dto.topic ||
				inclusion !== dto.inclusion ||
				dto.team.some((t) => (t.gender ?? 'none') !== genders[t.participantId]))
	);

	const genderOptions = [
		{ value: 'female', label: 'weiblich' },
		{ value: 'male', label: 'männlich' },
		{ value: 'none', label: 'keine Leitung' }
	] as const;

	async function save() {
		if (!dto) return;
		const body = {
			freizeitArt,
			topic,
			inclusion,
			leaders: dto.team.map((t) => {
				const g = genders[t.participantId];
				return { participantId: t.participantId, gender: g && g !== 'none' ? g : null };
			})
		};
		const parsed = subsidyApplicationInput.safeParse(body);
		if (!parsed.success) {
			errors = Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]));
			return;
		}
		errors = {};
		busy = true;
		try {
			adopt(
				await apiFetch<SubsidyApplicationDto>(url, {
					method: 'PUT',
					body: JSON.stringify(parsed.data)
				})
			);
			toast.success('Zuschussantrag gespeichert');
		} catch (e) {
			if (e instanceof ApiClientError && e.details && typeof e.details === 'object') {
				errors = e.details as Record<string, string>;
			}
			toast.error(e instanceof ApiClientError ? e.message : 'Speichern fehlgeschlagen');
		} finally {
			busy = false;
		}
	}

	async function download() {
		downloading = true;
		try {
			await downloadApiFile(`${url}.pdf`, 'Zuschussantrag.pdf');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'PDF konnte nicht erstellt werden');
		} finally {
			downloading = false;
		}
	}

	const plan = $derived(dto?.plan ?? null);
	const missingApplicant = $derived(
		dto ? [!dto.parish && 'Gemeinde', !dto.bank.iban && 'Bankverbindung'].filter(Boolean) : []
	);
	const subsidyTotal = $derived(plan ? plan.forms.reduce((s, f) => s + f.subsidyCents, 0) : 0);
	const allowanceTotal = $derived(plan ? plan.forms.reduce((s, f) => s + f.allowanceCents, 0) : 0);
	const left = $derived(plan ? plan.unassigned.filter((u) => u.reason !== 'allowance-limit') : []);
	const noAllowance = $derived(
		plan ? plan.unassigned.filter((u) => u.reason === 'allowance-limit') : []
	);
	const names = (list: { name: string }[]) => list.map((p) => p.name).join(', ') || '–';
</script>

{#if loading && !dto}
	<LoadingState label="Zuschussantrag wird geladen" rows={4} />
{:else if loadError && !dto}
	<ErrorState message={loadError} onretry={load} busy={loading} />
{:else if dto && plan}
	<div class="space-y-4">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<p class="max-w-2xl text-sm text-muted-foreground">
				Erzeugt das Formular „Antrag und Abrechnung – Zuschüsse für Freizeiten und Fahrten“ des
				Landesjugendpfarramts fertig ausgefüllt. Je Antrag passen 20 Kinder, 20 Jugendliche (inkl.
				Team) und 5 Taschengeld-Zeilen; jeder Antrag braucht eine weibliche und eine männliche
				Leitung.
			</p>
			<Button onclick={download} disabled={downloading || dirty}>
				<FileDown />
				{downloading
					? 'Erstellt …'
					: plan.forms.length > 1
						? `${plan.forms.length} Anträge als PDF`
						: 'Antrag als PDF'}
			</Button>
		</div>
		{#if dirty}
			<p class="text-xs text-muted-foreground" role="status">
				Bitte zuerst speichern – das PDF nutzt die gespeicherten Angaben.
			</p>
		{/if}

		{#if missingApplicant.length}
			<Alert variant="warning">
				Im Antrag fehlt: {missingApplicant.join(' und ')}. Bitte unter Administration ›
				Einstellungen › Module bei „Aktionen“ ergänzen (die Bankverbindung kommt bei aktiver Kasse
				aus deren Einstellungen).
			</Alert>
		{/if}

		<div class="grid gap-4 lg:grid-cols-2">
			<Card.Root>
				<Card.Header>
					<Card.Title level={3}>Angaben zur Freizeit</Card.Title>
					<Card.Description>
						{formatDateDe(dto.action.startsOn)}{dto.action.endsOn
							? ` – ${formatDateDe(dto.action.endsOn)}`
							: ''}{dto.action.location ? ` · ${dto.action.location}` : ''}
						{dto.parish ? ` · Gemeinde: ${dto.parish}` : ''}
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<FormField
						label="Art der Freizeit"
						id="sa-art"
						hint="z. B. Sommerlager, Wochenendfahrt"
						error={errors.freizeitArt}
					>
						<Input id="sa-art" bind:value={freizeitArt} maxlength={80} disabled={!canEdit} />
					</FormField>
					<FormField label="Thema der Freizeit" id="sa-topic" error={errors.topic}>
						<Input id="sa-topic" bind:value={topic} maxlength={150} disabled={!canEdit} />
					</FormField>
					<div class="flex items-start gap-2">
						<Checkbox
							id="sa-inclusion"
							checked={inclusion}
							onCheckedChange={(v) => (inclusion = v === true)}
							disabled={!canEdit}
							class="mt-0.5"
						/>
						<Label for="sa-inclusion" class="leading-snug font-normal">
							Beratung und Bewilligung von Assistenzleistungen durch die Fachstelle Inklusion liegt
							vor
						</Label>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title level={3}>Leitungsteam</Card.Title>
					<Card.Description>
						Nur für den Antrag: Wer leitet als weibliche bzw. männliche Leitung? Team bis 27 steht
						zusätzlich in der Jugendliste.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					{#if dto.team.length === 0}
						<p class="text-sm text-muted-foreground">
							Noch kein Team eingetragen. Lege im Tab „Teilnehmende“ Personen mit der Rolle „Team“
							an.
						</p>
					{:else}
						<ul class="divide-y">
							{#each dto.team as member (member.participantId)}
								<li class="space-y-2 py-3">
									<div class="flex flex-wrap items-baseline justify-between gap-x-3">
										<p class="text-sm font-medium break-words">{member.name}</p>
										<p class="text-xs text-muted-foreground">
											{member.age != null
												? `${member.age} Jahre`
												: 'Alter unbekannt'}{member.juleica ? ' · Juleica' : ''}
										</p>
									</div>
									<SegmentedSlider
										label={`Leitung ${member.name}`}
										options={[...genderOptions]}
										class="w-full"
										value={genders[member.participantId] ?? 'none'}
										disabled={!canEdit}
										onchange={(v) => (genders[member.participantId] = v as LeaderGender | 'none')}
									/>
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>

		{#if canEdit}
			<div class="flex justify-end">
				<Button onclick={save} disabled={busy || !dirty}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</div>
		{/if}

		{#each plan.warnings as warning (warning)}
			<Alert variant="warning">{warning}</Alert>
		{/each}

		<section class="space-y-3" aria-labelledby="sa-preview">
			<div class="flex flex-wrap items-baseline justify-between gap-2">
				<h3 id="sa-preview" class="text-section">
					{plan.forms.length === 1 ? 'Ein Antrag' : `${plan.forms.length} Anträge`}
				</h3>
				<p class="text-sm text-muted-foreground tabular-nums">
					Zuschuss laut Richtlinie {formatEuro(subsidyTotal)} · Taschengeld {formatEuro(
						allowanceTotal
					)}
				</p>
			</div>
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each plan.forms as form (form.number)}
					<Card.Root>
						<Card.Header>
							<Card.Title level={4}>Antrag {form.number}</Card.Title>
							<Card.Description class="tabular-nums">
								{form.children.length} Kinder · {form.youth.length} Jugendliche · {form.nights} Nächte
							</Card.Description>
						</Card.Header>
						<Card.Content class="space-y-2 text-sm">
							<p>
								<span class="text-muted-foreground">weiblich:</span>
								{names(form.femaleLeaders)}
							</p>
							<p><span class="text-muted-foreground">männlich:</span> {names(form.maleLeaders)}</p>
							<p>
								<span class="text-muted-foreground">Taschengeld:</span>
								{form.allowance.length
									? form.allowance.map((a) => `${a.name} (${formatEuro(a.totalCents)})`).join(', ')
									: '–'}
							</p>
							<p class="tabular-nums">
								<span class="text-muted-foreground">Zuschuss:</span>
								{formatEuro(form.subsidyCents)}
							</p>
						</Card.Content>
					</Card.Root>
				{/each}
			</div>
			<p class="text-xs text-muted-foreground">
				Beträge nur zur Orientierung – im Formular trägt das Landesjugendpfarramt sie selbst ein.
				Unterschriften, Stempel und „Bremen, den“ bleiben frei.
			</p>
		</section>

		{#if left.length}
			<Card.Root>
				<Card.Header>
					<Card.Title level={3}>Nicht berücksichtigt</Card.Title>
					<Card.Description>
						{left.length === 1 ? '1 Person passt' : `${left.length} Personen passen`} auf keinen Antrag.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<ul class="space-y-1 text-sm">
						{#each left as u (u.participantId)}
							<li class="flex flex-wrap items-center gap-2">
								<span class="font-medium">{u.name}</span>
								<Badge variant="warning">{UNASSIGNED_REASON_LABELS[u.reason]}</Badge>
							</li>
						{/each}
					</ul>
				</Card.Content>
			</Card.Root>
		{/if}
		{#if noAllowance.length}
			<p class="text-sm text-muted-foreground">
				<span class="font-medium text-foreground">Ohne Taschengeld:</span>
				{noAllowance.map((u) => u.name).join(', ')} – stehen auf dem Antrag, aber die Grenze von 1 Ehrenamtlichen
				je 5 Kinder bzw. 7 Jugendliche (höchstens 5 je Antrag) ist erreicht.
			</p>
		{/if}
		{#if !left.length && plan.forms.every((f) => f.children.length + f.youth.length === 0)}
			plan.forms.every((f) => f.children.length + f.youth.length === 0)}
			<EmptyState
				title="Noch niemand zuschussberechtigt"
				description="Zuschussfähig sind Teilnehmende von 0 bis 27 Jahren aus Bremen/Bremerhaven (oder ausdrücklich als berechtigt markiert)."
			/>
		{/if}
	</div>
{/if}
