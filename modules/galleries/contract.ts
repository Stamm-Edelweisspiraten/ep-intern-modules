/**
 * Vertrag der Dienste, die `galleries` anderen Modulen anbietet (`ModuleDefinition.provides`).
 * Abruf: `await core.modules.useOptional<GalleryRefsService>('galleries', '<aufrufendes Modul>')`
 * (Aufrufer führt `galleries` in `optionalDependencies`). Nur AUSSERHALB offener Transaktionen aufrufen.
 */

import type { RequestContext } from '$lib/sdk/types';

/** Kurzverweis auf eine öffentliche Galerie */
export interface GalleryRefInfo {
	id: string;
	title: string;
	imageCount: number;
}

export interface GalleryRefsService {
	/**
	 * Öffentliche Galerien (auf der Stammeswebsite sichtbar), Suche im Titel, zuletzt geänderte zuerst,
	 * höchstens `limit` (1–50, Standard 20). Ohne Rechteprüfung – öffentliche Galerien sind für alle sichtbar.
	 */
	searchPublicGalleryRefs(opts?: { search?: string; limit?: number }): Promise<GalleryRefInfo[]>;
	/** Öffentliche Galerien aus `ids` (unbekannte/private fehlen), Reihenfolge wie `ids`, höchstens 100 */
	publicGalleryRefs(ids: readonly string[]): Promise<GalleryRefInfo[]>;
	/**
	 * Galerien, die `ctx` sehen darf (wie `GET /galleries`: eigene, öffentliche, freigegebene, `view-all`), Suche im Titel,
	 * zuletzt geänderte zuerst, höchstens `limit` (1–50, Standard 20). Prüft `galleries.gallery.view` selbst (sonst leer).
	 */
	searchGalleryCards(
		ctx: RequestContext,
		opts?: { search?: string; limit?: number }
	): Promise<GalleryCardInfo[]>;
	/** Nur die für `ctx` sichtbaren Galerien aus `ids` (höchstens 200), Reihenfolge wie `ids` */
	describeGalleryCards(ctx: RequestContext, ids: readonly string[]): Promise<GalleryCardInfo[]>;
}

/** Galerie für Karten in anderen Modulen (nur für Personen mit Zugriff) */
export interface GalleryCardInfo extends GalleryRefInfo {
	visibility: 'public' | 'private';
	/** Vorschaubild des Titelbilds (bzw. ersten Bilds) über die API, `null` ohne Bilder */
	coverUrl: string | null;
	/** Pfad in der App */
	href: string;
}
