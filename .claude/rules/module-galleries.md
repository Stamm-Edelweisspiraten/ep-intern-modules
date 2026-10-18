---
paths: ["src/lib/modules/galleries/**", "tests/**/galleries*", "src/lib/server/core/images/**", "tests/unit/images*"]
---

# Modul `galleries` (Galerien)

Fotos intern sammeln und ausgewählte Galerien auf der **Stammeswebsite** zeigen. Schema `mod_galleries`, Version 1.1.0,
startet deaktiviert, keine harten Abhängigkeiten; `optionalDependencies: ['members', 'events']` (Gruppen/Mitglieder als
Freigabe-Ziele, Termine für die Zuordnung **ganzer Galerien** (nicht einzelner Bilder) – ohne `events` entfällt die Zuordnung still, Eingabe → 422).
Freigabe nach dem Muster `events` (**Freigabe an Principals**, siehe `architecture.md`), dazu je Galerie **öffentlich/privat**.
Bildverarbeitung serverseitig über den Core-Dienst `core.images` (sharp). Navigation „Galerien“ (Icon `images`).

## Dateien (`src/lib/modules/galleries/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (Rechte, `defaultRoleGrants` Mitglied → `galleries.gallery.view`, Navigation), Migration, `resetAreas`/`resetUsers`, Endpoints (Reihenfolge `website` → `meta` → `images` → `galleries`, erster Treffer gewinnt) |
| `ui.ts` | Route `''` → `GalleriesPage`, `':id'` → `GalleryDetailPage` |
| `schemas.ts` | API-Vertrag (Server + UI): `galleryInput`, `coverInput`, `uploadFields`, `imageUpdateInput`, `imageBulkInput` (`BULK_ACTIONS`), `shareInput`, `eventId`, Params (`idParams`, `imageParams`, `variantParams`, `websiteVariantParams`), Queries (`listQuery`, `principalSearchQuery`, `eventSearchQuery`, `websiteListQuery`, `websiteImagesQuery`), Konstanten (`VISIBILITIES` + Labels/Beschreibungen, `IMAGE_VARIANTS`, `WEBSITE_VARIANTS`, `IMAGE_CONTENT_TYPES`/`IMAGE_ACCEPT`, `MAX_IMAGE_BYTES` 25 MB, `MAX_IMAGES_PER_GALLERY` 2000, `MAX_EVENTS_PER_IMAGE` 20, `MAX_SHARES` 200, `MAX_BULK` 200, `UPLOAD_CONCURRENCY` 3), DTOs `GalleryItem`, `GalleryDetail`, `GalleryImage`, `GalleryShare`, `EventRef`, `ImageCover`, `Website*`, Helfer `imageUrl()` |
| `access.ts` | Objektzugriff: `resolveAccess`, `requireAccess` (404/403), `visibleGalleriesFilter` (SQL, Alias `g`), `accessForMany`, `canEditAll`/`canViewAll`, `rowsOf` |
| `files.ts` | `db()`, `filesCtx()` (Systemkontext `galleries-files`), `VARIANT_SPECS`, `variantPath`, `VARIANT_COLUMN`, `removeFiles` (best-effort), `fileResponse` (rohe Response), `effectiveCoverSql`/`effectiveCover`, `eventsService()` |
| `galleries.service.ts` | `loadShares`/`replaceShares`, Termine der Galerie: `loadEventIds`, `eventIdsByGallery`, `replaceGalleryEvents`, `validateEventIds(ctx, ids, keep)`, `describeEvents`/`pickEvents`; `loadDetailData` (in der Transaktion, prüft Lesezugriff) + `finishDetail` (danach: Eigentümer*in, Termine, Freigaben), `buildGalleryDetail(ctx, id, keys)`, `describeShares`, `everyoneLabel()` (Einstellung `events.stamm.name`, sonst „Stamm“), `iso`, `likePattern` |
| `images.service.ts` | `IMAGE_COLUMNS` (Alias `i`), `toGalleryImage`, `requireImageRow`/`requireImagesOfGallery`, `imagePathsOf`, `sanitizeOriginalName`, `downloadName` |
| `galleries.endpoints.ts` | CRUD `/galleries`, Titelbild `/galleries/:id/cover` |
| `images.endpoints.ts` | Upload, Bearbeiten, Sammelaktionen, Löschen, Auslieferung der Varianten |
| `meta.endpoints.ts` | `/principals`, `/events` (Terminsuche über den `events`-Dienst), `/settings/stamm` → `{ name }` (für `everyoneLabel`) |
| `website.endpoints.ts` | `/website/galleries[/:id]` (mit Website-Terminen, Filter `eventId`), Bilddateien `thumb`/`web` |
| `reset.ts` | Reset-Bereich `all` (vier Tabellen, Kind vor Eltern, `storagePrefixes: 'all'`, `rebuild`), `resetUsers` (Benutzer-Freigaben löschen, `owner_id`/`created_by`/`uploaded_by` auf den verbleibenden Benutzer) |
| `pages/GalleriesPage.svelte` | Kartenraster mit Titelbild, Badge Öffentlich/Privat, Suche/Filter, „Neue Galerie“ |
| `pages/GalleryDialog.svelte` | Anlegen/Bearbeiten: Titel, Beschreibung, Sichtbarkeit, **Termine** (`EventPicker`), `SharePanel` lokal (nur Anlegen) |
| `pages/GalleryDetailPage.svelte` | Kopf mit **`ShareMenu` oben rechts** (`type`, `everyoneLabel`), Bearbeiten/Löschen, Bilder |
| `pages/UploadZone.svelte` | Mehrfachauswahl, Drag & Drop, Fortschritt, 3 Uploads parallel (`UPLOAD_CONCURRENCY`) |
| `pages/ImageGrid.svelte` | Bildraster (`thumb`), Badge „Titelbild“, Auswahlmodus |
| `pages/ImageViewer.svelte` | Lightbox (←/→), Beschreibung bearbeiten, „Als Titelbild festlegen“, Download `full` |
| `pages/EventPicker.svelte` | Terminsuche (`GET /events?search=`), Mehrfachauswahl – im `GalleryDialog` (Feld „Termine“) |
| `pages/EventBadges.svelte` | Termine als Badges (Detailkopf; Karte mit `max={1} compact`) |
| `pages/ImageBulkBar.svelte` | Sammelleiste im Auswahlmodus: Löschen |
| `migrations/0001_init.sql` | Schema |

## Datenmodell (0001)
- IDs sind `text` (UUID per `crypto.randomUUID()`), Zeitstempel `timestamptz`, keine FKs auf Core-/Fremdschemata.
- `galleries`: `id`, `title`, `description`, `visibility` CHECK `private|public` (Standard `private`), `cover_image_id`
  (NULL = Standard, FK `galleries_cover_fk` → `gallery_images` **ON DELETE SET NULL**), `owner_id` (ohne FK), `created_by`,
  `created_at`, `updated_at`. Indizes `owner_id`, `visibility`.
- `gallery_images` (FK `gallery_id` CASCADE): `description`, `position`, `original_name`, `content_type`, `width`, `height`,
  `size_bytes`, `thumb_path`, `web_path`, `full_path`, `uploaded_by`, `created_at`. Index `(gallery_id, created_at, id)`.
  Gespeichert werden **nur** metadatenfreie Varianten, nie das Original.
- `gallery_image_events` (0001) ist mit **0002 entfernt**: Termine hängen seit 0002 an der Galerie.
- `gallery_events` (0002, PK `gallery_id` + `event_id`, FK `gallery_id` CASCADE): Zuordnung der **ganzen Galerie** zu Terminen
  aus `events` (`event_id` ohne FK, anderes Schema), Index `event_id`. Migration 0002 hat vorhandene Bild-Zuordnungen auf die Galerie übernommen.
- `gallery_shares`: `<obj>_shares`-Muster (PK `gallery_id` + `principal_type` + `principal_id`, `principal_type` CHECK
  `everyone|group|role|user|member`, `level` CHECK `read|edit`, `created_by`, `created_at`), Index `(principal_type, principal_id)`.

## Titelbild
- **Effektiv** = `cover_image_id` ?? ältestes Bild (`ORDER BY created_at, id`) – `effectiveCoverSql` (Alias `g`) bzw. `effectiveCover(tx, id)`.
- `PUT /galleries/:id/cover` mit `{ imageId }` setzt, `{ imageId: null }` setzt auf Standard zurück; Bild muss zur Galerie gehören (422).
- Gelöschtes Titelbild → FK setzt NULL → wieder Standard. Detail liefert `coverImageId` (effektiv) und `coverIsDefault`; ohne Bilder `cover: null`.

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `galleries.gallery.view` | Grundrecht für alle internen Endpoints; sieht eigene, freigegebene und **öffentliche** Galerien. Rolle „Mitglied“ per `defaultRoleGrants` |
| `galleries.gallery.create` | Galerien anlegen (Handler prüft zusätzlich `view`; nur Benutzer, System → 400) |
| `galleries.gallery.view-all` | alle Galerien lesen |
| `galleries.gallery.edit-all` | alle Galerien bearbeiten/löschen; System-Kontext ebenso |
| `galleries.website.read` | **nur** `/website/…` – Scope für den API-Key der Stammeswebsite; kein Zugriff auf interne Endpoints |

Keine `galleries.storage.*`-Rechte: Dateien werden nach der Objektprüfung mit dem Systemkontext gelesen/geschrieben.

## Zugriffsregeln (`access.ts`)
1. System oder `edit-all` → bearbeiten. 2. Eigentümer*in (`owner_id`) → bearbeiten. 3. Freigabe `edit` an einen passenden
Principal → bearbeiten. 4. Freigabe `read`, `view-all` **oder `visibility = public`** → lesen. 5. Sonst **404**; Lesen ohne
Bearbeiten bei Änderungen → **403**.
- Principal-Schlüssel immer **vor** der Transaktion: `principalKeysFor(ctx, 'galleries')`; in SQL `principalMatchSql('s', keys)`.
- Freigaben wie bei `events`: `validatePrincipals` (422 `['shares', i, 'id']`), `describePrincipals`, `searchPrincipals`;
  `PUT` ersetzt Freigaben komplett, `shares` im Detail nur bei Bearbeiten-Zugriff.
- `public` heißt: **alle** Konten mit `galleries.gallery.view` (auch Elternkonten) sehen die Galerie, und die Website darf sie abrufen.

## API (`/api/v1/modules/galleries/…`, Session oder API-Key, nicht öffentlich)
| Methode + Pfad | Recht | Besonderheiten |
|---|---|---|
| GET `/galleries` | gallery.view | sichtbare Galerien; Query `search`, `visibility`, `eventId` (Galerien zu einem Termin), `limit` 1–200 (50), `offset`; Item mit Titel, Sichtbarkeit, `imageCount`, `cover { imageId, width, height }`, `events` (sichtbare Termine), `access` |
| GET `/galleries/:id` | gallery.view | Detail inkl. `events` (nur für den Aufrufer sichtbare Termine) und Bilder (Beschreibung, Maße), `coverImageId` + `coverIsDefault`, `shares` nur bei `edit` |
| POST `/galleries` | gallery.create | `galleryInput` strikt (`title`, `description`, `visibility`, `shares`, `eventIds` ≤ 20); Eigentümer*in = Aufrufer; Termine über den `events`-Dienst geprüft (422 `eventIds[i]`; `events` inaktiv + nicht leer → 422 `eventIds`) |
| PUT `/galleries/:id` | Objekt-`edit` | ersetzt alles inkl. Freigaben und Termine; bereits gespeicherte, inzwischen unsichtbare Termine bleiben ungeprüft |
| DELETE `/galleries/:id` | Objekt-`edit` | CASCADE; Dateien **nach** der Transaktion best-effort entfernen |
| PUT `/galleries/:id/cover` | Objekt-`edit` | `{ imageId \| null }` (null = Standard); fremdes Bild → 422 |
| POST `/galleries/:id/images` | Objekt-`edit` | multipart `file` (+ optional `description`), ≤ 25 MB, ≤ 2000 Bilder je Galerie; **ein Request je Datei** |
| PUT `/galleries/:id/images/:imageId` | Objekt-`edit` | `{ description }` (strikt; `eventIds` am Bild → 422) |
| POST `/galleries/:id/images/bulk` | Objekt-`edit` | `{ action: 'delete', ids ≤ 200 }` → `{ affected }` |
| DELETE `/galleries/:id/images/:imageId` | Objekt-`edit` | Bild + Dateien |
| GET `/galleries/:id/images/:imageId/:variant` | gallery.view + Objekt-`read` | `thumb\|web\|full`, rohe Response, `private, max-age=3600`, `nosniff`; `full` mit `content-disposition: attachment` |
| GET `/principals` | gallery.view | Query `search` (2–100 Zeichen) → `searchPrincipals` |
| GET `/events` | gallery.view | Terminsuche (`search`, `limit` 1–50) über den `events`-Dienst, nur sichtbare Termine; ohne `events` bzw. ohne `events.event.view` → `[]` |
| GET `/website/galleries` | **website.read** | nur `public`: `id`, `title`, `description`, `imageCount`, `cover`, `events` (nur `onWebsite`), `updatedAt`; `eventId` = nur Galerien zu diesem Website-Termin (sonst leer); `limit`/`offset`; Rate-Limit 120/60 s |
| GET `/website/galleries/:id` | **website.read** | öffentliche Galerie (mit `events`, nur `onWebsite`) + Bilder (`id`, Beschreibung, Maße, `position`); privat → 404 |
| GET `/website/galleries/:id/images/:imageId/:variant` | **website.read** | nur `thumb\|web` (`full` → 422), Bild einer privaten Galerie → 404, Rate-Limit 600/60 s, `public, max-age=86400` |

Audit: `galleries.gallery.created|updated|deleted|cover_changed`, `galleries.image.uploaded|updated|deleted|bulk_updated` –
`target` = ID, metadata nur IDs/Zähler/`visibility`, **keine** Beschreibungen oder Dateinamen.

## Website-Anbindung
- Nur Galerien mit `visibility = public`, nur öffentliche Felder (`WebsiteGallery`, `WebsiteImage`): keine Freigaben,
  Eigentümer*innen, Dateinamen, Uploader. Termine der Galerie nur, wenn sie selbst „auf der Website“ stehen (`websiteEventRefs`). Bilder zu einem Termin: `GET /website/galleries?eventId=` und dann das Detail.
- **Bilddateien nur mit Key** über `/website/galleries/:id/images/:imageId/thumb|web`; `full` gibt es für die Website **nie**.
  Es gibt keine öffentlichen oder signierten Bild-URLs – die Website lädt Bilder serverseitig und liefert sie selbst aus (bzw. cacht sie).
- Einrichtung wie bei `events`: Benutzer*in mit `galleries.website.read` legt einen API-Key mit **nur** dem Scope
  `galleries.website.read` an (ggf. zusammen mit `events.website.read` in einem Key). Abruf **serverseitig** (Key nie im Browser, kein CORS):
  ```bash
  curl -H "Authorization: Bearer epk_…" \
    "https://intern.example.org/api/v1/modules/galleries/website/galleries?limit=20"
  curl -H "Authorization: Bearer epk_…" -o bild.webp \
    "https://intern.example.org/api/v1/modules/galleries/website/galleries/<id>/images/<imageId>/web"
  ```
- Antworten cachen; Modul deaktiviert → `404 module_disabled`. Ein Key nur mit diesem Scope bekommt intern **403**.

## Bildverarbeitung (`core.images`, `src/lib/server/core/images/index.ts`)
- `core.images.process(bytes, { variants, maxInputPixels?, maxInputBytes? })` → `{ format, width, height, hasAlpha, variants[] }`
  (je Variante `bytes`, `contentType`, `extension`, `width`, `height`). sharp **nur im Core**; Typen über `$lib/sdk/server`.
- Prüft den **Inhalt** per sharp-Metadaten (JPEG, PNG, WebP, AVIF, GIF – nur erstes Bild), nicht den angegebenen Typ;
  `limitInputPixels` 50 MP, ≤ 25 MB. Dreht nach EXIF (`rotate()`), **entfernt alle Metadaten** (EXIF inkl. GPS, XMP, IPTC; ICC → sRGB).
- Varianten (`VARIANT_SPECS` in `files.ts`): `thumb` 480 px lange Kante WebP q75, `web` 2048 px WebP q82, `full`
  Originalauflösung metadatenfrei, JPEG q90 bzw. PNG bei Transparenz (`format: 'auto'`). Nie vergrößern.
- Fehler: leer/unlesbar/nicht unterstützt/zu viele Pixel → 400 (`badRequest`), zu groß → 413 (`tooLarge`); Texte deutsch mit Umlauten.

## Storage
- Dateien über `core.storage` mit `filesCtx()` = `core.auth.systemContext('galleries-files')`, **erst nach** der Objektprüfung
  (Muster `actions/service.ts`). Pfad `<galleryId>/<imageId>-<variant>.<webp|jpg|png>` (`variantPath`).
- Upload: verarbeiten → Storage → DB; bei DB-Fehler Dateien best-effort entfernen (`removeFiles`). Ohne S3 → **503**.
- Core-Aufrufe (`storage`, `audit`, `users.directory`, `events`-Dienst) **nie** in offener Modul-Transaktion (PGlite).
- Reset `all` löscht Dateien per `storagePrefixes: 'all'` (`core.storage.purge`).

## Tests
- Unit: `tests/unit/images.test.ts` (sharp-erzeugte Testbilder: EXIF-Drehung, Metadaten/GPS weg, Größen der Varianten,
  PNG mit Transparenz, falsches Format/Pixelgrenze, AVIF/GIF; HEIC abgelehnt), `galleries-schemas.test.ts`, `galleries-reset.test.ts`
  (Titelbild-FK `SET NULL` von der Reihenfolge-Prüfung ausgenommen), `galleries-files.test.ts`.
- Integration: `galleries.test.ts` (Zugriffsmatrix Owner/Freigabe/Public/view-all/edit-all/fremd 404, 422, Audit ohne Inhalte,
  Modul aus → 404), `galleries-images.test.ts` (Upload mit `tests/helpers/fake-storage.ts`, Titelbild-Fallback, Termin-Zuordnung der Galerie
  mit/ohne `events`, Sammelaktionen), `galleries-website.test.ts` (nur `public`, Felder, Varianten, Key nur mit Scope → 403 intern),
  `events-refs.test.ts` (Dienst `EventRefsService`).
- E2E: `tests/e2e/galleries.spec.ts` (ohne S3: aktivieren, anlegen per Dialog, Teilen „Stamm (alle)“, bearbeiten, Filter, löschen; Upload ohne S3 → „Dateispeicher nicht eingerichtet“). Upload-Erfolg über Integrationstests (Fake-Storage) und manuell mit MinIO (API).

## Entscheidungen und offen
- **Termine je Galerie, nicht je Bild** (Wunsch des Nutzers, 2026-10-18): eine Galerie gehört zu einem oder mehreren Terminen;
  einzelne Bilder haben keine Termine (API, UI und Website entsprechend, Migration 0002).
- Termin-Zuordnung über `events`-Dienst (`events/contract.ts`, `EventRefsService`: `searchEventRefs`, `describeEventRefs`,
  `websiteEventRefs`) per `core.modules.useOptional('events', 'galleries')`; Termine im Detail nur, wenn der Aufrufer sie sehen darf.
- **HEIC/HEIF nicht unterstützt** (sharp-Prebuilt ohne HEIC; Safari/iOS wandelt beim Upload meist in JPEG).
- **Kein Sortieren per Drag & Drop**: Reihenfolge = Upload-Reihenfolge (`created_at`, `id`; `position` vorhanden, aber nicht änderbar).
- Website lädt Bilder **serverseitig** mit Key; keine öffentlichen Bild-URLs, kein CORS.
- Öffentliche Galerien sind für die Website gedacht: Beschreibungen ohne personenbezogene Daten pflegen; Einwilligungen
  (Fotos von Kindern) prüft das System nicht.
- Demo: `scripts/seed-demo-galleries.mjs` (braucht MinIO; Login über `DEMO_EMAIL`/`DEMO_PASSWORD`, Standard `admin@demo.test`).
- Wie bei `events`: Wer per `edit`-Freigabe die **eigene** Freigabe entfernt, bekommt 404 und die Änderung wird zurückgenommen (Detail wird in derselben Transaktion neu geladen) – Doku von `events` sagt „darf sich selbst entfernen“, Code verhält sich wie hier. Offen.
- Nicht geprüft: Docker-Image-Build mit sharp (Produktions-Build lokal grün, sharp bleibt extern), Upload mit echtem S3 **in der Oberfläche** (per API mit MinIO geprüft).
