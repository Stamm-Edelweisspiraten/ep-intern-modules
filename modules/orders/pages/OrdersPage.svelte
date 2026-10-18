<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { PageHeader } from '$lib/components/layout';

	const points = [
		'Mitglieder bestellen interne Artikel wie Halstuch, Liederbuch oder Abzeichen',
		'Zuständige Personen pflegen das Lager (Artikel, Preise, Bestände) und verwalten die Bestellungen',
		'Eine Rechnung geht an das zugeordnete Mitglied (Konto-Verknüpfung, Mail)',
		'Die Zahlung läuft über die Kasse: Rechnung, Zuordnung der Zahlung, Erinnerungen'
	];
</script>

<PageHeader
	title="Bestellungen"
	description="Interne Artikel des Stammes bestellen, zum Beispiel Halstuch oder Liederbuch."
/>

<Card.Root class="max-w-2xl">
	<Card.Header>
		<Card.Title>In Planung</Card.Title>
		<Card.Description>Dieses Modul ist noch nicht umgesetzt. Geplant ist:</Card.Description>
	</Card.Header>
	<Card.Content>
		<ul class="list-disc space-y-1.5 pl-5 text-sm">
			{#each points as point (point)}
				<li>{point}</li>
			{/each}
		</ul>
	</Card.Content>
</Card.Root>
