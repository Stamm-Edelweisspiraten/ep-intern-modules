import { z } from 'zod';
import { membersAssist, PERM_AI } from './assist';
import { defineModule, type PrincipalProvider } from '$lib/sdk/server';
import type { MembersService } from './contract';
import { membersSearch } from './search';
import { membersDashboard } from './dashboard';
import { resetAreas, resetUsers } from './reset';
import { onUserDeleted } from './user-deleted';
import { addressEndpoints } from './address.endpoints';
import { fieldEndpoints } from './fields.endpoints';
import { membersService } from './fields.service';
import { messagingService } from './messaging.service';
import { documentEndpoints } from './documents.endpoints';
import { groupEndpoints } from './groups.endpoints';
import { groupImageEndpoints } from './group-image.endpoints';
import { reprocessGroupImages } from './group-image.service';
import { linkEndpoints } from './link.endpoints';
import { listMemberSheets } from './sheets.service';
import { principalsService } from './principals.service';
import { sheetEndpoints } from './sheets.endpoints';
import { memberEndpoints } from './members.endpoints';
import { ledEndpoints } from './led.endpoints';
import { syncLeaderGrants } from './leader.service';
import { websiteEndpoints } from './website.endpoints';
import { retentionEndpoints } from './retention.endpoints';
import { DEFAULT_RETENTION_YEARS, RETENTION_SETTING } from './retention.service';
import { subjectExport } from './subject-export';
import {
	LEADER_ROLE_NAME,
	LED_EDIT,
	LED_EXPORT,
	LED_VIEW,
	LINK_DEFAULT_ROLE,
	LINK_MAX_USES_DEFAULT,
	LINK_MAX_USES_SETTING,
	NOTIFY_ACCOUNT_LINKED
} from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_members_v2.sql?raw';
import m0003 from './migrations/0003_user_links.sql?raw';
import m0004 from './migrations/0004_address_fields.sql?raw';
import m0005 from './migrations/0005_member_fields.sql?raw';
import m0006 from './migrations/0006_membership.sql?raw';
import m0008 from './migrations/0008_member_mail_prefs.sql?raw';
import m0009 from './migrations/0009_group_website.sql?raw';
import m0010 from './migrations/0010_group_meeting_end.sql?raw';
import m0011 from './migrations/0011_stage_jungpfadfinder.sql?raw';
import m0012 from './migrations/0012_link_code_uses.sql?raw';
import m0013 from './migrations/0013_privacy.sql?raw';
import m0014 from './migrations/0014_link_token_hash_constraints.sql?raw';
import m0015 from './migrations/0015_leader_self_link.sql?raw';
import m0016 from './migrations/0016_leader_users.sql?raw';
import m0017 from './migrations/0017_group_age.sql?raw';
import { hashStoredLinkTokens, membersBackup } from './link-tokens';

export default defineModule({
	manifest: {
		id: 'members',
		name: 'Mitglieder & Gruppen',
		version: '1.14.0',
		dependencies: [],
		defaultRoleGrants: {
			/** Rolle „Mitglied“ (Verknüpfungs-Konten) darf die eigenen Mitglieder sehen/bearbeiten */
			[LINK_DEFAULT_ROLE]: ['members.own.view', 'members.own.edit'],
			/**
			 * Rolle „Gruppenleitung“ (automatisch über `user_role_grant`, siehe `leader.service.ts`): Mitglieder
			 * der eigenen Gruppen ansehen, bearbeiten, Dokumente verwalten, PDF-Listen erzeugen
			 */
			[LEADER_ROLE_NAME]: [
				LED_VIEW,
				LED_EDIT,
				LED_EXPORT,
				'members.storage.read',
				'members.storage.write',
				'members.storage.delete'
			]
		},
		permissions: [
			PERM_AI,
			'members.own.view',
			'members.own.edit',
			LED_VIEW,
			LED_EDIT,
			LED_EXPORT,
			'members.member.view',
			'members.member.edit',
			'members.member.delete',
			'members.group.view',
			'members.group.edit',
			'members.group.delete',
			'members.field.manage',
			'members.link.view',
			'members.link.manage',
			'members.data.export',
			'members.website.read',
			'members.storage.read',
			'members.storage.write',
			'members.storage.delete'
		],
		permissionDescriptions: {
			[PERM_AI]: 'KI-Schreibhilfe für Gruppentexte (intern und Website) nutzen',
			'members.own.view': 'Eigene verknüpfte Mitglieder im Profil ansehen',
			'members.own.edit':
				'Eigene verknüpfte Mitglieder bearbeiten: Kontakte, Zusatzfelder, Benachrichtigungen',
			[LED_VIEW]:
				'Gruppenleitung: Mitglieder der Gruppen ansehen, die man selbst leitet (inkl. Dokumente und Zusatzfelder)',
			[LED_EDIT]:
				'Gruppenleitung: Mitglieder der eigenen Gruppen bearbeiten und Dokumente verwalten (ohne Gruppenzuordnung und Mitgliedschaftsdaten)',
			[LED_EXPORT]:
				'Gruppenleitung: Mitgliedsdaten-PDF der eigenen Gruppen erzeugen (enthält Kontakt- und Gesundheitsdaten)',
			'members.member.view': 'Mitglieder ansehen, inkl. Dokumente herunterladen',
			'members.member.edit': 'Mitglieder anlegen und bearbeiten, Dokumente verwalten',
			'members.member.delete': 'Mitglieder löschen',
			'members.group.view': 'Gruppen ansehen',
			'members.group.edit': 'Gruppen anlegen und bearbeiten, inkl. Leitung und Bild',
			'members.group.delete': 'Gruppen löschen',
			'members.field.manage': 'Zusatzfelder für Mitglieder festlegen (z. B. Ernährung, Allergien)',
			'members.link.view': 'Verknüpfte Benutzerkonten und Status der Verknüpfungscodes ansehen',
			'members.link.manage': 'Verknüpfungscodes und -briefe erzeugen, Verknüpfungen lösen',
			'members.data.export':
				'Datenblätter und Teilnehmendenlisten als PDF erzeugen (enthält Kontakt- und Gesundheitsdaten)',
			'members.website.read':
				'Nur Website-Endpunkte: öffentliche Gruppen-Steckbriefe (Scope für den API-Key der Stammeswebsite)',
			'members.storage.read': 'Dateien des Mitgliedermoduls lesen (Dokumente, Gruppenbilder)',
			'members.storage.write': 'Dateien des Mitgliedermoduls hochladen',
			'members.storage.delete': 'Dateien des Mitgliedermoduls löschen'
		},
		navigation: [
			{
				label: 'Mitglieder',
				icon: 'users',
				path: '/modules/members',
				// Gruppenleitungen sehen dieselbe Seite, eingeschränkt auf ihre Gruppen
				anyPermission: ['members.member.view', LED_VIEW],
				order: 50
			},
			{
				label: 'Gruppen',
				icon: 'folder',
				path: '/modules/members/groups',
				permission: 'members.group.view',
				order: 60
			},
			// Konfigurationsseiten: in der Verwaltung (Abschnitt „Module“), nicht im Hauptmenü
			{
				label: 'Zusatzfelder',
				icon: 'settings',
				path: '/modules/members/fields',
				permission: 'members.field.manage',
				admin: true
			},
			{
				label: 'Löschfristen',
				icon: 'shield',
				path: '/modules/members/retention',
				permission: 'members.member.delete',
				admin: true
			}
		]
	},
	/** Dienste für abhängige Module (Vertrag: `contract.ts`, Abruf: `core.modules.use`) */
	provides: {
		...membersService,
		listMemberSheets,
		...principalsService,
		...messagingService
	} satisfies MembersService & PrincipalProvider,
	settings: [
		{
			key: 'members.address.openPlzUrl',
			label: 'Adress-Autovervollständigung (OpenPLZ-URL)',
			description:
				'Basis-URL der OpenPLZ API (amtliches Straßenverzeichnis Deutschland, schnell). Datenschutz: Beim Tippen gehen Straßenname und ggf. PLZ (ohne Personennamen) vom Server an diesen externen Dienst; er sieht nur die Server-Adresse. Leer = aus (keine Übermittlung).',
			schema: z.union([z.literal(''), z.string().url().max(300)]),
			default: 'https://openplzapi.org'
		},
		{
			key: 'members.address.photonUrl',
			label: 'Adress-Autovervollständigung (Photon-URL, Ersatz)',
			description:
				'Basis-URL eines Photon-Dienstes (OpenStreetMap, öffentlich: Komoot). Wird nur gefragt, wenn das Straßenverzeichnis nichts findet oder das Land nicht Deutschland ist (öffentlicher Dienst ist langsam). Datenschutz: Die eingegebene Anschrift (ohne Personennamen) geht an diesen externen Dienst. Leer = aus (keine Übermittlung).',
			schema: z.union([z.literal(''), z.string().url().max(300)]),
			default: 'https://photon.komoot.io'
		},
		{
			key: LINK_MAX_USES_SETTING,
			label: 'Verknüpfungsbrief: Konten je Code',
			description:
				'Wie viele Konten sich mit einem Brief (Code) verknüpfen lassen, z. B. 2 = beide Elternteile. Danach ist ein neuer Brief nötig. Gilt für neu erzeugte Codes.',
			schema: z.number().int().min(1).max(10),
			default: LINK_MAX_USES_DEFAULT
		},
		{
			key: RETENTION_SETTING,
			label: 'Löschfrist nach Austritt (Jahre)',
			description:
				'Ehemalige Mitglieder, deren Austritt länger zurückliegt, erscheinen unter „Löschfristen“ als Vorschlag zum Anonymisieren (keine automatische Löschung).',
			schema: z.number().int().min(1).max(30),
			default: DEFAULT_RETENTION_YEARS
		}
	],
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_members_v2', sql: m0002 },
		{ name: '0003_user_links', sql: m0003 },
		{ name: '0004_address_fields', sql: m0004 },
		{ name: '0005_member_fields', sql: m0005 },
		{ name: '0006_membership', sql: m0006 },
		{ name: '0008_member_mail_prefs', sql: m0008 },
		{ name: '0009_group_website', sql: m0009 },
		{ name: '0010_group_meeting_end', sql: m0010 },
		{ name: '0011_stage_jungpfadfinder', sql: m0011 },
		{ name: '0012_link_code_uses', sql: m0012 },
		{ name: '0013_privacy', sql: m0013 },
		{ name: '0014_link_token_hash_constraints', sql: m0014 },
		{ name: '0015_leader_self_link', sql: m0015 },
		{ name: '0016_leader_users', sql: m0016 },
		{ name: '0017_group_age', sql: m0017 }
	],
	assist: membersAssist,
	search: membersSearch,
	/** Übersicht: Gruppenstunden im Wochenstreifen (eigene Mitglieder, Gruppenleitung) */
	dashboard: membersDashboard,
	notifications: {
		types: [
			{
				key: NOTIFY_ACCOUNT_LINKED,
				label: 'Weiteres Konto mit meinem Mitglied verknüpft',
				description:
					'Sicherheitshinweis, wenn jemand anderes ein Mitglied mit seinem Konto verknüpft.',
				mandatory: true,
				permission: 'members.own.view'
			}
		]
	},
	jobs: [
		{
			id: 'reprocess-group-images',
			summary: 'Vorhandene Gruppenbilder bereinigen (EXIF/GPS entfernen, WebP)',
			schedule: 'hourly',
			run: reprocessGroupImages
		},
		{
			id: 'sync-leader-grants',
			summary: 'Rolle „Gruppenleitung“ abgleichen (Konten der Gruppenleitungen, Austritte)',
			schedule: 'hourly',
			run: async () => {
				const { users } = await syncLeaderGrants();
				return `${users} Konten mit Rolle „${LEADER_ROLE_NAME}“`;
			}
		},
		{
			id: 'hash-link-tokens',
			summary: 'Verknüpfungs-Token nur noch als Hash speichern (Altbestand)',
			schedule: 'hourly',
			run: async () => {
				const { updated } = await hashStoredLinkTokens();
				return `${updated} Verknüpfungscodes umgestellt`;
			}
		}
	],
	onEnable: async () => {
		await hashStoredLinkTokens();
		await syncLeaderGrants();
	},
	/** Datensicherung: `token_hash` der Verknüpfungscodes mit dem Schlüssel des Zielservers neu berechnen */
	backup: membersBackup,
	resetAreas,
	resetUsers,
	onUserDeleted,
	subjectExport,
	endpoints: [
		// Website-Endpunkte (Scope `members.website.read`) zuerst: feste Pfade vor `:id`-Pfaden
		...websiteEndpoints,
		// Vor `memberEndpoints`: `GET /members/sheet-columns` darf nicht von `/members/:id` abgefangen werden
		...sheetEndpoints,
		...memberEndpoints,
		// Gruppenleitung (`/led/…`, eigene Rechte `members.led-member.*`, Bereich = geleitete Gruppen)
		...ledEndpoints,
		...addressEndpoints,
		...fieldEndpoints,
		...linkEndpoints,
		...groupEndpoints,
		...groupImageEndpoints,
		...documentEndpoints,
		...retentionEndpoints
	]
});
