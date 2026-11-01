---
paths: ["modules/material/**", "src/lib/sdk/labels/**", "src/lib/sdk/style-presets.ts", "src/lib/server/core/pdf/labels.ts", "src/lib/components/layout/BarcodeScanner.svelte", "src/lib/components/layout/scan-input.ts", "tests/**/material*", "tests/unit/labels.test.ts", "scripts/seed-demo-material.mjs"]
---

# Modul `material` (Materialverwaltung / Materialwart*in) – v2.1

**Neu aufgebaut am 2026-10-28** (Nutzerwunsch: altes Modul mit Stücken/Kisten/Mengen, Zelt-Sets, Ausgabe/Rückgabe verworfen).
Lager mit **Typen** und **Lagerartikeln**, Kategorien mit Icon/Farbe, flache Lagerorte, Reservieren **wie „Bestellen“ im Modul `orders`**,
Scannen (Kamera/USB), Etiketten-Designer (erhalten), Exporte. **Seit 2026-10-28 (v2.1.0, Migr. 0005)**: Sets, Zelte als Bauplan, automatische
Zuteilung konkreter Artikel und „Ausgegeben“. Schema `mod_material`, Version 2.1.0, keine harten Abhängigkeiten, optional
`actions` (Zweck Aktion), `members` (Zweck Gruppe) und `offices` (Amt „Materialwart*in“). Navigation „Material“ (Icon `boxes`, `order: 45`).

## Entscheidungen des Nutzers (2026-10-28, nicht ungefragt ändern)
- Altdaten **verworfen** (Migration 0004); erhalten bleiben nur Etikettenformate, Etikett-Layouts, Codezähler, vorab vergebene Codes.
- **Typ** (z. B. „Kohtenbahn“) fasst **Lagerartikel** zusammen; ein Artikel hat eine **Anzahl** („Kohtenbahn K1.1“ = 1, „Tampen“ = 21). Typ ist **optional**.
- Reservieren **nach Typ + Anzahl und nach konkretem Artikel** (beides). Reservierung hat **Zeitraum** und Zweck **Aktion / Gruppe / Sonstiges**.
- ~~Keine Zelt-Sets~~ → ersetzt am 2026-10-28 (v2.1, siehe unten). Weiterhin **keine** Rückgabe per Scan. Behalten: **Zustand/Schäden** und **Bilder**.
- **Sets und Zelte (2026-10-28, v2.1)**: Ein **Set** ist eine Gruppe zusammengehöriger Artikel (z. B. „KJ1“ = Kohtenbahnen KJ1.1–KJ1.6); die
  Artikel bleiben normale Artikel ihres Typs und einzeln reservierbar. Ein **Zelt** ist ein **Bauplan** aus Typen und Artikeln (z. B. Jurte = Dach
  6 × Kohtenbahn „möglichst aus einem Set“ + Wand + Abspannseil) und lässt sich reservieren. Ohne gewählte Bahnen teilt das System **automatisch
  konkrete Artikel** zu, bevorzugt ganze Sets; ist keins vollständig frei, wird kombiniert und ein **Hinweis** gezeigt (Speichern bleibt möglich).
- Zuteilung wird **beim Speichern** festgehalten und **automatisch umgeplant**, solange die Reservierung in der Zukunft liegt und nicht
  ausgegeben ist. Knopf **„Ausgegeben“** (Verwaltung) schreibt sie fest; von Hand gesetzte Zuteilungen bleiben ebenfalls fest.
- Lagerorte sind eine **flache Liste** („Kiste 1“). Aufbau mit **Reitern wie Bestellungen**.
- Etiketten: Designer bleibt; Etikettgrößen im Menü einstellbar; oben rechts „Erstellen“, darunter Kacheln der Etiketten.
- Scannen: Kamera (QR **oder** Strichcode, auch vom Bildschirm) oder USB-Scanner; im Reservieren → Artikel in den Warenkorb, im Lager → Artikel-Dialog
  **zentriert** (kein Seitenblatt).

## Dateien (`modules/material/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (5 Rechte, `defaultRoleGrants` „Materialwart*in“ = alle, „Gruppenleitung“ = view + reservieren), Amts-Vorlage `materialwart` (Ereignisse `reservation-created`, `damage-reported`), Job `legacy-cleanup` (stündlich, einmalig wirksam), Hooks `search`, `resetAreas`/`resetUsers`, `onUserDeleted`, `subjectExport`; Endpoint-Reihenfolge images → exports → catalog → codes → reservations → labels |
| `ui.ts` | Routen `''` → `MaterialPage` (Reiter `?tab=` reservieren · meine · alle · lager · etiketten), `scan/:code` → `ScanRedirectPage` (QR-Ziel: Artikel → `?tab=lager&open=`, Ort → `?tab=lager&location=`), `labels/:id` → `LabelDesigner` (vollflächig); Kacheln `mine`, `manage` |
| `schemas.ts` | Vertrag (Zod + DTOs), Codes (`CODE_PREFIX` M/L, `normalizeCode`, `codeFromScan`, `scanPath`), `batchNames`, `reservationState`, `LABEL_FIELDS`, `INVENTORY_COLUMNS` |
| `availability.ts` (rein) | `AvailabilityIndex`: frei je Artikel/Typ als Minimum über die Tage, `check(lines, period)` prüft neue Zeilen gemeinsam; `Booking.assigned` = feste Zuteilung (zählt nur beim Artikel) |
| `allocation.ts` (rein) | `allocate(candidates, needed, { slotSize })`: ganze Sets → lose → angebrochene Sets; mit `slotSize` je Zelt ein Set (genau passend, sonst kleinstes ausreichendes, sonst gemischt); `setCompleteness` |
| `assignment.ts` (rein) | `planAssignments({ items, fixed, requests })`: Greedy nach Beginn, bisherige Zuteilung bleibt, solange gültig (zweiter Lauf ohne diese Rücksicht, wenn etwas fehlt); `samePicks`, `slotInfo` (Hinweis „gemischt“) |
| `tents.ts` (rein) | `expandTent(parts, count)` → Teil-Zeilen mit `slotSize`, `tentFree(index, parts, period)` = baubare Zelte |
| `assign.service.ts` | `loadPlanInput`, `reassignAll`/`reassignLocked` (alle laufenden/kommenden Reservierungen, schreibt nur geänderte Zeilen), `previewPlan` (Vorschau im Warenkorb), `describePicks` |
| `sets.endpoints.ts` | Sets (`/sets`, `/sets/order`, `/sets/:id`, `PUT /sets/:id/items`, Auflösen) und Zelte (`/tents`, Teile komplett ersetzen, Archiv, Löschen nur unbenutzt) |
| `db.ts` | `mdb`, `rows`, `str`, `dateStr`, Codes `nextCodes` (Zähler + Advisory-Lock `material:codes`) / `claimCode`, `likePattern`, `userNames`, Dienste `actionsService`/`membersService`/`officesService` (optional) |
| `inventory.ts` | Laden: `loadCategories`, `loadLocations`, `loadTypes`, `loadItems` (wirksame Kategorie, Bilder, Titelbild vom Typ), `loadStock`, `loadBookings`, `imagesFor` |
| `catalog.endpoints.ts` | `/overview`, Lagerorte, Kategorien (Icon geprüft über `loadIconSet`), `/inventory`, Typen, Artikel (Mehrfach-Anlage, Umlagern, Zustand melden, Archiv, Löschen) |
| `images.endpoints.ts` / `files.ts` | Bilder an Typen und Artikeln (`/types/:id/images…`, `/items/:id/images…`, Pfad `<owner>/<id>/<bild>-<variante>.webp`), `removeLegacyImages` |
| `reservations.service.ts` / `reservations.endpoints.ts` | Katalog (Typen mit `sets`, Zelte mit `parts`), Zweck prüfen, Liste/Detail (Zeilen verschachtelt: Zelt → Teile, je Typ-Zeile `assignments`/`missing`/`mixedSlots`, `notices`), `checkLines` (Zelte aufgelöst, `preview` → `note`), `replaceLines` (Zelt-Teile, übernimmt bisherige Zuteilung), `hand-out` (POST/DELETE), `PUT …/lines/:lineId/assignment` (angeheftet), `POST …/reassign` |
| `codes.endpoints.ts` | `GET /codes/:code` (Artikel → Ort → reserviert), `POST /codes/reserve` |
| `labels.endpoints.ts` | Formate (Vorgaben aus `$lib/sdk/labels` + eigene `custom:<id>`), Layouts, `POST /labels.pdf` (`labelValues` für `item`/`location`/`blank`) |
| `exports.endpoints.ts` | `POST /exports/inventory` (PDF/CSV, nach Kategorie oder Lagerort), `GET /reservations/:id/packing-list?format=`, `POST /exports/reservations` |
| `notify.ts`, `search.ts`, `reset.ts`, `user-deleted.ts`, `subject-export.ts`, `legacy-cleanup.ts` | Hooks |
| `pages/` | `MaterialPage`, `ScanRedirectPage`, `reserve/` (Katalog inkl. Zelte/ganze Sets, Warenkorb mit Zuteilungs-Hinweis), `reservations/` (Listen, Detail mit Zuteilung/Ausgabe, `AssignmentDialog`, Export), `inventory/` (Ansichten Artikel · Sets · Zelte: Lagertabelle, `SetsView`/`SetDialog`, `TentsView`/`TentDialog`, Dialoge), `labels/` (Kacheln, Designer), `shared/` (`ScanButton`, `scan.ts`, `CategoryGlyph`, `ImageManager`, `ItemPicker` mit `seed`, `PrintLabelsDialog`, Vorschauen), `widgets/`, `helpers.ts` |

## Datenmodell (Migration 0004; 0001–0003 = altes Modell, nicht ändern)
`locations` (flach, `code` `L-…`, `position`), `categories` (`icon`, `color` `#rrggbb` klein, `position`), `types` (`category_id`, `archived_at`),
`items` (`type_id` RESTRICT nullable, `category_id` nur ohne Typ, `quantity ≥ 1`, `location_id` SET NULL, `code` UNIQUE `M-…`, `condition`
ok|worn|damaged|defect|lost + Notiz/gemeldet von/am, `archived_at`), `images` (`type_id` **oder** `item_id`), `reservations` (`purpose`
action|group|other, `action_id`/`group_id` ohne FK, `status` reserved|cancelled), `reservation_lines` (`type_id` **oder** `item_id`, `quantity`),
`label_formats`, `label_templates` (Ziel `item|location|blank`), `code_counters`, `reserved_codes`, `legacy_cleanup` (Marker).
Migration 0005: `sets`, `items.set_id` (SET NULL), `tents`, `tent_parts` (`type_id` **oder** `item_id`, `quantity`, `from_one_set`, `label`),
`reservation_lines.tent_id|parent_line_id|label|slot_size` (genau eines von Typ/Artikel/Zelt; Zelt-Zeilen belegen nichts, ihre Teile schon),
`reservation_assignments` (`line_id`, `item_id`, `quantity`, `pinned`, `slot` = Nummer des Zelts), `reservations.handed_out_at|by`.

## Regeln
- **Verfügbarkeit**: je Tag Artikel I frei = nutzbare Anzahl − Artikel-Zeilen(I); Typ T frei = Σ nutzbare Anzahl seiner Artikel − Artikel-Zeilen
  dieser Artikel − Typ-Zeilen(T). Nutzbar = nicht defekt/verloren, nicht archiviert. Vergangene Reservierungen belegen nur ihren Zeitraum.
  Speichern unter Advisory-Lock `material:reservations`; Zeilen gleicher Typen/Artikel werden zusammengefasst.
- **Zuteilung**: `reassignAll` nach jedem Speichern/Stornieren und nach Bestandsänderungen (Zustand, Archiv, Typ, Anzahl, Set, Löschen), stündlich
  per Job `assign-refresh`. Umplanbar = Beginn > heute und nicht ausgegeben; sonst bleibt die Zuteilung (nicht ausgegebene laufende werden nur
  ergänzt). Angeheftete (`pinned`) und eingefrorene Zuteilungen belegen den Artikel (`assigned`-Buchung) – gezielte Reservierung → 409. Gezielte
  Reservierung einer nur automatisch zugeteilten Bahn plant die andere Reservierung um. Fehlt nach einem Defekt etwas, steht es als
  „noch nicht zugeteilt“ in Detail und Packliste. Hinweis „gemischt“ nur, wenn es für den Typ überhaupt Sets gibt.
- **Ausgabe**: `hand-out` mit `reservation.manage` oder `inventory.manage`; danach Ändern/Stornieren/Neu zuteilen 409, bis zurückgenommen.
- **Rechte**: ändern/stornieren/löschen = Ersteller*in mit `reservation.create` oder `reservation.manage`; Liste „alle“ nur mit `manage`
  (sonst 403); Detail für alle mit `view`. Löschen nur storniert oder vergangen (409). Zustand melden mit `reserve` oder `inventory.manage`.
- **Löschen**: Typ nur ohne Artikel/Reservierungen/Zelt-Teile, Artikel nur ohne Reservierungszeilen, Zelt-Teile und feste Zuteilungen (409 →
  archivieren; automatische Zuteilungen kommender Reservierungen gehen an andere Artikel). Ort löschen → Artikel ohne Ort. Set auflösen → Artikel bleiben.
  Zelt löschen nur unbenutzt, sonst archivieren; Bauplan ändern wirkt nur auf neue Reservierungen.
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

## Handy (< 640 px, `deviceLayout() === 'phone'`; Tablet/Desktop unverändert, 2026-10-29)
- Reiter als einzeilige `ScrollPills` mit Kurznamen (Reservieren · Meine · Alle · Lager · Etiketten), Seitenbeschreibung ausgeblendet.
- Reservieren: kompakte Zeilen `reserve/EntryRow.svelte` mit −/+ direkt in den Warenkorb (Typ = beliebige, Artikel, Zelt; gezielt gewählte
  Artikel zählen mit, aber nur über die Details), Suche + Scan-Symbol in einer Zeile, Kategorien seitlich scrollbar, Warenkorb-Leiste unten.
- Lager: `ListRow`-Liste (Typen → Typ-Dialog, gefiltert alle Artikel flach), Filter im `BottomSheet` (`ChoiceChips`), Kategorien/Lagerorte/Export
  im „…“-Blatt, Auswahl per langem Drücken, einzeilige Auswahlleiste mit Symbolknöpfen.
- Reservierungen: `ListRow`-Liste, Status als Pillen. Dialog-Füße zweispaltig; Detail-Dialog fokussiert auf Touch kein Zahlenfeld.

## Tests und Demo
Unit `tests/unit/material-availability.test.ts`, `material-allocation.test.ts` (Zuteilung, Planer, Zelte), `material-cart.test.ts`,
`material-label-designer.test.ts`, `labels.test.ts`; Integration `tests/integration/material.test.ts`, `material-sets.test.ts` (Sets, Zelte, Umplanen,
Ausgabe, Anheften), Upgrade `material-migrations.test.ts` (0002, 0004, 0005); E2E `tests/e2e/material.spec.ts`. Demo `node scripts/seed-demo-material.mjs`
(Sets K1/K2/KJ1/KJ2, Zelte Kohte/Jurte).

## Offen
- Echte Handy-Kamera (iOS) und Etikettendrucker nur nach Deploy mit HTTPS prüfbar.
- Keine Rückgabe per Scan und keine Historie je Artikel (bewusst entfallen); „Ausgegeben“ ist nur eine Markierung.
- Zuteilung ist Greedy nach Beginn (optimal ohne feste Zuteilungen); mit vielen angehefteten Bahnen kann sie Fehlmengen melden, obwohl eine
  andere Verteilung ginge. Zelte haben keine eigenen Bilder (Bild des ersten Teils). E2E für Sets/Zelte fehlt noch.
