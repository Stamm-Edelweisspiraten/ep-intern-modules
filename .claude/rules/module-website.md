---
paths: ["modules/website/**", "tests/**/website-module*", "src/lib/sdk/server/html.ts", "src/lib/sdk/slug.ts"]
---

# Modul `website` (Inhalte der Stammeswebsite)

Pflege der öffentlichen Stammeswebsite (`website/`, siehe `website.md`) aus dem Intern-Bereich: **Banner/Hinweise**, **häufige Fragen**
und **Blog**. Schema `mod_website`, Version 1.0.0 (2026-10-25), keine harten Abhängigkeiten, `optionalDependencies: ['members', 'events',
'galleries']` (Gruppen-Verknüpfung und Mitschreiben an Gruppen/Mitglieder, Termin-Verknüpfung, öffentliche Galerien). Navigation
„Website“ (Icon `globe`, `order` 25, `anyPermission` write/manage). Pfade der Website-API: `/api/v1/modules/website/website/…` (doppeltes
„website“ ist richtig – `website/src/lib/server/backend.ts` erlaubt nur `/modules/<x>/website/…`).

Nutzerentscheidungen (2026-10-25): Banner je Eintrag als **Leiste oben auf allen Seiten** oder **Kasten auf der Startseite** (ersetzt den
früheren statischen Ferienhinweis); Blog „ausführlich“ (Bilder im Text, Titelbild, Entwurf/Veröffentlicht + geplanter Zeitpunkt, Autor*in nur
Vorname, Verknüpfung Gruppen/Termin/Galerie, Themen mit Filter, RSS, Mitschreiben per Freigabe); **getrennte Rechte**.

## Dateien (`modules/website/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest, Migration, `search`, `resetAreas`/`resetUsers`, `onUserDeleted`, `subjectExport`; Endpoints (Reihenfolge website → content → posts) |
| `schemas.ts` | `MODULE_ID`, `PERM`, Limits, Zod (`bannerInput`, `faqInput`, `postCreateInput`, `postUpdateInput` partial, `publishInput`, `sharesInput`, `imageUpdateInput`, Queries), DTOs intern + `Website*`, reine Helfer `bannerState`, `firstNameOf` |
| `content.endpoints.ts` | Banner und FAQ (CRUD + `PUT …/order`), `toBanner`/`toFaq`, Antwort-Bereinigung |
| `posts.service.ts` | Laden/Abbilden, `uniqueSlug`/`slugTaken`, Themen, Gruppen, Bilder, `buildDetail` (Namen, Freigaben, Verweise nach der Transaktion), Dienste `eventsService`/`galleriesService`/`listGroups` |
| `posts.endpoints.ts` | Beiträge, Veröffentlichen, Freigaben, Bilder, Hilfen (`/tags`, `/refs/*`, `/principals`) |
| `access.ts` | `createShareAccess` (`post_shares`, Eigentum `author_id`, `viewAll`/`editAll` = `website.post.publish`), `canPublish`, `visiblePostsFilter` |
| `files.ts` | Storage mit Systemkontext `website-files`, Varianten `thumb` 640 / `web` 1600 WebP, Pfad `posts/<postId>/<imageId>-<variant>.webp` |
| `website.endpoints.ts` / `website.schemas.ts` | Website-API + Zod-Vertrag (`Exact<>`-Typgleichheit) |
| `search.ts`, `privacy.ts`, `reset.ts` | Globale Suche (Beiträge), `onUserDeleted`/`subjectExport`, Reset `all` (`storagePrefixes: 'all'`, `rebuild` – legt die Startfragen neu an) |
| `ui.ts`, `pages/` | `''` → `PostsPage`, `banners` → `BannersPage`, `faq` → `FaqPage`, `posts/:id` → `PostEditorPage`; `WebsiteTabs` (Reiter nach Recht), `BannerDialog`, `FaqDialog`, `helpers.ts` |
| `migrations/0001_init.sql` | `banners`, `faqs` (+ 4 Startfragen aus der alten `website/src/lib/faqs.ts`), `posts`, `post_images`, `post_groups`, `post_tags`, `post_shares` |

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `website.content.manage` | Banner und FAQ pflegen |
| `website.post.write` | Grundrecht Blog (Router-Recht **aller** Beitrags-Endpunkte): eigene Beiträge anlegen/bearbeiten, freigegebene mitbearbeiten, eigene **Entwürfe** löschen |
| `website.post.publish` | zusätzlich zu `write`: alle Beiträge sehen/bearbeiten, veröffentlichen/planen/zurückziehen, alle löschen, Freigaben aller Beiträge ändern |
| `website.content.read` | nur Website-Endpunkte (Scope des Website-API-Keys) |

Keine `website.storage.*`-Rechte: Bilder werden nach der Objektprüfung mit dem Systemkontext gelesen/geschrieben. Freigaben (Mitschreiben)
ändern Autor*in oder `publish`; Freigabe-Typen `user|role|group|member`, Stufe immer `edit`.

## Regeln
- **Banner**: `level` `info|important`, `placement` `bar|home`, Zeitfenster `starts_at`/`ends_at` (Ende > Beginn, sonst 422), Link relativ `/…` oder
  http(s)/mailto, `dismissible` (Website merkt geschlossene Hinweise im `localStorage` als `id:updatedAt`). Zustand `live|scheduled|expired|inactive`.
- **FAQ**: Antwort als Rich-Text (bereinigt, ohne Bilder, ≤ 5000 Zeichen Text), `featured` = auch Startseite, `active` = auf der Website.
- **Beiträge**: Anlegen nur mit Titel → Entwurf mit eindeutigem Slug (`slugify`, `-2`, `-3` …, Advisory-Sperre `website:post-slug`); Slug änderbar
  (doppelt 409). `PATCH` nur übergebene Felder, Listen ersetzen. Text: `sanitizeRichText(html, { images })` – Bilder **nur** als
  `<img data-image-id alt>` mit Bildern dieses Beitrags (fremde/freie `src` entfallen). Beim Speichern von Text oder Titelbild werden **unbenutzte
  Bilder gelöscht** (weder im Text noch Titelbild; auch frisch hochgeladene, die nicht im gespeicherten Text stehen). Veröffentlichen
  (`publish`-Recht) sofort oder geplant (`publishedAt` in der Zukunft → Status `published`, aber erst ab dem Zeitpunkt auf der Website, kein Job nötig).
- Verknüpfungen ohne FK: `post_groups.group_id` (members), `event_id` (events, Anzeige nur für sichtbare Termine), `gallery_id` (nur öffentliche Galerien
  über den neuen Dienst `GalleryRefsService` aus `galleries/contract.ts`). Die Website zeigt Verknüpfungen nur, wenn sie in ihren eigenen öffentlichen
  Listen vorkommen.
- **Website-Autor*in**: Override (`author_name_override`, z. B. „Die Meute“) oder Vorname des Kontos (`firstNameOf`); deaktiviert/gelöscht → `null`.
- Audit `website.banner.*`, `website.faq.*`, `website.post.created|updated|published|unpublished|deleted|shared|image-uploaded` – nur IDs/Zähler/Feldnamen, keine Texte.

## API (`/api/v1/modules/website/…`)
| Methode + Pfad | Recht | Besonderheiten |
|---|---|---|
| GET/POST `/banners`, PUT/DELETE `/banners/:id`, PUT `/banners/order` | content.manage | `order` = alle IDs genau einmal, sonst 422 |
| GET/POST `/faqs`, PUT/DELETE `/faqs/:id`, PUT `/faqs/order` | content.manage | wie Banner |
| GET `/posts?status=all|draft|scheduled|published&tag&search&limit&offset` | post.write | eigene + freigegebene, mit publish alle |
| POST `/posts` `{ title }`, GET/PATCH/DELETE `/posts/:id` | post.write | fremd 404; DELETE ohne publish nur eigener Entwurf (sonst 403) |
| POST `/posts/:id/publish` `{ publishedAt? }`, POST `/posts/:id/unpublish` | post.write + **publish** | sonst 403 |
| PUT `/posts/:id/shares` `{ shares }` | Autor*in oder publish | `validatePrincipals` mit `SHARE_TYPES` |
| POST `/posts/:id/images` (multipart `file`, `alt`), PUT `/posts/:id/images/:imageId` `{ alt }`, GET `/posts/:id/images/:imageId/:variant` | Objekt-edit / -read | ≤ 25 MB, ≤ 100 Bilder je Beitrag, EXIF/GPS entfernt; GET `IMAGE_RATE_LIMIT` |
| GET `/tags`, `/refs/groups`, `/refs/events?search`, `/refs/galleries?search`, `/principals?search` | post.write | `/principals` nur für Teilende (publish oder Autor*in eines Beitrags) |
| GET `/website/banners`, `/website/faqs`, `/website/posts?tag&limit&offset`, `/website/posts/:slug`, `/website/posts/:slug/images/:imageId/:variant` | **content.read** | nur laufende/aktive/veröffentlichte (Zeitpunkt erreicht); Bilder `thumb|web`, `public, max-age=86400` |

## Core-Erweiterungen dafür
- `$lib/sdk/server/html.ts`: `sanitizeRichText(html, { images? })`, `RICH_TEXT_TAGS`, `richTextImageIds` (aus `messages/html.ts` herausgelöst;
  `messages.sanitizeBody` ruft es auf).
- `$lib/sdk/slug.ts`: `slugify(text, max)`, `SLUG_PATTERN`.
- `RichTextEditor`: optionale Bilder (`uploadImage(file) → { id, src, alt? }`, `imageSrc(id)`), Knopf/Einfügen/Ziehen, Alt-Text-Leiste; neue
  Abhängigkeit `@tiptap/extension-image` 3.32.0 (fest). `setEditable` ohne `update`-Ereignis (sonst galt ein frisch geladener Text als geändert).
- Icon `globe`; `galleries` bietet `GalleryRefsService` (`searchPublicGalleryRefs`, `publicGalleryRefs`) über `provides`.

## Benachrichtigungen (2026-10-25, `notify.ts`)
- `post-invited` (neu hinzugekommene Mitschreib-Freigaben), `post-status` (veröffentlicht/geplant/zurückgezogen durch eine andere Person → Autor*in +
  Mitschreibende mit `edit`), Empfänger mit `website.post.write`. Kein eigener Test.

## Tests
`tests/integration/website-module.test.ts` (FAQ-Startdaten/Bereinigung/Reihenfolge, Banner-Zeitfenster und Website-Filter, Slugs, Zugriffsmatrix,
Mitschreiben, Bild-Bereinigung und Aufräumen mit Fake-Storage, geplantes Veröffentlichen, Website-API gegen Schemas, Scope-Key 403 intern, Audit
ohne Texte, Kontolöschung, Modul aus → 404), `tests/unit/sdk-html.test.ts`, Website: `tests/unit/website-rich-text.test.ts`, `website-contract.test.ts`.

## Offen
- Kein E2E für die Editor-Seite; Bild-Upload in der Oberfläche nur mit Fake-Storage/Integrationstest geprüft (Demo ohne MinIO).
- Kein Vorschau-Link auf die Website (die Intern-App kennt die Website-Adresse nicht); kein Autosave (bewusst, Warnung beim Verlassen).
- Termin-/Galerieauswahl zeigt die neuesten 50 (ohne Suche im Auswahlfeld).
- Geplante Beiträge erscheinen auf der Website erst nach Ablauf des Website-Caches (≤ 60 s nach dem Zeitpunkt).
