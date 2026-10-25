/**
 * API-Vertrag des Moduls `messages` (Nachrichten): Zod-Eingaben, DTO-Typen und Konstanten –
 * von Server und Oberfläche genutzt.
 */
import { z } from 'zod';
import { MAILBOX_KEY_PATTERN, type MailboxKind } from './mailbox';

export const MODULE_ID = 'messages';
export const BASE_PATH = '/modules/messages';

export const PERM_SEND = 'messages.message.send';
export const PERM_VIEW_ALL = 'messages.message.view-all';
export const PERM_SETTINGS = 'messages.settings.manage';
/** Postfach der Stamm-Adresse lesen und daraus antworten */
export const PERM_INBOX_STAMM = 'messages.inbox.stamm';
/** Nicht zugeordnete Mails sehen/zuordnen/löschen, Abruf auslösen und testen */
export const PERM_INBOX_MANAGE = 'messages.inbox.manage';
/** Nur Website-Endpunkt Kontaktformular – Scope für den API-Key der Stammeswebsite */
export const PERM_WEBSITE_CONTACT = 'messages.website.contact';

/** Kontaktformular der Website (`POST /website/contact`): Grenzen wie auf der Website */
export const CONTACT_LIMITS = { name: 100, email: 254, phone: 40, message: 5000 } as const;
// eslint-disable-next-line no-control-regex
const ONE_LINE = /^[^\u0000-\u001f\u007f]*$/;

export const contactInput = z
	.object({
		name: z.string().trim().min(1).max(CONTACT_LIMITS.name).regex(ONE_LINE, 'Ungültige Zeichen'),
		email: z.email().max(CONTACT_LIMITS.email).toLowerCase(),
		phone: z
			.string()
			.trim()
			.max(CONTACT_LIMITS.phone)
			.regex(/^[0-9+()/ .-]*$/, 'Ungültige Telefonnummer')
			.optional()
			.default(''),
		message: z.string().trim().min(1).max(CONTACT_LIMITS.message),
		pow: z
			.object({
				salt: z.string().max(64),
				challenge: z.string().max(64),
				number: z.number().int().min(0),
				signature: z.string().max(128)
			})
			.strict()
	})
	.strict();
export type ContactInput = z.infer<typeof contactInput>;

/** Probestunden-Formular der Website (`POST /website/trial`): Grenzen wie auf der Website */
export const TRIAL_LIMITS = { childName: 100, ageMin: 3, ageMax: 30, message: 2000 } as const;

export const trialInput = z
	.object({
		childName: z
			.string()
			.trim()
			.min(1)
			.max(TRIAL_LIMITS.childName)
			.regex(ONE_LINE, 'Ungültige Zeichen'),
		childAge: z.number().int().min(TRIAL_LIMITS.ageMin).max(TRIAL_LIMITS.ageMax),
		name: contactInput.shape.name,
		email: contactInput.shape.email,
		phone: z
			.string()
			.trim()
			.min(1)
			.max(CONTACT_LIMITS.phone)
			.regex(/^[0-9+()/ .-]*$/, 'Ungültige Telefonnummer'),
		message: z.string().trim().max(TRIAL_LIMITS.message).optional().default(''),
		/** Gewählte Gruppe (Slug der Website); ohne → passende Gruppe nach Alter */
		groupSlug: z
			.string()
			.trim()
			.max(100)
			.regex(/^[a-z0-9-]*$/)
			.optional()
			.default(''),
		pow: contactInput.shape.pow
	})
	.strict();
export type TrialInput = z.infer<typeof trialInput>;

export const SETTING_KEYS = {
	domain: 'messages.domain',
	personalEnabled: 'messages.personal.enabled',
	replyTo: 'messages.replyTo.default',
	layout: 'messages.layout.default',
	maxRecipients: 'messages.maxRecipients'
} as const;

/** Einstellungen des Posteingangs (IMAP-Abruf des Catch-all-Postfachs) */
export const INBOX_SETTING_KEYS = {
	enabled: 'messages.imap.enabled',
	host: 'messages.imap.host',
	port: 'messages.imap.port',
	secure: 'messages.imap.secure',
	user: 'messages.imap.user',
	password: 'messages.imap.password',
	folder: 'messages.imap.folder',
	processedFolder: 'messages.imap.processedFolder',
	retentionDays: 'messages.inbox.retentionDays',
	spamFilter: 'messages.spam.enabled'
} as const;

export const REPLY_TO_MODES = ['account', 'sender'] as const;
export type ReplyToMode = (typeof REPLY_TO_MODES)[number];
export const REPLY_TO_LABELS: Record<ReplyToMode, string> = {
	account: 'E-Mail-Adresse des eigenen Kontos',
	sender: 'Absenderadresse'
};

export const LAYOUTS = ['stamm', 'plain'] as const;
export type MessageLayout = (typeof LAYOUTS)[number];
export const LAYOUT_LABELS: Record<MessageLayout, string> = {
	stamm: 'Stamm-Layout (Kopf, Signatur, Fußzeile)',
	plain: 'Einfach (wie aus dem Mailprogramm)'
};

export const MAX_RECIPIENTS_DEFAULT = 500;
export const MAX_RECIPIENTS_LIMIT = 5000;
export const MAX_SUBJECT = 200;
export const MAX_BODY_HTML = 100_000;
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_MEMBER_IDS = 1000;
export const MAX_GROUP_IDS = 50;
/** Frei eingegebene Adressen (ohne Mitglied) je Nachricht */
export const MAX_ADDRESSES = 100;

/** Nachrichten älter als so viele Tage werden gelöscht; Anhänge schon nach `ATTACHMENT_DAYS` */
export const RETENTION_DAYS = 365;
export const ATTACHMENT_DAYS = 30;

/** Posteingang: Standard-Aufbewahrung (Tage), nicht zugeordnete Mails, Papierkorb */
export const INBOX_RETENTION_DEFAULT = 365;
export const UNASSIGNED_DAYS = 30;
export const INBOX_TRASH_DAYS = 30;
/** Spam wird nach so vielen Tagen gelöscht */
export const INBOX_SPAM_DAYS = 30;
/** Größere Mails werden nur angeschnitten übernommen (Kopf + Anfang, ohne Anhänge) */
export const INBOX_MAX_BYTES = 25 * 1024 * 1024;
/** Mails je Abruf (der Rest folgt beim nächsten Lauf) */
export const INBOX_FETCH_LIMIT = 50;
/** Länge des Inhalts in Benachrichtigungen */
export const NOTIFY_TEXT_MAX = 4000;
/** Eingebettete Bilder (cid) bis zu dieser Größe werden in der Ansicht angezeigt */
export const INLINE_IMAGE_MAX = 2 * 1024 * 1024;

const id = z.string().trim().min(1).max(100);
export const emailAddress = z
	.string()
	.trim()
	.toLowerCase()
	.max(254)
	.email('Ungültige E-Mail-Adresse');

// --- Eingaben -------------------------------------------------------------------------------

export const idParams = z.object({ id });
export const attachmentParams = z.object({ id, attachmentId: id });

export const recipientsInput = z.object({
	memberIds: z.array(id).max(MAX_MEMBER_IDS).default([]),
	groupIds: z.array(id).max(MAX_GROUP_IDS).default([]),
	/** Mitglieder, die trotz Gruppenauswahl nicht angeschrieben werden */
	excludeMemberIds: z.array(id).max(MAX_MEMBER_IDS).default([]),
	/** Frei eingegebene E-Mail-Adressen (ohne Mitglied) */
	addresses: z
		.array(emailAddress)
		.max(MAX_ADDRESSES, `Höchstens ${MAX_ADDRESSES} einzelne Adressen`)
		.default([])
});
export type RecipientsInput = z.infer<typeof recipientsInput>;

export const sendInput = recipientsInput.extend({
	/** Schlüssel eines Absenders aus `GET /senders` */
	senderKey: z.string().trim().min(1).max(200),
	/** Antwortadresse; leer = Standard der Einstellung */
	replyTo: z
		.union([z.literal(''), emailAddress])
		.optional()
		.transform((v) => (v ? v : null)),
	/** Aussehen; fehlt es, gilt die Einstellung `messages.layout.default` */
	layout: z.enum(LAYOUTS).optional(),
	subject: z
		.string()
		.trim()
		.min(1, 'Bitte einen Betreff eingeben')
		.max(MAX_SUBJECT, `Höchstens ${MAX_SUBJECT} Zeichen`)
		.refine((v) => !/[\r\n]/.test(v), 'Keine Zeilenumbrüche im Betreff'),
	bodyHtml: z
		.string()
		.min(1, 'Bitte einen Text eingeben')
		.max(MAX_BODY_HTML * 2, 'Der Text ist zu lang'),
	/** Antwort auf diese Mail aus dem Posteingang (setzt In-Reply-To/References, Verlauf) */
	replyOf: z.uuid().optional(),
	/** Weiterleitung dieser Mail aus dem Posteingang */
	forwardOf: z.uuid().optional(),
	/** Anhänge der weitergeleiteten Mail, die mitgeschickt werden */
	forwardAttachmentIds: z.array(z.uuid()).max(MAX_FILES).default([])
});
export type SendInput = z.infer<typeof sendInput>;

/** Vorschau: wie `sendInput`, aber Betreff und Text dürfen noch leer sein */
export const previewInput = z.object({
	senderKey: z.string().trim().min(1).max(200).optional(),
	layout: z.enum(LAYOUTS).optional(),
	subject: z.string().max(MAX_SUBJECT).default(''),
	bodyHtml: z
		.string()
		.max(MAX_BODY_HTML * 2, 'Der Text ist zu lang')
		.default('')
});
export type PreviewInput = z.infer<typeof previewInput>;

export const listQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(30),
	offset: z.coerce.number().int().min(0).default(0)
});

export const INBOX_FILTERS = ['all', 'unread', 'spam', 'trash'] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];
/**
 * Ansicht im Ordnerbaum eines Postfachs: Posteingang (`inbox`), ein eigener Ordner (ID), „Gesendet“
 * (von der Adresse des Postfachs), Spam, Papierkorb. Die Filterleiste kennt nur noch Alle | Ungelesen.
 */
export const INBOX_SYSTEM_VIEWS = ['inbox', 'sent', 'spam', 'trash'] as const;
export type InboxSystemView = (typeof INBOX_SYSTEM_VIEWS)[number];
export type InboxView = InboxSystemView | (string & {});

/** Ordner: höchstens so viele Ebenen, Ordner je Postfach, Mails je Sammelaktion */
export const MAX_FOLDER_DEPTH = 3;
export const MAX_FOLDERS_PER_MAILBOX = 100;
export const MAX_FOLDER_NAME = 100;
export const MAX_BULK_IDS = 200;

export const mailboxSentQuery = z.object({
	mailbox: z.string().trim().min(1).max(400),
	search: z.string().trim().max(100).default(''),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});

export const mailboxKey = z
	.string()
	.trim()
	.min(1)
	.max(400)
	.regex(MAILBOX_KEY_PATTERN, 'Unbekanntes Postfach');

export const inboxListQuery = z.object({
	mailbox: mailboxKey,
	filter: z.enum(INBOX_FILTERS).default('all'),
	/** `inbox` = Mails ohne Ordner, sonst Ordner-ID (bei Spam/Papierkorb ohne Wirkung) */
	folder: z.union([z.literal('inbox'), z.uuid()]).default('inbox'),
	search: z.string().trim().max(100).default(''),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});

export const COMPOSE_MODES = ['reply', 'reply-all', 'forward'] as const;
export type ComposeMode = (typeof COMPOSE_MODES)[number];
export const composeQuery = z.object({ mode: z.enum(COMPOSE_MODES) });

export const assignInput = z.object({ mailbox: mailboxKey });

export const folderName = z
	.string()
	.trim()
	.min(1, 'Bitte einen Namen eingeben')
	.max(MAX_FOLDER_NAME, `Höchstens ${MAX_FOLDER_NAME} Zeichen`)
	// eslint-disable-next-line no-control-regex
	.regex(/^[^\u0000-\u001f\u007f]+$/, 'Ungültige Zeichen im Namen');

export const folderCreateInput = z.object({
	mailbox: mailboxKey,
	/** Elternordner im selben Postfach; `null` = oberste Ebene */
	parentId: z.uuid().nullable().default(null),
	name: folderName
});
export type FolderCreateInput = z.infer<typeof folderCreateInput>;

export const folderUpdateInput = z
	.object({ name: folderName.optional(), parentId: z.uuid().nullable().optional() })
	.refine((v) => v.name !== undefined || v.parentId !== undefined, {
		message: 'Nichts zu ändern'
	});
export type FolderUpdateInput = z.infer<typeof folderUpdateInput>;

const mailIds = z
	.array(id)
	.min(1, 'Keine Nachricht ausgewählt')
	.max(MAX_BULK_IDS, `Höchstens ${MAX_BULK_IDS} Nachrichten auf einmal`);

export const moveMailsInput = z.object({
	ids: mailIds,
	/** Zielordner; `null` = Posteingang */
	folderId: z.uuid().nullable()
});
export type MoveMailsInput = z.infer<typeof moveMailsInput>;

export const detailsQuery = z.object({
	mailbox: mailboxKey,
	/** Ordner-ID; ohne Angabe = ganzes Postfach */
	folder: z.uuid().optional()
});

export const BULK_ACTIONS = ['read', 'unread', 'delete', 'restore'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
export const bulkInput = z.object({ ids: mailIds, action: z.enum(BULK_ACTIONS) });

/** „Spam“ / „Kein Spam“ für markierte Mails; `remember` = Absender auf die Sperr- bzw. Vertrauensliste */
export const spamMarkInput = z.object({
	ids: mailIds,
	spam: z.boolean(),
	remember: z.boolean().default(true)
});
export type SpamMarkInput = z.infer<typeof spamMarkInput>;

export const SENDER_RULE_KINDS = ['block', 'allow'] as const;
export type SenderRuleKindValue = (typeof SENDER_RULE_KINDS)[number];
export const SENDER_RULE_LABELS: Record<SenderRuleKindValue, string> = {
	block: 'Gesperrt',
	allow: 'Vertrauenswürdig'
};
export const MAX_SENDER_RULES = 2000;

export const senderRuleInput = z.object({
	kind: z.enum(SENDER_RULE_KINDS, 'Bitte „Gesperrt“ oder „Vertrauenswürdig“ wählen'),
	/** Adresse („name@example.org“) oder Domain („example.org“, „@example.org“) */
	value: z.string().trim().min(3, 'Bitte eine Adresse oder Domain eingeben').max(254, 'Zu lang'),
	note: z
		.string()
		.trim()
		.max(200, 'Höchstens 200 Zeichen')
		.nullish()
		.transform((v) => v || null)
});
export type SenderRuleInput = z.infer<typeof senderRuleInput>;

// --- DTOs -----------------------------------------------------------------------------------

export type SenderKind = 'personal' | 'office' | 'group' | 'stamm';

export interface Sender {
	/** Stabiler Schlüssel: `personal`, `stamm`, `office:<id>:<adresse>`, `group:<id>` */
	key: string;
	kind: SenderKind;
	address: string;
	/** Anzeigename im „Von“-Feld */
	name: string;
	/** Beschriftung für die Auswahl, z. B. „Kasse (kasse@…)“ */
	label: string;
}

export interface SendersResponse {
	senders: Sender[];
	/** Konto-Adresse für „Antworten an“ (leer, wenn nicht ermittelbar) */
	accountEmail: string | null;
	/** Standardwahl aus den Einstellungen */
	replyToDefault: ReplyToMode;
	/** Warum es keine persönliche Adresse gibt (z. B. Domain fehlt), sonst `null` */
	personalHint: string | null;
	/** Standard für „Aussehen“ aus den Einstellungen */
	layoutDefault: MessageLayout;
	/** Hinweis zur Zustellbarkeit (z. B. Absender-Domain ≠ Mailserver-Domain), sonst `null` */
	deliverabilityHint: string | null;
	/** Posteingang aktiv: Antworten gehen standardmäßig an die Absenderadresse */
	inboxEnabled: boolean;
}

export interface ResolvedRecipient {
	/** `null` bei frei eingegebener Adresse */
	memberId: string | null;
	name: string | null;
	address: string;
}

export interface RecipientsResult {
	recipients: ResolvedRecipient[];
	/** Anzahl der Mitglieder mit mindestens einer Adresse */
	members: number;
	/** Mitglieder ohne hinterlegte Adresse (werden nicht angeschrieben) */
	withoutEmail: { id: string; name: string }[];
	/** Ausgetretene Mitglieder, die übersprungen wurden */
	exited: number;
	/** Frei eingegebene Adressen, die nicht schon zu einem gewählten Mitglied gehören */
	external: number;
	maxRecipients: number;
}

export interface MessagePreview {
	/** Vollständiges HTML-Dokument der Mail (Bilder als `data:`-URLs) */
	html: string;
	subject: string;
	/** „Name <adresse>“ des gewählten Absenders oder `null` */
	from: string | null;
}

export type MessageStatus = 'sending' | 'done' | 'partial' | 'failed';
export type RecipientStatus = 'pending' | 'sending' | 'sent' | 'failed';

export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
	sending: 'Wird gesendet',
	done: 'Gesendet',
	partial: 'Teilweise gesendet',
	failed: 'Fehlgeschlagen'
};

export interface MessageSummary {
	id: string;
	subject: string;
	senderAddress: string;
	senderName: string | null;
	createdBy: string | null;
	createdByName: string;
	createdAt: string;
	status: MessageStatus;
	total: number;
	sent: number;
	failed: number;
	attachmentCount: number;
}

export interface MessageAttachmentInfo {
	id: string;
	filename: string;
	contentType: string;
	size: number;
	/** Datei wurde nach Ablauf der Aufbewahrung entfernt */
	removed: boolean;
}

export interface MessageRecipientInfo {
	id: string;
	name: string | null;
	address: string;
	status: RecipientStatus;
	error: string | null;
	sentAt: string | null;
}

export interface MessageDetail extends MessageSummary {
	bodyHtml: string;
	layout: MessageLayout;
	replyTo: string | null;
	/** Antwort auf / Weiterleitung von dieser Mail im Posteingang */
	replyOf: string | null;
	forwardOf: string | null;
	attachments: MessageAttachmentInfo[];
	recipients: MessageRecipientInfo[];
}

// --- Posteingang ----------------------------------------------------------------------------

export interface MailboxInfo {
	key: string;
	kind: MailboxKind;
	/** Adresse des Postfachs (leer bei „Nicht zugeordnet“) */
	address: string;
	/** Anzeigename, z. B. „Kasse“, „Persönlich“ */
	name: string;
	/** Gemeinsames Postfach (Amt, Gruppe, Stamm) */
	shared: boolean;
	/** Absender-Schlüssel zum Antworten (`null` bei „Nicht zugeordnet“) */
	senderKey: string | null;
	unread: number;
	/** Eigene Ordner des Postfachs (flach, alphabetisch; leer bei „Nicht zugeordnet“) */
	folders: InboxFolder[];
	/** Ungelesene Mails im Posteingang (ohne Ordner) */
	inboxUnread: number;
	/** Mails im Spam (nicht gelöscht) */
	spamCount: number;
}

export interface InboxFolder {
	id: string;
	parentId: string | null;
	name: string;
	/** Ungelesene Mails direkt in diesem Ordner (ohne Spam/Papierkorb) */
	unread: number;
	/** Mails direkt in diesem Ordner (ohne Spam/Papierkorb) */
	total: number;
}

/** Details zu einem Postfach oder Ordner (Rechtsklick → „Details“) */
export interface FolderDetails {
	kind: 'mailbox' | 'folder';
	/** Name des Postfachs bzw. Ordners */
	name: string;
	mailboxName: string;
	address: string;
	/** Pfad des Ordners (ohne Postfach), leer beim Postfach */
	path: string[];
	shared: boolean;
	/** Nachrichten (ohne Papierkorb/Spam; beim Ordner inkl. Unterordner) */
	messages: number;
	/** davon direkt im Ordner bzw. im Posteingang (ohne Ordner) */
	direct: number;
	unread: number;
	/** Größe der Nachrichten in Bytes (Rohgröße inkl. Anhänge) */
	size: number;
	attachments: number;
	/** Unterordner (beim Postfach: alle Ordner) */
	folders: number;
	spam: number | null;
	trash: number | null;
	oldest: string | null;
	newest: string | null;
	createdAt: string | null;
	createdByName: string | null;
	/** Personen mit Zugriff (nur gemeinsame Postfächer) */
	access: string[];
}

export interface MoveMailsResult {
	moved: number;
	/** Vorheriger Ordner je Mail (für „Rückgängig“) */
	previous: { id: string; folderId: string | null }[];
}

export interface DeleteFolderResult {
	deleted: true;
	/** Mails, die zurück in den Posteingang gingen */
	movedMessages: number;
}

export interface MailboxesResponse {
	mailboxes: MailboxInfo[];
	/** Posteingang eingerichtet (IMAP aktiv) */
	enabled: boolean;
	/** Recht für Abruf/Test/Sammelordner */
	canManage: boolean;
	/** Letzter Abruf (ISO) und dessen Ergebnis, nur mit `canManage` */
	lastPoll: { at: string | null; status: string | null; message: string | null } | null;
}

export interface InboxAddress {
	address: string;
	name: string | null;
}

export interface InboxSummary {
	id: string;
	mailboxKey: string;
	from: InboxAddress;
	subject: string;
	/** Anfang des Textes (≤ 160 Zeichen) */
	snippet: string;
	receivedAt: string;
	read: boolean;
	attachmentCount: number;
	spam: boolean;
	/** Mindestens eine Antwort aus der App */
	answered: boolean;
	deleted: boolean;
	/** Ordner der Mail; `null` = Posteingang */
	folderId: string | null;
}

export interface SpamReasonInfo {
	code: string;
	label: string;
	points: number;
}

export interface SpamMarkResult {
	/** Geänderte Mails (ausgewählte und weitere desselben Absenders in deinen Postfächern) */
	changed: number;
	/** Neu auf die Liste gesetzte Absender */
	remembered: number;
}

export interface SenderRule {
	id: string;
	kind: SenderRuleKindValue;
	matchType: 'address' | 'domain';
	pattern: string;
	note: string | null;
	origin: 'manual' | 'button';
	createdByName: string | null;
	createdAt: string;
}

export interface InboxAttachmentInfo {
	id: string;
	filename: string;
	contentType: string;
	size: number;
	inline: boolean;
}

export interface InboxReplyInfo {
	messageId: string;
	byName: string;
	at: string;
	kind: 'reply' | 'forward';
}

export interface ThreadEntry {
	id: string;
	direction: 'in' | 'out';
	from: string;
	subject: string;
	snippet: string;
	at: string;
	/** Relativer Link (Posteingang bzw. Gesendet) */
	href: string;
	current: boolean;
}

export interface InboxDetail extends InboxSummary {
	mailboxAddress: string;
	mailboxName: string;
	/** Pfad des Ordners von oben nach unten (leer = Posteingang) */
	folderPath: { id: string; name: string }[];
	to: InboxAddress[];
	cc: InboxAddress[];
	replyTo: string | null;
	/** Vollständiges, bereinigtes HTML-Dokument für `<iframe srcdoc sandbox>` */
	document: string;
	authResult: 'pass' | 'fail' | 'none';
	/** Punkte der Spam-Bewertung (`null` = vor der eigenen Erkennung importiert) */
	spamScore: number | null;
	/** Gründe der Bewertung (höchste Punkte zuerst) */
	spamReasons: SpamReasonInfo[];
	/** Wodurch die Mail Spam ist (`null` = kein Spam) */
	spamSource: 'server' | 'rules' | 'blocklist' | 'user' | null;
	truncated: boolean;
	unassignedReason: 'unknown' | 'ambiguous' | null;
	attachments: InboxAttachmentInfo[];
	/** Externe Bilder, die aus Datenschutzgründen entfernt wurden */
	blockedImages: number;
	/** Anhänge, die nicht übernommen wurden (Dateityp nicht erlaubt) */
	skippedAttachments: { filename: string; contentType: string; size: number }[];
	replies: InboxReplyInfo[];
	thread: ThreadEntry[];
	/** Antworten möglich (Absender des Postfachs verfügbar) */
	canReply: boolean;
}

export interface InboxListResponse {
	items: InboxSummary[];
	total: number;
}

/** Von der Adresse eines Postfachs gesendete Nachricht (Ansicht „Gesendet“ im Posteingang) */
export interface MailboxSentItem {
	id: string;
	subject: string;
	/** Erste Empfängeradresse */
	to: string;
	recipients: number;
	createdAt: string;
	createdByName: string;
	status: MessageStatus;
	attachmentCount: number;
}

export interface MailboxSentResponse {
	items: MailboxSentItem[];
	total: number;
}

/** Vorbelegung für „Antworten“/„Weiterleiten“ in `ComposePage` */
export interface ComposePrefill {
	mode: ComposeMode;
	senderKey: string | null;
	addresses: string[];
	subject: string;
	bodyHtml: string;
	replyOf: string | null;
	forwardOf: string | null;
	attachments: InboxAttachmentInfo[];
}

export interface PollResult {
	imported: number;
	skipped: number;
	failed: number;
	message: string;
}
