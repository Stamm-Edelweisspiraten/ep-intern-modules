<script lang="ts">
	// Etiketten: Layouts, Formate und Leer-Etiketten (Gestaltung im Designer `labels/:id`).
	import { PageHeader } from '$lib/components/layout';
	import MaterialNav from './MaterialNav.svelte';
	import LabelsTab from './labels/LabelsTab.svelte';
</script>

<PageHeader
	title="Etiketten"
	description="Layouts für Kisten, Zeltbahnen, Regalfächer und Lagerorte – gedruckt auf A4-Bögen oder am Etikettendrucker."
/>
<MaterialNav />
<LabelsTab />
