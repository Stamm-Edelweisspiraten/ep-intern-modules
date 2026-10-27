---
paths: ["src/lib/modules/material/**", "src/lib/sdk/labels/**", "src/lib/server/core/pdf/labels.ts", "src/lib/components/layout/BarcodeScanner.svelte", "src/lib/components/layout/scan-input.ts", "tests/**/material*", "tests/unit/labels.test.ts", "scripts/seed-demo-material.mjs"]
---

# Modul `material` (Materialverwaltung / Materialwart*in)

Überblick über das Material des Stammes: **was** da ist (Artikel → Einzelstücke mit Code **oder** Mengen), **wo** es liegt (Lagerorte als Baum,
Kisten als Behälter, verschachtelbar), **wer** es wann braucht (Reservierungen, frei oder je Aktion) – mit Ausgabe/Rückgabe per Barcode/QR
(Handy-Kamera, USB-Scanner) und Etiketten-Designer/-Druck (A4-Bögen und Etikettendrucker). Schema `mod_material`, Version 1.2.0, keine harten
Abhängigkeiten, optional `actions` (Reservierung je Aktion) und `offices` (Amt „Materialwart*in“). Navigation „Material“ (Icon `boxes`, `order: 45`).

## Entscheidungen des Nutzers (2026-10-27, nicht ungefragt ändern)
- Erfassung **beides**: Einzelstücke mit eigenem Code (Zeltbahn, Kocher, Kiste) **und** Mengenartikel mit Bestand je Ort/Kiste (Tassen, Heringe).
- Reservieren **direkt** (kein Freigabe-Workflow) für alle mit `material.reservation.create`.
- Zelte: **freie Bahnen-Anfrage** – man reserviert Teile nach Typ und Anzahl („8 Kohtenbahnen“) oder ganze Sets; Sets sind Vorschlag, beim Zuteilen/
  Ausgeben dürfen sie aufgeteilt werden. Set-Typen (Zelttypen) und Sets sind frei konfigurierbar.
- Etiketten: A4-Bögen **und** Etikettendrucker (Rolle); Scannen per Handy-Kamera **und** USB-Handscanner.
- Ausgabe/Rückgabe per Scan mit Zustandsmeldung gehört dazu (Annahme im Plan, mit der Freigabe bestätigt).

## Neugestaltung „Ausleihen zuerst“ (2026-10-27, v1.1.0, Nutzerentscheidungen)
- **Aufbau** mit eigenen Routen statt Reitern und Bereichsleiste `pages/MaterialNav.svelte` (Desktop `LinkTabs`, Handy `MobileTabBar`, Sichtbarkeit
  in `pages/nav.ts` `visibleAreas`): `''` **Ausleihen** (Katalog mit Zeitraum, Suche, Kategorien, „frei N von M“, Zelte als Typ × Anzahl → Teile,
  Merkliste → Reservieren), `meine` **Meine Reservierungen**, `reservierung/:id` (Detailseite), `scan`, `lager` **Lager** (für alle mit `view` lesbar,
  „Wo ist …?“-Suche, Orte-Baum, Ansichten Orte · Artikel · Zelte & Sets über `?view=`, `?open=`), `ausgabe` **Ausgabe & Rückgabe** (Verwaltung),
  `etiketten` + `labels/:id`. Reservieren für alle mit `material.reservation.create` (keine Rollenänderung).
- **Gestaltung**: Taste Skill App-Screens, Stil „Achromatic ledger“ (`.taste-skill/material/direction.json`) mit den Projekt-Tokens: Farbe nur auf
  Daten/Status und eine Primäraktion, „frei“-Anzahl bzw. Lagerort als Haupt-Datenelement, Listen mit Linien statt Kartenraster, ein `h1` + Befund-Satz.
- **Artikel-Codes** `A-…` (Migr. 0002): Etiketten und Scannen auch für Mengenartikel (Ziel `article`, Felder `LABEL_FIELDS.article`).
- **Etiketten**: Vorgabe `avery-l7159` (63,5 × 33,9 mm, 24 je A4); Logos farbig oder **Schwarz-Weiß** (`monochrome`, Assets `*-sw.png`, `logoKey`/
  `logoDataUrl`); senkrechte Linien als eigenes Werkzeug.
- **PDF-Listen**: `GET /reservations/:id/handout.pdf` (Ausgabeliste zum Abhaken, nach Lagerort sortiert, Kisteninhalt eingerückt,
  Unterschriftszeilen) und `POST /inventory.pdf` (Bestandsliste A4 quer, Filter Ort inkl. Unterorte/Kategorie/Artikel/Zustand, Gruppierung,
  Spalten `INVENTORY_COLUMNS`, Mengen-Abschnitt). Weitere neue Endpunkte: `GET /catalog`, `GET /find` (`borrow.endpoints.ts`).

## Set-Typen mit Mengen (2026-10-27, v1.2.0, Migr. 0003, Nutzerwunsch)
- Teile eines Set-Typs dürfen **Mengenartikel** sein (z. B. 10 Heringe, Seile je Kohte). Konkrete Sets bestehen weiter nur aus Einzelstücken;
  Vollständigkeit zählt nur die Einzelstück-Teile, die Mengen stehen als `MaterialSet.bulkParts` („Dazu aus dem Lager“).
- Reservieren eines Sets (`kind: 'set'`): der Server legt je Mengenteil eine eigene Artikel-Zeile mit `reservation_lines.source_set_id` an
  (`replaceLines` → `setBulkLines`), DTO `ReservationLine.fromSet` (Name des Sets). Prüfung mit `withSetBulk`; `POST /availability` meldet
  Engpässe dieser Mengen am Set. Der Bearbeiten-Dialog schickt erzeugte Zeilen nicht zurück (sie entstehen beim Speichern neu).
- Ausleihen eines ganzen Zelttyps nimmt die Mengenteile über die Teileliste mit; „frei“ eines Zelttyps berücksichtigt sie.

## Dateien (`src/lib/modules/material/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (5 Rechte, `defaultRoleGrants` „Materialwart*in“ = alle, „Gruppenleitung“ = view + reservieren), Amts-Vorlage `materialwart`, Job `overdue` (täglich), Benachrichtigung `my-overdue`, Hooks `search`, `resetAreas`/`resetUsers`, `onUserDeleted`, `subjectExport`; Endpoint-Reihenfolge images → catalog → units → stock → sets → handout → reservations → labels |
| `ui.ts` | Routen `''` → `MaterialPage` (Reiter `?tab=` overview · inventory · sets · reservations · labels), `scan`, `scan/:code` → `ScanPage`, `labels/:id` → `LabelDesigner` (vollflächig); Dashboard-Kacheln `mine`, `manage` |
| `schemas.ts` | Vertrag (Zod + DTOs), Labels, Codes (`CODE_PREFIX` M/S/L, `normalizeCode`, `codeFromScan` = Code oder volle Scan-URL, `scanPath`), `LABEL_FIELDS` (Platzhalter je Etikett-Ziel mit Beispielwerten) |
| `availability.ts` (rein) | Belegungen (`Booking`: konkrete Stücke + Anzahl je Artikel), `blockedUnits`, `freeUnitCount`/`freeQuantity` als **Tages-Sweep** (Minimum über alle Tage) |
| `allocation.ts` (rein) | `allocate` (Bahnen-Anfrage: erst ganze Sets, dann lose, zuletzt Teile – bereits unvollständige Sets zuerst; meldet `splitSets`), `completeness` (Set gegen Vorlage: fehlend/zu viel/unbrauchbar) |
| `places.ts` (rein) | `locationPaths`, `wouldCycle`, `descendants`, `effectivePlace` (Ort über die Kisten-Kette) |
| `db.ts` | `mdb`, `rows`, `str` (null → `''`), `dateStr`, `bool`, Codes `nextCodes` (Zähler `code_counters` + Advisory-Lock `material:codes`, überspringt vergebene/reservierte) und `claimCode` (eigener Code, verbraucht reservierten), `logMovement`, `userNames`, `actionsService`/`officesService` (optional) |
| `inventory.ts` | `loadPlaceIndex` (alle Orte + Stücke, wenige Spalten), `placeText`/`holderText`, `containedUnits` (rekursiv), `UNIT_SELECT`/`toUnitSummary`/`unitSummaries`, `isUsable` |
| `catalog.endpoints.ts` | Lagerorte (Baum, Code `L-…`, Löschen nur leer), Kategorien (Farbe, Icon), Artikel (`kind` fest nach Anlage, Archivieren statt Löschen wenn verwendet) |
| `files.ts` / `images.endpoints.ts` | Artikelbilder wie `orders` (Systemkontext `material-files`, `core.images.process` thumb/web) |
| `units.endpoints.ts` | Stücke/Kisten: Liste mit Filtern (`deep` = Unterorte + Kisteninhalt, `from/to` = nur freie), Detail (Inhalt, Packliste Soll/Ist, Verlauf, Reservierungen), Anlegen (bis 200, nummeriert, eigener Code nur einzeln), Bearbeiten, `move`/`units/move`, `condition` (auch mit Reservierungsrecht), `retire`, `targets`, Löschen nur ohne Reservierungen |
| `stock.endpoints.ts` | Mengenbestand: `GET /stock`, `POST /stock/set` (zählen), `POST /stock/move`; `setQty` |
| `sets.endpoints.ts` | Set-Vorlagen (Teile = Einzelstück-Artikel × Anzahl), Sets (`S-…`, `unitIds` ersetzt – Stücke wandern aus anderen Sets herüber, Verlauf `set-added|set-removed`), Löschen nur ohne offene Reservierung |
| `reservations.service.ts` | `loadBookings` (andere offene Reservierungen; ausgegebene gelten bis mindestens heute), `checkLines` (je Zeile ok/frei/Meldung/Hinweise inkl. Set-Aufteilung), `assertLinesAvailable` (409 mit `details.lines`), `loadReservation`, `canEditReservation` |
| `reservations.endpoints.ts` | Liste, Detail, Anlegen/Ändern (Advisory-Lock `material:reservations`), Stornieren, Löschen (nur storniert), `/my/reservations`, `/reservations/by-action/:actionId`, `POST /availability`, `GET /availability/articles` |
| `handout.endpoints.ts` | `GET /codes/:code`, `POST /codes/reserve` (Leer-Etiketten), `GET …/allocation`, `POST …/issue`, `POST …/return`, `POST …/unissue` |
| `labels.endpoints.ts` | `GET /overview`, Etikettenformate (Vorgaben aus `$lib/sdk/labels` + eigene `custom:<id>`), Etikett-Layouts, `POST /labels.pdf` |
| `notify.ts` | Amt: neue Reservierung **für eine Aktion**, Schaden/Verlust bei Rückgabe, überfällig (Tagesjob, einmal je Fälligkeit über `overdue_notified_on`); Person: `my-overdue` |
| `search.ts`, `reset.ts` (`reservations`, `all`; `USER_COLUMNS`), `user-deleted.ts`, `subject-export.ts` | Hooks |
| `borrow.endpoints.ts` | `GET /catalog`, `GET /find`, Ausgabeliste- und Bestandslisten-PDF |
| `pages/` | `BorrowPage` (+ `borrow/`), `MyReservationsPage`, `ReservationPage`, `StockPage` (+ `stock/`, `inventory/`, `sets/`), `HandoutPage` (+ `handout/`, `reservations/`), `LabelsPage` + `labels/` (inkl. `LabelDesigner`), `ScanPage`, `widgets/`, `shared/`, `MaterialNav` + `nav.ts`, `helpers.ts` |

## Datenmodell (Migration 0001, 0002 Artikel-Codes)
`locations` (Baum, `code`), `categories`, `articles` (`kind` unit|bulk, `min_quantity`), `article_images`, `units` (`code` unique, `label`, `is_container`,
`container_id` **oder** `location_id`, `condition` ok|worn|damaged|defect|lost, `retired_at`, `issued_reservation_id`, Wert in Cent `bigint`), `stock`
(Artikel × Halter Ort **oder** Kiste, partielle Unique-Indizes), `container_targets` (Packliste), `set_templates`/`set_template_parts`, `sets`/`set_units`
(`unit_id` unique = ein Stück in höchstens einem Set), `reservations` (Status reserved|issued|returned|cancelled, `action_id` ohne FK), `reservation_lines`
(`kind` unit|set|article, `issued_qty`/`returned_qty` für Mengen), `reservation_units` (tatsächlich ausgegebene Stücke inkl. Kisteninhalt, Zeile, Rückgabe-Zustand),
`movements` (Verlauf), `label_formats`, `label_templates` (`layout jsonb`), `code_counters`, `reserved_codes`.

## Regeln
- **Verfügbarkeit**: Stück konkret belegt, wenn eine andere offene Reservierung im Zeitraum es als Stück, über ein Set oder als Kisteninhalt enthält oder
  es ausgegeben ist. Anzahl-Zeilen belegen „N beliebige“ (abzüglich bereits zugeteilter). Frei = nutzbare Stücke − konkret belegte − Anzahl, je Tag.
  Defekte/verlorene/ausgemusterte Stücke zählen nie. Mengenartikel: Gesamtbestand aller Orte − Reservierungen je Tag.
- **Ausgabe** ordnet gescannte Stücke ihrer Zeile zu (Stück → Set → Kiste → passende Anzahl-Zeile); fremde nur mit `allowExtra` (neue Zeile, wenn frei).
  Kisten nehmen ihren Inhalt mit. **Rückgabe**: Zustand ≠ ok wird am Stück gespeichert; `closeMissingAsLost` markiert Rest als verloren und bucht fehlende
  Mengen aus dem Bestand aus. Alles zurück → Status `returned`.
- Ausgegebene Reservierungen: nur Titel/Notiz/Aktion/Ende änderbar; Verlängern prüft die draußen befindlichen Stücke im neuen Zeitraum.
- Bearbeiten/Ausgeben/Zurücknehmen: Ersteller*in (mit `reservation.create`) oder `reservation.manage`; ansehen alle mit `inventory.view`.
- Aktion verknüpfen: nur, wenn die Aktion für die Person sichtbar ist (`ActionsService.accessibleActions`, vor der Transaktion); Karte in der Aktion
  (`actions/pages/ActionMaterialCard.svelte`) spricht nur REST (`/reservations/by-action/:id`).
- **Codes**: `M-000001` (Stücke/Kisten), `S-…` (Sets), `L-…` (Orte); eigener Code (z. B. vorab gedrucktes Etikett, Herstellercode) frei wählbar, wenn
  ungenutzt. QR-Inhalt = volle URL `<ORIGIN>/modules/material/scan/<code>` (Handy-Kamera ohne App), Code 128/DataMatrix = Code.
- **Etiketten**: Layout in mm (`$lib/sdk/labels`), Platzhalter `{feld}` je Ziel (`LABEL_FIELDS`), Druck `core.pdf.labels` (Bogen mit Startfeld oder Rolle).
  Drucken mit `inventory.manage` oder `labels.manage`.

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `material.inventory.view` | Bestand, Orte, Sets, Reservierungen ansehen, scannen; Grundrecht |
| `material.inventory.manage` | Bestand pflegen (Orte, Kategorien, Artikel, Stücke, Kisten, Mengen, Sets, Vorlagen), Etiketten drucken |
| `material.reservation.create` | Reservieren, eigene ändern/ausgeben/zurücknehmen, Schäden melden |
| `material.reservation.manage` | Alle Reservierungen bearbeiten, ausgeben, zurücknehmen, stornierte löschen |
| `material.labels.manage` | Etikettenformate und -Layouts gestalten, drucken |

## Tests und Demo
Unit `tests/unit/material-nav.test.ts`, `material-cart.test.ts`, `material-label-designer.test.ts`, `tests/unit/material-logic.test.ts` (Verfügbarkeit, Zuteilung, Vollständigkeit, Orte, Codes), `tests/unit/labels.test.ts` (Etiketten-Layout, Barcodes,
HTML, USB-Scanner); Integration `tests/integration/material.test.ts`, Upgrade `material-migrations.test.ts` (0002); E2E `tests/e2e/material.spec.ts`. Demo `node scripts/seed-demo-material.mjs`.

## Offen
- Echte Handy-Kamera (iOS-Polyfill) und echte Etikettendrucker nur nach Deploy mit HTTPS prüfbar.
- Keine Inventur-Historie je Ort, kein Wartungsplan (z. B. Zelte imprägnieren), keine Kosten/Abschreibung.
- Mengenartikel werden bei der Ausgabe nicht je Ort ausgebucht (nur bei Verlust).
