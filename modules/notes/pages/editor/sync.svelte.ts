/**
 * Yjs-Provider über SSE + POST (kein WebSocket): Ereignis-Stream mit eigenem Wiederverbinden (1–15 s), nach jedem
 * `hello` Abgleich per State-Vector (fehlende Änderungen holen, eigene Offline-Änderungen nachschicken), gebündeltes
 * Senden eigener Updates (~100 ms, `Y.mergeUpdates`, eine Anfrage gleichzeitig, Wiederholung bei Netzfehlern) und
 * gedrosselte Anwesenheit (y-protocols Awareness: Cursor, Auswahl, Name/Farbe).
 */
import { SvelteMap } from 'svelte/reactivity';
import * as Y from 'yjs';
import {
	applyAwarenessUpdate,
	Awareness,
	encodeAwarenessUpdate,
	removeAwarenessStates
} from 'y-protocols/awareness';
import { apiFetch } from '$lib/sdk/client';
import {
	API_BASE,
	MAX_UPDATE_BYTES,
	type LiveEvent,
	type NoteNode,
	type Peer,
	type ShareLevel
} from '../../schemas';
import { fromBase64, toBase64 } from './base64';

export type SyncStatus = 'connecting' | 'live' | 'offline' | 'closed';

export interface NoteSyncHandlers {
	onMeta?(note: Pick<NoteNode, 'id' | 'title' | 'icon' | 'color'>): void;
	onAccess?(level: ShareLevel): void;
	/** Kein Zugriff mehr bzw. Notiz gelöscht */
	onGone?(reason: 'revoked' | 'deleted'): void;
	/** Version wiederhergestellt o. Ä. → Dokument komplett neu laden */
	onReset?(): void;
	/** Änderung endgültig abgelehnt */
	onRejected?(message: string): void;
}

/** Herkunft entfernter Änderungen (werden nicht zurückgeschickt) */
export const REMOTE = 'remote';

const FLUSH_MS = 100;
const AWARENESS_MS = 100;
/** Byte-Budget je Anfrage (Server-Grenze MAX_UPDATE_BYTES) */
const MAX_BATCH_BYTES = Math.floor(MAX_UPDATE_BYTES * 0.8);
/** `keepalive`-Anfragen dürfen höchstens 64 KB haben */
const KEEPALIVE_BYTES = 60_000;

function randomClient(): string {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	return `c${[...bytes].map((b) => b.toString(36).padStart(2, '0')).join('')}`.slice(0, 32);
}

export class NoteSync {
	readonly client = randomClient();
	readonly doc = new Y.Doc();
	readonly awareness = new Awareness(this.doc);
	status = $state<SyncStatus>('connecting');
	/** Eigene Änderungen noch nicht vom Server bestätigt */
	saving = $state(false);
	/** Erster Abgleich mit dem Server erfolgt */
	synced = $state(false);
	readonly = $state(false);
	/** Andere Verbindungen (je Tab) */
	peers = new SvelteMap<string, Peer>();

	private es: EventSource | null = null;
	private pending: Uint8Array[] = [];
	private inflight: Uint8Array | null = null;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private stateTimer: ReturnType<typeof setTimeout> | null = null;
	private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
	private retryDelay = 1000;
	private reconnectDelay = 1000;
	private stateDelay = 1000;
	private closed = false;
	private awarenessDirty = false;
	private lastAwarenessAt = 0;
	private stateRun = 0;

	constructor(
		private readonly noteId: string,
		private readonly handlers: NoteSyncHandlers = {},
		level: ShareLevel = 'edit'
	) {
		this.readonly = level === 'read';
		this.doc.on('update', this.onDocUpdate);
		this.awareness.on('update', this.onAwarenessUpdate);
	}

	private get base(): string {
		return `${API_BASE}/notes/${encodeURIComponent(this.noteId)}`;
	}

	private onDocUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === REMOTE) return;
		this.queue(update);
	};

	private onAwarenessUpdate = (
		changes: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown
	) => {
		if (origin === REMOTE) return;
		const me = this.doc.clientID;
		if (![...changes.added, ...changes.updated, ...changes.removed].includes(me)) return;
		this.awarenessDirty = true;
		this.scheduleAwareness();
	};

	connect(): void {
		this.closed = false;
		this.open();
	}

	private open(): void {
		if (this.closed) return;
		this.es?.close();
		if (this.status !== 'live') this.status = 'connecting';
		const url = `${this.base}/live?client=${this.client}&awarenessId=${this.doc.clientID}`;
		const es = new EventSource(url, { withCredentials: true });
		this.es = es;
		es.onmessage = (msg) => {
			let event: LiveEvent;
			try {
				event = JSON.parse(msg.data) as LiveEvent;
			} catch {
				return;
			}
			this.handle(event);
		};
		es.onerror = () => {
			// Browser würde selbst wiederverbinden – Abstand und Abgleich steuern wir selbst
			es.close();
			if (this.es !== es || this.closed) return;
			this.es = null;
			this.status = 'offline';
			this.clearPeers();
			if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
			this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15_000);
		};
	}

	private handle(event: LiveEvent): void {
		switch (event.type) {
			case 'hello':
				this.status = 'live';
				this.reconnectDelay = 1000;
				this.clearPeers();
				for (const p of event.peers) if (p.client !== this.client) this.peers.set(p.client, p);
				this.setLevel(event.level);
				void this.syncState();
				this.awarenessDirty = true;
				this.scheduleAwareness();
				if (this.pending.length) this.scheduleFlush(0);
				break;
			case 'update':
				if (event.client === this.client) return;
				try {
					Y.applyUpdate(this.doc, fromBase64(event.update), REMOTE);
				} catch {
					// kaputtes Update → Zustand neu abgleichen
					void this.syncState();
				}
				break;
			case 'awareness':
				if (event.client === this.client) return;
				try {
					applyAwarenessUpdate(this.awareness, fromBase64(event.update), REMOTE);
				} catch {
					/* ungültige Anwesenheit ignorieren */
				}
				break;
			case 'join':
				if (event.peer.client !== this.client) {
					this.peers.set(event.peer.client, event.peer);
					// Neue Verbindung kennt unseren Cursor noch nicht
					this.awarenessDirty = true;
					this.scheduleAwareness();
				}
				break;
			case 'peer':
				if (event.peer.client !== this.client) this.peers.set(event.peer.client, event.peer);
				break;
			case 'leave': {
				const peer = this.peers.get(event.client);
				this.peers.delete(event.client);
				const id = event.awarenessId ?? peer?.awarenessId ?? null;
				if (id !== null && id !== this.doc.clientID)
					removeAwarenessStates(this.awareness, [id], REMOTE);
				break;
			}
			case 'meta':
				this.handlers.onMeta?.(event.note);
				break;
			case 'access':
				this.setLevel(event.level);
				break;
			case 'reset':
				this.handlers.onReset?.();
				break;
			case 'revoked':
			case 'deleted':
				this.close();
				this.handlers.onGone?.(event.type);
				break;
		}
	}

	private setLevel(level: ShareLevel): void {
		const ro = level === 'read';
		if (ro === this.readonly) return;
		this.readonly = ro;
		if (ro) this.pending = [];
		this.handlers.onAccess?.(level);
	}

	private clearPeers(): void {
		const ids = [...this.peers.values()]
			.map((p) => p.awarenessId)
			.filter((id): id is number => id !== null && id !== this.doc.clientID);
		this.peers.clear();
		if (ids.length) removeAwarenessStates(this.awareness, ids, REMOTE);
	}

	/** Abgleich: fehlende Änderungen holen, eigene (z. B. offline entstandene) nachschicken */
	private async syncState(): Promise<void> {
		const run = ++this.stateRun;
		if (this.stateTimer) {
			clearTimeout(this.stateTimer);
			this.stateTimer = null;
		}
		try {
			const sv = toBase64(Y.encodeStateVector(this.doc));
			const res = await fetch(`${this.base}/state?sv=${encodeURIComponent(sv)}`, {
				credentials: 'same-origin',
				headers: { accept: 'application/octet-stream' }
			});
			if (run !== this.stateRun || this.closed) return;
			if (res.status === 403 || res.status === 404) {
				this.close();
				this.handlers.onGone?.(res.status === 404 ? 'deleted' : 'revoked');
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (run !== this.stateRun || this.closed) return;
			if (bytes.length) Y.applyUpdate(this.doc, bytes, REMOTE);
			const level = res.headers.get('x-note-level');
			if (level === 'read' || level === 'edit') this.setLevel(level);
			const serverSv = res.headers.get('x-yjs-state-vector');
			if (serverSv && !this.readonly) {
				const missing = Y.encodeStateAsUpdate(this.doc, fromBase64(serverSv));
				// leeres Update = 2 Byte (keine Structs, kein Delete-Set)
				if (missing.length > 2) this.queue(missing);
			}
			this.synced = true;
			this.stateDelay = 1000;
		} catch {
			if (run !== this.stateRun || this.closed) return;
			this.stateTimer = setTimeout(() => void this.syncState(), this.stateDelay);
			this.stateDelay = Math.min(this.stateDelay * 2, 15_000);
		}
	}

	private queue(update: Uint8Array): void {
		if (this.readonly || this.closed) return;
		this.pending.push(update);
		this.saving = true;
		this.scheduleFlush(FLUSH_MS);
	}

	private scheduleFlush(ms: number): void {
		if (this.flushTimer || this.retryTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, ms);
	}

	private takeBatch(limit: number): Uint8Array {
		const batch: Uint8Array[] = [];
		let bytes = 0;
		while (this.pending.length) {
			const next = this.pending[0]!;
			if (batch.length && bytes + next.length > limit) break;
			batch.push(next);
			bytes += next.length;
			this.pending.shift();
		}
		return batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
	}

	async flush(keepalive = false): Promise<void> {
		if (this.inflight || !this.pending.length || this.readonly || this.closed) {
			this.updateSaving();
			return;
		}
		const update = this.takeBatch(keepalive ? KEEPALIVE_BYTES : MAX_BATCH_BYTES);
		this.inflight = update;
		try {
			const res = await fetch(`${this.base}/updates?client=${this.client}`, {
				method: 'POST',
				body: update as BodyInit,
				headers: { 'content-type': 'application/octet-stream' },
				credentials: 'same-origin',
				keepalive: keepalive && update.length <= KEEPALIVE_BYTES
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as {
					error?: { message?: string };
				} | null;
				throw Object.assign(new Error(body?.error?.message ?? res.statusText), {
					status: res.status
				});
			}
			this.inflight = null;
			this.retryDelay = 1000;
		} catch (e) {
			const status = (e as { status?: number }).status ?? 0;
			this.inflight = null;
			if (status === 403) {
				this.setLevel('read');
				this.handlers.onRejected?.('Du darfst diese Notiz nicht mehr bearbeiten.');
			} else if (status === 404) {
				this.close();
				this.handlers.onGone?.('deleted');
			} else if ([400, 409, 413, 422].includes(status)) {
				this.handlers.onRejected?.(
					(e as Error).message || 'Änderung konnte nicht gespeichert werden.'
				);
			} else {
				// Netz/Server kurz weg: vorne wieder einreihen und später erneut senden
				this.pending.unshift(update);
				if (this.status === 'live') this.status = 'offline';
				this.retryTimer = setTimeout(() => {
					this.retryTimer = null;
					void this.flush();
				}, this.retryDelay);
				this.retryDelay = Math.min(this.retryDelay * 2, 15_000);
			}
		}
		this.updateSaving();
		if (this.pending.length && !this.retryTimer) this.scheduleFlush(0);
	}

	private updateSaving(): void {
		this.saving = this.pending.length > 0 || this.inflight !== null;
	}

	private scheduleAwareness(): void {
		if (this.awarenessTimer || this.status !== 'live') return;
		const wait = Math.max(0, AWARENESS_MS - (Date.now() - this.lastAwarenessAt));
		this.awarenessTimer = setTimeout(() => {
			this.awarenessTimer = null;
			if (!this.awarenessDirty || this.status !== 'live') return;
			this.awarenessDirty = false;
			this.lastAwarenessAt = Date.now();
			const update = toBase64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
			void apiFetch(`/modules/notes/notes/${encodeURIComponent(this.noteId)}/awareness`, {
				method: 'POST',
				body: JSON.stringify({ client: this.client, update })
			}).catch(() => undefined);
		}, wait);
	}

	hasUnsaved(): boolean {
		return this.pending.length > 0 || this.inflight !== null;
	}

	close(): void {
		this.closed = true;
		this.es?.close();
		this.es = null;
		this.status = 'closed';
		for (const t of [this.reconnectTimer, this.awarenessTimer, this.stateTimer])
			if (t) clearTimeout(t);
		this.reconnectTimer = this.awarenessTimer = this.stateTimer = null;
		this.clearPeers();
	}

	/** Beim Verlassen: Ausstehendes noch senden, dann alles freigeben */
	dispose(): void {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.flushTimer = this.retryTimer = null;
		const hadPending = this.pending.length > 0 && !this.readonly && !this.closed;
		if (hadPending) void this.flush(true);
		this.close();
		this.doc.off('update', this.onDocUpdate);
		this.awareness.off('update', this.onAwarenessUpdate);
		this.awareness.destroy();
		if (!hadPending) this.doc.destroy();
	}
}
