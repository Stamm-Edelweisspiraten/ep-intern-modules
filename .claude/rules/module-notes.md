---
paths: ["src/lib/modules/notes/**", "tests/**/notes*", "scripts/seed-demo-notes.mjs", "src/lib/modules/actions/pages/ActionNotesCard.svelte", "src/lib/sdk/server/live-hub.ts", "src/lib/server/core/embeds/**", "src/routes/embed/**", "src/lib/sdk/types/embeds.ts"]
---

# Modul `notes` (Notizen, live gemeinsam bearbeiten)

Notizen als **Seitenbaum** (Unterseiten beliebig bis 10 Ebenen) mit **Live-Bearbeitung durch mehrere Personen** (Yjs/CRDT, Cursor der anderen),
formatiertem Editor (Tiptap 3) mit **Markdown-Kürzeln**, eingefügtem Markdown und umschaltbarer **Quelltext-Ansicht**, Werkzeugleiste (fett, kursiv,
unterstrichen, durchgestrichen, Schriftgröße, Farbe/Markierung, Ausrichtung, Listen/Aufgaben, Zitat, Code, **Tabellen**, Link, Bild, Trennlinie),
Slash-Menü (`/`), **Bilder** (Upload/Einfügen/Ziehen, Größe per Griff), **eingebettete Whiteboards** (live bearbeitbar, Core-Mechanismus „Einbetten“),
Teilen an Principals (vererbt auf Unterseiten), Notizen je **Aktion**, Versionen, Papierkorb, **Export** `.md`/`.zip`/`.html`/`.docx`/`.pdf` und Import
`.md`/`.zip`. Schema `mod_notes`, v1.0.0 (2026-10-29), keine harten Abhängigkeiten, `optionalDependencies: ['members','actions']`.
Navigation „Notizen“ (Icon `notebook-pen`, `order` 72), Editor vollflächig (`fullBleedRoutes: [':id']`).

Nutzerentscheidungen (2026-10-29): eigenes Modul (nicht in „Dateien“); formatierter Editor mit Markdown-Kürzeln **plus** Quelltext-Umschalter;
**Seitenbaum** mit vererbter Freigabe; Whiteboard **live + bearbeitbar** einbetten (generischer Core-Mechanismus); Export .md (+ .zip mit Bildern), .pdf,
.docx, .html.

## Architektur
- **Inhalt = Yjs-Dokument** (Fragment `default`, Schema aus `doc/extensions.ts` – Server UND Browser, Browser ergänzt nur Verhalten/Node-Views, nie
  Knoten/Marks). Gespeichert: `notes.ydoc` (verdichtet) + `note_updates` (Einzel-Updates seit der Verdichtung). Abgeleitet (5 s verzögert):
  `content_json` (über das Schema, ungültige Blöcke fallen weg) und `content_text` (Suche/Vorschau, Volltextindex `german`).
- **Transport wie Whiteboard**: SSE `GET /notes/:id/live` (Hub `live.ts` über den SDK-Baustein `$lib/sdk/server/live-hub.ts` `createLiveHub`, Heartbeat,
  Recheck 60 s, ≤ 30 Streams je Konto) + Änderungen per `POST /notes/:id/updates` (Body = **ein rohes Yjs-Update**, `application/octet-stream`, ≤ 5 MB,
  umgeht das 1-MB-JSON-Limit des Routers) + Awareness `POST /notes/:id/awareness` (nur weitergereicht). Start: `GET /notes/:id/state?sv=` (binär,
  nur fehlende Änderungen, Header `x-yjs-state-vector` + `x-note-level`) → Client schickt eigene fehlende Änderungen nach (offline bearbeitet).
- **Server-Dokument** (`doc.service.ts`): je geöffneter Notiz ein `Y.Doc` im Speicher (nach 5 min ohne Verbindung entladen), Schreiben unter einer
  Sperre je Notiz (`withDocLock`): dekodieren (kaputt → 422) → speichern → anwenden → verteilen; ab 200 Updates bzw. stündlich (Job) verdichten.
  Grenze 20 MB je Notiz (413 „Teile sie in Unterseiten auf“). **Nur eine App-Instanz** (Dokumente und Hub im Prozess).
- **Bilder** speichern im Dokument nur `assetId` (`image`-Knoten), die Adresse baut der Renderer (`assetUrl`), eine freie `src` wird nie ausgegeben;
  Markdown `![alt](asset:<id>)`. **Einbettungen** `embed { module, kind, refId, height }`, Markdown `:::embed {module="…" kind="…" refId="…" height="…"} :::`.
- Rückgängig/Wiederholen über den Yjs-UndoManager (nur eigene Änderungen); Wiederherstellen einer Version = eine Server-Transaktion auf dem Live-Dokument
  (`replaceContent`), offene Editoren übernehmen sie ohne Neuladen.

## Dateien (`src/lib/modules/notes/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (4 Rechte, **keine** `defaultRoleGrants`), Jobs `versions` (stündlich: verdichten + automatische Versionen) und `purge-trash` (täglich), Hooks, `provides` `NoteRefsService`, Endpoints in `withNoteContext` (transfer → notes → live → assets → versions) |
| `schemas.ts` | Vertrag: Konstanten/Grenzen, Zod (`noteCreateInput` mit `markdown`, `noteUpdateInput`, `moveInput`, `stateQuery`, `liveQuery`, `updatesQuery`, `awarenessInput`, `sharesInput`, `exportQuery` …), DTOs (`NoteNode`, `NoteDetail`, `NoteRoots`, `NoteShares` mit `inherited`, `NoteVersion`, `TrashItem`, `NoteAsset`, `Peer`), `LiveEvent`, `presenceColor` |
| `access.ts` | Zugriff mit **Vererbung über die Oberseiten-Kette** (`chainOf`, `resolveNoteAccess`, `requireNoteAccess(…, 'read'|'edit'|'share', { includeDeleted })`), Liste `accessForMany` (ein CTE), `visibleNotesSql`, `notInTrashSql`, Teilbaum-Hilfen, Sperren `lockNote`/`lockRoots`, `loadNoteContext`/`withNoteContext` (Schlüssel + `accessibleActions` **vor** der Tx) |
| `db.ts` | `mdb`, `filesCtx` (Systemkontext `notes-files`), `userRefs`/`refOf` |
| `doc.service.ts` | Yjs im Speicher: `applyClientUpdate`, `stateFor`, `fullState`, `currentJson`, `stateFromJson`, `jsonFromState`, `replaceContent`, `flushNote`/`flushAll`, `dropDoc`, Test-Hilfen |
| `live.ts` / `live.endpoints.ts` | Hub (`hub`, `peersOf`, `recheckNotes`, `closeNotes`), Endpunkte `state`, `live`, `updates` (1200/60 s), `awareness` (1500/60 s) |
| `notes.endpoints.ts` / `tree.service.ts` | Wurzeln (eigene/geteilt/Aktionen), zuletzt bearbeitet, Suche, Papierkorb, `by-action`, Principals, CRUD, Kinder, Verschieben, Freigaben; Aufbau der DTOs, Positionen, Teilbaum |
| `trash.service.ts` | `purgeExpiredTrash` (Job, ≤ 200 je Lauf), `afterPurge` (Dateien, Dokumente, Streams) |
| `assets.service.ts` / `assets.endpoints.ts` / `storage.ts` | Bild-Upload (`core.images.process` thumb 640 / web 2000 WebP ohne Metadaten), Auslieferung `GET /assets/:assetId/:variant` (Zugriff über die Notiz des Assets, `IMAGE_RATE_LIMIT`), Pfade `notes/<noteId>/<assetId>-<variant>.<ext>` |
| `versions.service.ts` / `versions.endpoints.ts` | Versionen (auto ≤ 50, benannt ≤ 100), Vorschau (`content` = PM-JSON), Wiederherstellen (sichert vorher „Vor dem Wiederherstellen“), `runAutoVersions` |
| `transfer.endpoints.ts` + `export/*` | Export `GET /notes/:id/export?format=md|zip|html|docx|pdf&subpages&letterhead` (`collect.ts` ≤ 300 Seiten/200 MB Bilder, `markdown.ts`, `zip.ts`, `html.ts` eigener Serialisierer mit Allowlist, `docx.ts`, `pdf.ts` über Core-Block `richText`, `embeds.ts`), Import `POST /notes/import` (`import.ts`: .md/.txt/.zip, Ordner → Unterseiten, Bilder neu verarbeitet, ZIP-Grenzen 500 Einträge/200 MB, kein `..`) |
| `privacy.ts`, `search.ts`, `notify.ts`, `refs.service.ts`, `contract.ts` | Löschen/Reset/Auskunft, globale Suche, `note-shared`, `NoteRefsService` (Karte „Notiz“ im Whiteboard) |
| `doc/extensions.ts`, `doc/text.ts` | Schema (`noteExtensions`, `noteSchema`, `noteImage`, `Embed`, `assetUrl`), Klartext/Assets/Einbettungen aus PM-JSON |
| `ui.ts`, `pages/**` | Übersicht, Editor-Seite mit Seitenbaum, Editor (`pages/editor/`: `sync.svelte.ts` Yjs-Provider über SSE, `NoteEditor`, `Toolbar`, `SlashMenu`, `BubbleMenu`, `SourcePanel` + `source-diff.ts`, `EmbedView`/`EmbedPicker`, Node-Views), Dialoge, Dashboard-Kachel |

Außerhalb: `actions/pages/ActionNotesCard.svelte` (REST, in `ActionDetailPage` mit `notes.note.view`), Whiteboard-Karte `note` und Einbettung
(`whiteboard/embeds.ts`, `pages/EmbedBoardPage.svelte`), Core `core.embeds` + `/api/v1/embeds*` + Route `/embed/<modul>/<pfad>` (`src/routes/embed/`,
`core/internal-pages.ts`, Header `SAMEORIGIN` + `frame-ancestors 'self'` nur dort), PDF-Block `richText` (`sanitizeDocumentHtml`), Icon `notebook-pen`.

## Rechte und Zugriff
`notes.note.view` (Grundrecht), `.create` (eigene Wurzeln anlegen/importieren), `.view-all`, `.edit-all`. Bearbeiten: Eigentümer*in (der Seite oder einer
Oberseite), Freigabe `edit` auf der Seite **oder einer Oberseite**, Aktion der Wurzel mit Bearbeiten-Zugriff, `edit-all`. Lesen: Freigabe `read`, Aktion lesbar,
`view-all`. **Teilen, Löschen, Aktion wechseln, aus dem Teilbaum verschieben: nur Eigentümer*in/`edit-all`** (Bearbeiten-Freigabe reicht nicht – wie `files`).
Unterseiten gehören der Eigentümer*in der Wurzel; Verschieben in einen fremden Teilbaum wechselt die Eigentümer*in des Teilbaums. Fremd/Papierkorb → 404.
Live-Verbindungen prüfen beim Start, alle 60 s und sofort nach Freigabe-/Aktions-/Ortswechsel (`recheckNotes(subtreeIds)`).

## Grenzen
Titel 200, Tiefe 10, 500 Unterseiten je Seite, 20 MB Yjs-Zustand je Notiz, Update 5 MB, Bild 25 MB, Import 50 MB, Export 300 Seiten, 200 Freigaben,
30 Live-Streams je Konto, Papierkorb 30 Tage, Einbettungshöhe 160–1600 px.

## Audit
`notes.note.created|updated|moved|trashed|restored|purged|shared|exported|imported`, `notes.asset.uploaded`, `notes.version.created|restored|deleted` – nur
IDs/Zähler/Formate, **keine** Inhalte oder Titel. Einzelne Text-Änderungen werden nicht auditiert.

## Tests und Demo
Integration `tests/integration/notes.test.ts` (Zugriffsmatrix inkl. Vererbung/Aktion, Yjs-Konvergenz zweier Clients, SSE, Verdichtung, Versionen,
Bilder, Papierkorb, Suche, Audit), `notes-transfer.test.ts` (alle Exportformate, Import inkl. manipulierter ZIPs), `core-embeds.test.ts`; Unit
`notes-doc`, `notes-text`, `notes-export`, `notes-source-diff`, `pdf-rich-text`; E2E `tests/e2e/notes.spec.ts`.
Demo: `node scripts/seed-demo-notes.mjs` (Beispielnotiz mit Unterseiten; `--big` = große Notiz für den Lasttest).

## Fallen
- `doc.service`-Funktionen und Core-Dienste **nie** in `mdb().transaction` (PGlite hängt).
- Neue Knoten/Marks nur in `doc/extensions.ts` – sonst verwirft der Server sie beim Ableiten und Export.
- Router: POST antwortet 201; `updates` braucht `content-type: application/octet-stream` (kein JSON).

## Offen
- Mehrere App-Instanzen nicht unterstützt; SSE hinter Traefik, echte Tablets/Safari, echtes S3 und echtes Chromium-PDF nach Deploy prüfen.
- Einbettungen bleiben in Export/Import nur als Link erhalten.
