---
paths: ["src/lib/modules/members/**", "tests/**/members*"]
---

# Modul `members` (Mitglieder & Gruppen)

Stammdaten des Stammes: Mitglieder (Kontakte, Stand, Gruppen, Einwilligungen, Dokumente) und Gruppen
(Sippen/Meuten mit Leitern, Treffen, Farbe, Bild). Schema `mod_members`, Version 1.13.0, keine Abhängigkeiten.
Abnehmer des Dienstes `MembersService` (`contract.ts`): `actions` (verknüpfte Mitglieder, Zusatzfelder) und `treasury`
(`listMemberContacts`: Zahler, Mails, Mitgliedschaft/Beitragsebenen).

## Dateien (`src/lib/modules/members/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (Rechte, Navigation Mitglieder/Gruppen im Hauptmenü, Zusatzfelder/Löschfristen mit `admin: true` in der Administration, Einstellungen `members.address.*`), Migrationen, `provides` (`membersService` + `listMemberSheets` + `principalsService`), `search`, `backup` (`membersBackup`), `resetAreas`/`resetUsers`, `onUserDeleted`, `subjectExport`; Endpoints (Reihenfolge website → sheets → members → address → fields → link → groups → group-image → documents → retention) |
| `ui.ts` | Routen `''` → `MembersPage`, `groups` → `GroupsPage`, `fields` → `FieldsPage`, `retention` → `RetentionPage`; öffentlich `verknuepfen/:token` → `LinkAccount`; `profileSections`, Dashboard-Kachel (`pages/widgets/MyMembersWidget.svelte`) |
| `contract.ts` | Vertrag `MembersService` für abhängige Module (`core.modules.use('members', …)`) |
| `principals.service.ts` | `principalsService` (Vertrag `PrincipalProvider`): `listGroups`, `principalIdsForUser`, `searchMembers` (ohne Rechteprüfung, Aufrufer prüft), `searchMemberPrincipals` (Freigabe-Suche, prüft selbst `members.member.view`) |
| `fields.service.ts` / `fields.endpoints.ts` | Zusatzfelder: `loadFieldDefs`/`listFieldDefs`/`putFieldDefs`, `validateCustomValues`, `mergeCustom`, `loadMailOptOut`, Dienst `membersService`; `GET /fields` (`members.member.view`), `PUT /fields` (`members.field.manage`, Vorlagen bleiben) |
| `address.service.ts` / `address.endpoints.ts` / `address-utils.ts` (rein) | Adress-Autovervollständigung (Mitglieder → OpenPLZ → Photon), `GET /address/suggest`, `GET /address/places` (PLZ aus `data/plz-de.json`); Hilfen `splitHouseNumber`, `matchesStreetName` … – Details unten |
| `link.ts` (rein) / `link.service.ts` / `link.endpoints.ts` / `link-tokens.ts` | Konto-Verknüpfung: Code/Token erzeugen, Briefe (`buildLinkLetters`), manuell verknüpfen/lösen; Endpoints `/members/:id/link-*`, `/my/members…`, `/public/link/:token` (+ `/claim`, `/register`); Tokens nur als Hash + Chiffrat, `hashStoredLinkTokens`, Backup-Hook `membersBackup.rehash` |
| `messaging.service.ts` | Dienste für das Modul `messages`: `listGroupMemberIds`, `listLedGroups` (geleitete Gruppen mit Kontakt-E-Mail), `getOwnMemberName` (eigenes Konto-Mitglied), `listGroupMailboxes`, `listWebsiteGroupRefs` (Website-Gruppen mit Altersangabe, für Probestunden) – ohne Rechteprüfung |
| `slug.ts` (rein) | `slugFromName` – Vorschlag für die Website-Adresse einer Gruppe |
| `website.endpoints.ts` / `website.schemas.ts` | `/website/groups[/:slug[/image]]` (Scope `members.website.read`, nur `on_website` + `slug`, Leitende nur mit Vornamen und Einwilligung); Zod-Vertrag `websiteGroupSchema` (#48, Typgleichheit zu `WebsiteGroup`) |
| `search.ts` | Globale Suche (`membersSearch`): Mitglieder nach Vor-/Nach-/Pfadfindername (`members.member.view`), Gruppen nach Name (`members.group.view`); keine sensiblen Felder |
| `reset.ts` | Reset-Bereiche `all` (alle Tabellen + Dokumente/Gruppenbilder, `rebuild`, `implies` `treasury:payers` + `treasury:annual`) und `links` (Konto-Verknüpfungen + Codes); `unlinkUsers` (gemeinsam mit `onUserDeleted`), `resetUsers` |
| `user-deleted.ts` | `onUserDeleted`: Konto-Verknüpfungen lösen, `created_by`/`updated_by` → `NULL`; Mitglieder bleiben |
| `schemas.ts` | Zod (`memberInput`, `groupInput`, Query, Params), DTO-Typen, `STAGES`, `ageFromBirthDate`, `isRealDate`, `normalizeHexColor`, Upload-Limits |
| `members.service.ts` | `listMembers/getMember/createMember/updateMember/deleteMember`, `hydrate` (Telefone/E-Mails/Gruppen), Audit; `listMembers`/`getMember`/`updateMember` mit optionalem `scope` (Gruppenleitung) |
| `leader.service.ts` / `led.endpoints.ts` | Gruppenleitung: `ledGroupIds` (Bereich je Aufruf), `inScopeSql`/`assertMemberInScope`, `syncLeaderGrants` (Rolle „Gruppenleitung“), `assertCanGrantLeader`; Endpunkte `/led/…` – siehe „Gruppenleitung“ |
| `members.endpoints.ts` | CRUD `/members` |
| `groups.endpoints.ts` | CRUD `/groups` inkl. Leiter, Namens-Eindeutigkeit |
| `$lib/pdf-lists` (`compose.ts`, `member-columns.ts`, rein, gemeinsam mit `actions`) / `sheets.service.ts` / `sheets.endpoints.ts` | Mitgliedsdaten-PDF: Spalten-Katalog + Zeilen, `composeListBlocks`, Formatierer (`formatDateDe`, `ageOn`, `formatFieldValue`), Erzeugung für Mitglieder bzw. je Gruppe, Katalog-Endpoint, Dienst `listMemberSheets` |
| `documents.endpoints.ts` | Datenschutz-/Anmeldedokument je Mitglied (multipart) |
| `group-image.endpoints.ts` | Gruppenbild (multipart) |
| `group-image.service.ts` | `processGroupImage` (`core.images.process`, WebP ≤ 1600 px, Metadaten weg, Inhalt muss zum Typ passen), `processedGroupImagePath`/`isProcessedGroupImagePath`, Job `reprocessGroupImages` |
| `pages/MembersPage.svelte`, `MemberForm.svelte` (Tabs, auch Ansicht), `GroupsPage.svelte` | UI |
| `pages/` (weitere) | `FieldsPage` (Zusatzfelder, `FormBuilder`), `BulkDialog`, `LinksDialog`, öffentlich `LinkAccount`, `AddressFields` (+`countries.ts`), Profil `ProfileMembers`/`ProfileMemberCard`/`ProfileMailPrefs` (+`profile-shared.ts`), `download.ts`, Kachel `widgets/MyMembersWidget` |
| `retention.service.ts`, `retention.endpoints.ts`, `pages/RetentionPage.svelte` | Löschfrist nach Austritt: Vorschlagsliste, Sammel-Anonymisieren (#30) |
| `subject-export.ts` | Beitrag zur Datenauskunft (`subjectExport`: `findSubjects`, `resolve`, `run`) |
| `migrations/0001_init.sql` … `0017_group_age.sql` | Schema (0007 unbenutzt) |
| `pages/LeaderUserPicker.svelte` | Auswahl von Benutzerkonten als Gruppenleitung (Chips + Suche `GET /groups/leader-users`) |

## Datenmodell
- **0001**: `groups` (`name` UNIQUE, `type` CHECK `sippe|meute`, `description`, `meeting_place`, `meeting_time`),
  `members` (`birth_date date`, `stage` CHECK, seit **0011** 8 Stände: neuling-woelfling, woelfling, neuling-jungpfadfinder, jungpfadfinder, knappe,
  pfadfinder, spaeher, kreuzpfadfinder; `consent_social_media|website|print`; `privacy_consent_path/name`,
  `registration_path/name`), `member_phones`/`member_emails` (`member_id` FK CASCADE, `value`, `position`),
  `member_groups` (PK member+group, beide CASCADE), `group_leaders` (PK group+member, **member FK RESTRICT**).
- **0002**: `name` an Telefon/E-Mail (z. B. „Mutter“), `groups.meeting_weekday` (1–7), `color` (CHECK `#rrggbb` klein),
  `image_path`, `image_name`.
- **0003**: `member_user_links` (PK member+user, `user_id text` ohne FK, `relation` frei, `created_by`), `member_link_codes`
  (1 Zeile je Mitglied: `token` UNIQUE 32 Hex, `code_enc` verschlüsselt, `expires_at` = +90 Tage, `failed_attempts`, `locked_until`).
- **0014** (#67 01b-14, #73): `member_link_codes.token_hash` + `token_enc`, `token` = NULL (`link-tokens.ts`, Suche über den Hash, Altzeilen ohne
  Hash noch über den Klartext; `onEnable` + Job `members.hash-link-tokens`; Backup-Hook `membersBackup.rehash`, nicht entschlüsselbar → Code gelöscht).
  Index `group_leaders(member_id)`, CHECKs `groups.meeting_time`/`meeting_end_time` HH:MM und `members.exit_date >= entry_date` (Altbestand: ungültige
  Uhrzeiten bzw. Eintritt → NULL), Altspalte `address` geleert. Dokumente und Gruppenbilder über `secureFileResponse` (CSP-Sandbox); Dokument-Upload
  prüft Magic Bytes (`assertContentMatches`, falscher Inhalt **422**).
- **0012** (#18): `member_link_codes.use_count` (Verknüpfungen über den Code) und `max_uses` (Höchstzahl, **seit 2026-10-29 unbenutzt**, neue Codes `NULL`). Bestand: `use_count` = Verknüpfungen seit `created_at` des Codes (inkl. manueller, vorsichtig gezählt).
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
| `members.link.view` / `.manage` | verknüpfte Konten + Codestatus sehen / Code erzeugen, Briefe (PDF), Konten per Hand verknüpfen, Verknüpfung lösen |
| `members.led-member.view` / `.edit` / `.export` | **Gruppenleitung** (2026-10-21): Mitglieder der selbst geleiteten Gruppen ansehen (inkl. Dokumente, Zusatzfelder) / bearbeiten + Dokumente verwalten (ohne Gruppen und Mitgliedschaftsdaten) / Mitgliedsdaten-PDF der eigenen Gruppen. `.edit`/`.export` setzen `.view` voraus. Wirken **nur** auf den Bereich `ledGroupIds`; vergeben über die automatische Rolle „Gruppenleitung“ |
| `members.own.view` / `.edit` | Eigene (verknüpfte) Mitglieder sehen / Kontakte, Zusatzfelder, Mail-Einstellungen ändern (`.edit` setzt `.view` voraus, Handler prüfen beides); Manifest `defaultRoleGrants` vergibt beide an die Rolle „Mitglied“ |
| `members.data.export` | Mitgliedsdaten-PDF (inkl. Telefone, Gesundheits-Zusatzfelder) erzeugen – auch `GET /actions/:id/participants.pdf`; zusätzlich `members.member.view` (+ `members.group.view` bei Gruppen) |
| `members.storage.read` / `.write` / `.delete` | Core-Storage-Rechte (Upload braucht `.write`, Entfernen `.delete`); in der UI `canUpload`/`canRemoveDoc` |

Kein Objekt-Besitz: Zugriff gilt global je Recht (keine Freigaben/Matrix) – Ausnahme Gruppenleitung (Bereich = geleitete Gruppen).

### Gruppenleitung (Migration 0015, v1.11.0, 2026-10-21)
- **Wer**: Konten, deren **eigenes Mitglied** eine Gruppe leitet (`group_leaders`), nicht ausgetreten (kein Austritt oder Austritt nach heute, `todayBerlin()`) und nicht
  anonymisiert. „Eigenes Konto“ = Verknüpfung mit `member_user_links.is_self` (Migr. 0015, Unique je Konto und je Mitglied). **Nur die Verwaltung**
  setzt es (`PUT /members/:id/links/:userId { self }`, `members.link.manage`, Schalter mit Personensymbol im `LinksDialog`, Badge „Eigenes Konto“);
  Brief-Code/Registrierung und manuelles Verknüpfen setzen es **nie** – sonst bekämen Eltern einer jugendlichen Leitung Zugriff auf die ganze Gruppe.
- **Rechte**: automatische Rolle **„Gruppenleitung“** (`LEADER_ROLE_NAME`, `defaultRoleGrants`: `members.led-member.view|edit|export` +
  `members.storage.read|write|delete`) über `core.roles.replaceModuleGrants('members', …)` (`user_role_grant`, nur bei aktivem Modul). `syncLeaderGrants`
  nach Gruppe anlegen/ändern/löschen, Mitglied ändern (Austritt geändert)/löschen/anonymisieren, Verknüpfung lösen, „eigenes Konto“ ändern,
  `onUserDeleted` (afterCommit), `onEnable` und stündlich per Job `members.sync-leader-grants` (Austritt erreicht). Der **Bereich** (`ledGroupIds`) wird je
  Aufruf frisch bestimmt – Austritt/Leitungswechsel wirken sofort, auch wenn die Rolle erst nach dem Abgleich verschwindet.
- **Rechteausweitung** (`assertCanGrantLeader` → `core.roles.assertCanGrant`, 403): Wer ein Mitglied mit eigenem Konto **neu als Leitung** einträgt
  (POST/PUT `/groups`) oder bei einer aktiven Leitung „eigenes Konto“ setzt, braucht alle Rechte der Rolle „Gruppenleitung“ (Administrator*innen ja;
  eine Rolle „Mitgliederverwaltung“ braucht dafür zusätzlich `members.led-member.*` + `members.storage.*`). Entfernen prüft nichts.
- **Endpunkte** (`led.endpoints.ts`, nach `memberEndpoints` registriert; fremdes Mitglied/fremde Gruppe → **404**):

  | Methode + Pfad | Recht | Besonderheiten |
  |---|---|---|
  | GET `/led/groups` | led-member.view | geleitete Gruppen als `GroupRef[]` |
  | GET `/led/members`, `/led/members/:id` | led-member.view | wie `/members`, nur Mitglieder mit ≥ 1 geleiteten Gruppe (auch wenn zusätzlich in fremden Gruppen; deren Namen sind sichtbar) |
  | PUT `/led/members/:id` | led-member.edit (+ view) | `memberInput`; **Gruppen, Eintritt, Austritt, Zweitmitglied, Beitragsebenen bleiben unverändert** (Server ignoriert sie). Audit `members.member.updated` mit `{ asGroupLeader: true }` |
  | POST/GET/DELETE `/led/members/:id/documents/:kind` | edit/view/edit | gleiche Logik wie `/members/…/documents` (`uploadDocument`/`downloadDocument`/`deleteDocument` mit `scope`); Bereich wird **vor** dem Lesen des Uploads geprüft |
  | GET `/led/fields` | led-member.view | Zusatzfelder (auch Gesundheitsfelder – Entscheidung des Nutzers) |
  | GET `/led/members/sheet-columns`, POST `/led/members/sheets.pdf`, POST `/led/groups/sheets.pdf` | led-member.export (+ view) | alle IDs im Bereich, sonst 404 (nichts erzeugt) |
  | GET `/led/address/suggest`, `/led/address/places` | led-member.edit | **ohne** Mitglieder-Anschriften (`includeMembers: false`), nur Verzeichnis/Photon |

  Kein Anlegen, Löschen, Sammeländern, Verknüpfen; keine globale Suche (Befehlspalette findet für Gruppenleitungen keine Mitglieder).
- **UI**: Navigationseintrag „Mitglieder“ mit `anyPermission: ['members.member.view', 'members.led-member.view']` (Core-Erweiterung). `MembersPage` schaltet
  ohne `members.member.view` in den Gruppenleitungs-Modus (`ledMode`, `apiBase = /modules/members/led`): Titel „Mitglieder meiner Gruppen“, Gruppenfilter =
  eigene Gruppen, Sammelleiste nur „Mitgliederliste (PDF)“, leerer Zustand „Du leitest derzeit keine Gruppe“ mit Hinweis aufs eigene Konto. `MemberForm`
  mit `apiBase` + `restricted`: Reiter Mitgliedschaft zeigt Gruppen als Badges, Eintritt/Austritt/Zweitmitglied gesperrt (Hinweis), Stand bleibt änderbar.
  `AddressFields` mit `apiBase` (Cache-Schlüssel enthält ihn).
- Tests `tests/integration/members-leaders.test.ts` (Rolle nur mit eigenem Konto, Eltern nie, Zugriffsmatrix, gesperrte Felder, Dokumente mit Fake-Storage,
  PDFs, Adressen ohne Mitglieder-Anschriften, Rolle weg bei Leitungswechsel/Austritt/Job/Lösen/Kontolöschung, Rechteausweitung 403, Navigation).
- **Konten als Leitung (Migr. 0016, v1.12.0, 2026-10-26, Nutzerentscheidung „Benutzer direkt wählen“)**: Tabelle `group_leader_users(group_id FK
  CASCADE, user_id ohne FK, created_at, PK)`. Eine Gruppe braucht **mindestens eine Leitung** – Mitglied (`leaderIds`) **oder** Konto (`leaderUserIds`,
  ≤ 20, neue nur aktive Konten, sonst 422 `leaderUserIds`; bereits eingetragene deaktivierte bleiben, Anzeige „Unbekannt“). DTO `Group.leaderUsers
  [{ id, name, active }]` (Namen nach der Transaktion über `core.users.byIds`). Direkte Konten zählen überall wie eigene Konten leitender Mitglieder:
  `ledGroupIds`, `syncLeaderGrants` (Rolle „Gruppenleitung“), `listGroupMailboxes.leaderUserIds`/`listLedGroups` (Gruppen-Postfach und -Absender in
  `messages`), `principalIdsForUser` (`group:<id>`), `userIdsForPrincipals`; „einzige Leitung“ (Löschen/Anonymisieren) zählt Konten mit.
  Rechteausweitung: neue Konto-Leitung → `assertCanGrantLeader(…, userIds)` → 403 ohne die Rechte der Rolle. `onUserDeleted`/`resetUsers` löschen die
  Zeilen (`unlinkUsers`), Datenauskunft `accountLeaderOf`. **Website**: Konto-Leitungen erscheinen **nicht** (keine Website-Einwilligung).
  `GET /groups/leader-users?search=` (`members.group.edit`, ab 2 Zeichen, E-Mail nur mit `core.users.view`). UI: Gruppendialog Abschnitt
  „Gruppenleitung *“ mit Mitglieder-`MultiSelect` und `LeaderUserPicker`, Tabelle Spalte „Leitung“; Website-Feld heißt „E-Mail-Adresse der Gruppe“
  (= Postfach der Leitungen). `messages` vergibt der Rolle „Gruppenleitung“ `messages.message.send` (`defaultRoleGrants`). Test
  `tests/integration/members-leader-users.test.ts`.
- Offen: Gruppenleitung kann keine Mitglieder anlegen/löschen (Entscheidung des Nutzers); kein Hinweis in der Gruppenliste, welche Leitung ein eigenes
  Konto hat; Verwaltungsrollen ohne `led-member.*` können Leitungen mit eigenem Konto nicht mehr eintragen (403, gewollt).

## API (`/api/v1/modules/members/…`, Session oder API-Key, nicht öffentlich)
| Methode + Pfad | Recht | Besonderheiten |
|---|---|---|
| GET `/members` | member.view | Query `search` (Vor-/Nach-/Pfadname ILIKE), `status` (`active` Standard = kein Austritt oder Austritt > heute, `left` = Austritt ≤ heute, `all`), `limit` 1–200 (50), `offset`; `{items,total}`. **Filter (2026-10-21, `memberFilterShape` in `schemas.ts`, Bedingungen in `buildMemberFilter` in `members.service.ts`)**: `stage` + `stages` (kommagetrennt, ODER), `groupId` + `groupIds` (kommagetrennt, ≤ 50) mit `groupMode` `any` (Standard) / `all`, `ungrouped=yes` („Ohne Gruppe“, bei `any` ODER-verknüpft), `ageMin`/`ageMax` (0–120, Jahre heute Berlin), `consentWebsite\|consentSocialMedia\|consentPrint\|secondary\|hasEmail` (`yes`/`no`), `entryFrom`/`entryTo` (`YYYY-MM-DD`). Dieselben Filter gelten für `/led/members` |
| GET `/members/ids` | member.view | gleiche Filter ohne `limit/offset` → `{ items[{id,name}], total, truncated }` (höchstens `SELECT_ALL_MAX` = 2000, danach `truncated`); für „Alle Treffer auswählen“; 60/min; Pfad vor `/members/:id`; Gruppenleitung: `/led/members/ids` |
| GET `/members/:id` | member.view | 404 wenn fehlt |
| POST `/members` | member.edit | Gruppen optional; `custom` = Werte der Zusatzfelder (nur aktive Schlüssel, sonst 422) |
| PUT `/members/:id` | member.edit | `FOR UPDATE`; `custom` wird mit den gespeicherten Werten **zusammengeführt** (fehlend = unverändert, leer = gelöscht) |
| DELETE `/members/:id` | member.delete | 409, wenn einziger Leiter einer Gruppe; entfernt Dateien best-effort |
| GET `/groups`, `/groups/:id` | group.view | inkl. Leiter und `memberCount` |
| POST `/groups`, PUT `/groups/:id` | group.edit | ≥ 1 Leitung (Mitglied oder Konto, 422 `leaderIds`); Name case-insensitiv eindeutig (409) |
| GET `/groups/leader-users?search=` | group.edit | aktive Konten für die Leitungsauswahl (ab 2 Zeichen, ≤ 30) |
| DELETE `/groups/:id` | group.delete | 409, solange Mitglieder zugeordnet |
| POST `/members/bulk` | member.edit (`delete`: zusätzlich member.delete) | Body `{ action: add-groups\|remove-groups\|set-stage\|set-consent\|delete, ids (1–2000 = `BULK_MAX_IDS`), … }`; Antwort `{ affected, skipped[{id,name,reason}] }`; unbekannte ID → 404 (nichts geändert); `remove-groups` lässt ≥ 1 Gruppe übrig, `delete` überspringt einzige Leiter (409-Grund); Audit `members.member.bulk_updated` ohne Namen |
| POST/GET/DELETE `/members/:id/documents/:kind` | edit/view/edit | `kind` = `privacy`\|`registration`; Upload multipart Feld `file`, PDF/JPEG/PNG/WebP ≤ 10 MB; ersetzt altes |
| POST/GET/DELETE `/groups/:id/image` | edit/view/edit | JPEG/PNG/WebP ≤ 2 MB, Inhalt muss zum Typ passen (sonst 400); gespeichert nur bereinigtes WebP (`groups/<id>/img-<uuid>.webp`); GET ohne Bild 404, eigenes Rate-Limit `IMAGE_RATE_LIMIT` |

### Mitgliedsdaten-PDF (Listen, A4 quer, wählbare Spalten, 2026-10-17)
- Layout: Vorlage `stamm-briefkopf-quer` (Fallback `compact` quer, `listTemplateInput` in `$lib/pdf-lists/compose.ts`), **eine Zeile je Person** in einer Gitter-Tabelle; Abschnitt = Überschrift +
  Info (Anzahl, Stand, bei sensiblen Spalten „Vertraulich …“); je Gruppe neue Seite. Datenblatt-Layout (Karte je Person) entfällt. Layout/Auswahl-Logik in `$lib/pdf-lists`
  (`normalizeSelection`, `visibleColumns`, `buildSectionedListBlocks`), gebündelt als `composeListBlocks` (`$lib/pdf-lists/compose.ts`, rein).
- Katalog (`$lib/pdf-lists/member-columns.ts`, rein; dort auch `MEMBER_HEALTH_FIELD_KEYS` = `SENSITIVE_FIELD_KEYS`): `buildMemberCatalog(defs)` = Basisspalten (`name`, `scoutName`, `stage`, `groups`, `age`, `birthDate`, `entryDate`, `address`, `phone`,
  `emergencyPhone`, `email`, `consents`) + je Zusatzfeld `field.<schlüssel>` (Gruppe `health`, `sensitive`; `field.juleica` Gruppe `person`, nicht sensibel). `emergencyPhone` = Nummer mit
  „Notfall“ in der Bezeichnung, sonst die erste. Voreinstellungen `fahrt` (Voreinstellung: Name, Gruppe, Alter, Notfall-Telefon, Ernährung, Allergien, Medikamente), `kontakt`, `gesundheit`, `minimal`
  (`LIST_PRESET_KEYS`, auf vorhandene Spalten gekürzt). `rowFromMember(m, defs, today)` liefert alle Spalten als fertigen Text. Leere Spalten entfallen bei `hideEmpty` (Standard).
- API (alle `members.data.export`, zusätzlich im Handler `members.member.view`, bei Gruppen `members.group.view` → sonst 403; PDF `private, no-store`):
  `GET /members/sheet-columns` → `{ columns: ListColumn[], presets: ListPreset[] }`;
  `POST /members/sheets.pdf` `{ ids (1–2000), selection? }` (Reihenfolge = ids, unbekannt 404), `POST /groups/sheets.pdf` `{ groupIds (1–20), selection? }` (Seite je Gruppe, nur aktuelle Mitglieder,
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
- `GET /address/suggest?q=&postalCode=&country=` (member.edit, ≥ 3 Zeichen, 180/min), seit 2026-10-20 schnell (vorher Photon allein, 3–5 s):
  1. **Mitglieder-Anschriften** (`street ILIKE q%`, häufigste zuerst, immer frisch, Quelle `members`);
  2. **OpenPLZ** (`members.address.openPlzUrl`, Standard `https://openplzapi.org`, amtliches Straßenverzeichnis DE, „enthält“-Suche): Straßenname ohne
     Hausnummer (`splitHouseNumber`, „straße/stra/straß“ → „str“ per `directoryName` in `address-utils.ts`), Region zuerst (eingegebene PLZ bzw.
     häufigster PLZ-Bereich der Mitglieder, 10 min gemerkt), dann bundesweit; Hausnummer wird angehängt (Quelle `directory`);
  3. **Photon** (`members.address.photonUrl`, Bounding-Box DE) nur bei Land ≠ DE, ohne Verzeichnistreffer oder wenn OpenPLZ > 0,8 s braucht (Timeout 6 s).
  Server-Zwischenspeicher 10 min je Straßenname/Region (vollständige kürzere Ergebnisse werden für längere Eingaben nur gefiltert), gleiche laufende
  Anfragen zusammengelegt. Antwort `{ items[≤ 8] (mit `source`), unavailable }`; nie ein Fehlerstatus. Oberfläche: fragt schon beim Tippen (höchstens eine
  Anfrage, ≥ 250 ms Abstand), Hausnummer ohne neue Anfrage (`withHouseNumber`), veraltete Treffer ausgefiltert (`matchesStreetName`), Ladeanzeige,
  „bei Mitgliedern“-Hinweis. **Datenschutz:** Der Straßentext (keine Namen) geht an OpenPLZ bzw. Photon. Bekannt: OpenPLZ kennt nicht jede Straße.
- `GET /address/places?postalCode=` (member.edit): Orte zur deutschen PLZ aus `data/plz-de.json` (GeoNames, CC BY 4.0, siehe `data/NOTICE.md`), offline.
- Brief-Adressfeld (`recipientLines`): ab 18 Jahren (`isAdult`) der Name selbst, sonst „Eltern von …“; dazu Straße, „PLZ Ort“, bei Land ≠ DE der Ländername (Großbuchstaben).
  Brieftext für Volljährige in „Ihre Mitgliedschaft“-Form, ohne Elternhinweis.

### Konto-Verknüpfung (`link.ts` rein, `link.service.ts`, `link.endpoints.ts`, UI `LinksDialog`, `LinkAccount`)
Mitglied ↔ Konten n:m (Mutter+Vater ↔ Kind; Elternteil ↔ mehrere Kinder). Verknüpft wird per **Brief** (Vorlage `stamm-brief`,
Adressfeld „Eltern von …“ + Anschrift; Block `box` (ohne Rahmen) mit QR-Code, großem Code `123 456`, Gültigkeit und anklickbarem Link ohne `https://`; darunter „So geht’s“ und „Gut zu wissen“, passt auf eine Seite). Code ist bis zum Ablauf (90 Tage) **beliebig oft** nutzbar (2026-10-29, Nutzerwunsch; Einstellung `members.link.maxUses` entfällt); der Brief
verwendet den bestehenden Code, erzeugt nur bei fehlendem/abgelaufenem Code einen neuen (`POST …/link-code` erzwingt neu → neues Token, Zähler 0).
**Entscheidung (#18, 2026-10-20, Höchstzahl am 2026-10-29 aufgehoben):** jede weitere Verknüpfung über den Code informiert alle bereits
verknüpften Konten per Mail („Weiteres Konto mit <Vorname> verknüpft“, ohne Daten des neuen Kontos); über den Brief neu angelegte Konten müssen ihre Adresse
bestätigen, bevor sie sich anmelden können. `use_count` zählt nur zur Anzeige (erneutes Einlösen durch ein schon verknüpftes Konto zählt nicht; manuelles Verknüpfen auch nicht).
Abgelaufen → `GET /public/link/:token`, `claim`, `register` antworten 404 („Dieser Link ist nicht mehr gültig.“). Scheitert die Registrierung nach
erfolgreicher Code-Prüfung (z. B. 409), wird der Zähler zurückgenommen. Unbestätigte Konten lassen sich unter `/admin/users` von Hand bestätigen.
| Methode + Pfad | Recht | Besonderheiten |
|---|---|---|
| GET `/members/:id/links` | link.view | Konten (Name/E-Mail via `core.users.directory`), Codestatus (nie der Code): `expiresAt`, `expired`, `locked`, `uses` |
| POST `/members/:id/link-code` | link.manage | neuer Code + Token, Zähler/Sperre zurück |
| POST `/members/:id/links` | link.manage | **Konto per Hand verknüpfen** (ohne Brief/Code, 2026-10-19): `{ userId, relation? }` strikt → `MemberLinks`; nur aktive Konten (sonst 422 `userId`), schon verknüpft 409, Mitglied unbekannt 404; Rollen bleiben unverändert; Audit `members.link.created` mit `manual: true` |
| GET `/link-users?search=` | link.manage | aktive Konten zum Verknüpfen (`core.users.directory`, ab 2 Zeichen, ≤ 30) → `LinkUserRef[]` |
| PUT `/members/:id/links/:userId` | link.manage | `{ self }` → `MemberLinks`: als **eigenes Konto** des Mitglieds markieren/lösen (Gruppenleitung, siehe oben); 404 ohne Verknüpfung, 409 wenn Konto/Mitglied schon ein eigenes hat, 403 bei Rechteausweitung; Audit `members.link.self-changed` |
| DELETE `/members/:id/links/:userId` | link.manage | Verknüpfung lösen (404 wenn nicht vorhanden) |
| GET `/members/:id/link-letter.pdf`, POST `/members/link-letters.pdf` `{ids ≤ 100}` | link.manage | PDF bzw. ein zusammengeführtes PDF (Reihenfolge = ids; unbekannte ID → 404); rohe Response → Status 200 |
| GET `/my/members` | own.view | eigene Mitglieder, siehe „Eigene Mitglieder im Profil“ |
| GET `/public/link/:token` | öffentlich | nur Vorname + `viewer`; unbekannt/abgelaufen 404 |
| POST `/public/link/:token/claim` | öffentlich + Session | `{code, relation?}`; ohne Anmeldung 401, falscher/gesperrter Code 403 |
| POST `/public/link/:token/register` | öffentlich | `{code,name,email,password≥12,relation?}` → Konto mit Rolle „Mitglied“ (`core.users.registerWithRole`, **`emailVerified=false`** + Bestätigungslink, Login erst nach Bestätigung), 409 bei vorhandener E-Mail |
Schutz: 10 Fehlversuche je Mitglied → 60 min Sperre (Zähler wird vor dem Werfen committet), Rate-Limits claim 10/600 s, register 5/600 s.
Öffentliche Seite `/p/members/verknuepfen/<token>`: Code, „Ich habe ein Konto“ (Login mit `redirectTo`, Code in `sessionStorage`) oder „Neues Konto“.
UI: Zeilenaktion „Verknüpfte Konten“ (Badge `linkCount`) → `LinksDialog` (mit `link.manage` zusätzlich „Konto direkt verknüpfen“: Kontosuche + optionale Beziehung, Klick auf einen Treffer verknüpft sofort); Sammelleiste „Verknüpfungs-Briefe (PDF)“ (`downloadPdf`).
Audit: `members.link.code_created|created|registered|removed|letters_generated` (nur IDs/Zähler; `created` mit `viaCode`, `repeated`, `notified`,
`registered` mit `notified`, `emailVerificationPending`). Tests: `tests/integration/members-links.test.ts`, `members-link-security.test.ts`.
Offen: Die Verknüpfung eines unbestätigten Kontos besteht sofort (Zeile in `member_user_links`), wirkt aber erst mit der ersten Anmeldung –
also nach Bestätigung; ein unbestätigtes Konto zählt als Nutzung. Die Verwaltung wird nicht zusätzlich benachrichtigt.

### Benachrichtigungen (2026-10-25)
- „Weiteres Konto verknüpft“ (`notifyLinkedAccounts`) geht über `core.notifications` (Typ `account-linked`, `mandatory`, sichtbar mit `members.own.view`).
- Neuer Dienst `MembersService.listLinkedUserIds(memberIds)` (systemweit, ohne Rechteprüfung, ≤ 2000, ohne anonymisierte) – für Push der Kasse.

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
  `GET /website/groups/:slug/image` (roh, `public, max-age=86400`, `nosniff`; 404 ohne Bild/Storage/nicht auf Website; `IMAGE_RATE_LIMIT` 1200/60 s; Storage über Systemkontext).
- `WebsiteGroup`: `id, slug, name, type, description` (Website-Text, sonst interne Beschreibung), `ageRange, meetingPlace, meetingWeekday, meetingTime, meetingEndTime, color,
  contactEmail, leaders: [{ firstName }]` (nur Vornamen, ohne Ausgetretene, **nur mit `consent_website`** – #27), `imagePath` (`…/image?v=<ms>` oder `null`). **Keine** Nachnamen, Mitglieder-Mails, Geburtsdaten.
- UI: Gruppendialog mit Reitern **Allgemein / Website** (Checkbox, Adresse mit Vorschlag aus dem Namen über `slug.ts` `slugFromName`, Vorschau `/gruppen/<slug>`,
  Text, Alter, Kontakt-E-Mail), Badge „Website“ in der Liste.
- **Gruppenbilder ohne Metadaten (#19, 2026-10-20)**: Upload läuft über `core.images.process` (nach EXIF drehen, EXIF/XMP/GPS entfernen, WebP q82,
  lange Kante ≤ 1600 px); gespeichert und ausgeliefert wird nur diese Variante. Bestand: stündlicher, idempotenter Job `members.reprocess-group-images`
  (Pfade ≠ `groups/<id>/img-<uuid>.webp` werden neu verarbeitet, Verweis nur umgestellt, wenn unverändert; fehlende Datei → Verweis entfernt;
  nicht lesbare Bilder bleiben und werden gemeldet; ≤ 100 je Lauf; Audit `members.group.image.reprocessed` mit Zählern). Test `members-group-image.test.ts`.
- **Alter von/bis (Migr. 0017, v1.13.0, 2026-10-27, Nutzerwunsch)**: `groups.age_min`/`age_max smallint` (0–99, CHECK bis ≥ von), Bestand aus dem
  Freitext nach den Regeln von `parseAgeRange` übernommen (Test `members-age-migration.test.ts`). Eingabe `website.ageMin|ageMax` (statt `ageRange`; bis < von →
  422 `website.ageMax`); `age_range` = abgeleiteter Anzeigetext `formatAgeRange` (`schemas.ts`: „6 bis 10 Jahre“, nur von → „ab 11 Jahren“, nur bis → „bis 10 Jahre“),
  beim Speichern gesetzt. DTOs `GroupWebsite`/`WebsiteGroup`/`WebsiteGroupRef` haben `ageRange` **und** `ageMin`/`ageMax`. Dialog: Felder „von“/„bis“ + Vorschau,
  Altbestand ohne Zahlen zeigt den alten Text als Hinweis.
- **Kleines Gruppenbild** (2026-10-27): `GET /website/groups/:slug/image?size=thumb` → WebP lange Kante 640 px (`groupThumbnail`, beim Abruf erzeugt, nicht
  gespeichert; nicht verkleinerbar → Original). Die Website cacht es je Größe.
- Tests `tests/integration/members-website.test.ts`. Nutzerin: Stammeswebsite (`rules/website.md`).

### Datenschutz: Einwilligungsnachweis, Löschfrist, Auskunft (Migration 0013, #27/#30, 2026-10-20)
- **Nachweis** (Art. 7 Abs. 1): `members.consent_{social_media,website,print}_at|_by` = Zeitpunkt + erfassende Person (`ctx.userId`, sonst
  `<actor-typ>:<id>`) der **letzten Änderung**. Anlegen: nur erteilte Einwilligungen bekommen einen Nachweis; PUT und Sammelaktion `set-consent`
  setzen ihn nur bei echter Änderung (`consentSet` in `members.service.ts`, CASE auf den alten Wert). DTO `Member.consentProof { socialMedia, website,
  print: { at, by } | null }` (Altbestand `null`), Anzeige „(erteilt/widerrufen am …)“ im Reiter Einwilligungen.
- **Website**: Leitende ohne `consent_website` fehlen in `WebsiteGroup.leaders` (Liste und Detail).
- **Löschfrist nach Austritt**: Einstellung `members.retention.exitYears` (1–30, Standard 3). `GET /retention` (`members.member.delete` + `member.view`) →
  `{ years, cutoff, items[{id, firstName, lastName, exitDate}] (≤ 500), total }` = Austritt vor `heute − N Jahre`, nicht anonymisiert.
  `POST /retention/anonymize { ids (1–200) }` (`members.member.delete`, 20/600 s) → `{ affected, skipped[{id, name, reason}] }`; nicht fällig/unbekannt/
  bereits anonymisiert/einzige Leitung → übersprungen. Anonymisieren siehe `docs/security.md` → „Löschkonzept“ (`anonymized_at`, Name „Anonymisiert“,
  Geburtsdatum 1.1. des Jahres, alles Weitere gelöscht; Stand, Ein-/Austritt, Zweitmitglied, Ebenen bleiben). Audit `members.member.anonymized` (Zähler).
  Seite `/modules/members/retention` („Löschfristen“ unter Administration › Module, nur mit `members.member.delete`). **Keine** automatische Löschung.
- **Hook `onMemberDeleted`**: `deleteMember` und das Anonymisieren rufen nach der Transaktion `core.modules.memberDeleted('members', { memberIds,
  reason: 'deleted' | 'anonymized' })` → alle anderen aktiven Module mit `onMemberDeleted` (z. B. `actions`). Dokument-Löschfehler werden protokolliert
  (`removeMemberFiles`, ohne Pfad).
- **Datenauskunft** (`subject-export.ts`): `findSubjects` (Name/Pfadname, ohne anonymisierte), `resolve` (Konto → verknüpfte Mitglieder),
  `run` (vollständiges `Member`-DTO inkl. Zusatzfelder, Konto-Verknüpfungen, Leitungen, Mail-Einstellungen; ohne Dokumentinhalte).
- Tests `tests/integration/privacy-retention.test.ts`, `members-website.test.ts` („Website-Einwilligung der Leitenden“).

### Verweise anderer Module auf Mitglieder/Gruppen (Stand 2026-10-21, Issue #76 10-09)
`members` implementiert selbst `onUserDeleted`, `subjectExport`, `search`, `backup.rehash`, `resetAreas` (mit `implies`) – aber kein `onMemberDeleted`
(es **löst** das Ereignis aus). Fremde Module speichern Mitglieds-/Gruppen-IDs ohne FK (anderes Schema):

| Verweis | Mitglied gelöscht/anonymisiert (`onMemberDeleted`) | Gruppe gelöscht | Reset `members:all` |
|---|---|---|---|
| `actions.action_participants.member_id` | bereinigt (Teilnehmende anonymisiert) | – | **nicht** mitgelöscht (kein `implies`), Verweis hängt |
| `orders.orders.member_id` (+ Snapshot `member_name`) | nicht bereinigt (kein Hook) | – | nicht mitgelöscht |
| `events.event_groups.group_id` | – | nicht bereinigt (kein Ereignis beim Gruppen-Löschen) | nicht mitgelöscht |
| `group:`/`member:`-Freigaben in `events.event_shares`, `files.node_shares`, `galleries.gallery_shares` | nicht bereinigt | nicht bereinigt | nicht mitgelöscht; Anzeige „Unbekannt“ (`describePrincipals`) |
| `treasury.payer_members.member_id`, `invoice_lines.member_id`, Jahresbeitrag | nicht bereinigt (kein Hook) | – | mitgelöscht über `implies` `treasury:payers`, `treasury:annual` (→ transitiv `treasury:invoices`) |

Die Beschreibung von `members:all` in `reset.ts` nennt diese hängenden Verweise ausdrücklich (Anzeige „Unbekannt“); aktiv bereinigt wird beim Reset nichts.
Ein `implies` auf `actions:participants` o. Ä. bzw. ein Hook `onReferencedDeleted` (Gruppen) ist offen (#76, fachliche Entscheidung).

### Ende der Gruppenstunde (Migration 0010, v1.8.0, 2026-10-19)
- `groups.meeting_end_time text` (`HH:MM`). DTO `Group.meetingEndTime`, `WebsiteGroup.meetingEndTime` (nur zusammen mit `meetingTime`, sonst `null`),
  Dienst `MemberGroupRef.meetingEndTime` (= `PrincipalGroupRef`); `events` übernimmt es in `EventGroupRef.meetingEndTime` (`loadGroupMap`), „Gruppenstunde
  übernehmen“ belegt das Ende am selben Tag vor (#46, 2026-10-21).
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
  Pfad `meetingEndTime`), `color` Hex (wird normalisiert), `leaderIds` 0–20 + `leaderUserIds` 0–20, zusammen ≥ 1.

## UI
- `MembersPage`: Zeilen klickbar (auch Enter/Leertaste) → `MemberForm` als Ansicht (`readonly`); Checkbox- und Aktionszelle stoppen den Klick.
  Filter „Mitgliedschaft“ (Aktiv/Ausgetreten/Alle, URL-Parameter `status`, Standard aktiv); Badges „Zweitmitglied“, „ausgetreten“ in der Namenszelle.
  Checkbox-Spalte + Sammelleiste (Gruppen hinzufügen/entfernen, Stand, Einwilligungen, Löschen; `BulkDialog`), Auswahl wird bei Filterwechsel verworfen. **„Alle Treffer auswählen“** (2026-10-21): Kopf-Checkbox wählt die Seite; sind alle Zeilen gewählt und es gibt mehr Treffer, bietet eine Leiste „Alle N Treffer auswählen“ → `GET …/members/ids` mit dem aktuellen Filter (`allMatched`; bei `truncated` Warnung). Verknüpfungs-Briefe bleiben bei 100 (`LINK_LETTERS_MAX_IDS`). **Filter** (`pages/MemberFilters.svelte`, URL-Parameter wie in der API): Suche, Mitgliedschaft, Stände und Gruppen als `MultiSelect` (Gruppen mit „Ohne Gruppe“, Umschalter „mindestens eine/alle gewählten“ ab 2 Gruppen), Knopf „Erweitert“ (Badge, bleibt offen solange etwas gesetzt ist): Alter von/bis, Eintritt ab/bis, Einwilligungen, Zweitmitglied, E-Mail; „Filter zurücksetzen“. Spalten Name, Stand, Gruppen (Farb-Badges),
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
  Leiter, `FileField` Bild mit Zuschnitt (`crop`, runde Maske, Ergebnis quadratisch 1200 px, Hintergrund für Ränder = Gruppenfarbe; Original bis 25 MB, hochgeladen wird nur der Ausschnitt). Buttons nach `can(permissions, …)` ein-/ausgeblendet.

## Audit
`members.member.created|updated|deleted` (**ohne** Metadaten – Person nur über `target`), `members.group.created|updated|deleted` (metadata `name` = Gruppenname),
`members.document.uploaded|deleted` (nur `kind`, kein Dateiname), `members.group.image.uploaded|deleted` (ohne Dateinamen).
Seit #26 (2026-10-20) keine Klarnamen/Dateinamen mehr im Audit; ältere Einträge enthalten sie noch (keine automatische Bereinigung, siehe `docs/security.md` → „Audit“).

## Tests
`tests/integration/members.test.ts` (Bootstrap ohne Gruppe, CRUD, Gruppenregeln 409/422, Farbe/Wochentag, Upload ohne
Storage, 403/401/404, Audit, Mitgliedschaft: Eintritt/Austritt/Zweitmitglied, 422-Regeln, Statusfilter, `listMemberContacts`) und `tests/unit/members-schemas.test.ts` (Alter, Datum, Farbe, `memberInput`, `groupInput`).
Upload-Erfolgspfad ist nicht getestet (kein S3; `tests/helpers/fake-storage.ts` wird hier nicht genutzt).

## Entscheidungen und Fallen
- **Gruppen sind für Mitglieder optional** (früher Pflicht ab der ersten Gruppe); Gruppen brauchen weiterhin ≥ 1 Leitung (Mitglied oder Konto).
- `group_leaders.member_id` ist RESTRICT; `deleteMember` prüft zuerst „einziger Leiter“ (409), löscht dann die Leiter-Zeilen.
- Stände sind eine feste Liste im Code (CHECK in der DB + `STAGES`); neuer Stand = neue Migration **und** Schema/Labels.
- Core-Aufrufe (`storage`, `audit`) liegen bewusst **außerhalb** der Modul-Transaktion (PGlite).
- Offen: Anbindung an `actions` (Teilnehmende aus Mitgliedern übernehmen) existiert nicht; Mitglieder-Import/Export fehlt.
