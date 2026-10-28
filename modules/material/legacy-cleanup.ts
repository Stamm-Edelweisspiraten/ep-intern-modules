/**
 * Einmalige Aufräumarbeit nach dem Neuaufbau (Migration 0004): Bilddateien des alten Bestands im Storage
 * löschen. Läuft als Job, bis es einmal geklappt hat (Marker in `legacy_cleanup`); ohne Storage nichts zu tun.
 */
import { sql } from 'drizzle-orm';
import { mdb, rows } from './db';
import { removeLegacyImages } from './files';

export async function runLegacyCleanup(): Promise<string> {
	const [open] = await mdb().transaction((tx) =>
		rows(tx, sql`SELECT id FROM legacy_cleanup WHERE id = 'v1-images' AND done_at IS NULL`)
	);
	if (!open) return 'Nichts zu tun';
	let removed = 0;
	try {
		removed = await removeLegacyImages();
	} catch (e) {
		// Ohne konfigurierten Storage gibt es auch keine alten Dateien
		const code = (e as { code?: string }).code;
		if (code !== 'unavailable') throw e;
	}
	await mdb().transaction((tx) =>
		tx.execute(sql`UPDATE legacy_cleanup SET done_at = now() WHERE id = 'v1-images'`)
	);
	return `${removed} alte Bilddatei(en) gelöscht`;
}
