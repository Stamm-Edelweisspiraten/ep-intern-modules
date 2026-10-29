/**
 * KI-Schreibhilfe in Galerien: Beschreibung einer Galerie und Bildbeschreibung (Alternativtext).
 * Kontext `galleries:image` (ID `<galerie>:<bild>`) liefert die Web-Variante – ohne Metadaten, weil
 * `core.images.process` beim Hochladen alles entfernt; der Core schickt sie nur mit `core.ai.assist.allowImages`.
 */
import {
	core,
	isCoreError,
	principalKeysFor,
	type ModuleAssist,
	type RequestContext
} from '$lib/sdk/server';
import { ASSIST_TEXT_TASKS } from '$lib/sdk/types/assist';
import { resolveAccess } from './access';
import { db, filesCtx } from './files';
import { imagePathsOf, requireImageRow } from './images.service';
import { MAX_DESCRIPTION, MAX_IMAGE_DESCRIPTION, MODULE_ID } from './schemas';

export const PERM_AI = 'galleries.ai.use';

async function imageContext(ctx: RequestContext, id: string) {
	if (!ctx.permissions.has('galleries.gallery.view')) return null;
	const [galleryId, imageId] = id.split(':');
	if (!galleryId || !imageId) return null;
	const keys = await principalKeysFor(ctx, MODULE_ID);
	const found = await db().transaction(async (tx) => {
		if (!(await resolveAccess(tx, ctx, galleryId, keys))) return null;
		try {
			return imagePathsOf(await requireImageRow(tx, galleryId, imageId));
		} catch (e) {
			if (isCoreError(e) && e.code === 'not_found') return null;
			throw e;
		}
	});
	if (!found) return null;
	const { buffer, file } = await core.storage.download(filesCtx(), {
		module: MODULE_ID,
		path: found.paths.web
	});
	const b64 = Buffer.from(buffer).toString('base64');
	return { facts: {}, images: [`data:${file.contentType};base64,${b64}`] };
}

export const galleriesAssist: ModuleAssist = {
	purposes: {
		'gallery-description': {
			label: 'Beschreibung einer Galerie',
			description:
				'Kurzer Text zu einer Fotogalerie (Fahrt, Lager, Aktion), ggf. öffentlich auf der Website. Keine Namen von Kindern.',
			format: 'plain',
			maxChars: MAX_DESCRIPTION,
			tasks: ASSIST_TEXT_TASKS,
			extraKeys: { title: 'Titel (Formular)', event: 'Termin (Formular)' }
		},
		'image-alt': {
			label: 'Beschreibung eines Bildes',
			description:
				'Alternativtext für ein Foto aus dem Stammesleben (für Screenreader und die Website). Keine Namen, keine Vermutungen über Personen.',
			format: 'plain',
			maxChars: MAX_IMAGE_DESCRIPTION,
			tasks: ['alt-text', 'rewrite', 'shorter', 'spelling'],
			contexts: ['galleries:image']
		}
	},
	contexts: { image: imageContext }
};
