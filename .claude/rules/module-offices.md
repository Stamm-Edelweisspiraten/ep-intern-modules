---
paths: ["src/lib/modules/offices/**", "tests/**/offices*", "scripts/seed-demo-offices.mjs"]
---

# Modul `offices` (Ämter)

Ämter des Stammes (Stammesführung, Kasse, Materialwart …) mit Beschreibung, eigener Reihenfolge, E-Mail-Adressen,
verknüpften **Rollen** und **Inhaber*innen** (Benutzerkonten). Inhaber*innen erhalten die Rechte der Amt-Rollen
automatisch über die Core-Tabelle `user_role_grant` (siehe `architecture.md` → „Rollen aus Modulen“), solange sie das
Amt haben und das Modul aktiv ist. Schema `mod_offices`, keine Abhängigkeiten. Navigation „Ämter“ (Icon `offices`).
Website-API für die Stammeswebsite (Ämter, Inhaber*innen, Beschreibung, Profilbild).
Seit 2026-10-19: **Vorlagen-Ämter** aus anderen Modulen (`manifest.offices`, z. B. „Kasse“ aus `treasury`) und
**Benachrichtigungen** per Mail an die Konto-Adresse der Inhaber*innen (Modus je Person und Ereignis im Profil), Dienst
`OfficesService.notify` über `provides` (siehe unten).

## Dateien (`src/lib/modules/offices/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (Rechte + Beschreibungen, `defaultRoleGrants` für „Amtsinhaber*in“, Navigation), Migrationen, `resetAreas`/`resetUsers`, `onUserDeleted`, `subjectExport`, `search`, `provides` (`OfficesService`), Jobs `sync-grants` (stündlich) + `notify-digest` (täglich), Endpoints (Reihenfolge `website` → `notifications` → `profile` → `holders` → `offices`, feste Pfade vor `:id`) |
| `ui.ts` | Route `''` → `OfficesPage`; `profileSections` „Meine Ämter“ (`ProfileOfficesSection`, Recht `offices.office.view`) |
| `schemas.ts` | API-Vertrag: `officeCreateInput`, `officeUpdateInput` (partial, Listen ersetzen), `officeOrderInput`, `holderInput`/`holdersInput`, `bioInput`, `userSearchQuery`, `idParams`, `userIdParams`, `isRealDate`; Konstanten `HOLDER_ROLE_NAME` („Amtsinhaber*in“), `MAX_NAME` 100, `MAX_DESCRIPTION` 5000, `MAX_BIO` 2000, `MAX_EMAILS` 10, `MAX_ROLES` 20, `MAX_HOLDERS` 50, `MAX_OFFICES` 200; DTOs `Office`, `OfficeEmail`, `OfficeRoleRef`, `OfficeHolder`, `MyOffices`, `UserRef`, `RoleRef`, `WebsiteOffice`, `WebsiteOfficeHolder` |
| `load.ts` | `mdb()`, `rowsOf`, `loadOffices`/`loadOfficeOr404` (in der Transaktion); `usersByIds`, `rolesByIds`, `buildOffices`/`buildOffice` (Namen auflösen, **nach** der Transaktion; Unbekannt/„Unbekannte Rolle“) |
| `grants.service.ts` | `holderRoleId`, `syncGrants` (alle Verleihungen aus `office_holders × office_roles` + Inhaber-Rolle neu setzen → `core.roles.replaceModuleGrants`), `validateRoleIds` (unbekannt / Inhaber-Rolle → 422), `assertCanChange` (Rechteausweitung → 403) |
| `offices.endpoints.ts` | CRUD `/offices`, `/offices/order`, `/users`, `/roles` |
| `holders.endpoints.ts` | `PUT /offices/:id/holders` |
| `profile.endpoints.ts` | `/me`, `/me/bio`, `/me/website` (Opt-in Stammeswebsite) |
| `notifications.endpoints.ts` | `GET/PUT /me/notifications` (eigene Benachrichtigungs-Einstellungen je Vorlagen-Amt und Ereignis; gespeichert nur Abweichungen vom Standard „sofort“) |
| `website.endpoints.ts` | `/website/offices`, `/website/offices/holders/:userId/avatar` |
| `website.schemas.ts` | Zod-Vertrag der Website-DTOs (`websiteOfficeSchema`, `websiteOfficeHolderSchema`, #48); Typgleichheit zu `WebsiteOffice`/`WebsiteOfficeHolder` geprüft, Integrationstests parsen die Antworten dagegen |
| `search.ts` | Globale Suche (`officesSearch`): Ämter nach Name/Beschreibung und Namen der Inhaber*innen, sichtbar mit `offices.office.view`; Namen über `core.users.directory` außerhalb der Transaktion |
| `user-deleted.ts` | `onUserDeleted`: Inhaber*innen-Zeilen, Bio, Benachrichtigungs-Einstellungen und Warteschlange der Person löschen, `offices.created_by` → `NULL`, danach `syncGrants` (nach dem Commit) |
| `templates.ts` | `registeredTemplates()` – Vorlagen aller registrierten Module aus den Manifesten (ohne DB) |
| `templates.service.ts` | `applyTemplates` – fehlende Vorlagen-Ämter aktiver Module einmalig anlegen (Marker `office_templates_applied`) |
| `notify.service.ts` | `notify` (Dienst `OfficesService` über `provides`), Tageszusammenfassung (Job `notify-digest`), Daten für `GET/PUT /me/notifications` |
| `contract.ts` | Vertrag `OfficesService`, `OfficeNotification`, `NotifyResult` für andere Module (keine Server-Imports) |
| `subject-export.ts` | Beitrag zur Datenauskunft (`ModuleDefinition.subjectExport`, `/admin/privacy`): Ämter, Bio, Website-Zustimmung, Benachrichtigungs-Einstellungen, Warteschlange des Kontos |
| `reset.ts` | Reset-Bereich `all` (alle acht Tabellen inkl. Vorlagen-Marker und Benachrichtigungen, `rebuild`, keine `implies`; der Core entzieht dabei die verliehenen Rollen), `deletePersonRows` (gemeinsam mit `onUserDeleted`), `resetUsers` (personenbezogene Zeilen fremder Benutzer löschen, `created_by` umschreiben) |
| `pages/OfficesPage.svelte` | Karten je Amt (Beschreibung, E-Mails, Rollen nur mit `manage`, Inhaber*innen mit Avatar/„seit“/Beschreibung), „Amt anlegen“, „Reihenfolge ändern“ (Ziehen oder Pfeile, „Reihenfolge speichern“), Menü Bearbeiten/Löschen, `MyBioCard` für Inhaber*innen |
| `pages/OfficeDialog.svelte` | Anlegen/Bearbeiten mit Tabs Allgemein (Name, Beschreibung, E-Mails, Rollen) / Inhaber*innen (Suche, Reihenfolge, „seit“) |
| `pages/MyBioCard.svelte`, `ProfileOfficesSection.svelte`, `ExpandableText.svelte`, `helpers.ts` | Eigene Beschreibung, Profilkarte, aufklappbarer Text, Hilfen |
| `pages/NotificationPrefsCard.svelte` | Profilkarte „Benachrichtigungen“ (nur für Inhaber*innen): je Vorlagen-Amt die Ereignisse mit `SelectField` Sofort/Täglich/Aus, speichert sofort (optimistisch, Rücksetzen bei Fehler, Toast „Gespeichert“); ohne Vorlagen-Ämter ausgeblendet |
| `migrations/0001_init.sql`, `0002_templates_notifications.sql`, `0003_notification_queue_retention.sql`, `0004_website_optin.sql`, `0005_bio_check.sql` | Schema; Vorlagen-Herkunft, Marker, Benachrichtigungs-Einstellungen, Warteschlange; Website-Opt-in; CHECK `char_length(bio) <= 2000` |

## Datenmodell (0001)
- `offices`: `id` (UUID), `name`, `description`, `position integer` (Reihenfolge, neue Ämter = max + 1), `created_by`, `created_at`, `updated_at`; Index `(position, name)`.
- `office_roles` (PK office+role, FK CASCADE): `role_id` = Core-Rolle **ohne FK** (anderes Schema).
- `office_emails` (`id`, `office_id` FK CASCADE, `email` klein geschrieben, `label`, `position`); Liste wird komplett ersetzt.
- `office_holders` (PK office+user, FK CASCADE): `user_id` ohne FK, `since date` (optional), `position` (Anzeige-Reihenfolge), `created_at`; Index `user_id`.
- `holder_profiles` (PK `user_id`): `bio` (≤ 2000), `updated_at` – **eine** Beschreibung je Person, erscheint bei allen ihren Ämtern.
  0004: `show_on_website boolean DEFAULT false` (Opt-in für die Stammeswebsite, #27) + `show_on_website_at` (Zeitpunkt der letzten Änderung = Nachweis).
  Die Zustimmung bleibt beim Entfernen aus einem Amt bestehen (gilt wieder bei erneuter Zuordnung); `onUserDeleted`/Reset löschen die Zeile.
- 0002: `offices.source_module`/`source_key` (Unique, wo gesetzt), `office_templates_applied(module_id, office_key, applied_at, PK)`,
  `notification_prefs(user_id, module_id, office_key, event_key, mode CHECK immediate|daily|off, PK)` – **nur Abweichungen** vom Standard „sofort“,
  `notification_queue(id, user_id, module_id, office_key, event_key, subject, text, link, created_at)` für die Tageszusammenfassung.
- Core (Migration `drizzle/0006_user_role_grant.sql`): `user_role_grant(user_id FK user CASCADE, role_id FK role CASCADE, module_id, created_at, PK user+role+module)`.

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `offices.office.view` | Grundrecht: Ämter, E-Mails, Inhaber*innen ansehen; `/me`, `/me/bio`. Rolle „Amtsinhaber*in“ bekommt es per `defaultRoleGrants` |
| `offices.office.manage` | Ämter anlegen/bearbeiten/sortieren/löschen, Rollen verknüpfen, Personen zuordnen; `/users`, `/roles` (Handler prüfen zusätzlich Rechteausweitung) |
| `offices.website.read` | **nur** Website-Endpunkte – Scope für den API-Key der Stammeswebsite, kein Zugriff auf interne Endpunkte |

## Rollen aus Ämtern (Regeln)
- Jede*r Inhaber*in bekommt die Rollen **aller** ihrer Ämter plus die Rolle **„Amtsinhaber*in“** (`HOLDER_ROLE_NAME`, gefunden über die Standardrollen-Kennung `core.roles.defaultRoleId` – nie per Name, #67 01a-07;
  bringt `offices.office.view`). Gespeichert in `user_role_grant` mit `module_id = 'offices'`; `syncGrants` ersetzt nach jeder relevanten
  Änderung (Rollen am Amt, Personen, Löschen) **alle** Zeilen des Moduls atomar (`core.roles.replaceModuleGrants`, nie in der Modul-Transaktion).
  Der stündliche Job `offices.sync-grants` gleicht nach (z. B. nach Reset/Wiederherstellung).
- Wirksam nur bei **aktivem Modul** (`getUserPermissions`, `core.users.roleIds`): deaktivieren → Rechte weg, Zeilen bleiben; aktivieren → zurück.
- **Manuelle Rollen** (`user_role`) bleiben unberührt; dieselbe Rolle manuell + über ein Amt → Entfernen aus dem Amt lässt das Recht bestehen.
  Zwei Ämter mit gleicher Rolle → Recht bleibt, bis die Person aus beiden entfernt ist.
- Gelöschte Benutzer (Hook `onUserDeleted`, `user-deleted.ts`): Inhaber*innen-Zeilen, Bio, `notification_prefs`/`notification_queue` der Person
  löschen (gemeinsam mit `resetUsers` über `deletePersonRows` in `reset.ts`), `offices.created_by` → `NULL`, danach `syncGrants`.
- Gelöschte Benutzer/Rollen: FK-Kaskade entfernt die Verleihungen; eine gelöschte Rolle bleibt am Amt als „Unbekannte Rolle“ sichtbar
  (`keep` in `validateRoleIds`, damit Speichern nicht blockiert). Die Inhaber-Rolle selbst kann nicht an ein Amt gehängt werden (422).
- **Rechteausweitung** (`assertCanChange` → `core.roles.assertCanGrant`, 403): Wer Personen eines Amts **hinzufügt oder entfernt** oder ein
  **besetztes** Amt löscht, braucht alle Rechte der Amt-Rollen **und** der Inhaber-Rolle. Wer Rollen eines Amts verknüpft oder löst (POST/PATCH, **auch bei
  unbesetztem Amt**), braucht die Rechte der **geänderten** (hinzugefügten/entfernten) Rollen – sonst könnte jemand ein leeres Amt mit fremden
  Rollen vorbereiten. Nur Umsortieren/„seit“ ändern prüft nichts.
- Neue Inhaber*innen müssen aktive Konten sein (422 `holders.<i>.userId`); bereits zugeordnete, inzwischen deaktivierte dürfen bleiben.

## API (`/api/v1/modules/offices/…`, Session oder API-Key, nicht öffentlich)
| Methode + Pfad | Recht | Besonderheiten |
|---|---|---|
| GET `/offices` | office.view | alle Ämter nach `position`, je `Office` mit `emails`, `roles` (nach Name), `holders` (Reihenfolge der Liste; `bio` je Person), `source` (`{ module, moduleName, key }` oder `null`) und `notifications` (Ereignisse der Vorlage; leer ohne Vorlage bzw. bei inaktivem Modul) |
| GET `/offices/:id` | office.view | 404 unbekannt, 422 keine UUID |
| POST `/offices` | office.manage | `officeCreateInput` (Name Pflicht ≤ 100, E-Mails ≤ 10 ohne Duplikate, Rollen ≤ 20 dedupliziert); neues Amt am **Ende**; 422 unbekannte Rolle / Inhaber-Rolle |
| PATCH `/offices/:id` | office.manage | nur übergebene Felder; `emails`/`roleIds` ersetzen die Liste; Rechteausweitung siehe oben |
| DELETE `/offices/:id` | office.manage | hart (CASCADE) → `{ deleted: true }`; besetzt → Rechteprüfung, danach `syncGrants` |
| PUT `/offices/order` | office.manage | `{ ids }` = **alle** Amt-IDs genau einmal, sonst 422 (Pfad `ids`) → `Office[]` |
| PUT `/offices/:id/holders` | office.manage | `{ holders: [{ userId, since? }] }` ersetzt komplett (≤ 50, keine Duplikate, `since` echtes Datum) → `Office` |
| GET `/users?search=` | office.manage | aktive Benutzer*innen (`core.users.directory`, ab 2 Zeichen, ≤ 30) → `UserRef[]` |
| GET `/roles` | office.manage | alle Rollen (`core.roles.directory({ all: true })`) **ohne** „Amtsinhaber*in“ |
| GET `/me` | office.view | `{ offices: [{id,name}], bio, canEditBio }` |
| GET `/me/notifications` | office.view | `MyNotifications`: `email` (Konto-Adresse oder `null`), `offices: [{ officeId, officeName, module, moduleName, officeKey, events: [{ key, label, description, mode }] }]` – nur eigene **Vorlagen**-Ämter aktiver Module |
| PUT `/me/notifications` | office.view | `{ module, office, event, mode }` (`notificationPrefInput`, Modus `immediate`/`daily`/`off`) → `MyNotifications`; **403**, wenn man das Amt nicht hat, **422** bei unbekanntem Ereignis |
| PUT `/me/bio` | office.view | `{ bio }` (≤ 2000, leer → `null`); ohne Amt **403** |
| PUT `/me/website` | office.view | `{ showOnWebsite }` → `MyOffices` (enthält `showOnWebsite`); ohne Amt **403**; Upsert ohne Verlust der Bio; Audit `offices.profile.website-changed` (`{ showOnWebsite }`) |
| GET `/website/offices` | **website.read** | Rate-Limit 120/60 s; siehe unten |
| GET `/website/offices/holders/:userId/avatar` | **website.read** | Bild roh (`private, max-age=300`, `nosniff`); 404, wenn die Person kein Amt hat, **nicht zugestimmt hat**, deaktiviert ist oder kein Bild/Storage vorhanden ist; `IMAGE_RATE_LIMIT` (1200/60 s, #23). Bild aus `core.users.readAvatar` ist seit #19 **bereinigt** (Core kodiert jedes Profilbild beim Hochladen über `core.images` neu: WebP ≤ 512 px, ohne EXIF/GPS; Bestand per Core-Job `core.avatars-reprocess`) |

Audit: `offices.office.created|updated|deleted|reordered|holders-changed` (metadata: Amtsname, Zähler, Rollen-IDs, bei Personen `added`/`removed`
als Benutzer-IDs) und `offices.profile.updated` (`hasBio`) – **keine** Beschreibungstexte, keine E-Mail-Adressen.

## Vorlagen-Ämter aus Modulen (2026-10-19)
- Ein Modul deklariert Ämter im Manifest: `offices: [{ key, name, description?, notifications: [{ key, label, description? }] }]`
  (Typ `ModuleOfficeTemplate` in `$lib/sdk/types`, Schlüssel `[a-z][a-z0-9-]*`, keine Duplikate – prüft die Registry).
- `applyTemplates` legt für jedes **aktive** Modul jedes noch nicht angewendete Vorlagen-Amt **einmal** an (Name/Beschreibung aus der Vorlage,
  `source_module`/`source_key`, Position am Ende) und setzt den Marker `office_templates_applied`. Aufruf im stündlichen Job `sync-grants`,
  bei `GET /offices` und `GET /me/notifications`.
- Danach ist es ein **normales Amt** (Name, Beschreibung, E-Mails, Rollen, Personen frei änderbar). **Gelöscht** → Benachrichtigungen des Moduls
  erreichen niemanden; wegen des Markers wird es **nicht neu angelegt** (Nutzerentscheidung). Umbenennen ändert die Zuordnung nicht (Schlüssel bleibt).
- UI: Badge „Vorlage: <Modul>“ an der Karte, Hinweis mit Ereignisliste im Bearbeiten-Dialog (Tab Allgemein), Zusatzhinweis in der Lösch-Bestätigung.

## Benachrichtigungen an Inhaber*innen (2026-10-19, seit 2026-10-25 über `core.notifications`)
- `notify` versendet über `core.notifications` (Typ `offices.template`, `scoped` + `digest`, Bereich `<modul>:<amt>:<ereignis>`, Einträge je eigenem
  Vorlagen-Amt über `forUser` = `notificationScopesFor`). Empfänger: Inhaber*innen des Vorlagen-Amts (`source_module` + `source_key`), nur aktive Konten,
  an die **Konto-Adresse** (nicht die Amts-Adressen). Kanal und Sofort/Täglich im Core-Profilreiter „Benachrichtigungen“; Ereignisse eines `notify`-Aufrufs
  werden je Person gebündelt. Alte `notification_prefs` übernimmt `migrateLegacyPrefs` einmalig; Job `notify-digest` arbeitet nur noch die alte Warteschlange ab.
- Keine sensiblen Daten (IBAN) in Betreff/Text – Verantwortung des aufrufenden Moduls.

### Vertrag für Modul-Entwickler*innen (`offices/contract.ts`)
```ts
// Manifest: optionalDependencies: ['offices'],
//           offices: [{ key: 'kasse', name: 'Kasse', notifications: [{ key: 'payable-created', label: '…' }] }]
const offices = await core.modules.useOptional<OfficesService>('offices', MODULE_ID); // null, wenn nicht aktiv
await offices?.notify(ctx, [{ module: MODULE_ID, office: 'kasse', event: 'payable-created',
  subject: 'Neue Überweisung: 12,00 € an …', text: 'Klartext ≤ 4000 Zeichen', link: '/modules/treasury?tab=…' }]);
// → { sent, queued, skipped }
```
- **Nach** der Transaktion aufrufen (nie in `forModule(...).transaction`). `notify` wirft nie (Fehler werden geloggt) – trotzdem `try/catch` um
  `useOptional`, damit Abgleich/Endpunkte nie daran scheitern. Mehrere Ereignisse eines Vorgangs in **einem** Aufruf übergeben (eine Mail je Person).
- `subject` eine Zeile ≤ 150 Zeichen, `text` ≤ 4000 Zeichen, `link` relativer App-Pfad. Unbekanntes Amt/Ereignis, unbesetztes oder gelöschtes Amt → `skipped`.
- Nutzer: `treasury` (Amt `kasse`, Ereignisse `payable-created`, `accounting-closed`; Helfer `treasury/office-notify.ts`), siehe `module-treasury.md`.

## Website-Anbindung
- `WebsiteOffice`: `id`, `name`, `description`, `position`, `emails` (`label`, `email` – Adressen des **Amts**), `holders` (`id`, `firstName`, `bio`, `since`,
  `avatarPath` = relativer API-Pfad oder `null`). **Keine** Benutzer-Mails, Rollen, Zeitstempel; deaktivierte Konten fehlen.
- **Opt-in (#27)**: `holders` enthält nur Personen mit `show_on_website = true` (Schalter „Auf der Stammeswebsite zeigen“ in der Karte „Meine Beschreibung“,
  Profil „Meine Ämter“ und Ämterseite; speichert sofort, Standard aus). Ohne Zustimmung fehlen Name, Bio und Bild ganz – das Amt erscheint mit `holders: []`
  (kein Hinweis „besetzt“). Die Stammeswebsite zeigt die Daten auf `/team` („Unser Team“).
- **Nur Vornamen** (2026-10-24, Nutzerwunsch): `WebsiteOfficeHolder.firstName` = erstes Wort des Kontonamens (`firstNameOf` in
  `website.endpoints.ts`, „Anna-Lena Muster“ → „Anna-Lena“); `avatarPath` trägt `?v=` aus `user.image` (neues Bild → neue Adresse).
- Einrichtung wie bei `events`: API-Key nur mit Scope `offices.website.read`, Abruf **serverseitig**; Profilbilder über `avatarPath` mit demselben Key abrufen und cachen.
  ```bash
  curl -H "Authorization: Bearer epk_…" https://intern.example.org/api/v1/modules/offices/website/offices
  ```
- Modul deaktiviert → `404 module_disabled`.

## Tests
- `tests/integration/offices.test.ts`: CRUD, Reihenfolge (neu am Ende, PUT order, unvollständig/doppelt/fremd 422), Validierung (Name, doppelte/ungültige
  E-Mail, unbekannte Rolle, Inhaber-Rolle), Inhaber*innen (Duplikat, Datum, unbekannt), `/users`, `/roles`, Zugriff (view ohne manage 403, ohne view 403),
  Audit ohne personenbezogene Details, Modul deaktiviert 404.
- `tests/integration/offices-grants.test.ts`: Rechte kommen/gehen (Zuordnen, Entfernen, Rolle lösen, Amt löschen), zwei Ämter gleiche Rolle, manuelle Rolle bleibt,
  Modul aus/an, `core.users.roleIds`, Rechteausweitung (auch bei leerem Amt), Job `offices.sync-grants`, FK-Kaskade bei Benutzer- und Rollenlöschung.
- `tests/integration/offices-profile-website.test.ts`: `/me`, eine Bio für mehrere Ämter, 403 ohne Amt, 422 > 2000, Audit; Website-Opt-in (ohne Zustimmung keine
  Personendaten, Zustimmung, Widerruf mit Zeitstempel, 403 ohne Amt, Audit, Avatar 404 ohne Zustimmung); Website (Scope, Felder, keine Mails/Rollen,
  inaktive ausgeblendet, Reihenfolge, `avatarPath`), Avatar 404-Pfade, deaktivierte Inhaber*innen; Datenauskunft (`subjectExport`).
- E2E `tests/e2e/offices.spec.ts` (Amt anlegen + Person zuordnen, Reihenfolge per Pfeil). Demo-Daten: `node scripts/seed-demo-offices.mjs` (nach `seed-demo.mjs`).

## Entscheidungen und offen
- Rollen gelten **sofort** (kein Freigabe-Schritt); Entfernen entzieht sie sofort (auch laufenden Sitzungen beim nächsten Request).
- Ämter-Rechte hängen am Benutzerkonto, nicht am Mitglied (`members`) – Personen ohne Konto können kein Amt haben.
- Benachrichtigungen gehen an das **Konto**, nicht an die Amts-Adressen; Einstellung nur im Profil; Vorlagen werden nach Löschen nicht neu angelegt.
- Offen (Benachrichtigungen): echter SMTP-Versand und Tagesjob im Echtbetrieb ungeprüft; keine Anzeige, wann die nächste Zusammenfassung kommt.
- Offen: Admin-Reset nur indirekt getestet (Core löscht `user_role_grant` des Moduls bei `rebuild`; Core-Bereiche `users`/`roles` räumen die Tabelle mit ab);
  Profilbild-Auslieferung mit echtem S3 nicht automatisiert getestet.
