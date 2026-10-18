import { defineModule } from '$lib/sdk/server';

/** Platzhalter: Datei-Cloud (Ablage, Freigaben, Links) – Umfang siehe `pages/FilesPage.svelte` */
export default defineModule({
	manifest: {
		id: 'files',
		name: 'Dateien',
		description: 'Cloud-Ablage mit Freigaben (in Planung)',
		version: '0.1.0',
		dependencies: [],
		permissions: ['files.file.view'],
		navigation: [
			{
				label: 'Dateien',
				icon: 'cloud',
				path: '/modules/files',
				permission: 'files.file.view'
			}
		]
	}
});
