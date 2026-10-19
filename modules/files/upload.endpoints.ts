/**
 * Hochladen und Ausliefern von Datei-Inhalten (internes Multipart, Muster `galleries/images.endpoints.ts`).
 *
 * Ablauf Upload: Rechte/Einstellungen vor der Transaktion → Tx 1 (Ziel prüfen, Ordnerpfad anlegen, Name,
 * Konflikt, Kontingent) → Storage außerhalb jeder Transaktion → Tx 2 (Knoten anlegen bzw. ersetzen) →
 * Aufräumen/Audit danach. Core-Services (Storage, Audit, Einstellungen) nie in einer offenen Transaktion (PGlite).
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import { requireFolderTarget, requireNode } from './access';
import { filesSettings, mdb, rowsOf } from './db';
import { normalizeName, splitRelativePath, uniqueName } from './names';
import { ensureFolderPath, loadFileNode, siblingNames } from './nodes.service';
import { keysFor } from './shares.service';
import {
	assertQuota,
	contentResponse,
	removeObjects,
	storageLimits,
	storeContent,
	thumbResponse,
	type StoredContent
} from './storage';
import {
	PERMISSIONS,
	contentQuery,
	idParams,
	nodeName,
	parentParams,
	uploadFields,
	type FileNode,
	type Space
} from './schemas';

const tags = ['Modul: files'];

/** Zuschlag für Multipart-Rahmen und Textfelder bei der Vorab-Prüfung von `content-length` */
const MULTIPART_OVERHEAD = 1024 * 1024;

/** Verletzung des Unique-Index (gleichzeitiger Upload mit gleichem Namen) erkennen */
function isUniqueViolation(e: unknown): boolean {
	let cur: unknown = e;
	for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
		if (String((cur as { code?: unknown }).code) === '23505') return true;
		cur = (cur as { cause?: unknown }).cause;
	}
	return false;
}

const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Optionales Textfeld aus dem Formular (fehlt → `undefined`, Datei statt Text → 400) */
function textField(form: FormData, key: string): string | undefined {
	const v = form.get(key);
	if (v === null) return undefined;
	if (typeof v !== 'string') throw errors.badRequest(`Feld "${key}" muss Text sein`);
	return v;
}

/** Ergebnis von Tx 1: alles, was Tx 2 zum Anlegen/Ersetzen braucht */
interface UploadPlan {
	space: Space;
	ownerId: string;
	parentId: string | null;
	name: string;
	/** Bei `conflict = replace`: vorhandene Datei, die ersetzt wird */
	replaceId: string | null;
	nodeId: string;
}

/** Nicht gelöschte Datei/Ordner mit gleichem Namen (ohne Groß/Klein) im Zielordner */
async function sameNamed(
	tx: Tx,
	plan: { space: Space; ownerId: string; parentId: string | null },
	name: string
): Promise<{ id: string; kind: string; sizeBytes: number } | null> {
	const cond = plan.parentId
		? sql`n.parent_id = ${plan.parentId}`
		: plan.space === 'shared'
			? sql`n.parent_id IS NULL AND n.space = 'shared'`
			: sql`n.parent_id IS NULL AND n.space = 'personal' AND n.owner_id = ${plan.ownerId}`;
	const [row] = await rowsOf(
		tx,
		sql`SELECT n.id, n.kind, n.size_bytes FROM nodes n
			WHERE ${cond} AND n.deleted_at IS NULL AND lower(n.name) = lower(${name}) LIMIT 1`
	);
	if (!row) return null;
	return { id: String(row.id), kind: String(row.kind), sizeBytes: Number(row.size_bytes ?? 0) };
}

export const uploadEndpoints = [
	defineEndpoint({
		method: 'POST',
		path: '/nodes/:parent/upload',
		summary: 'Datei hochladen (multipart, Feld "file"; `parent` = Ordner-ID oder `root`)',
		description:
			'Textfelder: `space` (personal|shared), optional `relativePath` (Ordner-Upload, Ordner werden angelegt) ' +
			'und `conflict` (rename = „Name (2)“, replace = vorhandene Datei ersetzen). Ein Request je Datei.',
		tags,
		permission: PERMISSIONS.view,
		params: parentParams,
		handler: async ({ ctx, params, request }): Promise<FileNode> => {
			const keys = await keysFor(ctx);
			const settings = await filesSettings();
			const limits = await storageLimits();

			// Vorab: nicht unnötig riesige Bodies einlesen (Router liest bei internem Multipart nichts selbst).
			// Ohne Content-Length (z. B. chunked) ließe sich die Größe erst nach dem Einlesen prüfen → ablehnen.
			// Browser (XHR/fetch mit FormData) senden den Header immer.
			const rawLength = request.headers.get('content-length');
			if (rawLength === null || !/^[0-9]+$/.test(rawLength.trim())) {
				throw errors.badRequest('Content-Length fehlt');
			}
			const declaredLength = Number(rawLength.trim());
			if (declaredLength > limits.maxFileBytes + MULTIPART_OVERHEAD) {
				throw errors.tooLarge('Die Datei ist zu groß.');
			}
			const form = await request.formData().catch(() => {
				throw errors.badRequest('Ungültige Formulardaten');
			});
			const file = form.get('file');
			if (!(file instanceof File)) {
				throw errors.validation([{ path: ['file'], message: 'Bitte eine Datei auswählen' }]);
			}
			if (file.size > limits.maxFileBytes) {
				throw errors.tooLarge(
					`Die Datei ist zu groß (höchstens ${Math.floor(limits.maxFileBytes / (1024 * 1024))} MB).`
				);
			}
			const parsed = uploadFields.safeParse({
				space: textField(form, 'space'),
				relativePath: textField(form, 'relativePath') || undefined,
				conflict: textField(form, 'conflict') || undefined
			});
			if (!parsed.success) throw errors.validation(parsed.error.issues);
			const fields = parsed.data;

			let folders: string[] = [];
			let rawName = file.name;
			if (fields.relativePath !== undefined) {
				const split = splitRelativePath(fields.relativePath);
				if (!split) {
					throw errors.validation([{ path: ['relativePath'], message: 'Ungültiger Pfad' }]);
				}
				folders = split.folders;
				rawName = split.file;
			}
			const checked = nodeName.safeParse(normalizeName(rawName));
			if (!checked.success) {
				const message = checked.error.issues[0]?.message ?? 'Ungültiger Dateiname';
				throw errors.validation([
					{ path: [fields.relativePath !== undefined ? 'relativePath' : 'file'], message }
				]);
			}
			const wantedName = checked.data;
			const size = file.size;
			const parentRef = params.parent === 'root' ? null : params.parent;

			// Tx 1: Ziel, Ordnerpfad, Name/Konflikt, Kontingent (Vorprüfung; Tx 2 prüft mit der echten Größe erneut).
			const plan: UploadPlan = await mdb().transaction(async (tx) => {
				const target = await requireFolderTarget(tx, ctx, fields.space, parentRef, keys, 'edit');
				const space = target.folder?.space ?? fields.space;
				const ownerId = target.ownerId;
				const parentId = await ensureFolderPath(tx, {
					space,
					ownerId,
					parentId: target.folder?.id ?? null,
					folders,
					createdBy: ctx.userId
				});
				const where = { space, ownerId, parentId };
				let name = wantedName;
				let replaceId: string | null = null;
				let replacedSize = 0;
				const existing = await sameNamed(tx, where, name);
				if (existing) {
					if (fields.conflict === 'replace') {
						if (existing.kind !== 'file') {
							throw errors.conflict(`Es gibt hier schon einen Ordner „${name}“`);
						}
						replaceId = existing.id;
						replacedSize = existing.sizeBytes;
					} else {
						name = uniqueName(await siblingNames(tx, where), name);
					}
				}
				if (space === 'personal') {
					await assertQuota(tx, ownerId, size - replacedSize, settings.quotaBytes);
				}
				return {
					space,
					ownerId,
					parentId,
					name,
					replaceId,
					nodeId: replaceId ?? crypto.randomUUID()
				};
			});

			// Storage außerhalb der Transaktion
			const bytes = new Uint8Array(await file.arrayBuffer());
			const stored: StoredContent = await storeContent({
				nodeId: plan.nodeId,
				bytes,
				name: plan.name,
				contentType: file.type || null
			});

			// Tx 2: anlegen bzw. ersetzen; bei Namenskonflikt durch parallelen Upload einmal neu versuchen.
			// Fehler hier (auch Kontingent) → hochgeladene Objekte werden unten wieder entfernt.
			const commit = () =>
				mdb().transaction(async (tx) => {
					// Zielordner kann inzwischen gelöscht/verschoben oder der Zugriff entzogen sein
					await requireFolderTarget(tx, ctx, plan.space, plan.parentId, keys, 'edit');
					// Nur ersetzen, wenn die Datei noch genau an diesem Ort liegt (nicht verschoben/gelöscht);
					// sonst als neue Datei anlegen. Bei „Meine Dateien“ zusätzlich gleiche Eigentümer*in.
					let old: Record<string, unknown> | undefined;
					if (plan.replaceId) {
						const ownerCond =
							plan.space === 'personal' ? sql`AND owner_id = ${plan.ownerId}` : sql``;
						[old] = await rowsOf(
							tx,
							sql`SELECT storage_path, thumb_path, size_bytes FROM nodes
								WHERE id = ${plan.replaceId} AND kind = 'file' AND deleted_at IS NULL
									AND parent_id IS NOT DISTINCT FROM ${plan.parentId}
									AND space = ${plan.space} ${ownerCond}
								FOR UPDATE`
						);
					}
					if (plan.space === 'personal') {
						const replacedSize = old ? Number(old.size_bytes ?? 0) : 0;
						await assertQuota(
							tx,
							plan.ownerId,
							stored.sizeBytes - replacedSize,
							settings.quotaBytes
						);
					}
					if (plan.replaceId) {
						if (old) {
							await tx.execute(
								sql`UPDATE nodes SET storage_path = ${stored.storagePath},
									thumb_path = ${stored.thumbPath}, content_type = ${stored.contentType},
									size_bytes = ${stored.sizeBytes}, updated_at = now()
									WHERE id = ${plan.replaceId}`
							);
							return {
								id: plan.replaceId,
								replaced: true,
								old: [
									old.storage_path == null ? null : String(old.storage_path),
									old.thumb_path == null ? null : String(old.thumb_path)
								]
							};
						}
					}
					// ersetzte Datei ist inzwischen weg (gelöscht/im Papierkorb) → als neue Datei mit neuer ID
					const insertId = plan.replaceId ? crypto.randomUUID() : plan.nodeId;
					let name = plan.name;
					const names = await siblingNames(tx, plan);
					if (names.some((n) => sameKey(n, name))) name = uniqueName(names, name);
					await tx.execute(
						sql`INSERT INTO nodes (id, parent_id, kind, space, owner_id, name, storage_path,
								thumb_path, content_type, size_bytes, created_by)
							VALUES (${insertId}, ${plan.parentId}, 'file', ${plan.space}, ${plan.ownerId},
								${name}, ${stored.storagePath}, ${stored.thumbPath}, ${stored.contentType},
								${stored.sizeBytes}, ${ctx.userId})`
					);
					return { id: insertId, replaced: false, old: [] as (string | null)[] };
				});
			let result: Awaited<ReturnType<typeof commit>>;
			try {
				result = await commit().catch((e: unknown) => {
					// eigene, neue Transaktion: die fehlgeschlagene ist nach 23505 abgebrochen
					if (isUniqueViolation(e)) return commit();
					throw e;
				});
			} catch (e) {
				await removeObjects([stored.storagePath, stored.thumbPath]);
				throw e;
			}
			const { id: nodeId, replaced, old: oldPaths } = result;

			// alte Objekte erst nach erfolgreichem Ersetzen entfernen
			if (replaced) await removeObjects(oldPaths);

			await core.audit.logFromContext(ctx, 'files.node.uploaded', {
				target: nodeId,
				metadata: {
					size: stored.sizeBytes,
					contentType: stored.contentType,
					replaced,
					space: plan.space
				}
			});
			return loadFileNode(ctx, nodeId);
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/nodes/:id/content',
		summary:
			'Datei-Inhalt (inline bei Bild/PDF/Text, sonst Download; `download=1` erzwingt Download)',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		query: contentQuery,
		handler: async ({ ctx, params, query }) => {
			const keys = await keysFor(ctx);
			const node = await mdb().transaction(async (tx) => {
				const { node } = await requireNode(tx, ctx, params.id, keys, 'read');
				return node;
			});
			if (node.kind !== 'file' || !node.storagePath) {
				throw errors.notFound('Datei nicht gefunden');
			}
			// kein Audit: Vorschau/Download wäre zu häufig
			return contentResponse({
				path: node.storagePath,
				name: node.name,
				contentType: node.contentType ?? 'application/octet-stream',
				download: query.download === '1'
			});
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/nodes/:id/thumb',
		summary: 'Vorschaubild (WebP, nur für Bilder)',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const keys = await keysFor(ctx);
			const node = await mdb().transaction(async (tx) => {
				const { node } = await requireNode(tx, ctx, params.id, keys, 'read');
				return node;
			});
			if (node.kind !== 'file' || !node.thumbPath) {
				throw errors.notFound('Kein Vorschaubild vorhanden');
			}
			return thumbResponse(node.thumbPath);
		}
	})
] as unknown as ApiEndpoint[];
