import { defineModule } from '$lib/sdk/server';
import { withNoteContext } from './access';
import { assetEndpoints } from './assets.endpoints';
import { flushAll } from './doc.service';
import { liveEndpoints } from './live.endpoints';
import { noteEndpoints } from './notes.endpoints';
import { onMemberDeleted, onUserDeleted, resetAreas, resetUsers, subjectExport } from './privacy';
import { noteRefsService } from './refs.service';
import { notesSearch } from './search';
import { transferEndpoints } from './transfer.endpoints';
import { purgeExpiredTrash } from './trash.service';
import { runAutoVersions } from './versions.service';
import { versionEndpoints } from './versions.endpoints';
import { NOTIFY_NOTE_SHARED, PERM } from './schemas';
import type { NoteRefsService } from './contract';
import m0001 from './migrations/0001_init.sql?raw';

export default defineModule({
	manifest: {
		id: 'notes',
		name: 'Notizen',
		description:
			'Gemeinsame Notizen mit Unterseiten: live zusammen schreiben, Markdown, Tabellen, Bilder, eingebettete Whiteboards, Teilen und Export (Markdown, PDF, Word, HTML)',
		version: '1.0.0',
		dependencies: [],
		/** Gruppen/Mitglieder als Freigabe-Ziele, Notizen an Aktionen */
		optionalDependencies: ['members', 'actions'],
		permissions: [PERM.view, PERM.create, PERM.viewAll, PERM.editAll],
		permissionDescriptions: {
			[PERM.view]:
				'Notizen nutzen: eigene, freigegebene und über Aktionen sichtbare Notizen ansehen und – je nach Freigabe – live mitbearbeiten',
			[PERM.create]:
				'Eigene Notizen anlegen und importieren (auch für Aktionen mit Bearbeiten-Recht)',
			[PERM.viewAll]: 'Alle Notizen ansehen, auch ohne Freigabe',
			[PERM.editAll]: 'Alle Notizen bearbeiten, teilen, verschieben und löschen'
		},
		navigation: [
			{
				label: 'Notizen',
				icon: 'notebook-pen',
				path: '/modules/notes',
				permission: PERM.view,
				order: 72
			}
		]
	},
	migrations: [{ name: '0001_init', sql: m0001 }],
	search: notesSearch,
	provides: noteRefsService satisfies NoteRefsService,
	notifications: {
		types: [
			{
				key: NOTIFY_NOTE_SHARED,
				label: 'Notiz mit mir geteilt',
				description:
					'Wenn eine Notiz mit dir, deiner Gruppe, deinem Mitglied oder deiner Rolle geteilt wird.',
				digest: true,
				permission: PERM.view
			}
		]
	},
	jobs: [
		{
			id: 'versions',
			summary: 'Automatische Version geänderter Notizen speichern und Änderungen verdichten',
			schedule: 'hourly',
			run: async () => {
				const flushed = await flushAll();
				const versions = await runAutoVersions();
				return `${versions} Versionen gespeichert, ${flushed} Notizen verdichtet`;
			}
		},
		{
			id: 'purge-trash',
			summary: 'Abgelaufene Notizen im Papierkorb endgültig löschen',
			schedule: 'daily',
			run: async () => `${await purgeExpiredTrash()} Notizen endgültig gelöscht`
		}
	],
	resetAreas,
	resetUsers,
	onUserDeleted,
	onMemberDeleted,
	subjectExport,
	// Reihenfolge: erster Treffer gewinnt (feste Pfade wie `/notes/roots`, `/notes/by-action/…` vor `/notes/:id`)
	endpoints: withNoteContext([
		...transferEndpoints,
		...noteEndpoints,
		...liveEndpoints,
		...assetEndpoints,
		...versionEndpoints
	])
});
