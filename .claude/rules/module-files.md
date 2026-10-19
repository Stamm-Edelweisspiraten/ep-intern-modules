---
paths: ["src/lib/modules/files/**", "tests/**/files*", "tests/helpers/s3-mock.ts", "scripts/seed-demo-files.mjs"]
---

# Modul `files` (Dateien / Cloud-Ablage)

Cloud-Ablage des Stammes: jede Person hat **„Meine Dateien“** (eigene Ablage mit Kontingent), dazu der gemeinsame **Stammesordner**
(„Stamm“). Ordner und Dateien lassen sich hochladen (auch ganze Ordner per Drag & Drop), umbenennen, verschieben, in den Papierkorb legen,
an **Principals** freigeben (Lesen/Bearbeiten, vererbt) und über **öffentliche Links** an Personen ohne Konto weitergeben. Vorschau für
Bilder, PDFs und Text. Schema `mod_files`, Version 1.0.0, keine harten Abhängigkeiten, optional `members` (Gruppen/Mitglieder als
Freigabe-Ziele). Navigation „Dateien“ (Icon `cloud`). Inhalte liegen im Core-Storage (S3, Modul `files`), Zugriff per Systemkontext
`files-storage` **nach** der Objektprüfung (Benutzer brauchen keine `files.storage.*`-Rechte).

## Entscheidungen des Nutzers (2026-10-19, nicht ungefragt ändern)
- Freigabe an **Principals** (Stamm, Gruppe, Rolle, Mitglied, Benutzer*in; `read`/`edit`) wie `events`/`galleries`.
- Öffentliche Links auch für Personen **ohne Konto**: Ablaufdatum, optionales Passwort, widerrufbar, rate-limitiert, **nur ansehen/herunterladen**.
- Drag & Drop für Dateien **und** Ordner (Upload von außen, Verschieben intern).
- Vorschau für **Bilder und PDFs** (+ Text).
- **Nicht im Umfang**: Sync-Client, Versionen, gemeinsames Bearbeiten, Videos.

## Dateien (`src/lib/modules/files/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (5 Rechte + Beschreibungen, `defaultRoleGrants` „Mitglied“ → `files.file.view`, Navigation), Einstellungen, Migrationen, `resetAreas`/`resetUsers`, Job `purge-trash` (täglich), Endpoint-Reihenfolge links → meta → trash → shares → upload → nodes (öffentliche/feste Pfade vor `:id`) |
| `ui.ts` | Route `''` → `FilesPage`; `publicRoutes` `link/:token` → `PublicLinkPage` |
| `schemas.ts` | API-Vertrag (Server + UI): `PERMISSIONS`, `SETTING_KEYS`, Bereiche `SPACES`/`SPACE_LABELS`, Grenzen (`MAX_NAME` 200, `MAX_DEPTH` 20, `MAX_BULK` 500, `MAX_SHARES` 200, `MAX_LINKS_PER_NODE` 20, `MAX_SEARCH_RESULTS` 100, `MIN_PASSWORD` 8, `MAX_UNLOCK_FAILURES` 10, `LINK_ACCESS_TTL_SEC` 900, `MAX_TEXT_PREVIEW_BYTES` 1 MB, `UPLOAD_CONCURRENCY` 3), Vorschau-Typen, `NEVER_INLINE_TYPES`, `INVISIBLE_CHARS`, Zod (`nodeName`, `folderCreateInput`, `moveInput`, `uploadFields`, `sharesInput`, `linkCreateInput`, …), DTOs `FileNode`, `FolderListing`, `SearchResult`, `TrashItem`, `NodeShares`, `ShareLink`, `PublicLinkInfo`, `PublicListing`, `FilesMeta` |
| `db.ts` | `mdb()`, `filesCtx()` (Systemkontext für Storage), `NodeRow`/`nodeRowOf`/`NODE_COLUMNS`, `loadNode(s)`, `ancestorsOf`/`descendantIds` (rekursive CTEs, Zyklenschutz 64), `userRefs` (nach der Tx), `filesSettings()` |
| `access.ts` | Objektprüfung: `rootAccess`, `resolveAccess`, `requireNode` (404/403), `requireFolderTarget`, `accessForMany` (Listen, ein CTE), `sharedWithMeRoots`, `visibleNodesFilter` (Suche), `canManageAll`/`canSharedEdit`/`canSharedView` |
| `names.ts` (rein) | `normalizeName` (NFC, unsichtbare Zeichen raus, Leerzeichen, Kürzen mit Endung), `splitExtension`, `uniqueName` („Bild (2).jpg“), `splitRelativePath`, `displayPath` |
| `nodes.service.ts` / `nodes.endpoints.ts` | Auflisten, „Mit mir geteilt“, Suche, Ordner anlegen, `ensureFolderPath` (Ordner-Upload), Umbenennen, Verschieben (Advisory-Lock, Zyklus-/Tiefenprüfung, Bereichs-/Eigentümerwechsel, Kontingent) |
| `upload.endpoints.ts` | Upload (internes Multipart, zwei Transaktionen + Storage dazwischen), Inhalt, Thumbnail |
| `storage.ts` | `storeContent` (Typ normalisieren/prüfen, Thumbnail 320 px WebP per `core.images.process`), `contentResponse`/`thumbResponse` (Sicherheits-Header), `removeObjects`, `storageLimits`, `quotaUsed`/`assertQuota` |
| `shares.service.ts` / `shares.endpoints.ts` | Freigaben lesen (eigene + geerbte) / ersetzen, Principal-Suche, `keysFor`, `canManageShares`/`assertCanManageShares` |
| `links.service.ts` / `links.endpoints.ts` | Öffentliche Links: anlegen/auflisten/widerrufen (intern); Info, Freischalten, Ordnerinhalt, Inhalt (öffentlich) |
| `trash.service.ts` / `trash.endpoints.ts` | Papierkorb: löschen, Liste, wiederherstellen, endgültig löschen, Ablauf-Job `purgeExpired` |
| `meta.endpoints.ts` | `/meta`: Kontingent, Upload-Grenzen, Papierkorb-Dauer, Fähigkeiten des Aufrufers |
| `reset.ts` | Reset-Bereich `all` (`rebuild`, alle Storage-Objekte), `resetUsers` |
| `pages/FilesPage.svelte` | Seite mit Bereichen (`?view=` personal · shared · shared-with-me · trash, `?folder=`), Brotkrumen (Drop-Ziele), Raster/Liste (Wahl in `localStorage`), Suche, Mehrfachauswahl, Menüs, `QuotaBar` |
| `pages/FileList.svelte` | Raster-/Listenansicht, Tastatur (Pfeile, Home/End), internes Ziehen mit `DRAG_MIME` |
| `pages/UploadDropzone.svelte`, `upload-queue.ts` | Drop-Bereich + Datei-/Ordnerauswahl (`webkitdirectory`, `webkitGetAsEntry`), Warteschlange (Vorprüfung Größe/Typ/Kontingent, 3 parallel, Fortschritt, Fehler) – `upload-queue.ts` rein und getestet |
| `pages/FilePreview.svelte` | Vorschau (Bild mit Zoom/Blättern/Wischen, PDF im Blob-iframe, Text ≤ 1 MB), auch für die öffentliche Seite (`ContentUrlFn`) |
| `pages/NameDialog`, `MoveDialog`, `NodeInfoDialog`, `ShareNodeDialog` (`SharePanel`), `LinkDialog`, `TrashView`, `QuotaBar`, `helpers.ts` | Dialoge und Hilfen (`DRAG_MIME`, `VIEWS`, `internalUrl`, `compareNodes`, `formatDateTime`, `errorText`) |
| `pages/PublicLinkPage.svelte` | Öffentliche Seite `/p/files/link/<token>`: Passwortabfrage, Ordner blättern (`?folder=`), Vorschau, Download; Zugriffstoken in `sessionStorage` |
| `migrations/0001_init.sql`, `0002_link_lockout.sql` | Schema; Fehlversuchs-Zähler für Link-Passwörter |

## Datenmodell
- `nodes` – Ordner **und** Dateien als Baum (`parent_id` FK CASCADE, `kind` folder|file, `space` personal|shared, `owner_id` = Besitzer*in der Ablage
  bzw. bei `shared` nur Info, `name`, `storage_path`/`thumb_path`/`content_type`/`size_bytes` nur Dateien, `created_by`, Zeitstempel).
  **Wurzeln sind virtuell**: `parent_id NULL` + `space` (+ `owner_id` bei personal) – keine Wurzel-Zeile.
- Eindeutige Namen je Ordner ohne Groß/Klein über **Partial-Unique-Index** `nodes_unique_name_idx` auf
  `(COALESCE(parent_id, space || ':' || owner|''), lower(name)) WHERE deleted_at IS NULL` – Papierkorb-Einträge blockieren keine Namen.
  Konflikte: Upload (`conflict = rename|replace`), Verschieben und Wiederherstellen benennen automatisch per `uniqueName`; Ordner anlegen und
  Umbenennen → 409 mit Namensvorschlag.
- **Papierkorb**: alle Knoten eines gelöschten Teilbaums bekommen `deleted_at`/`deleted_by`, nur die Wurzel `trash_root = true`. Früher gelöschte
  Unterbäume behalten ihre eigene `trash_root` (bleiben beim Wiederherstellen des äußeren im Papierkorb; endgültiges Löschen entfernt sie per CASCADE mit).
  Wiederherstellen: zurück in den Elternordner, wenn er noch da ist (gleicher Bereich/gleiche Ablage), sonst in die Wurzel; Name ggf. `uniqueName`.
- `node_shares(node_id FK CASCADE, principal_type CHECK, principal_id, level read|edit, created_by, created_at, PK)` + Index `(principal_type, principal_id)`.
- `share_links(id, node_id FK CASCADE, token_hash UNIQUE, expires_on date (gültig bis einschließlich), password_hash, created_by, created_at, revoked_at,
  last_access_at, access_count)`; 0002: `failed_count`, `failed_window_start` (Fehlversuche je Link und Stunde).

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `files.file.view` | Grundrecht: eigene Ablage „Meine Dateien“, für mich Freigegebenes; alle internen Endpunkte |
| `files.shared.view` | Stammesordner ansehen und herunterladen |
| `files.shared.edit` | Im Stammesordner hochladen, Ordner anlegen, umbenennen, verschieben, löschen, Freigaben/Links verwalten |
| `files.link.create` | Öffentliche Links anlegen (zusätzlich Bereichsberechtigung am Knoten nötig) |
| `files.file.manage-all` | Alles sehen und verwalten, auch fremde „Meine Dateien“ (`GET /nodes?owner=`) |

`defaultRoleGrants`: „Mitglied“ → `files.file.view` (Verknüpfungs-Konten bekommen eine eigene Ablage und sehen Freigegebenes).

## Zugriffsregeln (`access.ts`)
- **Bereich**: System/`manage-all` → edit überall; `personal` → edit für `owner_id = ctx.userId`; `shared` → edit mit `files.shared.edit`, read mit `files.shared.view`.
- **Vererbung**: Freigabe auf dem Knoten **oder einem Vorfahren** gilt; **höchste Stufe gewinnt** (Bereich und Freigaben zusammen).
- Gelöschte Knoten (auch über einen gelöschten Vorfahren) und Knoten ohne Zugriff → **404**, nie 403 (Existenz nicht verraten). 403 nur, wenn read da ist,
  aber edit verlangt wird.
- `principalKeysFor` (`keysFor`) immer **vor** der Transaktion, `validatePrincipals`/`describePrincipals` vor bzw. nach.
- „Mit mir geteilt“: Knoten mit direkter Freigabe, die nicht ohnehin über den Bereich sichtbar sind und deren Vorfahren nicht schon freigegeben sind.
- Geerbte Freigaben zeigt `GET /nodes/:id/shares` nur von Vorfahren, auf die der Aufrufer selbst Zugriff hat (sonst würden fremde Ordnernamen sichtbar).

## Sicherheitsregeln (aus der Prüfung, nicht aufweichen)
- **Freigaben und Links verwalten nur Bereichsberechtigte** (`canManageShares`, DTO-Feld `canShare`): Eigentümer*in in „Meine Dateien“, `files.shared.edit`
  im Stammesordner, `manage-all`. **Edit über eine Freigabe reicht nicht** (sonst ließen sich fremde Inhalte weiterverteilen) → 403.
- **Verschieben**: edit auf Quelle und Ziel; aus einer fremden Ablage **heraus** (Bereichs- oder Eigentümerwechsel) nur mit Bereichsrecht an der Quelle –
  edit über Freigabe → 403 „Nur die Eigentümer*in kann Einträge aus dieser Ablage herausverschieben“. Nicht in sich selbst/Nachfahren (422), Tiefe ≤ 20 (422).
- **Namen**: keine `/ \`, keine Steuerzeichen, nicht `.`/`..`, **keine unsichtbaren Zeichen** (Zero-Width, Bidi wie U+202E, BOM → 422); Upload-Namen werden
  vorher normalisiert.
- **Upload**: `Content-Length` ist **Pflicht** (fehlt/ungültig → 400; > Max + 1 MB → 413, bevor der Body gelesen wird); Typ gegen die Allowlist
  (Browser-Typ, sonst Endung, sonst `application/octet-stream`; aktive Inhalte nur, wenn ausdrücklich erlaubt). **Kontingent in beiden Transaktionen**
  (Vorprüfung + mit echter Größe beim Anlegen/Ersetzen; Fehler → hochgeladene Objekte werden entfernt); Papierkorb zählt mit. Verschieben in eine
  „Meine Dateien“ prüft das Kontingent der Ziel-Eigentümer*in.
- **Auslieferung** (`contentResponse`): `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`, `content-disposition` nach
  RFC 5987; inline nur Bilder, PDF und Text (Text als `text/plain; charset=utf-8`); **aktive Inhalte** (`text/html`, `image/svg+xml`, `application/xhtml+xml`)
  **nie inline**, immer `attachment` als `application/octet-stream`.
- **Link-Token** (32 Byte, base64url) wird **nur als Hash** gespeichert (`core.crypto.forModule('files').hash`, HMAC-SHA-256); Klartext-URL nur einmal in der
  Antwort von `POST …/links`. Passwort: scrypt mit Salt, `timingSafeEqual`, `MIN_PASSWORD` 8.
- **Zugriffstoken** nach dem Freischalten: `<linkId>.<exp>.<sig>` (HMAC über eigene Domäne `access:`), gültig **15 min**.
- **Passwort-Raten**: höchstens **10 Fehlversuche je Link und Stunde**, danach **429** (auch bei richtigem Passwort); Erfolg setzt zurück. Zusätzlich Rate-Limit
  `unlock` 10/600 s je IP.
- Ungültig / abgelaufen / widerrufen / Knoten im Papierkorb → überall dieselbe 404 „Link nicht verfügbar“. Öffentlicher Zugriff nur im Teilbaum des Links.
- Audit ohne Inhalte/Namen: `files.node.created|uploaded|renamed|moved|trashed|restored|purged`, `files.share.updated` (Anzahl), `files.link.created|revoked`,
  `files.link.accessed` (höchstens 1× je Link und Stunde, Akteur `system`/„Öffentlicher Link“). Vorschau/Download wird nicht protokolliert.

## API (`/api/v1/modules/files/…`)
Alle internen Endpunkte: Recht `files.file.view`, die Objektprüfung macht der Handler.
| Methode + Pfad | Besonderheiten |
|---|---|
| GET `/meta` | `FilesMeta`: Kontingent, `maxFileBytes`, erlaubte Typen, `trashDays`, `can` |
| GET `/nodes?space=&parent=&owner=` | `FolderListing` (Ordner zuerst, Name de); `owner` nur mit `manage-all` |
| GET `/shared-with-me` | `FileNode[]` |
| GET `/search?q=&space=` | ab 2 Zeichen, ≤ 100 Treffer (`truncated`), mit Pfad |
| POST `/folders` | `{ space, parentId, name }`; edit am Ziel; Tiefe ≤ 20 |
| POST `/nodes/move` | `{ ids ≤ 500, targetId, space }` → `{ affected }`; Regeln siehe oben |
| GET `/nodes/:id` | `FileNode` (404 ohne Zugriff) |
| PATCH `/nodes/:id` | `{ name }` umbenennen (Konflikt 409 mit Vorschlag) |
| POST `/nodes/:parent/upload` | multipart `file` + `space`, `relativePath?`, `conflict?`; `parent` = Ordner-ID oder `root`; ein Request je Datei |
| GET `/nodes/:id/content?download=1` | Inhalt mit Sicherheits-Headern (`private, max-age=60`) |
| GET `/nodes/:id/thumb` | WebP 320 px (`private, max-age=3600`), 404 ohne Thumbnail |
| GET / PUT `/nodes/:id/shares` | lesen (read) / Liste ersetzen (`canShare`, ≤ 200, keine Duplikate, unbekannte Ziele 422) |
| GET `/principals?q=` | Freigabe-Ziele (`everyoneLabel` „Stamm“) |
| GET / POST `/nodes/:id/links` | Links auflisten / anlegen (`canShare` + `files.link.create`; `expiresOn` echtes Datum, nicht vergangen; ≤ 20 aktive je Knoten → 409) |
| DELETE `/links/:id` | widerrufen (ohne edit 404, edit nur über Freigabe 403) |
| POST `/nodes/trash` | `{ ids }` in den Papierkorb (edit) |
| GET `/trash` | `TrashItem[]` mit ursprünglichem Ort und `purgeOn` |
| POST `/trash/restore`, `/trash/purge` | wiederherstellen / endgültig löschen (nur Papierkorb-Wurzeln, Storage danach) |

Öffentlich (`public: true`, kein Login; Router ergänzt einen IP-unabhängigen Gesamt-Bucket 20 × Limit, mind. 200):
| Methode + Pfad | Rate-Limit je IP | Besonderheiten |
|---|---|---|
| GET `/public/links/:token?t=` | 60/60 s | `PublicLinkInfo` (Name, Art, `needsPassword`, Ablauf; Datei-Knoten erst nach Freischalten) |
| POST `/public/links/:token/unlock` | 10/600 s | `{ password }` → `{ accessToken, expiresInSec }`; falsch 403, gesperrt 429 |
| GET `/public/links/:token/nodes?parent=&t=` | 120/60 s | Ordnerinhalt im Link-Teilbaum; ohne gültiges `t` bei Passwort 403 |
| GET `/public/links/:token/content/:nodeId?t=&download=&thumb=` | 300/60 s | Datei/Thumbnail; Thumbnails zählen nicht als Abruf |

## UI
- **Bereiche/URL**: `?view=` `personal` (Standard) · `shared` (nur mit `files.shared.view`) · `shared-with-me` · `trash`, dazu `?folder=<id>`. Raster/Liste
  wird je Browser gemerkt.
- **Drag & Drop**: Dateien/Ordner **von außen** = Upload (`UploadDropzone`, Ordner per `webkitGetAsEntry` bzw. Auswahl `webkitdirectory`, Ordnerstruktur über
  `relativePath`); **intern** = Verschieben auf Ordner oder Brotkrumen mit eigenem MIME `DRAG_MIME` (`application/x-ep-files-nodes`, JSON-Liste der IDs).
- **Vorschau** (`FilePreview`): Bilder mit Zoom (Buttons, Strg + Mausrad, Tasten) und Blättern (←/→, Wischen); **PDF per Blob-URL im iframe**, weil die App
  `X-Frame-Options: DENY` setzt (direkte URL im iframe wäre blockiert); Text bis 1 MB, größer → Hinweis + Download.
- **Öffentliche Seite** `/p/files/link/<token>`: Passwortabfrage, Ordner blättern, Vorschau und Download; Zugriffstoken je Link in `sessionStorage`.
- Freigabe-Dialog mit `SharePanel` (eigene + geerbte Freigaben), Link-Dialog (Ablauf, Passwort, Link einmalig kopieren, Liste mit Widerrufen).

## Einstellungen, Job, Reset
- `files.quota.mb` (Standard 1024, 0 = unbegrenzt; gilt nur für „Meine Dateien“), `files.trash.days` (Standard 30, 1–365).
  Größe/Typen kommen aus den Core-Storage-Einstellungen (`core.storage.maxFileSizeMb`, `core.storage.allowedContentTypes`).
- Job `files.purge-trash` (täglich): abgelaufene Papierkorb-Wurzeln endgültig löschen (je Lauf ≤ 500, Rest beim nächsten Lauf), Storage danach.
- Reset: Bereich `all` (alle Tabellen, alle Storage-Objekte, `rebuild`). `resetUsers`: öffentliche Links auf fremde Ablagen **widerrufen**, jede fremde
  Ablage wandert in einen neuen Ordner **„Übernommen“** („Übernommen (2)“ …) in der Ablage der behaltenen Person, Benutzer-Freigaben fremder Personen weg,
  `owner_id`/`created_by`/`deleted_by` umschreiben.

## Tests und Demo
Unit `tests/unit/files-*.test.ts` (u. a. `files-upload-queue.test.ts`, Namen); Integration `tests/integration/files.test.ts` (Ablage, Upload, Papierkorb,
Kontingent, Auslieferung) und `tests/integration/files-sharing.test.ts` (Freigaben, Vererbung, Links, Fehlversuche); E2E `tests/e2e/files.spec.ts`;
S3-Ersatz `tests/helpers/s3-mock.ts`. Demo: `node scripts/seed-demo-files.mjs` (braucht MinIO). Stand 2026-10-19: Tests/Demo entstehen parallel.

## Offen / Bekannt
- Core-Router setzt bei öffentlichen Endpunkten `cache-control: no-store` → Thumbnails öffentlicher Links sind nicht cachebar.
- Core-Router schreibt den Pfad **inkl. Link-Token** in `api_log` (Token-Leck in Logs) – Core-Fix vorgeschlagen: Pfad maskieren.
- Rate-Limit `content` 300/60 s gilt je IP **über alle Links** plus globaler Bucket (viele Thumbnails können andere Links bremsen).
- Zugriffstoken `t` steht in der URL (Logs/Verlauf); gültig 15 min.
- Leere Ordner zählen nicht ins Kontingent.
- Typ-Allowlist der Core-Storage-Einstellungen ist als Standard in `storage.ts` dupliziert (Module dürfen `$lib/server/*` nicht importieren) – mitpflegen.
- AVIF und ODF (`odt`/`ods`/`odp`) werden ohne Erweiterung der Allowlist durch Admins abgelehnt.
- Ungeprüft: PDF-Einbettung im echten Browser/mobil, echtes S3 bei großen Dateien.
