/**
 * Drag & Drop im Posteingang: Mails aus der Liste bzw. Ordner aus dem Baum auf einen Ordner ziehen.
 * `getData` ist in `dragover` nicht lesbar, daher merkt sich der Ziehvorgang hier, was gezogen wird
 * (Postfach + IDs) – die Ziele entscheiden damit, ob sie den Drop annehmen.
 */

export const MAIL_DRAG_MIME = 'application/x-ep-inbox-mails';
export const FOLDER_DRAG_MIME = 'application/x-ep-inbox-folder';

export type InboxDrag =
	| { kind: 'mails'; mailbox: string; ids: string[] }
	| { kind: 'folder'; mailbox: string; id: string };

export const inboxDrag = $state<{ current: InboxDrag | null }>({ current: null });

/** Ziehbild „N Nachrichten“ statt der ganzen Tabellenzeile */
export function setDragGhost(e: DragEvent, text: string): void {
	if (!e.dataTransfer) return;
	const ghost = document.createElement('div');
	ghost.className =
		'fixed -top-96 left-0 rounded-md bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground shadow';
	ghost.textContent = text;
	document.body.appendChild(ghost);
	e.dataTransfer.setDragImage(ghost, 12, 12);
	setTimeout(() => ghost.remove(), 0);
}

/** Abgelegte Daten lesen (nur im `drop`-Ereignis verfügbar) */
export function readDrop(e: DragEvent): InboxDrag | null {
	const mails = e.dataTransfer?.getData(MAIL_DRAG_MIME);
	const folder = e.dataTransfer?.getData(FOLDER_DRAG_MIME);
	try {
		const raw: unknown = JSON.parse(mails || folder || 'null');
		if (!raw || typeof raw !== 'object') return null;
		const v = raw as Record<string, unknown>;
		if (typeof v.mailbox !== 'string') return null;
		if (mails && Array.isArray(v.ids)) {
			const ids = v.ids.filter((id): id is string => typeof id === 'string');
			return ids.length ? { kind: 'mails', mailbox: v.mailbox, ids } : null;
		}
		if (folder && typeof v.id === 'string') return { kind: 'folder', mailbox: v.mailbox, id: v.id };
	} catch {
		// fremde/kaputte Daten ignorieren
	}
	return null;
}
