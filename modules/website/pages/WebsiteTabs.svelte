<script lang="ts">
	import { page } from '$app/state';
	import { can } from '$lib/sdk/client';
	import { LinkTabs } from '$lib/components/layout';
	import { PERM } from '../schemas';
	import { BASE } from './helpers';

	/** Reiter des Moduls nach Recht: Blog | Banner | Häufige Fragen */
	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const tabs = $derived([
		...(can(permissions, PERM.postWrite) ? [{ label: 'Blog', href: BASE }] : []),
		...(can(permissions, PERM.contentManage)
			? [
					{ label: 'Banner', href: `${BASE}/banners` },
					{ label: 'Häufige Fragen', href: `${BASE}/faq` }
				]
			: [])
	]);
</script>

{#if tabs.length > 1}
	<LinkTabs {tabs} label="Bereiche der Website" />
{/if}
