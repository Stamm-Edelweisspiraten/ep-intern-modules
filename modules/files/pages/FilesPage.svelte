<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { PageHeader } from '$lib/components/layout';

	const points = [
		'Eigene Ablage („Meine Dateien“) und gemeinsame Stammesordner mit Ordnern, Upload und Download',
		'Freigabe an Benutzer*innen (Lesen oder Bearbeiten), pro Ordner oder Datei',
		'Freigabe per Link mit Ablaufdatum und optionalem Passwort, jederzeit widerrufbar',
		'Speicherplatz pro Person und ein Papierkorb, damit nichts versehentlich verloren geht'
	];
</script>

<PageHeader
	title="Dateien"
	description="Eine kleine Cloud für den Stamm: Dateien ablegen, ordnen und freigeben."
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
