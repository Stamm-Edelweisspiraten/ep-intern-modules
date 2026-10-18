---
paths: ["src/lib/modules/actions/**", "tests/**/actions*", "tests/**/accounting*", "tests/**/refund*"]
---

# Modul `actions` (Aktionen)

Freizeiten/Veranstaltungen: Stammdaten, Freigabe, Teilnehmende, Kalkulation (+ Zuschuss), öffentlicher Anmeldelink,
Abrechnung (Buchungen, Belege, Auslagen, Abschluss, PDF) und Rückzahlung des Überschusses. Schema `mod_actions`,
Version 1.1.0, **hängt von `members` ab**. Alle Pfade unten relativ zu `/api/v1/modules/actions` (UI: `apiFetch('/modules/actions/…')`).
Teilnehmende sind eigene Datensätze (Name, `group_label` als Freitext); bei Anmeldung mit Mitglied zusätzlich `member_id`/`user_id` (siehe „Anmeldung mit Mitglied“).

## Dateien (`src/lib/modules/actions/`)
| Datei | Inhalt |
|---|---|
| `module.ts` / `ui.ts` | Manifest, Rechte, Einstellungen `actions.bank.*`, `actions.payment.purposeTemplate`; Routen `''`, `:id`, öffentlich `anmeldung/:token` |
| `schemas.ts` | Zod + DTO-Typen + Konstanten (`CALC_CATEGORIES`, `ACCOUNTING_CATEGORIES`, `CHECKLIST_ITEMS`, `FORM_PUBLIC_PREFIX`, `STANDARD_FORM_KEYS`) |
| `access.ts` | `resolveAccess`/`requireAccess`/`visibleActionsFilter` (Objektzugriff) |
| `actions.endpoints.ts`, `participants.endpoints.ts` | Aktionen, Freigaben, Benutzersuche, Teilnehmende |
| `calculation.ts` (rein), `calculation.endpoints.ts` | Kalkulation, Vorschläge, Beitrag übernehmen |
| `subsidy.ts` (rein) | Zuschuss/Taschengeld Richtlinie 2026 |
| `subsidy-eligibility.ts` (rein) | `effectiveSubsidyEligible`, `deriveSubsidyCounts` (EINE Klassifikation für Vorschläge und Abrechnung) |
| `auto-income.ts` (rein) | `computeAutoIncome`, `appliedAutoIncome` (automatische Einnahmen) |
| `form-support.ts` (rein), `form.endpoints.ts` | Anmeldeformular: Standardfelder, Disclaimer, Status, CSV, öffentliche Endpoints |
| `accounting.ts` (rein), `accounting-core.ts`, `accounting.endpoints.ts` | Summen/Soll-Ist/CSV/PDF-Blöcke; DB-Hilfen (`assertOpen`, `loadRefundSnapshot`); Buchungen + Belege |
| `payouts.endpoints.ts`, `iban.ts` | Empfänger, IBAN, Auszahlung, Abschluss, `report.pdf`; IBAN-Prüfung/Maske |
| `refund.ts` (rein), `refund.endpoints.ts` | Rückzahlung |
| `action-archive.ts` (rein), `export-import.endpoints.ts` | Export/Import als ZIP (Format, Zod, Limits, Pfadschutz; Endpoints) |
| `pages/` | `ActionsPage`, `ActionDetailPage` (Tabs), `ActionForm`, `CalculationTab` (+`CalcItemsEditor`, `CalcSummary`, `SubsidySection`), `RegistrationTab` (+`FormSettings`, `DisclaimerEditor`), `ParticipantForm`, `AccountingTab` (+`AccountingSummaryCards`, `EntriesTable`, `AccountingEntryDialog`, `PayeeDialog`, `PayoutsSection`, `RefundCard`, `refund-types.ts`), `PublicRegistration` |

## Datenmodell (Migrationen, nie ändern)
- **0001** `actions` (`owner_id`, `starts_on`, optionale Uhrzeiten als text), `action_shares` (PK action+user, `level` read|edit),
  `action_participants` (`role` participant|team, `juleica`, `diet`, `bremen_resident`, `answers jsonb`, `source` manual|link).
- **0002** `action_calculations` (1:1, Eckdaten, Checkliste jsonb), `calc_items` (`category`, `amount_cents` 0..100 Mio, `basis`).
- **0003** Basis `flat|per_person|per_person_night`; `team_percent`, `team_youth`; an `actions`: `fee_cents`,
  `team_fee_cents`, `fee_applied_at/by` (NULL = nicht übernommen).
- **0004** `action_forms` (1:1, `token` UNIQUE, `enabled`, `opens_at/closes_at`, `max_participants`, `definition jsonb`,
  `intro`, `disclaimer_template`, `privacy_url`); Teilnehmende: `contact_email`, `dedupe_key` + partieller UNIQUE-Index.
- **0005** `accounting_payees` (`iban_enc` verschlüsselt, `iban_last4`), `accounting_entries` (`type` income|expense,
  `category`, `amount_cents` > 0, `paid_by` club|person, `payee_id` RESTRICT, Beleg-Felder, `reimbursed_at`;
  CHECK `paid_by='person'` ⇔ `payee_id`, Einnahmen nur `club`), `action_accounting` (`closed_at/by`).
- **0006** Kategorie `refund` im CHECK, `accounting_refunds` (Einzelbeträge je Person), `action_refund_booking` (Snapshot:
  `entry_id`, `surplus_cents`, `per_head_cents`, `paying_count`, `remainder_cents`, `booked_at/by`).
- **0007** `action_refund_booking.mode` `auto|manual` (Default `auto`).
- **0009** `action_participants.subsidy_eligible boolean` (NULL = automatisch).
- **0011** Stamm-Ausgaben: `accounting_entries.recipient_name`, `recipient_iban_enc` (verschlüsselt), `recipient_iban_last4`,
  `recipient_bic`, `purpose`, `club_paid_at` (NULL = offen), `club_paid_via` `manual|treasury`. Altdaten → bezahlt (`manual`).
- **0012** `actions.is_past boolean NOT NULL DEFAULT false` („liegt bereits in der Vergangenheit“, nachträgliche Abrechnung).
  API: `isPast` in `ActionSummary` (Liste + Detail) und `ReceivableSource`; POST-Default `false`, PUT ohne Feld = unverändert
  (`actionUpdateInput`); Audit created/updated mit `isPast`; Archiv `action.isPast` optional (fehlt = false).
- **0013** `accounting_entries.reimbursed_upfront boolean NOT NULL DEFAULT false` (beim Erfassen bereits erstattet; schützt vor Doppelzahlung bei Rücknahme einer Kassen-Zahlung).
- Kein Fremdschlüssel auf Core-Tabellen (`owner_id`, `user_id`, `created_by` sind `text`).

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `actions.action.view` | Basisrecht: Modul/Liste; **alle** Endpoints verlangen es, Feinheiten über `access.ts` |
| `actions.action.create` | Aktion anlegen (Anleger*in wird Eigentümer*in) |
| `actions.action.view-all` / `edit-all` | alle Aktionen lesen / lesen+bearbeiten+teilen+Abrechnung wieder öffnen |
| `actions.action.delete` | löschen (zusätzlich nur Eigentümer*in oder `edit-all`) |
| `actions.payout.view` | IBAN im Klartext, `payouts.csv`, Empfänger anlegen/ändern, Auszahlung markieren, volle IBAN im PDF |
| `actions.storage.read/write/delete` | Core-Storage (Belege, Beleg-Anhänge im PDF brauchen `read`) |

Objektzugriff (`resolveAccess`): Eigentümer*in, `edit-all`, System → bearbeiten+teilen; Freigabe `edit` → bearbeiten;
Freigabe `read` oder `view-all` → lesen; sonst **404**. Lesende bekommen bei Schreibzugriff **403**. Teilen: nur
Eigentümer*in/`edit-all` (`canShare`). Liste: `visibleActionsFilter` (eigene + freigegebene, oder alle).

## API (Auszug, alle `actions.action.view` + Objektzugriff; Schreiben = `edit`)
| Pfad | Methode | Besonderheiten |
|---|---|---|
| `/actions`, `/actions/:id` | GET/POST(create)/PUT/DELETE | Name ≤ 150, Ende ≥ Start; Detail inkl. `fee`, `participantCount` |
| `/actions/:id/shares[/:userId]`, `/users` | GET/PUT/DELETE, GET | Freigabe `read|edit`, nicht an Eigentümer*in; `/users` = Verzeichnissuche |
| `/actions/:id/participants[/:pid]` | GET/POST/PUT/DELETE | `participants.csv` unter `/actions/:id/participants.csv` (Formel-Schutz); `participants.pdf` = Teilnehmendenliste (A4 quer, eine Zeile je Person, wählbare Spalten: `GET` = Voreinstellung „Fahrt“, `POST { selection }`; `GET /actions/:id/participants/pdf-columns` = Katalog; braucht zusätzlich `members.data.export`, Audit `actions.participants.sheet_generated` mit `count`, `columns`) |
| `/actions/:id/calculation` | GET/PUT | PUT ersetzt alle Posten (≤ 100), Checkliste nur bekannte Schlüssel |
| `/actions/:id/calculation/suggestions` | GET | Zählt Teilnehmende/Team/Bremen-Kinder/-Jugend aus der Liste, `incomplete[]`, Nächte aus Datum |
| `/actions/:id/calculation/apply` | POST/DELETE | schreibt `recommendedPerPerson`/`…Team` nach `fee_cents`/`team_fee_cents`; 400 ungespeichert, 422 bei 0 Teilnehmenden |
| `/actions/:id/form`, `…/form/rotate-token` | GET/PUT, POST | Formular-Konfiguration; Token erneuern macht alten Link ungültig |
| `/public/forms/:token` | GET | **`public: true`**, `permission: null`, Rate-Limit 60/60 s; 404 „Anmeldung nicht verfügbar“ |
| `/public/forms/:token/submit` | POST | **`public: true`**, 5 pro 600 s, Honeypot `website`, 409 bei voll/geschlossen/Duplikat |
| `/actions/:id/accounting` | GET | Buchungen, Summen (`summarize`), Soll aus Kalkulation, Empfänger, Abschlussstatus |
| `/actions/:id/accounting/entries[/:eid]` | POST/PUT/DELETE | 409 bei Kategorie `refund`, erstatteter Buchung oder Abschluss; Datum nicht zu weit in der Zukunft |
| `…/entries/:eid/receipt` | POST/GET/DELETE | multipart `file`, PDF/JPEG/PNG/WebP ≤ 10 MB, nur Ausgaben; ohne S3 503 |
| `…/accounting/payees[/:pid]` | POST/PUT/DELETE | `payout.view`; IBAN validiert (`isValidIban`), nur verschlüsselt; Löschen mit Buchungen 409; PUT ohne IBAN = unverändert |
| `…/payees/:pid/iban` | GET | Klartext, `no-store`, auditiert, `payout.view` |
| `…/payees/:pid/reimburse` | POST/DELETE | „als ausgezahlt markieren“ / zurücknehmen (setzt nur `reimbursed_at`, **keine** echte Überweisung) |
| `…/accounting/payouts.csv` | GET | `payout.view`; nur offene Auslagen; `;`, UTF-8-BOM, Format **vorläufig** |
| `…/accounting/close`, `…/reopen` | POST | Close: 409 bei Ausgaben ohne Beleg außer `acceptMissingReceipts`; Reopen nur Eigentümer*in/`edit-all` |
| `…/accounting/report.pdf` | GET | `read` genügt; Vorlage `stamm-briefkopf` (Fallback `default`) |
| `…/accounting/refund` | GET/POST/DELETE | siehe Rückzahlung |
| `/actions/:id/export` | GET | `application/zip`, `attachment`, `no-store`; Lesezugriff genügt (fremd → 404) |
| `/actions/import` | POST | `actions.action.create`; multipart `file` ≤ 200 MB; 201 `{ id, name, counts, warnings }`; 422/413/503, 403 ohne `storage.write` bei Belegen |

## Kalkulation (`calculation.ts`, `calculate`)
- Posten: Kategorien `food, lodging, lodging_extra, materials, other, travel, program`; Basis `flat` (einmalig),
  `per_person` (× Personen), `per_person_night` (× Personen × Nächte). Personen = zahlende Teilnehmende + Team.
- Gewicht = Teilnehmende + Team × `teamPercent`/100 (Team zahlt X %, Rest auf Teilnehmende umgelegt; 0–100 %).
- **Programm**: Pro-Kopf-Preis wird auf volle Euro **aufgerundet** (`ceilDiv`), Gesamt = Kopfpreis × Gewicht (kann Rohsumme überschreiten).
- Puffer: % auf Zwischensumme (`Math.round`); Zuschuss (nur `includeSubsidy`) wird gedeckelt auf Gesamt; Netto ≥ 0.
- Empfohlener Beitrag je Person: `ceil(Netto/Gewicht)` auf volle Euro; Team-Beitrag = empfohlener × Team-% auf volle Euro aufgerundet.
- Negative/NaN/Infinity → 0, alles Integer-Cent; `nightsBetween(startsOn, endsOn)` → `null` ohne Enddatum.
- Default: 10 Teilnehmende, 3 Nächte, Puffer 5 %, Teamer 0, extern, `kids`.

## Zuschuss (`subsidy.ts`, `SUBSIDY_RATES_2026`, `computeSubsidy`)
- Quelle: Richtlinien Freizeitzuschüsse Bremische Evangelische Kirche, Stand 01.01.2026; **jährlich prüfen, vor Produktivbetrieb gegen Original abgleichen**.
- Cent je Person und Nacht: extern Kinder 13 €, Jugend 14 €; ab 4 Nächten ohne Konfi 15 €/16 €; Gemeinderäume 3 €/4 € erst ab 3 Nächten; max. 14 Nächte.
- Nur Teilnehmende aus Bremen/Bremerhaven; Kinder 0–11, Jugend 12–27 **inkl. Teamer*innen 12–27** (`teamYouth`).
- Taschengeld Ehrenamtliche: mit Juleica 15 €, ohne 10 € je Nacht; Limit 1 je 5 Kinder (`kids`) bzw. 1 je 7 Jugendliche (`youth`).
- Warnungen als Texte im Ergebnis; Förder-Checkliste = `CHECKLIST_ITEMS` (5 Punkte, Autosave).

## Zuschussberechtigung je Person (Migr. 0009)
- `subsidy_eligible`: `true` = berechtigt, `false` = nie, `NULL` = automatisch. DTO: `subsidyEligible` (Override) + `subsidyEffective`.
- Effektiv (`effectiveSubsidyEligible(p, startsOn)`): `false` → nein; Alter zum Aktionsstart unbekannt oder nicht 0–27 → nein;
  `true` → ja (Wohnort egal); `NULL` → nur `bremen_resident = true`. Override `true` ohne Geburtsdatum zählt also nicht.
- `deriveSubsidyCounts` → Kinder 0–11, Jugend 12–27, `teamYouth` (Team 12–27, effektiv berechtigt). Taschengeld-Kontingent
  (`teamWithJuleica`/`WithoutJuleica`): Team ≤ 27 unabhängig vom Wohnort, außer ausdrücklich `false`.
  `incomplete[]`: fehlendes Geburtsdatum (außer bei `false`), fehlender Wohnort (nur ohne Override).
- PUT/POST `subsidyEligible?: boolean|null`: fehlt das Feld, bleibt der Wert beim PUT unverändert; `null` setzt auf automatisch. Audit unverändert (ohne Personendaten).

## Automatische Einnahmen (`auto-income.ts`, `loadAutoIncome` in `accounting-core.ts`)
- `GET …/accounting` liefert `autoIncome: { contributions, subsidy, overridden }`; `summary.incomeCents`/`byCategory.actual`/Saldo
  enthalten die Automatik. Wird live berechnet (kein Snapshot, kein Einfluss auf Abschluss).
- Beiträge = Teilnehmende (Rolle participant) × `fee_cents` + Team × `team_fee_cents`; nur wenn `fee_cents` gesetzt.
- Zuschuss = `computeSubsidy` mit Nächten/Unterkunft/Konfi/Freizeittyp der gespeicherten Kalkulation und den aus der Liste
  abgeleiteten Zahlen (nicht den manuellen Zählern); nur bei `include_subsidy`. Taschengeld ist **keine** Einnahme.
- **Manuell überschreibt Automatik**: existiert mindestens eine manuelle Einnahme der Kategorie `contributions`/`subsidy`,
  steht die Kategorie in `overridden` und die Automatik zählt dort nicht (Werte bleiben im DTO für die Anzeige).
- Rückzahlung (`refund.endpoints.ts`): Überschuss enthält die angewendete Automatik. PDF: Zeile „Automatisch aus Anmeldungen
  (n × x € + m × y €)“ bzw. „Zuschuss laut Kalkulation (n berechtigte Personen)“ in den Einnahme-Gruppen; Anlagenverzeichnis unverändert.
- Fallstrick: Automatik hat kein Datum/keinen Beleg und ist nicht als Buchung vorhanden (nicht editier-/löschbar).

## Kasse (optionale Abhängigkeit `treasury`)
- `manifest.optionalDependencies: ['treasury']`; `actions` stellt `actionsService` bereit (`contract.ts`: `listReceivableSources`,
  `listActionRefs` – ohne Objektrechte, der Aufrufer prüft).
- **Zahlstand in der Teilnehmerliste**: `GET /actions/:id/participants` hängt bei aktiver Kasse `payment` an
  (`TreasuryService.participantPayments`, nach der Transaktion; `null` = keine Rechnung, Feld fehlt = Kasse aus).
  UI: Spalte „Beitrag“ (`PaymentCell`: Bezahlt / Teilweise / Offen / Überfällig / Erlassen, Link zur Rechnung mit
  `treasury.cash.view`) und Zusammenfassung „Beiträge: x von y bezahlt · … offen“.
- Weitere Vertragsfunktionen für die Kasse: `listClubExpenses`, `getClubExpenseIban`, `markClubExpensePaid`,
  `getClosedAccounting` (Detail abgeschlossener Abrechnungen, nutzt `loadState` aus `accounting.endpoints.ts`).
- `loadTreasuryContributions(actionId)` (VOR der Transaktion) → an `loadAutoIncome(…, treasury)` / `loadRefund(…, treasury)`:
  Führt die Kasse Rechnungen zur Aktion, zählen bei Teilnehmerbeiträgen die **eingegangenen Zahlungen**
  (`contributions.source = 'treasury'`, dazu `dueCents`, `openCents`, `invoiceCount`); sonst wie bisher n × Beitrag.

## Anmeldung mit Mitglied (Migration 0010, `dependencies: ['members']`)
- `actions` hängt hart von `members` ab (Aktivieren nur mit aktivem `members`, `members` nicht deaktivierbar). Zugriff auf Mitgliedsdaten **nur** über `core.modules.use<MembersService>('members','actions')`
  (`form.endpoints.ts` `membersService()`), außerhalb von Modul-Transaktionen.
- `action_forms.require_login` („Anmeldung erzwingen“, Schalter in `FormSettings`), `action_participants.member_id`/`user_id` + UNIQUE `(action_id, member_id)`.
- Formularfeld-Bindung `memberKey` (Formular-Bibliothek): Standardfelder Ernährung→`ernaehrung`, Allergien→`allergien` (`MEMBER_KEY_BY_STANDARD`); weitere per „Mitgliedsfeld hinzufügen“ (Schlüssel `mf_<key>`, `GET /actions/:id/form/member-fields`).
- Öffentlich: `GET /public/forms/:token` liefert `requireLogin`, `viewer`, `members[]` (nur mit Session; `id`, `name`, `registered`, `prefill`). `POST …/submit` nimmt optional `memberId`:
  `requireLogin` ohne Konto → 401, ohne `memberId` → 422, `memberId` ohne Konto 401, nicht verknüpft → 404, doppelt → 409.
  Mit Mitglied setzt der **Server** Name, Gruppen (Namen), Geburtsdatum, Bremen (`isBremenCity`), E-Mail (Mitglied, sonst Konto) und `juleica` (Zusatzfeld); Stammdatenfelder (`IDENTITY_KEYS`) werden nicht
  abgefragt (Client-Werte dafür → 422). Nach dem Speichern werden `memberKey`-Werte **ans Mitglied zurückgeschrieben** (`memberUpdated`; Fehler bricht die Anmeldung nicht ab).
- UI `PublicRegistration`: Login-Karte mit `redirectTo`, Mitgliedsauswahl (bei Erzwingen Pflicht, sonst „Andere Person“), Stammdatenfelder ausgeblendet, Gesundheitsfelder vorausgefüllt.

## Anmeldeformular
- Bibliothek `src/lib/forms/` (Typen, Feldtyp-Registry, `validateFormValues`); Komponenten `src/lib/components/forms/`.
- Standardfelder gesperrt (`locked`), Schlüssel `STANDARD_FORM_KEYS` (name, group, birthDate, bremenResident, diet,
  allergies, notes, email, privacy, disclaimer); zusätzliche Felder landen in `answers`. `mergeStandardFields` hält sie stabil.
- Status `computeFormStatus`: `closed` (aus/abgelaufen), `not_open`, `full`, `open`. Plätze + Duplikate unter `FOR UPDATE`.
- Duplikat = gleicher normalisierter Name + Geburtsdatum (`dedupe_key`, 409). Eingang → Teilnehmende*r `source='link'`.
- Disclaimer aus Vorlage mit Platzhaltern (`renderDisclaimer`, Beitrag, Kontodaten aus Settings); Datenschutz = externer Link + Pflicht-Checkbox.
- Bestätigungs-Mail über `core.mail.send` nach der Transaktion (Fehler ≠ Fehlschlag); Audit mit Akteur `system`/`public-form`.
- Öffentliche Seite `/p/actions/anmeldung/<token>`; Link kopieren/erneuern im Tab „Anmeldung“.

## Ausgaben „bezahlt vom Stamm“ (Migration 0011, 2026-10-16)
- Ausgabe + `paidBy='club'`: `clubPaid` (API-Default **true** = bezahlt; die UI startet mit **offen**). Offen ⇒ Pflicht
  Empfänger, IBAN (`isValidIban`), Verwendungszweck (≤ 140); BIC optional. PUT ohne `iban` behält die gespeicherte IBAN.
- Offene Stamm-Ausgaben werden **sofort** Auszahlung in der Kasse (`expense:<aktion>:<buchung>`); bezahlt die Kasse vollständig,
  setzt `markClubExpensePaid` `club_paid_via='treasury'` (auch bei abgeschlossener Abrechnung) – dann PUT/DELETE 409.
  Zahlung in der Kasse gelöscht → wieder offen. „Bereits bezahlt“ nachträglich → Kassen-Auszahlung wird automatisch storniert.
- IBAN-Klartext: `GET …/entries/:eid/iban` (`payout.view`, auditiert). DTO: `recipient {name, ibanMasked, bic}`, `purpose`,
  `clubPaidAt`, `clubPaidVia`; `summary.openClubPayments {count, cents}` (Hinweis im Abschluss-Dialog, blockiert nicht).
- PDF: „Stamm (offen)“. Export/Import: `entries[].transfer` (`recipientName`, `iban` nur mit `payout.view`, `bic`,
  `purpose`, `paidAt`); fehlt `transfer` (alte Archive) → bezahlt. Kategorie `refund` ist nie eine Stamm-Ausgabe in diesem Sinn.
- **Auslage „bereits erstattet“** (Migration 0013 `reimbursed_upfront`): `entryInput.reimbursed` (Default false), nur Ausgabe + `paidBy='person'` (sonst 422, Pfad `reimbursed`);
  POST setzt `reimbursed_at = now()` **und** `reimbursed_upfront = true` (offen 0 ⇒ keine Auszahlung in Kasse/payouts.csv). **PUT mit `reimbursed:true` auf offener Auslage → 422**
  („Die Erstattung kann nur beim Anlegen gesetzt werden“, Pfad `reimbursed`); `false`/fehlend wirkungslos; geschlossene Abrechnung → 409 (`assertOpen` zuerst).
  PUT/DELETE auf erstattete Einträge 409. `markReimbursed(…, true)` (Kasse zahlt) setzt nur nicht erstattete; `markReimbursed(…, false)` (Kassen-Zahlung gelöscht)
  setzt **nur** `reimbursed_upfront = false`-Einträge zurück (vorab erstattete bleiben erstattet, sonst Doppelzahlung). `DELETE …/payees/:pid/reimburse` ist die
  ausdrückliche Rücknahme der ganzen Person (`reimbursed_at = NULL` + `reimbursed_upfront = false`, danach editierbar). Archiv: `entries[].reimbursedUpfront` optional (fehlt = false,
  nur mit `reimbursedAt`). Audit `entry_created.reimbursed` (Boolean). UI: erstattete Auslage im Dialog komplett gesperrt, Zeilenmenü „Ansehen“ ohne „Löschen“.
- **Auslagen** (bezahlt von Person) gibt `listReimbursements` nur aus **abgeschlossenen** Abrechnungen an die Kasse.

## Abrechnung (`accounting.ts`)
- Kategorien: Ausgaben = `CALC_CATEGORIES`; Einnahmen `contributions` (Teilnehmerbeiträge), `subsidy`, `misc`; `refund`
  nur über Rückzahlungsfunktion (Entry-Schema → 422, PUT/DELETE → 409). `summarize` liefert Soll/Ist, fehlende Belege
  (Ausgaben ohne Beleg, `refund` ausgenommen), offene Auslagen.
- Empfänger: IBAN `core.crypto.forModule('actions')`; Liste zeigt nur Maske (`maskFromLast`), Klartext nur mit `payout.view`.
- Abschluss sperrt alle Änderungen (`assertOpen` → 409); Reopen nur Eigentümer*in/`edit-all`.
- **PDF-Bericht** (`buildReportBlocks` → `core.pdf.generate`, Vorlage `stamm-briefkopf`): Gitter-Tabellen (`variant:'grid'`)
  je Einnahme-Gruppe/Ausgabe-Kategorie; **Beleg-Nummern** (`numberExpenses`: Kategorie-Reihenfolge, Datum, Erfassung, id;
  Einnahmen und `refund` ohne Nummer, „(fehlt)“ ohne Beleg); Seitenumbruch, Abschlussseite (Ergebnis **vor** Rückzahlung,
  Soll/Ist, Erstattungen mit Bankdaten, Rückzahlung, „Buchungsanweisung für die Kasse“, Anlagenverzeichnis).
  Belege als Anhang (`attachments`, PDF/Bild, max. 80 Stück/50 MB, Reihenfolge = Nummer, nur mit `actions.storage.read`;
  nicht anhängbare → Hinweis). Bankdaten im Bericht nur mit `payout.view`, sonst maskiert.

## Rückzahlung des Überschusses (`refund.ts`, `refund.endpoints.ts`, Migr. 0006/0007)
- Überschuss = Einnahmen − Ausgaben **ohne** `refund`. Rückzahlung bucht eine Ausgabe `refund` (club) + Snapshot.
- **auto**: `computeRefund` je Person anteilig am Beitrag (`fee_cents`, Team `team_fee_cents`; ohne Beitrag zahlt nicht),
  je Betrag **abgerundet auf ganze Euro**, Rest bleibt in der Stammkasse; bei gleichen Beiträgen gleicher Betrag.
- **manual**: Nutzer gibt die **Namen** der Berechtigten an (1–300, je 1–80 Zeichen, getrimmt, keine Steuerzeichen, Duplikate erlaubt);
  Anzahl = Namen, `computeManualRefund` = `floor(Überschuss / Anzahl / 100) × 100` je Person; Reihenfolge bleibt (`accounting_refunds.position`).
- Schwelle `refundThresholdOk`: nur wenn je Person **> 5 €** (`MIN_REFUND_PER_HEAD_CENTS = 500`).
- API: `GET …/refund?count=` (reine Vorschau 1–1000, `items: []`), `POST` Body `{ names?: string[] }` strict (ohne `names` = auto;
  `{count}` → 422), Snapshot mit `mode`, `count`, `perHeadCents`, `items` (manuell: Namen mit neuer UUID als `participantId`);
  Buchungstext `Rückzahlung an Teilnehmende (<n> × <euro> €)`; `DELETE` nimmt zurück (Buchung, Einzelbeträge, Snapshot).
  Migrationen 0006 (Refund), 0007 (`mode`), 0008 (`position`). Schwelle nicht erfüllt = 409 auf POST. Audit ohne Namen (`count`, `totalCents`).
- PDF-Bericht: in beiden Modi dieselbe Namensliste (Teilnehmende*r | Betrag), keine Zeile „n Personen × x €“.
- UI: kleine Karte `RefundCard` + Dialog `RefundDialog` (Modus „Nach Teilnehmerliste“/„Namen selbst eintragen“).
- Hinweis „Rückzahlung erfolgt erst, sobald alle Zahlungen einschließlich der Zuschüsse eingegangen sind“ **nur im PDF-Bericht**.
- Blocker (`blockers[]`): bereits gebucht, abgeschlossen, kein Überschuss, kein Beitrag, keine Zahlenden, zu geringer Betrag.
- „Zahlung an Personen“ = nur Markierung „als ausgezahlt“ (kein Zahlungsverkehr, kein SEPA).

## Export/Import (`action-archive.ts`, `export-import.endpoints.ts`)
- **ZIP** (Bibliothek `fflate`, rein JS): `manifest.json` (`format: 'ep-intern-action'`, `formatVersion: 1`, `exportedAt`,
  `contents{participants,entries,receipts,payees,includesBank}`, optional `receiptsOmitted`/`receiptsMissing`), `action.json`,
  `receipts/<exportId>-<bereinigter-name>`. `action.json` ist **strikt** (Zod, `archiveDocumentSchema`): Aktion inkl. Beitrag,
  Kalkulation + Posten, Teilnehmende (inkl. `subsidyEligible`, `answers`, Einwilligung), Anmeldeformular **ohne Token**,
  Empfänger, Buchungen (Referenzen über Export-IDs `p1…`, `y1…`, `e1…` nach Reihenfolge), Rückzahlungs-Snapshot, Abschlussstatus.
- **Nicht** exportiert: Freigaben/Benutzer-IDs, Besitzer*in, Audit, API-Daten, Token. IBAN im Klartext nur mit
  `actions.payout.view` (`includesBank`), Belege nur mit `actions.storage.read` und erreichbarem Storage (sonst
  `receiptsOmitted`, Buchung ohne Beleg). Export wird auditiert (`actions.action.exported`, nur Zähler + `withBank`).
- **Import** legt **immer eine neue Aktion** an (neue UUIDs, Besitzer*in = Importierende*r, neue Zeitstempel für
  `created_at`; `reimbursedAt`, `closedAt`, `bookedAt` bleiben als Fachdaten erhalten). Formular `enabled=false` + neuer Token.
  Abgeschlossene Abrechnung bleibt abgeschlossen. IBAN: geprüft (`isValidIban`) + `core.crypto` verschlüsselt; ungültig oder
  ohne `payout.view` → Warnung, Empfänger ohne IBAN. Ablauf: parsen/validieren → Belege hochladen → **eine** DB-Transaktion →
  bei Fehler hochgeladene Belege best-effort löschen → Audit (`actions.action.imported`).
- **Grenzen** (`action-archive.ts`): Archiv ≤ 200 MB, ≤ 2000 Einträge, entpackt ≤ 300 MB (Header-Prüfung im fflate-`filter`
  vor dem Entpacken), Beleg ≤ 10 MB, JSON ≤ 20 MB. Erlaubte Pfade nur `manifest.json`, `action.json`, `receipts/<name>`;
  absolute/`..`/doppelte/unbekannte Einträge → 422. Belegtyp per **Magic Bytes** (PDF/PNG/JPEG/WebP); Storage-Pfad wird
  immer neu gebaut (`<actionId>/<entryId>-<uuid>-<name>`), nie aus Archivnamen.
- **Round-Trip**: Export → Import → Export liefert dieselbe `action.json` (Test); dafür werden `created_at` beim Import
  in Reihenfolge gesetzt (Sortierung `created_at, name, id`) und Export-IDs nach Index vergeben.
- Fallstrick: `BODY_SIZE_LIMIT` im Dockerfile ist 55 MB – für Importe bis 200 MB muss es (und ein Proxy-Limit) erhöht werden.

## UI
Seite Liste (`DataTable`, Suche) → Detail mit Kopf (Freigabe-Menü `ShareMenu`) und Tabs: Übersicht, Kalkulation,
Anmeldung, Teilnehmende (n), Abrechnung. Abrechnung: Summenkarten, Buchungstabelle, Dialoge (Buchung, Empfänger),
`PayoutsSection`, `RefundCard` (Vorschau, manuelle Namensliste, Buchen/Zurücknehmen), Abschluss, PDF/CSV.

## Audit
`actions.action.created|updated|deleted|shared|unshared`, `actions.participant.created|updated|deleted`,
`actions.participants.exported`, `actions.action.exported|imported`, `actions.calculation.updated`, `actions.fee.applied|cleared`,
`actions.form.updated|token_rotated`, `actions.registration.submitted` (Akteur `public-form`),
`actions.accounting.entry_created|entry_updated|entry_deleted|receipt_uploaded|receipt_deleted|payee_created|payee_updated|payee_deleted|iban_viewed|reimbursed|reimbursement_reverted|exported|closed|reopened|report|refund_booked|refund_reverted`.
Metadata nur IDs/Zähler/Beträge – keine IBAN, keine Namen aus der Rückzahlung (Test prüft das).

## Tests
Integration: `actions.test.ts` (Zugriffsmatrix), `actions-calculation`, `actions-form` (+`public-endpoints.test.ts`),
`actions-accounting`, `actions-payouts` (Empfänger, Auszahlung, Abschluss, PDF), `actions-refund`, `actions-export-import`, `actions-past` (isPast, vorab erstattete Auslagen), `actions-past-fixes` (Rücknahme durch die Kasse, PUT-422, Archiv).
Unit: `action-archive`, `calculation`, `subsidy`, `accounting`, `accounting-report`, `refund`, `iban`, `actions-form-support`, `forms-*`,
`pdf-attachments`, `pdf-letterhead`. Helfer: `tests/helpers/fake-storage.ts`, `setPdfRendererForTests`.

## Entscheidungen des Nutzers und Fallen
- Siehe `project-state.md`: Programm aufrunden, Puffer %, Team-%, Zuschuss inkl. Teamer*innen, Freigabe im Menü, Doppelanmeldung ablehnen, Bestätigungs-Mail.
- Rückzahlung: ganze Euro abrunden, > 5 € je Person, Hinweis nur im PDF, Zahlung = Markieren.
- Core-Services (`storage`, `crypto`, `audit`, `pdf`, `mail`) **außerhalb** der Modul-Transaktion (PGlite hängt sonst).
- IBAN/Namen nie in Audit-`metadata`; `payouts.csv` Format vorläufig (ggf. SEPA-XML).
- Zahlungseingänge je Teilnehmende*r: Modul `treasury` (siehe `rules/module-treasury.md`). Offen: Auszahlungsformat, `docs/` um `actions` ergänzen.

## Teilnehmendenliste als PDF (`participants-sheet.endpoints.ts`)
- Katalog = Mitglieder-Katalog (`members/sheet-columns.ts`) + Aktionsspalten `role` (direkt hinter `name`), `fee`, `juleica`, `notes` (sensibel); Voreinstellungen `fahrt`/`gesundheit` zeigen zusätzlich `notes`.
  Felddefinitionen über `core.modules.use('members')` (`listFieldDefinitions`), **nie** in der Modul-Transaktion.
- Zeile: ohne Mitglied aus `action_participants` (Gruppe = `group_label`, Alter, E-Mail, `diet` → Ernährung, `allergies` → Allergien); mit `member_id` aus `listMemberSheets` (Notfall-Telefon, Zusatzfelder), Ernährung/Allergien/E-Mail aus beiden zusammengeführt.
  `fee` = `fee_cents` bzw. `team_fee_cents` (Team), `notes` = Hinweise + Antworten des Anmeldeformulars (ohne `mf_*` bei Mitglied). Abschnitte „Teilnehmende“ und „Team“ (neue Seite).
- Reihenfolge der Prüfung: Zugriff (`requireAccess read`, fremde Aktion 404) → `members.data.export` (403). POST-Body `{ selection? }` strikt (`listSelectionInput` aus `members/schemas.ts`), leere/zu lange Auswahl 422.
