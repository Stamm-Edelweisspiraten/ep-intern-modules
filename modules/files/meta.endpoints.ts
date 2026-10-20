/**
 * Metadaten für die Oberfläche: Kontingent, Upload-Grenzen, Papierkorb-Dauer, Fähigkeiten des Aufrufers.
 */
import { core, defineEndpoint, type ApiEndpoint } from '$lib/sdk/server';
import { canManageAll } from './access';
import { filesSettings, mdb } from './db';
import { quotaUsed, storageLimits } from './storage';
import { PERMISSIONS, type FilesMeta } from './schemas';

const TAGS = ['Modul: files'];

export const metaEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/meta',
		summary: 'Kontingent, Upload-Grenzen, Papierkorb-Dauer und Rechte des Aufrufers',
		tags: TAGS,
		permission: PERMISSIONS.view,
		handler: async ({ ctx }): Promise<FilesMeta> => {
			// Einstellungen/Grenzen vor der Transaktion lesen (Core-Services, PGlite)
			const settings = await filesSettings();
			const limits = await storageLimits();
			const userId = ctx.userId;
			const usedBytes = userId ? await mdb().transaction((tx) => quotaUsed(tx, userId)) : 0;
			return {
				quota: { usedBytes, limitBytes: settings.quotaBytes },
				maxFileBytes: limits.maxFileBytes,
				allowedContentTypes: limits.allowedContentTypes,
				trashDays: settings.trashDays,
				can: {
					linkCreate: core.permissions.has(ctx, PERMISSIONS.linkCreate),
					manageAll: canManageAll(ctx)
				}
			};
		}
	})
] as ApiEndpoint[];
