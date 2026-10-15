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
- Telefone/E-Mails/Gruppen werden bei jedem Update **komplett gelöscht und neu geschrieben** (Reihenfolge = `position`).

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `members.member.view` / `.edit` / `.delete` | Mitglieder lesen (auch Dokument-Download) / anlegen+ändern+Dokumente hoch/löschen / löschen |
| `members.group.view` / `.edit` / `.delete` | Gruppen lesen (auch Bild) / anlegen+ändern+Bild / löschen |
| `members.storage.read` / `.write` / `.delete` | Core-Storage-Rechte (Upload braucht `.write`, Entfernen `.delete`); in der UI `canUpload`/`canRemoveDoc` |

Kein Objekt-Besitz: Zugriff gilt global je Recht (keine Freigaben/Matrix).

## API (`/api/v1/modules/members/…`, Session oder API-Key, nicht öffentlich)
| Methode + Pfad | Recht | Besonderheiten |
|---|---|---|
| GET `/members` | member.view | Query `search` (Vor-/Nach-/Pfadname ILIKE), `stage`, `groupId`, `limit` 1–200 (50), `offset`; `{items,total}` |
| GET `/members/:id` | member.view | 404 wenn fehlt |
| POST `/members` | member.edit | ab der ersten Gruppe ≥ 1 Gruppe Pflicht (422); beim allerersten Mitglied leer erlaubt |
| PUT `/members/:id` | member.edit | `FOR UPDATE`, gleiche Prüfung |
| DELETE `/members/:id` | member.delete | 409, wenn einziger Leiter einer Gruppe; entfernt Dateien best-effort |
| GET `/groups`, `/groups/:id` | group.view | inkl. Leiter und `memberCount` |
| POST `/groups`, PUT `/groups/:id` | group.edit | ≥ 1 Leiter (Mitglied, 422); Name case-insensitiv eindeutig (409) |
| DELETE `/groups/:id` | group.delete | 409, solange Mitglieder zugeordnet |
| POST/GET/DELETE `/members/:id/documents/:kind` | edit/view/edit | `kind` = `privacy`\|`registration`; Upload multipart Feld `file`, PDF/JPEG/PNG/WebP ≤ 10 MB; ersetzt altes |
| POST/GET/DELETE `/groups/:id/image` | edit/view/edit | JPEG/PNG/WebP ≤ 2 MB; GET ohne Bild 404 |

Ohne S3 antworten Upload/Download mit `503 unavailable`. Storage-Pfad `<id>/<kind>-<uuid>-<bereinigter Name>`;
bei DB-Fehler nach Upload wird die Datei wieder entfernt.

## Validierungsregeln (`schemas.ts`)
- Geburtsdatum `YYYY-MM-DD`, echtes Datum, nicht in der Zukunft, Alter ≤ 120.
- Telefon: `+?` Ziffern, 6–15 Ziffern, ≤ 30 Zeichen; E-Mail lower-case, `z.email`; je ≤ 10; **Duplikate** (Telefon nach
  Ziffern normalisiert, E-Mail exakt) → 422.
- Gruppe: `meetingWeekday` 1–7 (optional), `meetingTime` `HH:MM`, `color` Hex (wird normalisiert), `leaderIds` 1–20.

## UI
- `MembersPage`: `DataTable` (Suche, Filter Stand/Gruppe via `SelectField`), Spalten Name, Stand, Gruppen (Farb-Badges),
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
- Ab der ersten Gruppe braucht jedes Mitglied ≥ 1 Gruppe; Gruppen brauchen ≥ 1 Leiter (Henne-Ei: erstes Mitglied ohne
  Gruppe, dann Gruppe mit ihm als Leiter).
- `group_leaders.member_id` ist RESTRICT; `deleteMember` prüft zuerst „einziger Leiter“ (409), löscht dann die Leiter-Zeilen.
- Stände sind eine feste Liste im Code (CHECK in der DB + `STAGES`); neuer Stand = neue Migration **und** Schema/Labels.
- Core-Aufrufe (`storage`, `audit`) liegen bewusst **außerhalb** der Modul-Transaktion (PGlite).
- Offen: Anbindung an `actions` (Teilnehmende aus Mitgliedern übernehmen) existiert nicht; Mitglieder-Import/Export fehlt.
