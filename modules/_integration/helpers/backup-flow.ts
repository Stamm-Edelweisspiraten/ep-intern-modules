/**
 * Ablauf-Helfer für Datensicherungs-Tests: Export → Datei, Upload in Stücken, Vorschau, Ausführen,
 * Tabellenabzug (Geheimnisse als Klartext-Marker, damit neu verschlüsselte Werte vergleichbar sind).
 */
import { expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/core/database/client';
import { startBackupExport, takeBackupDownload } from '$lib/server/core/backup/export';
import { listBackupScopes } from '$lib/server/core/backup/scopes';
import { loadTableInfo } from '$lib/server/core/backup/introspect';
import { encodeRowSecrets } from '$lib/server/core/backup/secrets';
import {
	analyzeBackup,
	appendUpload,
	createUpload,
	executeRestore,
	waitForRestore
} from '$lib/server/core/backup/restore';
import { MERGE_CONFIRM_WORD, RESTORE_CONFIRM_WORD } from '$lib/server/core/backup/types';
import { resetAllForTests } from '$lib/server/core/rate-limit';
import type { ExportSummary, RestorePreview, RunStatus } from '$lib/backup/contract';
import type { RequestContext } from '$lib/sdk/types';
import { SEED_PASSWORD } from './backup-seed';

export const BACKUP_PW = 'Sicherung-Passwort-2026';

/**
 * Tabellen, die sich durch Export/Wiederherstellen legitim ändern und deshalb nicht verglichen werden:
 * - `audit_log`: Export und Wiederherstellen schreiben selbst Einträge (`backup_exported`/`backup_restored`)
 * - `api_log`, `job_run`: Protokolle laufender Aufrufe/Jobs
 * - `session`, `verification`: werden nie gesichert; Wiederherstellen von Benutzern löscht fremde Sitzungen/Links
 * - `module_state`, `module_migration`: nicht gesichert, Zeitstempel ändern sich beim erneuten Migrieren
 */
export const VOLATILE_TABLES = new Set([
	'public.audit_log',
	'public.api_log',
	'public.job_run',
	'public.session',
	'public.verification',
	'public.module_state',
	'public.module_migration'
]);

/**
 * Spalten, die nach dem Wiederherstellen neu gebildet werden: `user_role_grant` baut der Abgleich-Job
 * `offices.sync-grants` nach dem Wiederherstellen neu auf (gleiche Zeilen, neuer Zeitstempel).
 */
export const DERIVED_COLUMNS: Record<string, string[]> = {
	'public.user_role_grant': ['created_at']
};

/** Alle Zeilen aller Tabellen (`public` + `mod_*`), Geheimnisse als Klartext, je Tabelle sortiert. */
export async function dumpAll(
	exclude: Set<string> = VOLATILE_TABLES
): Promise<Record<string, string[]>> {
	const schemas = (
		(await getDb().execute(
			sql`SELECT nspname::text AS n FROM pg_catalog.pg_namespace WHERE nspname = 'public' OR nspname LIKE 'mod\_%'`
		)) as unknown as { rows: { n: string }[] }
	).rows.map((r) => r.n);
	const out: Record<string, string[]> = {};
	for (const t of await loadTableInfo(getDb(), schemas)) {
		const name = `${t.schema}.${t.table}`;
		if (exclude.has(name)) continue;
		out[name] = await dumpTable(name);
	}
	return out;
}

export async function dumpTable(name: string): Promise<string[]> {
	const [schema, table] = name.split('.') as [string, string];
	const [t] = await loadTableInfo(getDb(), [schema]).then((l) =>
		l.filter((x) => x.table === table)
	);
	if (!t) return [];
	const res = (await getDb().execute(
		sql.raw(`SELECT row_to_json(x)::text AS j FROM "${schema}"."${table}" x`)
	)) as unknown as { rows: { j: string }[] };
	const rows: string[] = [];
	for (const r of res.rows) {
		const { row } = await encodeRowSecrets(t, JSON.parse(r.j) as Record<string, unknown>);
		for (const c of DERIVED_COLUMNS[name] ?? []) delete row[c];
		rows.push(JSON.stringify(row));
	}
	return rows.sort();
}

export async function allScopeKeys(): Promise<string[]> {
	return (await listBackupScopes()).map((s) => s.key);
}

export async function exportBackup(
	ctx: RequestContext,
	opts: { scopes?: string[]; includeFiles?: boolean; password?: string; totp?: string } = {}
): Promise<{ bytes: Uint8Array; summary: ExportSummary; fileName: string }> {
	resetAllForTests();
	const res = await startBackupExport(ctx, {
		scopes: opts.scopes ?? (await allScopeKeys()),
		includeFiles: opts.includeFiles ?? true,
		backupPassword: BACKUP_PW,
		password: opts.password ?? SEED_PASSWORD,
		...(opts.totp ? { totp: opts.totp } : {})
	});
	const dl = await takeBackupDownload(ctx, res.downloadId);
	const bytes = new Uint8Array(await readFile(dl.path));
	await dl.done();
	return { bytes, summary: res.summary, fileName: res.fileName };
}

export async function uploadBackup(ctx: RequestContext, bytes: Uint8Array): Promise<string> {
	const { uploadId, chunkBytes } = await createUpload(ctx, { size: bytes.length });
	for (let off = 0; off < bytes.length; off += chunkBytes) {
		const part = bytes.subarray(off, off + chunkBytes);
		const p = await appendUpload(
			ctx,
			uploadId,
			off,
			new Response(Buffer.from(part)).body!,
			part.length
		);
		expect(p.received).toBe(off + part.length);
	}
	return uploadId;
}

export async function previewBackup(
	ctx: RequestContext,
	bytes: Uint8Array,
	opts: { password?: string; backupPassword?: string; totp?: string } = {}
): Promise<RestorePreview> {
	resetAllForTests();
	const uploadId = await uploadBackup(ctx, bytes);
	return analyzeBackup(ctx, {
		uploadId,
		backupPassword: opts.backupPassword ?? BACKUP_PW,
		password: opts.password ?? SEED_PASSWORD,
		...(opts.totp ? { totp: opts.totp } : {})
	});
}

export async function runRestore(
	ctx: RequestContext,
	preview: RestorePreview,
	opts: {
		mode?: 'restore' | 'merge';
		scopes?: string[];
		takeSmtp?: boolean;
		applyModuleState?: boolean;
	} = {}
): Promise<RunStatus> {
	const mode = opts.mode ?? 'restore';
	const { runId } = await executeRestore(ctx, {
		token: preview.token,
		mode,
		scopes: opts.scopes ?? preview.scopes.map((s) => s.key),
		takeSmtp: opts.takeSmtp ?? false,
		applyModuleState: opts.applyModuleState ?? true,
		confirmWord: mode === 'restore' ? RESTORE_CONFIRM_WORD : MERGE_CONFIRM_WORD
	});
	const status = await waitForRestore(runId);
	expect(status.state, status.error).toBe('done');
	return status;
}

/** Fehler einer Promise als CoreError-ähnliches Objekt (Status/Code/Details) */
export async function failure(
	p: Promise<unknown>
): Promise<{ status?: number; code?: string; details?: unknown; message?: string }> {
	try {
		await p;
	} catch (e) {
		return e as { status?: number; code?: string; details?: unknown; message?: string };
	}
	throw new Error('Fehler erwartet, aber erfolgreich');
}
