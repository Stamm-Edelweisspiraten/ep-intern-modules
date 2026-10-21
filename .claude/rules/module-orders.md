---
paths: ["src/lib/modules/orders/**", "tests/**/orders*", "tests/integration/treasury-orders.test.ts", "scripts/seed-demo-orders.mjs"]
---

# Modul `orders` (Bestellungen / Kämmerer*in)

Stammesartikel (Halstuch, Liederbuch, Kluft …) bestellen: Benutzer*innen bestellen für ihre **verknüpften Mitglieder**, die Rechnung geht
**sofort** über die Kasse raus. Die*der Kämmerer*in pflegt Artikel (Größen, Preise, Bilder, Notizen, Nachbestelllinks), gibt Ware aus
(auch teilweise), sieht Lager und Fehlmengen, bestellt beim Lieferanten (Teillieferung) und gibt die Lieferantenrechnung als Auszahlung
an die Kasse. Schema `mod_orders`, Version 1.0.0, **hängt von `members` ab**, optional `treasury` (Rechnungen/Auszahlungen) und
`offices` (Amts-Vorlage „Kämmerer*in“). Navigation „Bestellungen“ (Icon `shopping-basket`).

## Entscheidungen des Nutzers (2026-10-19, nicht ungefragt ändern)
Rechnung **sofort bei Bestellung** (kein Freigabeschritt) · Teillieferung **in beide Richtungen** (Wareneingang vom Lieferanten und Ausgabe
an Mitglieder; Rest bleibt offen bzw. wird nachbestellt) · Benutzer bestellen nur für **verknüpfte Mitglieder**, Kämmerer*in (`manage`)
für **jedes** Mitglied.
**2026-10-19:** Der Warenkorb (Tab „Bestellen“) bietet **nur** die verknüpften Mitglieder (Dropdown, keine Suche); für andere Mitglieder bestellt
die*der Kämmerer*in im Tab „Bestellungen“ über **„Bestellung anlegen“** (`OrderCreateDialog`: Mitglied suchen, Positionen, Notiz → `POST /orders`).

## Dateien (`src/lib/modules/orders/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (Rechte + Beschreibungen, `defaultRoleGrants` Mitglied/Kämmerer*in, Amts-Vorlage `kaemmerer`), Migrationen, Jobs `sync-treasury` (stündlich) + `deficit-digest` (täglich), Endpoint-Reihenfolge images → articles → stock → supplier → orders; Hooks `search`, `resetAreas`/`resetUsers`, `onUserDeleted`, `subjectExport` (kein `onMemberDeleted`) |
| `ui.ts` | Route `''` → `OrdersPage`; Dashboard-Kacheln `manage` („Bestellungen & Lager“, mit `orders.order.manage` oder `orders.stock.manage`) und `mine` („Meine Bestellungen“), Komponenten in `pages/widgets/` |
| `search.ts` | Globale Suche (`ordersSearch`): Artikel nach Titel (Katalog-Sichtbarkeit, mit `orders.article.manage` auch inaktive), Bestellungen nach Nummer/Mitgliedsname (eigene bzw. verknüpfte Mitglieder, mit `orders.order.manage` alle) |
| `user-deleted.ts` | `onUserDeleted`: Daten bleiben, nur Kontoverweise (`created_by`, `uploaded_by`, `ordered_by`) → `NULL` |
| `subject-export.ts` | Datenauskunft (`subjectExport`), siehe unten |
| `schemas.ts` | API-Vertrag (Zod + DTOs `Article`, `Order`, `StockRow`, `SupplierOrder` …, Labels, Grenzen, Kassen-Schlüssel `invoiceSourceKey`/`invoiceLineRef`/`payableRef`, `imageUrl`) |
| `stock.ts` (rein) | `openQty`, `inTransitQty`, `deficit`, `priceRange`, `orderStatus`, `supplierStatus`, `billableCents`, `formatNumber`, `lineDescription` |
| `db.ts` | `mdb`, `rows`, `today()` (= `todayBerlin()`, Test-Override `setTodayForTests` aus `$lib/sdk/dates`), `nextNumber` (B-/E-JJJJ-NNNN, Advisory-Lock), Dienste `membersService`, `treasuryService()`/`officesService()` (optional, `null`), `userNames` |
| `articles.service.ts` / `articles.endpoints.ts` | Artikel laden (Katalog vs. Verwaltung), CRUD, Varianten ersetzen (archivieren statt löschen, wenn verwendet), Reihenfolge |
| `files.ts` / `images.endpoints.ts` | Bilder wie `galleries` (Systemkontext `orders-files`, `core.images.process` thumb 480 / web 1600 WebP; Auslieferung gestreamt, `IMAGE_RATE_LIMIT` 1200/60 s; Löschen per `core.storage.removeMany`, #23/#24) |
| `orders.service.ts` / `orders.endpoints.ts` | Bestellen, Liste/Detail, Storno, Ausgabe, `/my/members`, `/members`, `/overview` |
| `stock.endpoints.ts` | Lager (Bestand, Nachfrage, unterwegs, Fehlmenge), Korrektur, Bewegungen |
| `supplier.endpoints.ts` | Einkauf: Vorschlag, CRUD, Wareneingang, Rest stornieren, abschließen/öffnen, Lieferantenrechnung (multipart) |
| `treasury-link.ts` | `pushInvoice`, `pushPayable`, `syncTreasury` (Job) |
| `notify.ts` | Amt `kaemmerer`: `order-created` (nach Bestellung), `stock-deficit` (Tagesjob, nur bei geändertem Stand – `digest_state`) |
| `reset.ts` | Bereich `all` (alle Tabellen + Bilder, `rebuild`), `resetUsers` |
| `pages/` | `OrdersPage` (Tabs `?tab=` bestellen · meine · bestellungen · lager · einkauf · artikel je nach Recht), `CatalogTab`/`ArticleCard`/`ArticleDetailDialog`/`CartPanel` (Warenkorb in `sessionStorage`, mobil `MobileActionBar` + Sheet), `MyOrdersTab`, `ArticlesTab`/`ArticleDialog`/`VariantEditor`/`ImageManager`, `OrdersAdminTab`/`OrderCreateDialog`/`HandoutDialog`/`CancelItemsDialog`, `StockTab`/`StockCorrectionDialog`, `SupplierOrdersTab`/`SupplierOrderDialog`/`ReceiveDialog`/`SupplierInvoiceDialog`, Badges `OrderStatusBadge`/`PaymentBadge`/`SupplierStatusBadge`, `helpers.ts`, `admin-helpers.ts` |
| `migrations/0001_init.sql`, `0002_digest_state.sql`, `0003_fk_indexes.sql` | Schema; Merker der Fehlmengen-Meldung; Indizes `stock_movements.order_item_id`/`supplier_item_id` (#73) |

## Datenmodell
- `articles` (`title`, `description`, `notes` intern, `reorder_url`, `active`, `position`, `archived_at`) · `article_variants` (`label` – `''` = ohne Größe,
  `price_cents`, `reorder_url`, `stock` ≥ 0, `min_stock`, `archived_at`; **jeder Artikel ≥ 1 Variante**) · `article_images` (thumb/web-Pfade, erstes = Titelbild).
- `orders` (`B-JJJJ-NNNN`, `member_id` ohne FK + `member_name` Snapshot, `ordered_by`, `invoice_id`/`invoice_number`, `treasury_dirty`, `treasury_synced_at`)
  · `order_items` (Snapshot Titel/Größe/Einzelpreis, `quantity`, `delivered_qty`, `cancelled_qty`, CHECK Summe ≤ Menge).
- `supplier_orders` (`E-JJJJ-NNNN`, Lieferant, Datum, Rechnung `invoice_amount_cents`/`invoice_recipient`/`payable_ref`, `closed_at`) · `supplier_order_items`
  (`received_qty`, `cancelled_qty`, `unit_cost_cents`).
- `stock_movements` (`delta`, `kind` receipt|handout|correction|return, Bezug auf Position) – Bestand steht in `article_variants.stock`, gleiche Transaktion.

## Regeln
- **Positionen** neuer Artikel/Bilder (`MAX(position)+1`) und die Höchstzahlen werden unter `pg_advisory_xact_lock(hashtext('orders:articles'))` bzw. `'orders:article-images:<id>'` vergeben → parallele Anlagen bekommen eindeutige Positionen (#73, 07-12).
- **Preise sind Snapshots**: Preisänderungen am Artikel ändern bestehende Bestellungen/Rechnungen nicht.
- **Fehlmenge** je Variante = max(0, offene Nachfrage + Mindestbestand − Bestand − unterwegs). „Bestellvorschlag übernehmen“ legt daraus eine Lieferantenbestellung an.
- **Lager-Tab** (2026-10-20): eine Zeile je Artikel; Artikel mit Größen zeigen Summen + Größen-Chips (`S: 3`) und lassen sich aufklappen
  (bei Suche/„Nur Fehlmengen“ automatisch offen, nur passende Größen). 20 Artikel je Seite, clientseitig (`pages/stock-groups.ts`
  `groupStockRows`/`paginate`, Unit `tests/unit/orders-stock-groups.test.ts`, E2E `tests/e2e/orders-stock.spec.ts`). `GET /stock` unverändert.
- **Größen-Reihenfolge** (2026-10-20): im Artikel-Dialog (Tab „Größen & Preise“, `VariantEditor`) per Griff ziehen (Desktop) oder Pfeile;
  die Listenreihenfolge wird beim Speichern zu `article_variants.position` (Katalog, Lager, Bestellung). IDs bleiben erhalten.
- **Ausgabe** nur aus dem Lager (Menge ≤ offen und ≤ Bestand, sonst 422/409 „Nur N auf Lager“). **Storno**: eigene Bestellung (create) nur, solange nichts
  ausgegeben ist (409); `manage` storniert beliebige offene Mengen. Storno-Grund nur als `hasReason` im Audit.
- **Lieferantenbestellung**: Positionen änderbar, solange nichts eingegangen ist (409); Wareneingang in Teilmengen erhöht den Bestand; „Rest stornieren“
  storniert offene Mengen und schließt ab (Fehlmengen erscheinen wieder im Lager).
- Varianten, die bestellt/eingekauft/bewegt wurden oder Bestand haben, werden beim Entfernen **archiviert**; Artikel mit Verwendung werden beim Löschen archiviert.

## Kasse (Push, `treasury/external.ts`, Vertrag `treasury/contract.ts`)
- Bestellung → `upsertOrderInvoice` (Rechnung `source='order'`, `source_key = order:<id>`, Posten `order:<id>:<itemId>` mit `member_id`, Notiz „Bestellung B-…“
  + Notiz der Bestellung). Neu → `R-JJJJ-NNNN` + Mail mit PDF; Storno/Teilstorno → Posten angepasst, versendete Rechnungen bekommen „Geänderte Rechnung“/„Stornierung“;
  keine Posten mehr → Rechnung storniert (Bezahltes wird beim nächsten Kassen-Abgleich Guthaben).
- Kasse inaktiv oder Fehler → Bestellung bleibt gültig, `treasury_dirty = true`, Job `orders.sync-treasury` holt nach (erste Rechnung wird dann verschickt).
- Lieferantenrechnung (`PUT /supplier-orders/:id/invoice`, multipart, Beleg ≤ 10 MB) → `upsertOrderPayable` (`source='order'`, Schlüssel `order-supplier:<id>`,
  IBAN verschlüsselt, Meldung an Amt „Kasse“); ohne aktive Kasse 409. Entfernen → `cancelOrderPayable` (bezahlt → 409).
- Zahlstand: `invoiceStatus` (Bestellungen, `PaymentBadge`) und `payableStatus` (Einkauf „Bezahlt“-Spalte).
- In der Kasse: Herkunft „Bestellung“ bzw. „Bestellung (Lieferant)“; Bestell-Rechnungen nur Empfänger/Frist/Notiz änderbar, Löschen 409; Kassen-Abgleich
  (`sync.ts` nur `action:%`, `syncPayables` ohne `manual`/`order`) lässt sie unberührt. Die Kasse überschreibt beim Push Empfänger/Frist/Notiz nicht.

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `orders.order.view` | Katalog, eigene Bestellungen; Grundrecht |
| `orders.order.create` | Für verknüpfte Mitglieder bestellen, eigene stornieren (solange nichts ausgegeben) |
| `orders.order.manage` | Alle Bestellungen, für jedes Mitglied bestellen, ausgeben, stornieren |
| `orders.article.manage` | Artikel, Größen, Preise, Notizen, Nachbestelllinks, Bilder |
| `orders.stock.manage` | Lager, Korrekturen, Einkauf, Wareneingang, Lieferantenrechnung an die Kasse |
`defaultRoleGrants`: „Mitglied“ → view + create; „Kämmerer*in“ → alle. Die Amts-Vorlage `kaemmerer` verleiht **keine** Rolle von selbst – Rolle „Kämmerer*in“ im
Amt verknüpfen (Modul `offices`), dann erhalten die Inhaber*innen die Rechte. Keine `orders.storage.*`-Rechte (Bilder per Systemkontext).

## API (`/api/v1/modules/orders/…`)
`GET/POST /articles`, `PUT /articles/order`, `GET/PATCH/DELETE /articles/:id`, Bilder `POST /articles/:id/images`, `PUT …/images/order`,
`DELETE …/images/:imageId`, `GET …/images/:imageId/:variant` · `GET /my/members`, `GET /members?search=`, `GET /overview` · `GET/POST /orders`,
`GET /orders/:id`, `POST /orders/:id/cancel|handout` · `GET /stock`, `POST /stock/corrections`, `GET /stock/movements` · `GET /supplier-orders/suggestion`,
`GET/POST /supplier-orders`, `GET/PATCH /supplier-orders/:id`, `POST …/:id/receive|cancel-rest|close|reopen`, `PUT/DELETE …/:id/invoice`.
Audit `orders.article.*`, `orders.order.created|cancelled|handed-out`, `orders.stock.corrected`, `orders.supplier-order.*` – nur IDs/Zähler/Beträge.

## Tests und Demo
Unit `tests/unit/orders-stock.test.ts`; Integration `tests/integration/orders-articles.test.ts` (Fake-Storage), `orders.test.ts`, `orders-treasury.test.ts`,
`treasury-orders.test.ts`; E2E `tests/e2e/orders.spec.ts` (Artikel anlegen, „Bestellung anlegen“ für ein Mitglied + Ausgabe, Einkauf mit Teillieferung).
Demo: `node scripts/seed-demo-orders.mjs` (nach `seed-demo-modules.mjs`, Bilder brauchen MinIO).

## Offen
- Archivierte Artikel lassen sich nicht wiederherstellen; Lieferant ist Freitext (keine Vorschläge); Storno-Grund wird nicht gespeichert.
- Zahlungen auf Bestell-Rechnungen bekommen keine eigene Kategorie (z. B. „Material“).
- Ungeprüft: Beleg-/Bild-Upload mit echtem S3 im Echtbetrieb, echter SMTP-Versand, Fehlmengen-Tagesmail im Echtbetrieb.

## Datenauskunft (#30)
- `subject-export.ts` (Hook `subjectExport` in `module.ts`): Bestellungen für die Mitglieder der Person (Konto → verknüpfte Mitglieder via `members.resolve`) mit Positionen und Ausgaben/Rücknahmen; vom Konto für andere aufgegebene Bestellungen nur Nummer/Datum (keine Daten Dritter). Rechnungen stehen in der Kasse. Test `tests/integration/privacy-subject-export.test.ts`.

## Verweise auf `members`, Löschen und Reset (Stand 2026-10-21, Issue #76 10-09)
- `orders.member_id` (Mitglied aus `members`, ohne FK; Name als Snapshot `member_name`): `orders` hat **kein** `onMemberDeleted` – Löschen oder
  Anonymisieren eines Mitglieds lässt die Bestellungen samt Namens-Snapshot stehen. Reset `members:all` impliziert keinen `orders`-Bereich; `orders:all`
  (`reset.ts`) hat ebenfalls keine `implies` (Rechnungen/Auszahlungen der Kasse aus Bestellungen bleiben).
- Benutzerkonten: `onUserDeleted` setzt nur Verweise auf `NULL`.
