<script lang="ts">
	import { LinkTabs } from '$lib/components/layout';
	import { BASE } from './helpers';

	/** Reiter des Moduls: Posteingang | Gesendet */
	const tabs = [
		{ label: 'Posteingang', href: BASE },
		{ label: 'Gesendet', href: `${BASE}/sent` }
	];
</script>

<LinkTabs {tabs} label="Bereiche der Nachrichten" />
