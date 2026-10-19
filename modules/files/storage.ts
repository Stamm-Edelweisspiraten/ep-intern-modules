/**
 * Datei-Inhalte im Core-Storage (Modul `files`), Thumbnails, Auslieferung, Kontingent.
 * VERTRAG (Welle 0) – Implementierung: Welle 1.2. Signaturen nicht ändern.
 * Storage-Aufrufe nur AUSSERHALB offener Transaktionen (Ausnahme: `quotaUsed`/`assertQuota` sind reine SQL-Helfer).
 */
import { sql } from 'drizzle-orm';
import { core, errors, isCoreError, type Tx } from '$lib/sdk/server';
import { filesCtx } from './db';
import {
	MODULE_ID,
	NEVER_INLINE_TYPES,
	PREVIEW_IMAGE_TYPES,
	PREVIEW_PDF,
	PREVIEW_TEXT_TYPES
} from './schemas';

export interface StoredContent {
	storagePath: string;
	thumbPath: string | null;
	contentType: string;
	sizeBytes: number;
}

/**
 * Kopie von `DEFAULT_ALLOWED_CONTENT_TYPES` aus `src/lib/server/core/storage/index.ts`
 * (Module dürfen `$lib/server/*` nicht importieren). Bei Änderungen dort mitpflegen.
 */
const DEFAULT_ALLOWED_CONTENT_TYPES = [
	'application/pdf',
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'text/plain',
	'text/csv',
	'text/markdown',
	'application/json',
	'application/zip',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/msword',
	'application/vnd.ms-excel',
	'application/vnd.ms-powerpoint'
];

/** Aktive Inhalte: wie im Core nur zulässig, wenn ausdrücklich in der Allowlist genannt */
const ACTIVE_CONTENT_TYPES = new Set<string>(NEVER_INLINE_TYPES);

const OCTET = 'application/octet-stream';

const EXTENSION_TYPES: Record<string, string> = {
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	txt: 'text/plain',
	csv: 'text/csv',
	md: 'text/markdown',
	json: 'application/json',
	zip: 'application/zip',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	doc: 'application/msword',
	xls: 'application/vnd.ms-excel',
	ppt: 'application/vnd.ms-powerpoint',
	odt: 'application/vnd.oasis.opendocument.text',
	ods: 'application/vnd.oasis.opendocument.spreadsheet',
	odp: 'application/vnd.oasis.opendocument.presentation'
};

const THUMB_SPEC = { name: 'thumb', maxEdge: 320, format: 'webp', quality: 75 } as const;

const includes = (list: readonly string[], v: string) => list.includes(v);

/** Typ ohne Parameter, klein geschrieben; leer → `null` */
function cleanType(ct: string | null | undefined): string | null {
	const t = (ct ?? '').split(';')[0]!.trim().toLowerCase();
	return t || null;
}

/** Browser-Typ, sonst nach Endung, sonst `application/octet-stream` */
function normalizeType(ct: string | null, name: string): string {
	const t = cleanType(ct);
	if (t && t !== OCTET) return t;
	const dot = name.lastIndexOf('.');
	const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
	return EXTENSION_TYPES[ext] ?? OCTET;
}

function typeAllowed(ct: string, allowed: readonly string[]): boolean {
	if (ACTIVE_CONTENT_TYPES.has(ct) && !allowed.includes(ct)) return false;
	return allowed.some((a) => (a.endsWith('/*') ? ct.startsWith(a.slice(0, -1)) : a === ct));
}

/** Lesbare Größe (de-DE): KB/MB/GB */
function formatBytes(n: number): string {
	const fmt = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 1 });
	if (n >= 1024 ** 3) return `${fmt(n / 1024 ** 3)} GB`;
	if (n >= 1024 ** 2) return `${fmt(n / 1024 ** 2)} MB`;
	if (n >= 1024) return `${fmt(n / 1024)} KB`;
	return `${n} Byte`;
}

/** `content-disposition` nach RFC 6266/5987 mit ASCII-Ersatznamen */
function disposition(kind: 'inline' | 'attachment', name: string): string {
	const ascii =
		name
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.replace(/[^A-Za-z0-9._ -]+/g, '_')
			.trim() || 'datei';
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function download(path: string) {
	try {
		return await core.storage.download(filesCtx(), { module: MODULE_ID, path });
	} catch (e) {
		if (isCoreError(e) && e.code === 'not_found') throw errors.notFound('Datei nicht gefunden');
		throw e;
	}
}

/** Grenzen aus den Core-Storage-Einstellungen (`core.storage.maxFileSizeMb`, erlaubte Typen) */
export async function storageLimits(): Promise<{
	maxFileBytes: number;
	allowedContentTypes: string[];
}> {
	const s = await core.settings.getMany([
		'core.storage.maxFileSizeMb',
		'core.storage.allowedContentTypes'
	]);
	const mb = Number(s['core.storage.maxFileSizeMb'] ?? 50);
	const configured = Array.isArray(s['core.storage.allowedContentTypes'])
		? (s['core.storage.allowedContentTypes'] as unknown[])
				.map((v) => String(v).trim().toLowerCase())
				.filter(Boolean)
		: [];
	return {
		maxFileBytes: (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024,
		allowedContentTypes: configured.length ? configured : [...DEFAULT_ALLOWED_CONTENT_TYPES]
	};
}

/**
 * Inhalt ablegen: Pfad `<nodeId>/<uuid>`; Typ normalisieren (Browser-Typ, sonst nach Endung, sonst
 * `application/octet-stream`), Größe/Typ prüfen (413/422 mit deutscher Meldung), für `PREVIEW_IMAGE_TYPES`
 * ein Thumbnail per `core.images.process` (320 px, WebP) unter `<nodeId>/<uuid>-thumb.webp` – Fehler beim
 * Thumbnail sind kein Abbruch (`thumbPath = null`). Original bleibt unverändert.
 */
export async function storeContent(input: {
	nodeId: string;
	bytes: Uint8Array;
	name: string;
	contentType: string | null;
}): Promise<StoredContent> {
	const contentType = normalizeType(input.contentType, input.name);
	const sizeBytes = input.bytes.byteLength;
	const limits = await storageLimits();
	if (!typeAllowed(contentType, limits.allowedContentTypes)) {
		const message = `Dateityp nicht erlaubt: ${contentType}`;
		throw errors.validation({ file: message }, message);
	}
	if (sizeBytes > limits.maxFileBytes) {
		throw errors.tooLarge(
			`Die Datei ist zu groß (${formatBytes(sizeBytes)}, erlaubt sind höchstens ${formatBytes(limits.maxFileBytes)}).`
		);
	}

	const ctx = filesCtx();
	const id = crypto.randomUUID();
	const storagePath = `${input.nodeId}/${id}`;
	await core.storage.upload(ctx, {
		module: MODULE_ID,
		path: storagePath,
		file: input.bytes,
		contentType,
		name: input.name
	});

	let thumbPath: string | null = null;
	if (includes(PREVIEW_IMAGE_TYPES, contentType)) {
		const path = `${input.nodeId}/${id}-thumb.webp`;
		try {
			const processed = await core.images.process(input.bytes, { variants: [THUMB_SPEC] });
			const thumb = processed.variants[0];
			if (thumb) {
				await core.storage.upload(ctx, {
					module: MODULE_ID,
					path,
					file: thumb.bytes,
					contentType: thumb.contentType,
					name: 'thumb.webp'
				});
				thumbPath = path;
			}
		} catch {
			thumbPath = null;
		}
	}

	return { storagePath, thumbPath, contentType, sizeBytes };
}

/**
 * Inhalt als rohe Response. Inline nur für Bilder (`PREVIEW_IMAGE_TYPES`), PDF und Text
 * (Text als `text/plain; charset=utf-8`); `NEVER_INLINE_TYPES` und alles andere als `attachment`.
 * Header: `content-type`, `content-length`, `content-disposition` (RFC 5987, sicherer Name),
 * `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`,
 * `cache-control: private, max-age=60`.
 */
export async function contentResponse(input: {
	path: string;
	name: string;
	contentType: string;
	download: boolean;
}): Promise<Response> {
	const { buffer } = await download(input.path);
	const ct = cleanType(input.contentType) ?? OCTET;
	const isText = includes(PREVIEW_TEXT_TYPES, ct);
	const never = includes(NEVER_INLINE_TYPES, ct);
	const inlineOk = !never && (includes(PREVIEW_IMAGE_TYPES, ct) || ct === PREVIEW_PDF || isText);
	const inline = inlineOk && !input.download;

	let contentType: string;
	if (never) contentType = OCTET;
	else if (inline && isText) contentType = 'text/plain; charset=utf-8';
	else if (isText) contentType = `${ct}; charset=utf-8`;
	else contentType = ct;

	return new Response(buffer as BodyInit, {
		status: 200,
		headers: {
			'content-type': contentType,
			'content-length': String(buffer.byteLength),
			'content-disposition': disposition(inline ? 'inline' : 'attachment', input.name),
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
			'cache-control': 'private, max-age=60'
		}
	});
}

/** Thumbnail (WebP) als Response, `cache-control: private, max-age=3600` */
export async function thumbResponse(path: string): Promise<Response> {
	const { buffer } = await download(path);
	return new Response(buffer as BodyInit, {
		status: 200,
		headers: {
			'content-type': 'image/webp',
			'content-length': String(buffer.byteLength),
			'content-disposition': 'inline',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
			'cache-control': 'private, max-age=3600'
		}
	});
}

/** Objekte best-effort entfernen (Fehler ignorieren) */
export async function removeObjects(paths: readonly (string | null | undefined)[]): Promise<void> {
	const ctx = filesCtx();
	for (const path of new Set(paths)) {
		if (!path) continue;
		await core.storage.remove(ctx, { module: MODULE_ID, path }).catch(() => undefined);
	}
}

/** Belegter Platz einer Person in „Meine Dateien“ (inkl. Papierkorb), in der Transaktion */
export async function quotaUsed(tx: Tx, ownerId: string): Promise<number> {
	const res = (await tx.execute(
		sql`SELECT COALESCE(SUM(size_bytes), 0)::bigint AS used FROM nodes
			WHERE space = 'personal' AND owner_id = ${ownerId} AND kind = 'file'`
	)) as unknown as { rows: Record<string, unknown>[] };
	return Number(res.rows[0]?.used ?? 0);
}

/** 413 „Dein Speicherplatz ist voll …“, wenn `used + addBytes > limitBytes` (`null` = unbegrenzt) */
export async function assertQuota(
	tx: Tx,
	ownerId: string,
	addBytes: number,
	limitBytes: number | null
): Promise<void> {
	if (limitBytes === null) return;
	const used = await quotaUsed(tx, ownerId);
	if (used + addBytes > limitBytes) {
		throw errors.tooLarge(
			`Dein Speicherplatz ist voll: ${formatBytes(used)} von ${formatBytes(limitBytes)} belegt.`
		);
	}
}
