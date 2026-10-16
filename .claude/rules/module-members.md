---
paths: ["src/lib/modules/members/**", "tests/**/members*"]
---

# Modul `members` (Mitglieder & Gruppen)

Stammdaten des Stammes: Mitglieder (Kontakte, Stand, Gruppen, Einwilligungen, Dokumente) und Gruppen
(Sippen/Meuten mit Leitern, Treffen, Farbe, Bild). Schema `mod_members`, Version 1.0.0, keine Abhängigkeiten.
Kein anderes Modul greift derzeit auf Mitglieder zu (`actions` hat eigene Teilnehmende).

## Dateien (`src/lib/modules/members/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (Rechte, Navigation Gruppe „Stamm“), Migrationen, Endpoints |
| `ui.ts` | Routen `''` → `MembersPage`, `groups` → `GroupsPage` |
| `schemas.ts` | Zod (`memberInput`, `groupInput`, Query, Params), DTO-Typen, `STAGES`, `ageFromBirthDate`, `isRealDate`, `normalizeHexColor`, Upload-Limits |
| `members.service.ts` | `listMembers/getMember/createMember/updateMember/deleteMember`, `hydrate` (Telefone/E-Mails/Gruppen), Audit |
| `members.endpoints.ts` | CRUD `/members` |
| `groups.endpoints.ts` | CRUD `/groups` inkl. Leiter, Namens-Eindeutigkeit |
| `documents.endpoints.ts` | Datenschutz-/Anmeldedokument je Mitglied (multipart) |
| `group-image.endpoints.ts` | Gruppenbild (multipart) |
| `pages/MembersPage.svelte`, `MemberForm.svelte`, `GroupsPage.svelte` | UI |
| `migrations/0001_init.sql`, `0002_members_v2.sql` | Schema |

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
- Telefone/E-Mails/Gruppen werden bei jedem Update **komplett gelöscht und neu geschrieben** (Reihenfolge = `position`).

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `members.member.view` / `.edit` / `.delete` | Mitglieder lesen (auch Dokument-Download) / anlegen+ändern+Dokumente hoch/löschen / löschen |
| `members.group.view` / `.edit` / `.delete` | Gruppen lesen (auch Bild) / anlegen+ändern+Bild / löschen |
| `members.link.view` / `.manage` | verknüpfte Konten + Codestatus sehen / Code erzeugen, Briefe (PDF), Verknüpfung lösen |
| `members.storage.read` / `.write` / `.delete` | Core-Storage-Rechte (Upload braucht `.write`, Entfernen `.delete`); in der UI `canUpload`/`canRemoveDoc` |

Kein Objekt-Besitz: Zugriff gilt global je Recht (keine Freigaben/Matrix).

## API (`/api/v1/modules/members/…`, Session oder API-Key, nicht öffentlich)
| Methode + Pfad | Recht | Besonderheiten |
|---|---|---|
| GET `/members` | member.view | Query `search` (Vor-/Nach-/Pfadname ILIKE), `stage`, `groupId`, `limit` 1–200 (50), `offset`; `{items,total}` |
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

### Zusatzfelder und Dienst für andere Module (`fields.service.ts`, `contract.ts`, `pages/FieldsPage.svelte`)
- Migration **0005**: `member_field_defs (key PK, position, active, preset, definition jsonb)`, `members.custom jsonb`. Vorlagen (Seed, `preset`, Schlüssel/Typ fest, nicht löschbar,
  Label/Hilfe/Optionen/„Nicht anzeigen“ änderbar): `ernaehrung` (meat|vegetarian|vegan), `allergien`, `medikamente`, `gesundheit`, `schwimmen`, `zecken`, `tetanus`, `krankenkasse`, `notfallkontakt`, `juleica`.
  Eigene Felder: text, textarea, select, multiselect, boolean (max. 40); Antworten sind immer freiwillig. Werte deaktivierter Felder bleiben erhalten.
- `GET /fields` (member.view), `PUT /fields` (`members.field.manage`, ersetzt die Liste; Seite „Zusatzfelder“ mit `FormBuilder`). Audit `members.field.updated`.
- **Dienst `MembersService`** (`provides` in `module.ts`, Vertrag `contract.ts`): `listLinkedMembers(ctx)`, `getLinkedMember(ctx,id)` (404 wenn nicht mit `ctx.userId` verknüpft),
  `updateMemberFields(ctx,id,values)` (nur aktive Zusatzfelder, nur verknüpfte Mitglieder, Audit `members.member.fields_updated` mit Schlüsseln, ohne Werte), `listFieldDefinitions()`,
  `listMemberContacts({ids?,search?,limit?})` (Name, Geburtsdatum, alle E-Mails, Anschrift – **ohne** Rechteprüfung; genutzt von der Kasse).
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
| GET `/my/members` | angemeldet (public + Session-Pflicht) | eigene Mitglieder – Basis für Eltern-Funktionen anderer Module |
| GET `/public/link/:token` | öffentlich | nur Vorname + `viewer`; unbekannt/abgelaufen 404 |
| POST `/public/link/:token/claim` | öffentlich + Session | `{code, relation?}`; ohne Anmeldung 401, falscher/gesperrter Code 403 |
| POST `/public/link/:token/register` | öffentlich | `{code,name,email,password≥12,relation?}` → Konto mit Rolle „Mitglied“ (`core.users.registerWithRole`), 409 bei vorhandener E-Mail |
Schutz: 10 Fehlversuche je Mitglied → 60 min Sperre (Zähler wird vor dem Werfen committet), Rate-Limits claim 10/600 s, register 5/600 s.
Öffentliche Seite `/p/members/verknuepfen/<token>`: Code, „Ich habe ein Konto“ (Login mit `redirectTo`, Code in `sessionStorage`) oder „Neues Konto“.
UI: Zeilenaktion „Verknüpfte Konten“ (Badge `linkCount`) → `LinksDialog`; Sammelleiste „Verknüpfungs-Briefe (PDF)“ (`downloadPdf`).
Audit: `members.link.code_created|created|registered|removed|letters_generated` (nur IDs/Zähler).

Ohne S3 antworten Upload/Download mit `503 unavailable`. Storage-Pfad `<id>/<kind>-<uuid>-<bereinigter Name>`;
bei DB-Fehler nach Upload wird die Datei wieder entfernt.

## Validierungsregeln (`schemas.ts`)
- Geburtsdatum `YYYY-MM-DD`, echtes Datum, nicht in der Zukunft, Alter ≤ 120.
- Telefon: `+?` Ziffern, 6–15 Ziffern, ≤ 30 Zeichen; E-Mail lower-case, `z.email`; je ≤ 10; **Duplikate** (Telefon nach
  Ziffern normalisiert, E-Mail exakt) → 422.
- Gruppe: `meetingWeekday` 1–7 (optional), `meetingTime` `HH:MM`, `color` Hex (wird normalisiert), `leaderIds` 1–20.

## UI
- `MembersPage`: Checkbox-Spalte + Sammelleiste (Gruppen hinzufügen/entfernen, Stand, Einwilligungen, Löschen; `BulkDialog`), Auswahl wird bei Filterwechsel verworfen. `DataTable` (Suche, Filter Stand/Gruppe via `SelectField`), Spalten Name, Stand, Gruppen (Farb-Badges),
  Geburtsdatum + Alter, „Darf gezeigt werden“ (Einwilligungen), Aktionen; Dialog `MemberForm` (`ContactListField`,
  `MultiSelect` Gruppen, `FileField` für Dokumente, Einwilligungs-Schalter).
- `GroupsPage`: Tabelle Name, Typ, Leiter, Mitglieder, Treffpunkt, Treffen; Dialog mit `ColorPicker`, `MultiSelect`
  Leiter, `FileField` Bild. Buttons nach `can(permissions, …)` ein-/ausgeblendet.

## Audit
`members.member.created|updated|deleted` (metadata `name`), `members.group.created|updated|deleted` (metadata `name`),
`members.document.uploaded|deleted` (`kind`, `name`), `members.group.image.uploaded|deleted`.
Hinweis: `metadata.name` enthält den Klarnamen des Mitglieds – bewusst so umgesetzt (unklar, ob gewollt; siehe Audit-Regel
„keine personenbezogenen Details“, Name wird dort meist als unkritisch gewertet).

## Tests
`tests/integration/members.test.ts` (Bootstrap ohne Gruppe, CRUD, Gruppenregeln 409/422, Farbe/Wochentag, Upload ohne
Storage, 403/401/404, Audit) und `tests/unit/members-schemas.test.ts` (Alter, Datum, Farbe, `memberInput`, `groupInput`).
Upload-Erfolgspfad ist nicht getestet (kein S3; `tests/helpers/fake-storage.ts` wird hier nicht genutzt).

## Entscheidungen und Fallen
- **Gruppen sind für Mitglieder optional** (früher Pflicht ab der ersten Gruppe); Gruppen brauchen weiterhin ≥ 1 Leiter (Mitglied).
- `group_leaders.member_id` ist RESTRICT; `deleteMember` prüft zuerst „einziger Leiter“ (409), löscht dann die Leiter-Zeilen.
- Stände sind eine feste Liste im Code (CHECK in der DB + `STAGES`); neuer Stand = neue Migration **und** Schema/Labels.
- Core-Aufrufe (`storage`, `audit`) liegen bewusst **außerhalb** der Modul-Transaktion (PGlite).
- Offen: Anbindung an `actions` (Teilnehmende aus Mitgliedern übernehmen) existiert nicht; Mitglieder-Import/Export fehlt.
