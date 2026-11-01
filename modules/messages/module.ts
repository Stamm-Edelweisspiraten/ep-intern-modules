import { z } from 'zod';
import { NOTIFY_NEW, NOTIFY_REPLIED, notificationScopesFor } from './inbox-notify.service';
import { defineModule, manifestFromPackage } from '$lib/sdk/server';
import pkg from './atrium-module.json';
import { contactEndpoints } from './contact.endpoints';
import { cleanup, resumeDeliveries } from './delivery.service';
import { cleanupInbox, loadInboxConfig, pollInbox } from './inbound.service';
import { inboxEndpoints } from './inbox.endpoints';
import { unreadTotal } from './inbox.service';
import { messageEndpoints } from './messages.endpoints';
import { mailboxAdminEndpoints } from './mailboxes-admin.endpoints';
import { onMemberDeleted, onUserDeleted, subjectExport } from './privacy';
import { isValidDomain } from './sender';
import { messagesAssist } from './assist';
import {
	INBOX_RETENTION_DEFAULT,
	INBOX_SETTING_KEYS,
	MAX_RECIPIENTS_DEFAULT,
	MAX_RECIPIENTS_LIMIT,
	PERM_AI,
	PERM_INBOX_MANAGE,
	PERM_INBOX_STAMM,
	PERM_MAILBOX_MANAGE,
	PERM_SEND,
	PERM_SETTINGS,
	PERM_VIEW_ALL,
	PERM_WEBSITE_CONTACT,
	LAYOUTS,
	REPLY_TO_MODES,
	SETTING_KEYS
} from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_layout.sql?raw';
import m0003 from './migrations/0003_inbox.sql?raw';
import m0004 from './migrations/0004_inbox_folders.sql?raw';
import m0005 from './migrations/0005_spam.sql?raw';
import m0006 from './migrations/0006_extra_mailboxes.sql?raw';

/** IMAP-Ordnername: druckbar, ohne Steuerzeichen und Platzhalter */
const folderName = z
	.string()
	.trim()
	.min(1)
	.max(100)
	// eslint-disable-next-line no-control-regex
	.regex(/^[^\u0000-\u001f\u007f*%"\\]+$/, 'Ungültiger Ordnername');

export default defineModule({
	package: pkg,
	manifest: {
		// Kennung, Name, Beschreibung, Version, Abhängigkeiten: atrium-module.json
		...manifestFromPackage(pkg),
		permissions: [
			PERM_SEND,
			PERM_VIEW_ALL,
			PERM_SETTINGS,
			PERM_INBOX_STAMM,
			PERM_INBOX_MANAGE,
			PERM_WEBSITE_CONTACT,
			PERM_MAILBOX_MANAGE,
			PERM_AI
		],
		permissionDescriptions: {
			[PERM_SEND]:
				'Nachrichten an Mitglieder und Gruppen senden (Gruppenleitungen nur an die Mitglieder ihrer Gruppen), die eigenen gesendeten Nachrichten ansehen und die Postfächer der eigenen Absenderadressen lesen (persönlich, Ämter, geleitete Gruppen)',
			[PERM_VIEW_ALL]: 'Die gesendeten Nachrichten aller Personen mit Empfängerstatus ansehen',
			[PERM_SETTINGS]:
				'Einstellungen der Nachrichten ändern (Domain für persönliche Absenderadressen, Antwortadresse, Empfängerlimit, IMAP-Zugang des Posteingangs)',
			[PERM_INBOX_STAMM]:
				'Das Postfach der Stamm-Adresse lesen und daraus antworten (zusätzlich zum Senden-Recht)',
			[PERM_INBOX_MANAGE]:
				'Nicht zugeordnete Mails des Posteingangs sehen, einem Postfach zuordnen oder löschen und den Abruf auslösen',
			[PERM_WEBSITE_CONTACT]:
				'Nur Website-Endpunkte: Anfragen aus dem Kontakt- und dem Probestunden-Formular der Stammeswebsite in den Posteingang legen (Scope für den API-Key der Website)',
			[PERM_MAILBOX_MANAGE]:
				'Zusätzliche Postfächer (z. B. für ein Lager) anlegen, ändern, löschen und an Benutzer*innen, Mitglieder oder Gruppen freigeben sowie Weiterleitungen weiterer Adressen in bestehende Postfächer verwalten',
			[PERM_AI]:
				'KI-Schreibhilfe beim Verfassen von Nachrichten nutzen (Entwürfe, Umformulieren, Betreff, Antwortentwürfe)'
		},
		// Gruppenleitungen lesen das Postfach ihrer Gruppe – dafür brauchen sie das Senden-Recht
		defaultRoleGrants: { Gruppenleitung: [PERM_SEND] },
		navigation: [
			{
				label: 'Nachrichten',
				icon: 'mail',
				path: '/modules/messages',
				permission: PERM_SEND,
				order: 70
			},
			{
				label: 'Postfächer',
				icon: 'mail',
				path: '/modules/messages/admin',
				permission: PERM_MAILBOX_MANAGE,
				admin: true
			}
		]
	},
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_layout', sql: m0002 },
		{ name: '0003_inbox', sql: m0003 },
		{ name: '0004_inbox_folders', sql: m0004 },
		{ name: '0005_spam', sql: m0005 },
		{ name: '0006_extra_mailboxes', sql: m0006 }
	],
	settings: [
		{
			key: SETTING_KEYS.domain,
			label: 'Nachrichten: Domain der persönlichen Absenderadressen',
			description:
				'Aus Vorname und Nachname wird vorname.nachname@domain gebildet (bei mehreren Vornamen zählt nur der erste). Der Mailserver muss das Senden als diese Adressen erlauben. Leer = keine persönlichen Adressen.',
			schema: z.union([
				z.literal(''),
				z
					.string()
					.trim()
					.toLowerCase()
					.refine(isValidDomain, 'Bitte eine Domain wie beispiel.de eingeben')
			]),
			default: ''
		},
		{
			key: SETTING_KEYS.personalEnabled,
			label: 'Nachrichten: Persönliche Absenderadresse anbieten',
			schema: z.boolean(),
			default: true
		},
		{
			key: SETTING_KEYS.replyTo,
			label: 'Nachrichten: Antworten gehen standardmäßig an',
			description:
				'„account“ = E-Mail-Adresse des eigenen Kontos, „sender“ = die gewählte Absenderadresse. Im Formular änderbar. Ist der Posteingang eingeschaltet, gehen Antworten immer an die Absenderadresse (sie landen dann im passenden Postfach).',
			schema: z.enum(REPLY_TO_MODES),
			default: 'account'
		},
		{
			key: SETTING_KEYS.layout,
			label: 'Nachrichten: Standard-Aussehen',
			description:
				'„stamm“ = Stamm-Layout mit Kopf, Signatur und Fußzeile, „plain“ = einfache Mail wie aus einem Mailprogramm (wenig Spam-Punkte). Beim Senden wählbar.',
			schema: z.enum(LAYOUTS),
			default: 'stamm'
		},
		{
			key: SETTING_KEYS.maxRecipients,
			label: 'Nachrichten: Höchstzahl Empfänger je Nachricht',
			schema: z.number().int().min(1).max(MAX_RECIPIENTS_LIMIT),
			default: MAX_RECIPIENTS_DEFAULT
		},
		{
			key: INBOX_SETTING_KEYS.enabled,
			label: 'Posteingang: Catch-all-Postfach abrufen',
			description:
				'Ruft jede Minute alle Mails aus dem Catch-all-Postfach ab und ordnet sie den persönlichen, Amts-, Gruppen- und Stamm-Postfächern zu. Übernommene Mails werden auf dem Server in den Ablageordner verschoben.',
			schema: z.boolean(),
			default: false
		},
		{
			key: INBOX_SETTING_KEYS.host,
			label: 'Posteingang: IMAP-Server',
			description: 'Hostname des Mailservers, z. B. imap.beispiel.de',
			schema: z
				.string()
				.trim()
				.max(255)
				.regex(/^$|^[a-zA-Z0-9.-]+$/, 'Bitte nur den Hostnamen eingeben (ohne Protokoll)'),
			default: ''
		},
		{
			key: INBOX_SETTING_KEYS.port,
			label: 'Posteingang: IMAP-Port',
			schema: z.coerce.number().int().min(1).max(65535),
			default: 993
		},
		{
			key: INBOX_SETTING_KEYS.secure,
			label: 'Posteingang: TLS direkt (Port 993)',
			description: 'Aus = STARTTLS (Port 143), falls der Server es anbietet.',
			schema: z.boolean(),
			default: true
		},
		{
			key: INBOX_SETTING_KEYS.user,
			label: 'Posteingang: IMAP-Benutzer',
			schema: z.string().trim().max(254),
			default: ''
		},
		{
			key: INBOX_SETTING_KEYS.password,
			label: 'Posteingang: IMAP-Passwort',
			description:
				'Wird verschlüsselt gespeichert und nie angezeigt. Ändert sich Server, Port oder Benutzer, wird es verworfen.',
			schema: z.string().max(500),
			secret: true,
			secretBoundTo: [INBOX_SETTING_KEYS.host, INBOX_SETTING_KEYS.port, INBOX_SETTING_KEYS.user]
		},
		{
			key: INBOX_SETTING_KEYS.folder,
			label: 'Posteingang: Ordner mit neuen Mails',
			schema: folderName,
			default: 'INBOX'
		},
		{
			key: INBOX_SETTING_KEYS.processedFolder,
			label: 'Posteingang: Ablageordner nach dem Import',
			description: 'Wird bei Bedarf angelegt. Die Mails bleiben dort als Sicherung liegen.',
			schema: folderName,
			default: 'Importiert'
		},
		{
			key: INBOX_SETTING_KEYS.retentionDays,
			label: 'Posteingang: Aufbewahrung in Tagen',
			description:
				'Danach werden Mails samt Anhängen im Posteingang gelöscht (nicht im Ablageordner des Mailservers). Nicht zugeordnete Mails und der Papierkorb werden nach 30 Tagen gelöscht.',
			schema: z.coerce.number().int().min(30).max(3650),
			default: INBOX_RETENTION_DEFAULT
		},
		{
			key: INBOX_SETTING_KEYS.spamFilter,
			label: 'Posteingang: eigene Spam-Erkennung',
			description:
				'Prüft eingehende Mails zusätzlich zum Mailserver (gefälschte Absender, gefährliche Anhänge, irreführende Links, Massenversand …). Bekannte Absender (Mitglieder, Konten, schon angeschriebene Adressen) gelten nie als Spam. Sperr- und Vertrauensliste gelten immer.',
			schema: z.boolean(),
			default: true
		}
	],
	notifications: {
		types: [
			{
				key: NOTIFY_NEW,
				label: 'Neue Nachricht im Posteingang',
				scoped: true
			},
			{
				key: NOTIFY_REPLIED,
				label: 'Antwort aus einem gemeinsamen Postfach',
				scoped: true
			}
		],
		forUser: notificationScopesFor
	},
	jobs: [
		{
			id: 'resume',
			summary: 'Unterbrochene Nachrichten-Versände fortsetzen',
			schedule: 'hourly',
			run: (ctx) => resumeDeliveries(ctx)
		},
		{
			id: 'inbox-poll',
			summary: 'Catch-all-Postfach abrufen und Mails den Postfächern zuordnen',
			schedule: { everyMinutes: 1 },
			run: async (ctx) => {
				if (!(await loadInboxConfig()).enabled) return 'Posteingang ist ausgeschaltet';
				return (await pollInbox(ctx)).message;
			}
		},
		{
			id: 'cleanup',
			summary: 'Alte Nachrichten, Anhänge und Mails im Posteingang löschen (Aufbewahrung)',
			schedule: 'daily',
			run: async () => `${await cleanup()}; ${await cleanupInbox()}`
		}
	],
	/** Ungelesene Mails der eigenen Postfächer am Eintrag „Nachrichten“ der Seitenleiste */
	navBadge: { count: unreadTotal },
	assist: messagesAssist,
	onUserDeleted,
	onMemberDeleted,
	subjectExport,
	endpoints: [...contactEndpoints, ...mailboxAdminEndpoints, ...messageEndpoints, ...inboxEndpoints]
});
