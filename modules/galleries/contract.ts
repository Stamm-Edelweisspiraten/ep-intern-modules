/**
 * Vertrag der Dienste, die `galleries` anderen Modulen anbietet (`ModuleDefinition.provides`).
 * Abruf: `await core.modules.useOptional<GalleryRefsService>('galleries', '<aufrufendes Modul>')`
 * (Aufrufer führt `galleries` in `optionalDependencies`). Nur AUSSERHALB offener Transaktionen aufrufen.
 */

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
}
