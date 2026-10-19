---
paths: ["src/lib/modules/members/**", "tests/**/members*"]
---

# Modul `members` (Mitglieder & Gruppen)

Stammdaten des Stammes: Mitglieder (Kontakte, Stand, Gruppen, Einwilligungen, Dokumente) und Gruppen
(Sippen/Meuten mit Leitern, Treffen, Farbe, Bild). Schema `mod_members`, Version 1.8.0, keine Abhängigkeiten.
Abnehmer des Dienstes `MembersService` (`contract.ts`): `actions` (verknüpfte Mitglieder, Zusatzfelder) und `treasury`
(`listMemberContacts`: Zahler, Mails, Mitgliedschaft/Beitragsebenen).

## Dateien (`src/lib/modules/members/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (Rechte, Navigation Gruppe „Stamm“), Migrationen, Endpoints |
| `ui.ts` | Routen `''` → `MembersPage`, `groups` → `GroupsPage` |
| `schemas.ts` | Zod (`memberInput`, `groupInput`, Query, Params), DTO-Typen, `STAGES`, `ageFromBirthDate`, `isRealDate`, `normalizeHexColor`, Upload-Limits |
| `members.service.ts` | `listMembers/getMember/createMember/updateMember/deleteMember`, `hydrate` (Telefone/E-Mails/Gruppen), Audit |
| `members.endpoints.ts` | CRUD `/members` |
| `groups.endpoints.ts` | CRUD `/groups` inkl. Leiter, Namens-Eindeutigkeit |
| `member-list.ts` / `sheet-columns.ts` (rein) / `sheets.service.ts` / `sheets.endpoints.ts` | Mitgliedsdaten-PDF: Spalten-Katalog + Zeilen, `composeListBlocks`, Formatierer (`formatDateDe`, `ageOn`, `formatFieldValue`), Erzeugung für Mitglieder bzw. je Gruppe, Katalog-Endpoint, Dienst `listMemberSheets` |
| `documents.endpoints.ts` | Datenschutz-/Anmeldedokument je Mitglied (multipart) |
| `group-image.endpoints.ts` | Gruppenbild (multipart) |
| `pages/MembersPage.svelte`, `MemberForm.svelte` (Tabs, auch Ansicht), `GroupsPage.svelte` | UI |
| `migrations/0001_init.sql` … `0010_group_meeting_end.sql` | Schema (0007 unbenutzt) |

## Datenmodell
- **0001**: `groups` (`name` UNIQUE, `type` CHECK `sippe|meute`, `description`, `meeting_place`, `meeting_time`),
  `members` (`birth_date date`, `stage` CHECK 7 Stände: neuling-woelfling, woelfling, neuling-jungpfadfinder, knappe,
  pfadfinder, spaeher, kreuzpfadfinder; `consent_social_media|website|print`; `privacy_consent_path/name`,
  `registration_path/name`), `member_phones`/`member_emails` (`member_id` FK CASCADE, `value`, `position`),
  `member_groups` (PK member+group, beide CASCADE), `group_leaders` (PK group+member, **member FK RESTRICT**).
- **0002**: `name` an Telefon/E-Mail (z. B. „Mutter“), `groups.meeting_weekday` (1–7), `color` (CHECK `#rrggbb` klein),
  `image_path`, `image_name`.
- **0003**: `member_user_links` (PK member+user, `user_id text` ohne FK, `relation` frei, `created_by`), `member_link_codes`
  (1 Zeile je Mitglied: `token` UNIQUE 32 Hex, `code_enc` verschlüsselt, `expires_at` = +90 Tage, `failed_attempts`, `locked_until`).
- **0004**: `members.street`, `postal_code`, `city`, `country` (ISO-Alpha-2, Standard `DE`); alte Freitext-`address` wurde nach `street`
  kopiert und ist **nicht mehr in Gebrauch** (Spalte bleibt, `NOT NULL` aufgehoben, wird beim Speichern auf `NULL` gesetzt). API/DTO kennen kein `address` mehr.
- **0006**: `members.entry_date`/`exit_date` (`date NULL`), `secondary_member boolean` (Standard `false`), `fee_levels text[]`
  (Standard alle: `stamm,gau,landesmark,bund`). DTO/Input: `entryDate`, `exitDate`, `secondaryMember`, `feeLevels`
  (= Ebenen, die das Mitglied **bei uns** zahlt). Nicht-Zweitmitglieder werden beim Speichern auf alle Ebenen normalisiert
  und immer mit allen Ebenen ausgeliefert. Gelesen über `array_to_string(fee_levels, ',')` (treiberunabhängig).
- Telefone/E-Mails/Gruppen werden bei jedem Update **komplett gelöscht und neu geschrieben** (Reihenfolge = `position`).

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `members.member.view` / `.edit` / `.delete` | Mitglieder lesen (auch Dokument-Download) / anlegen+ändern+Dokumente hoch/löschen / löschen |
| `members.group.view` / `.edit` / `.delete` | Gruppen lesen (auch Bild) / anlegen+ändern+Bild / löschen |
| `members.link.view` / `.manage` | verknüpfte Konten + Codestatus sehen / Code erzeugen, Briefe (PDF), Verknüpfung lösen |
| `members.own.view` / `.edit` | Eigene (verknüpfte) Mitglieder sehen / Kontakte, Zusatzfelder, Mail-Einstellungen ändern (`.edit` setzt `.view` voraus, Handler prüfen beides); Manifest `defaultRoleGrants` vergibt beide an die Rolle „Mitglied“ |
| `members.data.export` | Mitgliedsdaten-PDF (inkl. Telefone, Gesundheits-Zusatzfelder) erzeugen – auch `GET /actions/:id/participants.pdf`; zusätzlich `members.member.view` (+ `members.group.view` bei Gruppen) |
| `members.storage.read` / `.write` / `.delete` | Core-Storage-Rechte (Upload braucht `.write`, Entfernen `.delete`); in der UI `canUpload`/`canRemoveDoc` |

Kein Objekt-Besitz: Zugriff gilt global je Recht (keine Freigaben/Matrix).

## API (`/api/v1/modules/members/…`, Session oder API-Key, nicht öffentlich)
| Methode + Pfad | Recht | Besonderheiten |
|---|---|---|
| GET `/members` | member.view | Query `search` (Vor-/Nach-/Pfadname ILIKE), `stage`, `groupId`, `status` (`active` Standard = kein Austritt oder Austritt > heute, `left` = Austritt ≤ heute, `all`), `limit` 1–200 (50), `offset`; `{items,total}` |
| GET `/members/:id` | member.view | 404 wenn fehlt |
| POST `/members` | member.edit | Gruppen optional; `custom` = Werte der Zusatzfelder (nur aktive Schlüssel, sonst 422) |
| PUT `/members/:id` | member.edit | `FOR UPDATE`; `custom` wird mit den gespeicherten Werten **zusammengeführt** (fehlend = unverändert, leer = gelöscht) |
| DELETE `/members/:id` | member.delete | 409, wenn einziger Leiter einer Gruppe; entfernt Dateien best-effort |
| GET `/groups`, `/groups/:id` | group.view | inkl. Leiter und `memberCount` |
| POST `/groups`, PUT `/groups/:id` | group.edit | ≥ 1 Leiter (Mitglied, 422); Name case-insensitiv eindeutig (409) |
| DELETE `/groups/:id` | group.delete | 409, solange Mitglieder zugeordnet |
| POST `/members/bulk` | member.edit (`delete`: zusätzlich member.delete) | Body `{ action: add-groups\|remove-groups\|set-stage\|set-consent\|delete, ids (1–200), … }`; Antwort `{ affected, skipped[{id,name,reason}] }`; unbekannte ID → 404 (nichts geändert); `remove-groups` lässt ≥ 1 Gruppe übrig, `delete` überspringt einzige Leiter (409-Grund); Audit `members.member.bulk_updated` ohne Namen |
| POST/GET/DELETE `/members/:id/documents/:kind` | edit/view/edit | `kind` = `privacy`\|`registration`; Upload multipart Feld `file`, PDF/JPEG/PNG/WebP ≤ 10 MB; ersetzt altes |
| POST/GET/DELETE `/groups/:id/image` | edit/view/edit | JPEG/PNG/WebP ≤ 2 MB; GET ohne Bild 404 |

### Mitgliedsdaten-PDF (Listen, A4 quer, wählbare Spalten, 2026-10-17)
- Layout: Vorlage `stamm-briefkopf-quer` (Fallback `compact` quer, `listTemplateInput` in `member-list.ts`), **eine Zeile je Person** in einer Gitter-Tabelle; Abschnitt = Überschrift +
  Info (Anzahl, Stand, bei sensiblen Spalten „Vertraulich …“); je Gruppe neue Seite. Datenblatt-Layout (Karte je Person) entfällt. Layout/Auswahl-Logik in `$lib/pdf-lists`
  (`normalizeSelection`, `visibleColumns`, `buildSectionedListBlocks`), im Modul gebündelt als `composeListBlocks` (`member-list.ts`, rein).
- Katalog (`sheet-columns.ts`, rein): `buildMemberCatalog(defs)` = Basisspalten (`name`, `scoutName`, `stage`, `groups`, `age`, `birthDate`, `entryDate`, `address`, `phone`,
  `emergencyPhone`, `email`, `consents`) + je Zusatzfeld `field.<schlüssel>` (Gruppe `health`, `sensitive`; `field.juleica` Gruppe `person`, nicht sensibel). `emergencyPhone` = Nummer mit
  „Notfall“ in der Bezeichnung, sonst die erste. Voreinstellungen `fahrt` (Voreinstellung: Name, Gruppe, Alter, Notfall-Telefon, Ernährung, Allergien, Medikamente), `kontakt`, `gesundheit`, `minimal`
  (`LIST_PRESET_KEYS`, auf vorhandene Spalten gekürzt). `rowFromMember(m, defs, today)` liefert alle Spalten als fertigen Text. Leere Spalten entfallen bei `hideEmpty` (Standard).
- API (alle `members.data.export`, zusätzlich im Handler `members.member.view`, bei Gruppen `members.group.view` → sonst 403; PDF `private, no-store`):
  `GET /members/sheet-columns` → `{ columns: ListColumn[], presets: ListPreset[] }`;
  `POST /members/sheets.pdf` `{ ids (1–200), selection? }` (Reihenfolge = ids, unbekannt 404), `POST /groups/sheets.pdf` `{ groupIds (1–20), selection? }` (Seite je Gruppe, nur aktuelle Mitglieder,
  Mehrfachmitglieder in jeder Gruppe). `selection = { preset?, columns (1–40), hideEmpty (Standard true) }` strikt; fehlt sie oder sind alle Schlüssel unbekannt → Voreinstellung `fahrt`.
  Audit `members.member.sheet_generated` / `members.group.sheet_generated` (nur Zähler: `count`, `groups`, `columns`).
  Falle: `sheetEndpoints` stehen in `module.ts` **vor** `memberEndpoints`, sonst fängt `GET /members/:id` den Pfad `/members/sheet-columns` ab (erster Treffer gewinnt).
- Dienst `MembersService.listMemberSheets(ids)` (`sheets.service.ts`, in `module.ts` an `provides` gehängt – nicht in `fields.service.ts`, Importzyklus): Telefone, Anschrift, Gruppen, `custom`; **ohne Rechteprüfung**, der Aufrufer prüft `members.data.export`.
  Genutzt von `actions` (`participants-sheet.endpoints.ts`).
- UI: Bulk-Leiste Mitglieder „Mitgliedsdaten (PDF)“; `GroupsPage` mit Auswahl-Checkboxen, Bulk „Mitglieder der Gruppen (PDF)“ und Zeilenaktion; Spaltenauswahl per `PdfExportDialog`; `downloadPdf` liegt in `$lib/components/layout/download.ts`.
- Tests: `tests/unit/member-list.test.ts`, `tests/integration/members-sheets.test.ts`, `tests/integration/actions-participants-pdf.test.ts`. Falle: `listAudit({action})` entfernt `_` aus dem Präfix → Präfix ohne Unterstrich suchen (`members.member.sheet`).

### Zusatzfelder und Dienst für andere Module (`fields.service.ts`, `contract.ts`, `pages/FieldsPage.svelte`)
- Migration **0005**: `member_field_defs (key PK, position, active, preset, definition jsonb)`, `members.custom jsonb`. Vorlagen (Seed, `preset`, Schlüssel/Typ fest, nicht löschbar,
  Label/Hilfe/Optionen/„Nicht anzeigen“ änderbar): `ernaehrung` (meat|vegetarian|vegan), `allergien`, `medikamente`, `gesundheit`, `schwimmen`, `zecken`, `tetanus`, `krankenkasse`, `notfallkontakt`, `juleica`.
  Eigene Felder: text, textarea, select, multiselect, boolean (max. 40); Antworten sind immer freiwillig. Werte deaktivierter Felder bleiben erhalten.
- `GET /fields` (member.view), `PUT /fields` (`members.field.manage`, ersetzt die Liste; Seite „Zusatzfelder“ mit `FormBuilder`). Audit `members.field.updated`.
- **Dienst `MembersService`** (`provides` in `module.ts`, Vertrag `contract.ts`): `listLinkedMembers(ctx)`, `getLinkedMember(ctx,id)` (404 wenn nicht mit `ctx.userId` verknüpft),
  `updateMemberFields(ctx,id,values)` (nur aktive Zusatzfelder, nur verknüpfte Mitglieder, Audit `members.member.fields_updated` mit Schlüsseln, ohne Werte), `listFieldDefinitions()`,
  `listMemberContacts({ids?,search?,limit?})` (Name, Geburtsdatum, alle E-Mails, Anschrift, `entryDate`, `exitDate`, `secondaryMember`, `feeLevels` –
  **ohne** Rechteprüfung und **ohne** Austritts-Filter (Aufrufer filtert); genutzt von der Kasse).
  Abruf nur über `core.modules.use<MembersService>('members', '<caller>')` (Aufrufer muss `members` in `dependencies` führen).
- **Gesundheitsdaten (Ernährung, Allergien, Medikamente) liegen unverschlüsselt in `members.custom`** – Verschlüsselung/Sonderrecht wäre ein Folgeschritt (DSGVO).

### Anschrift und Autovervollständigung (`address.service.ts`, `address.endpoints.ts`, `pages/AddressFields.svelte`, `pages/countries.ts`)
- Pflichtfelder `street` (≤ 200), `postalCode` (DE: genau 5 Ziffern, sonst ≤ 10 Zeichen), `city` (≤ 100); `country` Standard `DE`.
- `GET /address/suggest?q=` (member.edit, ≥ 3 Zeichen, 90/min): serverseitig **Photon** (OpenStreetMap) gemäß Modul-Einstellung
  `members.address.photonUrl` (Standard `https://photon.komoot.io`, leer = aus). Antwort `{ items[≤ 6], unavailable }`; Fehler/Timeout (3 s)
  → `unavailable: true`, nie ein Fehlerstatus. **Datenschutz:** Der Suchtext (Straße/Ort, keine Namen) geht dabei an den Dienst.
- `GET /address/places?postalCode=` (member.edit): Orte zur deutschen PLZ aus `data/plz-de.json` (GeoNames, CC BY 4.0, siehe `data/NOTICE.md`), offline.
- Brief-Adressfeld (`recipientLines`): ab 18 Jahren (`isAdult`) der Name selbst, sonst „Eltern von …“; dazu Straße, „PLZ Ort“, bei Land ≠ DE der Ländername (Großbuchstaben).
  Brieftext für Volljährige in „Ihre Mitgliedschaft“-Form, ohne Elternhinweis.

### Konto-Verknüpfung (`link.ts` rein, `link.service.ts`, `link.endpoints.ts`, UI `LinksDialog`, `LinkAccount`)
Mitglied ↔ Konten n:m (Mutter+Vater ↔ Kind; Elternteil ↔ mehrere Kinder). Verknüpft wird per **Brief** (Vorlage `stamm-brief`,
Adressfeld „Eltern von …“ + Anschrift; Block `box` (ohne Rahmen) mit QR-Code, großem Code `123 456`, Gültigkeit und anklickbarem Link ohne `https://`; darunter „So geht’s“ und „Gut zu wissen“, passt auf eine Seite). Code ist mehrfach nutzbar, 90 Tage gültig; der Brief
verwendet den bestehenden Code, erzeugt nur bei fehlendem/abgelaufenem Code einen neuen (`POST …/link-code` erzwingt neu → neues Token).
| Methode + Pfad | Recht | Besonderheiten |
|---|---|---|
| GET `/members/:id/links` | link.view | Konten (Name/E-Mail via `core.users.directory`), Codestatus (nie der Code) |
| POST `/members/:id/link-code` | link.manage | neuer Code + Token, Zähler/Sperre zurück |
| DELETE `/members/:id/links/:userId` | link.manage | Verknüpfung lösen (404 wenn nicht vorhanden) |
| GET `/members/:id/link-letter.pdf`, POST `/members/link-letters.pdf` `{ids ≤ 100}` | link.manage | PDF bzw. ein zusammengeführtes PDF (Reihenfolge = ids; unbekannte ID → 404); rohe Response → Status 200 |
| GET `/my/members` | own.view | eigene Mitglieder, siehe „Eigene Mitglieder im Profil“ |
| GET `/public/link/:token` | öffentlich | nur Vorname + `viewer`; unbekannt/abgelaufen 404 |
| POST `/public/link/:token/claim` | öffentlich + Session | `{code, relation?}`; ohne Anmeldung 401, falscher/gesperrter Code 403 |
| POST `/public/link/:token/register` | öffentlich | `{code,name,email,password≥12,relation?}` → Konto mit Rolle „Mitglied“ (`core.users.registerWithRole`), 409 bei vorhandener E-Mail |
Schutz: 10 Fehlversuche je Mitglied → 60 min Sperre (Zähler wird vor dem Werfen committet), Rate-Limits claim 10/600 s, register 5/600 s.
Öffentliche Seite `/p/members/verknuepfen/<token>`: Code, „Ich habe ein Konto“ (Login mit `redirectTo`, Code in `sessionStorage`) oder „Neues Konto“.
UI: Zeilenaktion „Verknüpfte Konten“ (Badge `linkCount`) → `LinksDialog`; Sammelleiste „Verknüpfungs-Briefe (PDF)“ (`downloadPdf`).
Audit: `members.link.code_created|created|registered|removed|letters_generated` (nur IDs/Zähler).

### Eigene Mitglieder im Profil (Migration 0008, 2026-10-17)
Alle Endpoints: Session/API-Key, **nicht** öffentlich, Recht `members.own.*`; fremdes Mitglied → 404. Eltern ändern **nicht**: Name, Geburtsdatum, Stand, Gruppen,
Einwilligungen, Ein-/Austritt, Adresse, Dokumente.
| Methode + Pfad | Recht | Antwort / Besonderheiten |
|---|---|---|
| GET `/my/members` | own.view (60/min) | `[{id, firstName, lastName, scoutName, relation, birthDate, groups[{id,name}], phones[{name,value}], emails[{name,value}], custom, mailOptOut[]}]` |
| GET `/my/fields` | own.view (60/min) | `{fields:[{key, field: FieldDefinition, sensitive}]}` – aktive Zusatzfelder; `sensitive` = Gesundheitsfelder (`SENSITIVE_FIELD_KEYS`) |
| PUT `/my/members/:id/fields` | own.edit (10/600 s) | `{values}` → `{changed: string[]}`; unbekannt/inaktiv 422; Audit `members.member.fields_updated` |
| PUT `/my/members/:id/contacts` | own.edit (10/600 s) | `{phones, emails}` (je ≤ 10, Duplikate 422) → `{phones, emails}`. `updateLinkedContacts`: Link-JOIN `FOR UPDATE` = Besitzprüfung; war vorher ≥ 1 E-Mail da, muss ≥ 1 bleiben (422). Audit `members.member.contacts_updated` nur Zähler `{phonesAdded, phonesRemoved, emailsAdded, emailsRemoved}` |
| PUT `/my/members/:id/mail-prefs` | own.edit (10/600 s) | `{category:'payment-confirmation'|'action-info', enabled}` → `{mailOptOut}`; verbindliche/unbekannte Kategorie 422 |
| PUT `/members/:id/mail-prefs` | member.edit | gleiche Logik für jedes Mitglied (Verwaltung) |
- `GET /my/members` verlangt jetzt `members.own.view` (früher nur Anmeldung). `actions` nutzt den Dienst (`listLinkedMembers`), nicht den Endpoint – unberührt.
- **Mail-Einstellungen**: Tabelle `member_mail_prefs(member_id FK CASCADE, category CHECK, enabled, updated_at, updated_by)`; **nur Abwahlen** (`enabled=false`) werden gespeichert,
  „an“ löscht die Zeile. `MAIL_CATEGORIES` (abschaltbar: `payment-confirmation`, `action-info`) / `MANDATORY_MAIL` (`invoice`, `annual-fee`, `reminder`, `registration`) in `schemas.ts`.
  `MemberContact.mailOptOut` und `LinkedMemberData.{phones,emails,mailOptOut}` im Dienstvertrag. Audit `members.member.mail_pref_updated` (`category`, `enabled`).
  Migrationsnummer 0008 (0007 ist in `members` unbenutzt).
- Tests: `tests/integration/members-own.test.ts` (Zugriffsmatrix, Kontakte, Felder, Mail-Prefs, Rate-Limit, Zahlungsbestätigung in der Kasse).

### Gruppen auf der Stammeswebsite (Migration 0009, v1.7.0, 2026-10-19)
- Spalten an `groups`: `on_website` (Standard `false`), `slug` (Unique, wo gesetzt; `[a-z0-9]+(-[a-z0-9]+)*`, ≤ 60), `website_description` (≤ 5000),
  `age_range` (≤ 50, Freitext „7 bis 10 Jahre“), `contact_email`. DTO `Group.website: GroupWebsite`; Eingabe `groupInput.website` (**optional** – fehlt es,
  bleiben die Werte unverändert; `onWebsite` ohne Slug → 422 `website.slug`, Slug doppelt → 409). Audit nur `{ name, onWebsite, slug }`.
- Recht `members.website.read` (nur Website-Endpunkte, Scope für den API-Key der Website). `website.endpoints.ts` (zuerst registriert):
  `GET /website/groups` (nur `on_website` mit Slug, Meute vor Sippe, dann Name; 120/60 s), `GET /website/groups/:slug` (404 privat/unbekannt, 422 ungültig),
  `GET /website/groups/:slug/image` (roh, `public, max-age=86400`, `nosniff`; 404 ohne Bild/Storage/nicht auf Website; 600/60 s; Storage über Systemkontext).
- `WebsiteGroup`: `id, slug, name, type, description` (Website-Text, sonst interne Beschreibung), `ageRange, meetingPlace, meetingWeekday, meetingTime, meetingEndTime, color,
  contactEmail, leaders: [{ firstName }]` (nur Vornamen, ohne Ausgetretene), `imagePath` (`…/image?v=<ms>` oder `null`). **Keine** Nachnamen, Mitglieder-Mails, Geburtsdaten.
- UI: Gruppendialog mit Reitern **Allgemein / Website** (Checkbox, Adresse mit Vorschlag aus dem Namen über `slug.ts` `slugFromName`, Vorschau `/gruppen/<slug>`,
  Text, Alter, Kontakt-E-Mail), Badge „Website“ in der Liste. Gruppenbild wird roh ausgeliefert (nicht über `core.images` bereinigt).
- Tests `tests/integration/members-website.test.ts`. Nutzerin: Stammeswebsite (`rules/website.md`).

### Ende der Gruppenstunde (Migration 0010, v1.8.0, 2026-10-19)
- `groups.meeting_end_time text` (`HH:MM`). DTO `Group.meetingEndTime`, `WebsiteGroup.meetingEndTime` (nur zusammen mit `meetingTime`, sonst `null`),
  Dienst `MemberGroupRef.meetingEndTime` (`events` nutzt es noch nicht – „Gruppenstunde übernehmen“ setzt das Ende weiterhin nicht).
- Eingabe `groupInput.meetingEndTime` optional; PUT ersetzt wie bei `meetingTime` (fehlt → `null`). Gruppendialog: Feld „bis“ neben „Uhrzeit“,
  Liste „Freitag, 16:30–18:00“.

Ohne S3 antworten Upload/Download mit `503 unavailable`. Storage-Pfad `<id>/<kind>-<uuid>-<bereinigter Name>`;
bei DB-Fehler nach Upload wird die Datei wieder entfernt.

## Validierungsregeln (`schemas.ts`)
- Geburtsdatum `YYYY-MM-DD`, echtes Datum, nicht in der Zukunft, Alter ≤ 120.
- Telefon: `+?` Ziffern, 6–15 Ziffern, ≤ 30 Zeichen; E-Mail lower-case, `z.email`; je ≤ 10; **Duplikate** (Telefon nach
  Ziffern normalisiert, E-Mail exakt) → 422.
- Eintritt/Austritt optional (`JJJJ-MM-TT`, leer → `null`), Austritt ≥ Eintritt (422 `exitDate`); Zweitmitglied braucht
  ≥ 1 Ebene (422 `feeLevels`); Ebenen werden in fester Reihenfolge dedupliziert.
- Gruppe: `meetingWeekday` 1–7 (optional), `meetingTime` `HH:MM`, `meetingEndTime` `HH:MM` (optional; ohne Beginn bzw. Ende ≤ Beginn → 422
  Pfad `meetingEndTime`), `color` Hex (wird normalisiert), `leaderIds` 1–20.

## UI
- `MembersPage`: Zeilen klickbar (auch Enter/Leertaste) → `MemberForm` als Ansicht (`readonly`); Checkbox- und Aktionszelle stoppen den Klick.
  Filter „Mitgliedschaft“ (Aktiv/Ausgetreten/Alle, URL-Parameter `status`, Standard aktiv); Badges „Zweitmitglied“, „ausgetreten“ in der Namenszelle.
  Checkbox-Spalte + Sammelleiste (Gruppen hinzufügen/entfernen, Stand, Einwilligungen, Löschen; `BulkDialog`), Auswahl wird bei Filterwechsel verworfen. `DataTable` (Suche, Filter Stand/Gruppe via `SelectField`), Spalten Name, Stand, Gruppen (Farb-Badges),
  Geburtsdatum + Alter, „Darf gezeigt werden“ (Einwilligungen), Aktionen; Dialog `MemberForm` (`ContactListField`,
  `MultiSelect` Gruppen, `FileField` für Dokumente, Einwilligungs-Checkboxen).
- `MemberForm`: Tabs Person / Kontakt / Mitgliedschaft (Stand, Gruppen, Eintritt/Austritt, Schalter „Zweitmitglied“ →
  Checkboxen „Beitrag bei uns zahlen für“) / Weitere Angaben (nur mit sichtbaren Zusatzfeldern) / Einwilligungen & Dokumente.
  Öffnet auf `initialTab` (Standard „Person“); bei Fehlern Wechsel zum ersten Tab mit Fehler, roter Punkt an betroffenen Tabs;
  Inhalt scrollt, Footer bleibt sichtbar, Mindesthöhe gegen Springen.
- Ansicht = `MemberForm` mit `readonly` (bindable): gleiche Tabs, alle Felder über `<fieldset disabled>` gesperrt (gut lesbar,
  ohne Abblenden), Titel = Name + Badges (Stand, Zweitmitglied, ausgetreten), Kontaktlisten mit `ContactListField readonly`,
  Gruppen als Farb-Badges, Dokumente nur als Link; Footer „Verknüpfte Konten (n)“ (`link.view`), „Schließen“, „Bearbeiten“
  (`member.edit`, schaltet im selben Dialog frei, Tab bleibt). Früheres Sheet `MemberView` ist entfallen (2026-10-17, Wunsch des Nutzers).
- `GroupsPage`: Tabelle Name, Typ, Leiter, Mitglieder, Treffpunkt, Treffen; Dialog mit `ColorPicker`, `MultiSelect`
  Leiter, `FileField` Bild. Buttons nach `can(permissions, …)` ein-/ausgeblendet.

## Audit
`members.member.created|updated|deleted` (metadata `name`), `members.group.created|updated|deleted` (metadata `name`),
`members.document.uploaded|deleted` (`kind`, `name`), `members.group.image.uploaded|deleted`.
Hinweis: `metadata.name` enthält den Klarnamen des Mitglieds – bewusst so umgesetzt (unklar, ob gewollt; siehe Audit-Regel
„keine personenbezogenen Details“, Name wird dort meist als unkritisch gewertet).

## Tests
`tests/integration/members.test.ts` (Bootstrap ohne Gruppe, CRUD, Gruppenregeln 409/422, Farbe/Wochentag, Upload ohne
Storage, 403/401/404, Audit, Mitgliedschaft: Eintritt/Austritt/Zweitmitglied, 422-Regeln, Statusfilter, `listMemberContacts`) und `tests/unit/members-schemas.test.ts` (Alter, Datum, Farbe, `memberInput`, `groupInput`).
Upload-Erfolgspfad ist nicht getestet (kein S3; `tests/helpers/fake-storage.ts` wird hier nicht genutzt).

## Entscheidungen und Fallen
- **Gruppen sind für Mitglieder optional** (früher Pflicht ab der ersten Gruppe); Gruppen brauchen weiterhin ≥ 1 Leiter (Mitglied).
- `group_leaders.member_id` ist RESTRICT; `deleteMember` prüft zuerst „einziger Leiter“ (409), löscht dann die Leiter-Zeilen.
- Stände sind eine feste Liste im Code (CHECK in der DB + `STAGES`); neuer Stand = neue Migration **und** Schema/Labels.
- Core-Aufrufe (`storage`, `audit`) liegen bewusst **außerhalb** der Modul-Transaktion (PGlite).
- Offen: Anbindung an `actions` (Teilnehmende aus Mitgliedern übernehmen) existiert nicht; Mitglieder-Import/Export fehlt.
