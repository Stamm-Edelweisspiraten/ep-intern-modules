/**
 * API-Vertrag des Moduls `messages` (Nachrichten): Zod-Eingaben, DTO-Typen und Konstanten –
 * von Server und Oberfläche genutzt.
 */
import { z } from 'zod';

export const MODULE_ID = 'messages';
export const BASE_PATH = '/modules/messages';

export const PERM_SEND = 'messages.message.send';
export const PERM_VIEW_ALL = 'messages.message.view-all';
export const PERM_SETTINGS = 'messages.settings.manage';

export const SETTING_KEYS = {
	domain: 'messages.domain',
	personalEnabled: 'messages.personal.enabled',
	replyTo: 'messages.replyTo.default',
	layout: 'messages.layout.default',
	maxRecipients: 'messages.maxRecipients'
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

/** Nachrichten älter als so viele Tage werden gelöscht; Anhänge schon nach `ATTACHMENT_DAYS` */
export const RETENTION_DAYS = 365;
export const ATTACHMENT_DAYS = 30;

const id = z.string().trim().min(1).max(100);
const emailAddress = z.string().trim().toLowerCase().max(254).email('Ungültige E-Mail-Adresse');

// --- Eingaben -------------------------------------------------------------------------------

export const idParams = z.object({ id });
export const attachmentParams = z.object({ id, attachmentId: id });

export const recipientsInput = z.object({
	memberIds: z.array(id).max(MAX_MEMBER_IDS).default([]),
	groupIds: z.array(id).max(MAX_GROUP_IDS).default([]),
	/** Mitglieder, die trotz Gruppenauswahl nicht angeschrieben werden */
	excludeMemberIds: z.array(id).max(MAX_MEMBER_IDS).default([])
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
		.max(MAX_BODY_HTML * 2, 'Der Text ist zu lang')
});
export type SendInput = z.infer<typeof sendInput>;

export const listQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(30),
	offset: z.coerce.number().int().min(0).default(0)
});

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
}

export interface ResolvedRecipient {
	memberId: string;
	name: string;
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
	maxRecipients: number;
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
	attachments: MessageAttachmentInfo[];
	recipients: MessageRecipientInfo[];
}
