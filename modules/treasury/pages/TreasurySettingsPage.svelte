<script lang="ts">
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { EmptyState, PageHeader } from '$lib/components/layout';
	import type { Account, Category } from '../schemas';
	import { BASE, errorMessage, type TreasuryPerms } from './helpers';
	import SettingsTab from './SettingsTab.svelte';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const perm = $derived<TreasuryPerms>({
		editTx: can(permissions, 'treasury.transaction.edit'),
		deleteTx: can(permissions, 'treasury.transaction.delete'),
		editInvoice: can(permissions, 'treasury.invoice.edit'),
		deleteInvoice: can(permissions, 'treasury.invoice.delete'),
		send: can(permissions, 'treasury.invoice.send'),
		report: can(permissions, 'treasury.report.view'),
		accounts: can(permissions, 'treasury.account.manage'),
		settings: can(permissions, 'treasury.settings.manage'),
		upload: can(permissions, 'treasury.storage.write'),
		payable: can(permissions, 'treasury.payable.edit'),
		bank: can(permissions, 'treasury.bank.view')
	});

	let accounts = $state<Account[]>([]);
	let categories = $state<Category[]>([]);
	let loading = $state(true);
	let version = $state(0);

	async function load() {
		try {
			[accounts, categories] = await Promise.all([
				apiFetch<Account[]>(`${BASE}/accounts`),
				apiFetch<Category[]>(`${BASE}/categories`)
			]);
		} catch (e) {
			toast.error(errorMessage(e, 'Einstellungen konnten nicht geladen werden'));
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void load();
	});

	async function changed() {
		version++;
		await load();
	}
</script>

<div class="space-y-6">
	<a
		href="/modules/treasury"
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" /> Zur Kasse
	</a>
	<PageHeader
		title="Kasse – Einstellungen"
		description="Konten und Standardkonto, Kategorien, Kontodaten, Fristen und E-Mail-Texte."
	/>
	{#if !perm.accounts && !perm.settings}
		<EmptyState
			title="Keine Berechtigung"
			description="Für diese Seite brauchst du die Rechte „Konten verwalten“ oder „Kassen-Einstellungen“."
		/>
	{:else if loading}
		<Skeleton class="h-64 w-full" />
	{:else}
		<SettingsTab
			{accounts}
			{categories}
			actions={[]}
			members={[]}
			payers={[]}
			{perm}
			{version}
			onchanged={changed}
		/>
	{/if}
</div>
