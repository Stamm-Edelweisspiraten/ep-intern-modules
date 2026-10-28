---
paths: ["src/lib/modules/material/**", "src/lib/sdk/labels/**", "src/lib/sdk/style-presets.ts", "src/lib/server/core/pdf/labels.ts", "src/lib/components/layout/BarcodeScanner.svelte", "src/lib/components/layout/scan-input.ts", "tests/**/material*", "tests/unit/labels.test.ts", "scripts/seed-demo-material.mjs"]
---

# Modul `material` (Materialverwaltung / Materialwart*in) – v2

**Neu aufgebaut am 2026-10-28** (Nutzerwunsch: altes Modul mit Stücken/Kisten/Mengen, Zelt-Sets, Ausgabe/Rückgabe verworfen).
Lager mit **Typen** und **Lagerartikeln**, Kategorien mit Icon/Farbe, flache Lagerorte, Reservieren **wie „Bestellen“ im Modul `orders`**,
Scannen (Kamera/USB), Etiketten-Designer (erhalten), Exporte. Schema `mod_material`, Version 2.0.0, keine harten Abhängigkeiten, optional
`actions` (Zweck Aktion), `members` (Zweck Gruppe) und `offices` (Amt „Materialwart*in“). Navigation „Material“ (Icon `boxes`, `order: 45`).

## Entscheidungen des Nutzers (2026-10-28, nicht ungefragt ändern)
- Altdaten **verworfen** (Migration 0004); erhalten bleiben nur Etikettenformate, Etikett-Layouts, Codezähler, vorab vergebene Codes.
- **Typ** (z. B. „Kohtenbahn“) fasst **Lagerartikel** zusammen; ein Artikel hat eine **Anzahl** („Kohtenbahn K1.1“ = 1, „Tampen“ = 21). Typ ist **optional**.
- Reservieren **nach Typ + Anzahl und nach konkretem Artikel** (beides). Reservierung hat **Zeitraum** und Zweck **Aktion / Gruppe / Sonstiges**.
- **Keine** Ausgabe/Rückgabe, **keine** Zelt-Sets. Behalten: **Zustand/Schäden** und **Bilder**.
- Lagerorte sind eine **flache Liste** („Kiste 1“). Aufbau mit **Reitern wie Bestellungen**.
- Etiketten: Designer bleibt; Etikettgrößen im Menü einstellbar; oben rechts „Erstellen“, darunter Kacheln der Etiketten.
- Scannen: Kamera (QR **oder** Strichcode, auch vom Bildschirm) oder USB-Scanner; im Reservieren → Artikel in den Warenkorb, im Lager → Artikel-Dialog
  **zentriert** (kein Seitenblatt).

## Dateien (`src/lib/modules/material/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (5 Rechte, `defaultRoleGrants` „Materialwart*in“ = alle, „Gruppenleitung“ = view + reservieren), Amts-Vorlage `materialwart` (Ereignisse `reservation-created`, `damage-reported`), Job `legacy-cleanup` (stündlich, einmalig wirksam), Hooks `search`, `resetAreas`/`resetUsers`, `onUserDeleted`, `subjectExport`; Endpoint-Reihenfolge images → exports → catalog → codes → reservations → labels |
| `ui.ts` | Routen `''` → `MaterialPage` (Reiter `?tab=` reservieren · meine · alle · lager · etiketten), `scan/:code` → `ScanRedirectPage` (QR-Ziel: Artikel → `?tab=lager&open=`, Ort → `?tab=lager&location=`), `labels/:id` → `LabelDesigner` (vollflächig); Kacheln `mine`, `manage` |
| `schemas.ts` | Vertrag (Zod + DTOs), Codes (`CODE_PREFIX` M/L, `normalizeCode`, `codeFromScan`, `scanPath`), `batchNames`, `reservationState`, `LABEL_FIELDS`, `INVENTORY_COLUMNS` |
| `availability.ts` (rein) | `AvailabilityIndex`: frei je Artikel/Typ als Minimum über die Tage, `check(lines, period)` prüft neue Zeilen gemeinsam |
| `db.ts` | `mdb`, `rows`, `str`, `dateStr`, Codes `nextCodes` (Zähler + Advisory-Lock `material:codes`) / `claimCode`, `likePattern`, `userNames`, Dienste `actionsService`/`membersService`/`officesService` (optional) |
| `inventory.ts` | Laden: `loadCategories`, `loadLocations`, `loadTypes`, `loadItems` (wirksame Kategorie, Bilder, Titelbild vom Typ), `loadStock`, `loadBookings`, `imagesFor` |
| `catalog.endpoints.ts` | `/overview`, Lagerorte, Kategorien (Icon geprüft über `loadIconSet`), `/inventory`, Typen, Artikel (Mehrfach-Anlage, Umlagern, Zustand melden, Archiv, Löschen) |
| `images.endpoints.ts` / `files.ts` | Bilder an Typen und Artikeln (`/types/:id/images…`, `/items/:id/images…`, Pfad `<owner>/<id>/<bild>-<variante>.webp`), `removeLegacyImages` |
| `reservations.service.ts` / `.endpoints.ts` | Katalog, Zweck prüfen (`accessibleActions`, `listGroups`), Liste/Detail, `checkLines`/`assertLinesAvailable` (409 mit `details.lines`), `replaceLines`/`mergeLines` |
| `codes.endpoints.ts` | `GET /codes/:code` (Artikel → Ort → reserviert), `POST /codes/reserve` |
| `labels.endpoints.ts` | Formate (Vorgaben aus `$lib/sdk/labels` + eigene `custom:<id>`), Layouts, `POST /labels.pdf` (`labelValues` für `item`/`location`/`blank`) |
| `exports.endpoints.ts` | `POST /exports/inventory` (PDF/CSV, nach Kategorie oder Lagerort), `GET /reservations/:id/packing-list?format=`, `POST /exports/reservations` |
| `notify.ts`, `search.ts`, `reset.ts`, `user-deleted.ts`, `subject-export.ts`, `legacy-cleanup.ts` | Hooks |
| `pages/` | `MaterialPage`, `ScanRedirectPage`, `reserve/` (Katalog, Warenkorb), `reservations/` (Listen, Detail, Export), `inventory/` (Lagertabelle, Dialoge), `labels/` (Kacheln, Designer), `shared/` (`ScanButton`, `scan.ts`, `CategoryGlyph`, `ImageManager`, `PrintLabelsDialog`, Vorschauen), `widgets/`, `helpers.ts` |

## Datenmodell (Migration 0004; 0001–0003 = altes Modell, nicht ändern)
`locations` (flach, `code` `L-…`, `position`), `categories` (`icon`, `color` `#rrggbb` klein, `position`), `types` (`category_id`, `archived_at`),
`items` (`type_id` RESTRICT nullable, `category_id` nur ohne Typ, `quantity ≥ 1`, `location_id` SET NULL, `code` UNIQUE `M-…`, `condition`
ok|worn|damaged|defect|lost + Notiz/gemeldet von/am, `archived_at`), `images` (`type_id` **oder** `item_id`), `reservations` (`purpose`
action|group|other, `action_id`/`group_id` ohne FK, `status` reserved|cancelled), `reservation_lines` (`type_id` **oder** `item_id`, `quantity`),
`label_formats`, `label_templates` (Ziel `item|location|blank`), `code_counters`, `reserved_codes`, `legacy_cleanup` (Marker).

## Regeln
- **Verfügbarkeit**: je Tag Artikel I frei = nutzbare Anzahl − Artikel-Zeilen(I); Typ T frei = Σ nutzbare Anzahl seiner Artikel − Artikel-Zeilen
  dieser Artikel − Typ-Zeilen(T). Nutzbar = nicht defekt/verloren, nicht archiviert. Vergangene Reservierungen belegen nur ihren Zeitraum.
  Speichern unter Advisory-Lock `material:reservations`; Zeilen gleicher Typen/Artikel werden zusammengefasst.
- **Rechte**: ändern/stornieren/löschen = Ersteller*in mit `reservation.create` oder `reservation.manage`; Liste „alle“ nur mit `manage`
  (sonst 403); Detail für alle mit `view`. Löschen nur storniert oder vergangen (409). Zustand melden mit `reserve` oder `inventory.manage`.
- **Löschen**: Typ nur ohne Artikel/Reservierungen, Artikel nur ohne Reservierungszeilen (409 → archivieren). Ort löschen → Artikel ohne Ort.
- Codes: `M-000001` (Artikel), `L-…` (Orte); eigener Code frei wählbar, wenn ungenutzt (vorab gedruckte Leer-Etiketten werden dabei verbraucht).
  QR-Inhalt = volle URL `<ORIGIN>/modules/material/scan/<code>`, Code 128/DataMatrix = Code.
- Exporte über `listTemplateInput` (`$lib/pdf-lists/compose`, A4 quer) bzw. `csvDocument` (`$lib/sdk/csv`); Reservierungsübersicht ohne `manage` nur eigene.
- Kategorien-Stil teilt sich `$lib/sdk/style-presets.ts` (`STYLE_COLORS`, `styleColor`, `styleIcon`) mit `files` (Ordner-Aussehen).

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `material.inventory.view` | Lager, Kategorien, Orte, Reservierungen ansehen, scannen, exportieren; Grundrecht |
| `material.inventory.manage` | Lager pflegen (Typen, Artikel, Kategorien, Orte, Bilder), Etiketten drucken |
| `material.reservation.create` | Reservieren, eigene ändern/stornieren, Schäden melden |
| `material.reservation.manage` | Alle Reservierungen sehen, ändern, stornieren, löschen |
| `material.labels.manage` | Etikettgrößen und Etiketten gestalten, drucken |

## Tests und Demo
Unit `tests/unit/material-availability.test.ts`, `material-cart.test.ts`, `material-label-designer.test.ts`, `labels.test.ts`; Integration
`tests/integration/material.test.ts`, Upgrade `material-migrations.test.ts` (0002, 0004); E2E `tests/e2e/material.spec.ts`. Demo `node scripts/seed-demo-material.mjs`.

## Offen
- Echte Handy-Kamera (iOS) und Etikettendrucker nur nach Deploy mit HTTPS prüfbar.
- Keine Ausgabe/Rückgabe und keine Historie je Artikel (bewusst entfallen).
