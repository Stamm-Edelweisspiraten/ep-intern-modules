/**
 * Endpoints des Moduls `messages` (`/api/v1/modules/messages/…`):
 * Absender und Empfänger vorab prüfen, Nachricht senden (multipart mit Anhängen), Verlauf, Wiederholen.
 * Feste Pfade (`/senders`, `/recipients/resolve`) vor den Parameter-Pfaden.
 */
import {
	checkUploadBytes,
	defineEndpoint,
	errors,
	readFormData,
	type AnyApiEndpoint
} from '$lib/sdk/server';
import { DEFAULT_ALLOWED_CONTENT_TYPES, EXTENSION_CONTENT_TYPES } from '$lib/sdk/content-types';
import { createMessage, getMessage, listMessages, retryMessage } from './delivery.service';
import { resolveRecipients } from './recipients.service';
import { listSenders } from './sender.service';
import {
	MAX_FILES,
	MAX_FILE_BYTES,
	MAX_TOTAL_BYTES,
	PERM_SEND,
	idParams,
	listQuery,
	recipientsInput,
	sendInput
} from './schemas';
import type { UploadedAttachment } from './delivery.service';

const tags = ['Modul: messages'];
/** Zuschlag für Textfelder und Multipart-Grenzen über der Anhangsgrenze */
const BODY_OVERHEAD = 2 * 1024 * 1024;

/** Typ nach Dateiendung, wenn der Browser keinen meldet */
function typeByExtension(name: string): string {
	const ext = name.split('.').pop()?.toLowerCase() ?? '';
	return EXTENSION_CONTENT_TYPES[ext] ?? '';
}

/** Anhänge aus dem Formular lesen und prüfen (Anzahl, Größe je Datei und gesamt) */
async function readAttachments(form: FormData): Promise<UploadedAttachment[]> {
	const entries = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
	if (entries.length > MAX_FILES) {
		throw errors.validation([{ path: ['files'], message: `Höchstens ${MAX_FILES} Anhänge` }]);
	}
	const total = entries.reduce((sum, f) => sum + f.size, 0);
	if (total > MAX_TOTAL_BYTES)
		throw errors.tooLarge('Die Anhänge sind zusammen zu groß (höchstens 20 MB).');
	const out: UploadedAttachment[] = [];
	for (const file of entries) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const checked = checkUploadBytes(
			{ bytes, contentType: file.type || typeByExtension(file.name), name: file.name },
			{
				field: 'files',
				maxBytes: MAX_FILE_BYTES,
				allowedTypes: DEFAULT_ALLOWED_CONTENT_TYPES,
				typesLabel: 'PDF, Bilder, Office- und OpenDocument-Dateien, Text oder ZIP',
				fallbackName: 'anhang'
			}
		);
		out.push({ filename: checked.name, contentType: checked.contentType, bytes: checked.bytes });
	}
	return out;
}

export const messageEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/senders',
		summary: 'Absender, die die angemeldete Person verwenden darf',
		tags,
		permission: PERM_SEND,
		handler: ({ ctx }) => listSenders(ctx)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/recipients/resolve',
		summary: 'Empfänger (Mitglieder/Gruppen) zu eindeutigen Adressen auflösen',
		tags,
		permission: PERM_SEND,
		rateLimit: { limit: 60, windowSec: 60 },
		body: recipientsInput,
		handler: ({ ctx, body }) => resolveRecipients(ctx, body)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/messages',
		summary: 'Verlauf der gesendeten Nachrichten (eigene, mit view-all alle)',
		tags,
		permission: PERM_SEND,
		rateLimit: { limit: 240, windowSec: 60 },
		query: listQuery,
		handler: ({ ctx, query }) => listMessages(ctx, query)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/messages',
		summary: 'Nachricht senden (multipart: Feld `data` als JSON, Dateien als `files`)',
		tags,
		permission: PERM_SEND,
		rateLimit: { limit: 10, windowSec: 600 },
		handler: async ({ ctx, request }) => {
			const length = Number(request.headers.get('content-length') ?? '');
			if (Number.isFinite(length) && length > MAX_TOTAL_BYTES + BODY_OVERHEAD) {
				throw errors.tooLarge('Die Anhänge sind zusammen zu groß (höchstens 20 MB).');
			}
			const form = await readFormData(request);
			let raw: unknown;
			try {
				raw = JSON.parse(String(form.get('data') ?? ''));
			} catch {
				throw errors.badRequest('Ungültige Formulardaten');
			}
			const parsed = sendInput.safeParse(raw);
			if (!parsed.success) {
				throw errors.validation(
					parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message }))
				);
			}
			return createMessage(ctx, parsed.data, await readAttachments(form));
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/messages/:id',
		summary: 'Nachricht mit Empfängerstatus',
		tags,
		permission: PERM_SEND,
		rateLimit: { limit: 240, windowSec: 60 },
		params: idParams,
		handler: ({ ctx, params }) => getMessage(ctx, params.id)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/messages/:id/retry',
		summary: 'Fehlgeschlagene Empfänger erneut versuchen',
		tags,
		permission: PERM_SEND,
		rateLimit: { limit: 10, windowSec: 600 },
		params: idParams,
		handler: ({ ctx, params }) => retryMessage(ctx, params.id)
	})
];
