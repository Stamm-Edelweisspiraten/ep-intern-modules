/**
 * Dünne Hülle um `imapflow` für den Abruf des Catch-all-Postfachs: Nachrichten des Eingangsordners lesen
 * (zu große nur angeschnitten) und nach erfolgreichem Import in den Ablageordner verschieben.
 * Tests ersetzen die Verbindung über `setImapConnectorForTests`.
 */
import { ImapFlow } from 'imapflow';

export interface ImapConfig {
	host: string;
	port: number;
	secure: boolean;
	user: string;
	password: string;
	/** Ordner mit neuen Mails (Standard `INBOX`) */
	folder: string;
	/** Ablage nach dem Import (wird bei Bedarf angelegt) */
	processedFolder: string;
}

export interface ImapMessage {
	uid: number;
	/** Größe laut Server (Bytes) */
	size: number;
	/** Rohtext; bei zu großen Mails nur der Anfang (`truncated`) */
	source: Buffer;
	truncated: boolean;
}

export interface ImapSession {
	/** Höchstens `limit` Nachrichten des Eingangsordners (älteste zuerst) */
	fetch(limit: number, maxBytes: number): Promise<ImapMessage[]>;
	/** Nachrichten (UIDs) in den Ablageordner verschieben */
	move(uids: number[]): Promise<void>;
	close(): Promise<void>;
}

export type ImapConnector = (config: ImapConfig) => Promise<ImapSession>;

/** Bei zu großen Mails nur so viel lesen (Kopfzeilen und Anfang des Textes) */
const HEAD_BYTES = 256 * 1024;

async function connectImapFlow(config: ImapConfig): Promise<ImapSession> {
	const client = new ImapFlow({
		host: config.host,
		port: config.port,
		secure: config.secure,
		auth: { user: config.user, pass: config.password },
		logger: false,
		connectionTimeout: 15_000,
		greetingTimeout: 15_000,
		socketTimeout: 120_000
	});
	// Ohne Listener beendet ein Socket-Fehler den Prozess
	client.on('error', (e: unknown) =>
		console.error('[messages] IMAP-Verbindung:', (e as Error)?.message ?? e)
	);
	await client.connect();
	let lock: { release(): void } | null = null;
	try {
		lock = await client.getMailboxLock(config.folder);
	} catch (e) {
		await client.logout().catch(() => client.close());
		throw e;
	}
	let folderReady = false;
	return {
		async fetch(limit, maxBytes) {
			const found = await client.search({ all: true }, { uid: true });
			const uids = (Array.isArray(found) ? found : []).sort((a, b) => a - b).slice(0, limit);
			const out: ImapMessage[] = [];
			for (const uid of uids) {
				const meta = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
				if (!meta) continue;
				const size = meta.size ?? 0;
				const truncated = size > maxBytes;
				const msg = await client.fetchOne(
					String(uid),
					{ uid: true, source: truncated ? { start: 0, maxLength: HEAD_BYTES } : true },
					{ uid: true }
				);
				if (!msg || !msg.source) continue;
				out.push({ uid, size, source: msg.source, truncated });
			}
			return out;
		},
		async move(uids) {
			if (!uids.length) return;
			if (!folderReady) {
				// Ordner anlegen, falls er fehlt (Fehler „existiert schon“ ist harmlos)
				await client.mailboxCreate(config.processedFolder).catch(() => undefined);
				folderReady = true;
			}
			const moved = await client.messageMove(uids.join(','), config.processedFolder, {
				uid: true
			});
			if (moved === false) throw new Error('Verschieben in den Ablageordner fehlgeschlagen');
		},
		async close() {
			lock?.release();
			await client.logout().catch(() => client.close());
		}
	};
}

let testConnector: ImapConnector | undefined;
/** Nur für Tests: IMAP durch einen Ersatz austauschen (`undefined` = echt) */
export function setImapConnectorForTests(fn: ImapConnector | undefined): void {
	testConnector = fn;
}

export function openImap(config: ImapConfig): Promise<ImapSession> {
	return (testConnector ?? connectImapFlow)(config);
}
