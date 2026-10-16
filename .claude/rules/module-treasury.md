---
paths: ["src/lib/modules/treasury/**", "tests/**/treasury*", "scripts/seed-demo-treasury.mjs"]
---

# Modul `treasury` (Kasse)

Digitale Kassenführung: Konten (Giro, Bar, …) mit Buchungen und Umbuchungen, Rechnungen (automatisch aus
Aktionen oder manuell), Zuordnung von Zahlungen zu Posten (auch **Sammelzahlungen für Geschwister**), Zahler
(Familien), CSV-Import mit Zuordnungsvorschlägen, Zahlungsbestätigungen und automatische Erinnerungen per Mail,
Kontolage und Zeitraumberichte (PDF/CSV). Schema `mod_treasury`, Version 1.0.0, **hängt von `members` und `actions` ab**.
Pfade unten relativ zu `/api/v1/modules/treasury` (UI: `apiFetch('/modules/treasury/…')`).

## Entscheidungen des Nutzers (2026-10-16, nicht ungefragt ändern)
Mehrere Konten + Umbuchungen · Erfassung manuell **und** CSV-Import mit Vorschlägen (nie automatisch buchen) ·
Kassen-Zahlungen ersetzen in der Aktions-Abrechnung die berechneten Beiträge (**Ist statt Soll**) · Erinnerungen
automatisch, zweistufig (täglicher Job) · Zahler + freie Aufteilung einer Buchung · Forderungen entstehen
**automatisch**, sobald an einer Aktion ein Beitrag übernommen ist · Mails an **alle E-Mail-Adressen der Mitglieder**
der Posten (dazu Rechnungs- und Zahler-Adresse; Fallback Kontakt-E-Mail der Anmeldung) · Berichte für frei
wählbare Zeiträume, **keine Jahressperre**.

**Ausbaustufe 2 (2026-10-16):** Standardkonto (Vorbelegung überall) · Einstellungen als Seite „Kasse“ unter
**Administration** (`/modules/treasury/settings`, Nav-Eintrag `admin: true`) · Zahler mit **Bankverbindung** (IBAN verschlüsselt,
HMAC für den Import-Abgleich) · **Auszahlungen** (ausstehende Überweisungen: Eingangsrechnungen, Auslagen aus Abrechnungen,
Rückzahlungen, Guthaben) · **Rechnungs-PDF bei Anmeldung** als Anhang der Anmeldebestätigung, Fassungen mit automatischem
Versand bei Änderung/Storno · Offene Posten als **eine** aufklappbare Tabelle.

## Dateien (`src/lib/modules/treasury/`)
| Datei | Inhalt |
|---|---|
| `module.ts` / `ui.ts` | Manifest, Rechte, Einstellungen `treasury.*`, Jobs `sync` (stündlich) + `reminders` (täglich), `provides`; Routen `''`, `invoices/:id` |
| `schemas.ts` | Zod + DTO-Typen + Konstanten (`DEFAULT_CATEGORIES`, `SETTING_KEYS`, Mail-Standardtexte, `MAIL_PLACEHOLDERS`) |
| `logic.ts` (rein) | Status/Summen, `distribute`, `computeDueOn`, `reminderLevelDue`, `matchMember`, `planSync`, `suggestPayers`, `suggestMatch`, Mail-Variablen, CSV-Export |
| `csv-import.ts` (rein) | CSV-Parser, `guessMapping` (Sparkasse CSV-CAMT u. a.), Betrag/Datum, Duplikat-Schlüssel |
| `db.ts` | Tx-Helfer, `today()` (Europe/Berlin, `setTreasuryTodayForTests`), Loader für Konten/Buchungen/Rechnungen, `resolveNames` (Dienste members/actions), `NEEDS_ALLOCATION_SQL`, `nextInvoiceNumber` |
| `sync.ts` | Abgleich Aktionen → Rechnungen (`syncActions`, `syncIfStale` max. 1×/min) |
| `allocation.ts` | `replaceAllocations` (Prüfungen, ergänzt Kategorie/Aktion), `loadMatchLines` |
| `notify.ts` | `notifyPaid`, `runReminderJob`, `sendManualReminders`, `loadBankData` |
| `service.ts` / `contract.ts` | `TreasuryService.contributionsForAction`, `invoiceForRegistration` für `actions` |
| `documents.ts` | Rechnungs-Snapshot, PDF aus Snapshot, Fassungen (`invoice_documents`), `sendDocuments`, `refreshSentDocuments` |
| `payables.ts` | Auszahlungen: `syncPayables` (Quellen aus `actions` + Guthaben), Endpoints, Rückkanal `syncReimbursementStatus` |
| `bank.ts`, `iban.ts` | IBAN verschlüsseln/HMAC (`core.crypto.forModule('treasury').hash`), Prüfung, Maske `•••• 1234` |
| `*.endpoints.ts` | `accounts`, `transactions`, `invoices` (inkl. Zahler, offene Posten, Aktionen), `import`, `reports` |
| `pages/` | `TreasuryPage` (Tabs Übersicht · Offene Posten · Auszahlungen · Buchungen · Rechnungen · Berichte; „Zahler & Familien“ als Seitenpanel im „Mehr“-Menü, `?tab=payers` öffnet es), `InvoicePage`, Dialoge (`TransactionDialog`, `AllocateDialog`, `InvoiceDialog`, `MarkPaidDialog`, `LineDialog`, `PayerDialog`, `AccountDialog`, `TransferDialog`, `ImportDialog`, `SuggestionsDialog`), `helpers.ts` |

## Datenmodell (Migration 0001)
- `accounts` (kind giro|cash|other, `iban` Klartext – eigenes Vereinskonto, Anfangsbestand + Stichtag, `archived_at`).
- `categories` (feste Standard-IDs `cat-…`, `built_in`, archivierbar; `cat-beitraege` = Teilnehmerbeiträge).
- `transactions` (Betrag **mit Vorzeichen**, ≠ 0; `transfer_id` verbindet beide Seiten einer Umbuchung; `import_hash`
  UNIQUE je Konto; Beleg-Felder; `action_id`/`category_id` optional).
- `payers` + `payer_members` (ein Mitglied gehört höchstens zu **einem** Zahler).
- `invoices` (`R-JJJJ-NNNN`, `year`+`seq` UNIQUE, Vergabe unter `pg_advisory_xact_lock`; `source` manual|action; `auto_cancelled`;
  `paid_notified_at` = Bestätigung erledigt; `reminders_paused`), `invoice_lines` (`waived_cents` ≤ Betrag, `source_ref`
  UNIQUE `action:<aktion>:<teilnehmende>`, `member_id`, `participant_id`, `action_id`), `allocations` (Buchung ↔ Posten, > 0,
  UNIQUE je Paar), `reminders` (`level`, `sent_on` = fachliches Datum), `action_settings` (ausschließen, feste Fälligkeit),
  `import_batches`, `sync_state`.

## Regeln
- **Status** (`invoiceTotals`): Soll = Σ(Betrag − Ermäßigung); offen = Σ max(0, Soll − bezahlt); `paid` bei offen 0 (auch
  vollständiger Erlass), `partial`, `open`, `cancelled`. Storniert schuldet nichts – Bezahltes wird **Guthaben**; Überzahlung ebenso.
- **Zuordnung** (`PUT /transactions/:id/allocations`, ersetzt alle): nur Einnahmen ohne Umbuchung; Summe ≤ Buchung; je Posten
  nie mehr als offen (422); stornierte Rechnungen 409. Fehlende Kategorie → „Teilnehmerbeiträge“, wenn alle Posten aus Aktionen;
  fehlende Aktion → die eine Aktion der Posten. Buchung ändern unter zugeordnetem Betrag → 409; löschen hebt Zuordnung auf.
- **„Braucht Zuordnung“** (`needsAllocation`, Filter `unassigned`, Vorschläge, Übersicht): Einnahme ohne Kategorie oder mit
  `cat-beitraege`, keine Umbuchung, Rest offen. Spenden/Zuschüsse erscheinen dort nicht.
- **Abgleich** (`planSync`): je Teilnehmende*r mit Beitrag > 0 (Team: `team_fee_cents`) eine Rechnung; Mitglied über
  `member_id` bzw. eindeutigen Namen + Geburtsdatum (Umlaute egal). Betrag/Text geändert → Update (Ermäßigung gekappt);
  entfallen/ausgeschlossen → automatisch storniert; wieder da → reaktiviert (nur automatisch stornierte). Fälligkeit
  `max(Start − daysBeforeStart, heute + minDays)` bzw. feste Fälligkeit der Aktion. Läuft stündlich, beim Öffnen der Seiten und per `POST /sync`.
- **Vorschläge** (`suggestMatch`): Rechnungsnummer im Zweck (`R-2026-0001`, `R 2026-1`) → Vor- **und** Nachname (Müller = Mueller)
  inkl. Geschwister derselben Gruppe (Zahler bzw. Nachname) → Thema (Aktions-/Postenname) im Zweck grenzt ein → Nachname der
  Gegenpartei → nur Betrag (niedrig). Sicherheit `high|medium|low`; übernommen wird nur per Klick.
- **Mails**: Bestätigung einmalig, sobald eine Rechnung vollständig bezahlt ist (je Adresse **eine** Mail mit allen Posten);
  `notify:false` markiert ohne Versand. Erinnerung Stufe 1 ab `firstDays` nach Fälligkeit, Stufe 2 frühestens `secondDays`
  nach Stufe 1, danach nur manuell (`POST /invoices/:id/remind`, nächste Stufe). Ohne Adresse/SMTP: kein Reminder-Eintrag.
  Platzhalter `{name} {posten} {summe} {rechnungen} {faellig} {kontodaten} {verwendungszweck} {stufe} {zahlung}`; Kontodaten
  nur `treasury.bank.*` (seit Ausbaustufe 3).
- **Ist statt Soll in `actions`**: `actions` führt `treasury` als `optionalDependencies`; `loadTreasuryContributions` (VOR der
  Transaktion) → `computeAutoIncome({ treasury })`: `contributions.cents` = eingegangene Zahlungen, `source:'treasury'`,
  `dueCents/openCents/invoiceCount`. Manuelle `contributions`-Buchungen überschreiben weiterhin. Kasse aus → wieder Soll.
- **Import**: CSV ≤ 5 MB, ≤ 5000 Zeilen, UTF-8 oder Windows-1252, Trennzeichen erkannt; Duplikat = SHA-256 aus Konto + Datum +
  Betrag + Gegenpartei + Zweck + laufender Nummer gleicher Zeilen (Neu-Import derselben Datei → alles „vorhanden“).

## Ausbaustufe 2 – Regeln (Migration 0002)
- **Standardkonto**: `accounts.is_default` (partieller UNIQUE), erstes Konto automatisch, `PUT /accounts/:id/default`;
  Standardkonto nicht archivierbar (409). Dialoge nutzen `defaultAccountId()` (`pages/helpers.ts`).
- **Zahler-Bankdaten**: `account_holder`, `iban_enc`, `iban_last4`, `iban_hash`, `bic`; Klartext `GET /payers/:id/iban`
  (`treasury.bank.view`, `no-store`, auditiert). Import: Spalte `iban` (Sparkasse „Kontonummer/IBAN“) → `transactions.counterparty_iban_hash/_last4`
  (kein Klartext); `suggestMatch({ payerId })` bevorzugt die Familie mit dieser IBAN.
- **Auszahlungen** (`payables`, `payable_payments`): Quellen `manual` (Eingangsrechnung, IBAN verschlüsselt, Beleg),
  `reimbursement` (`ActionsService.listReimbursements`; Betrag = in der Kasse gezahlt + in der Abrechnung offen),
  `refund` (`listRefundItems`, IBAN über Mitglied → Zahler), `credit` (Guthaben aus Rechnungen). Abgleich in `syncActions`;
  bezahlte nie storniert, Betrag nie unter Gezahltes. `POST /payables/:id/pay` bucht eine Ausgabe; Auslagen werden danach in
  der Abrechnung als ausgezahlt markiert (`markReimbursed`, auch bei abgeschlossener Abrechnung), beim Löschen der Zahlung
  zurückgenommen. `PUT /transactions/:id/payable` ordnet Import-Ausgaben zu. `payables.csv` = Überweisungsliste (IBAN nur mit `bank.view`).
- **Rechnungsdokumente** (`invoice_documents`, PDF deterministisch aus `snapshot`): Anmeldung über Link → `invoiceForRegistration`
  (Abgleich + Fassung 1) → PDF hängt an der Anmeldebestätigung (`core.mail.send({ attachments })`). Ändern sich Betrag,
  Posten, Ermäßigung, Frist oder Storno einer **bereits versendeten** Rechnung, verschickt `refreshSentDocuments` (im Abgleich und
  nach Bearbeitung) automatisch „Geänderte Rechnung“ bzw. „Stornierung“ mit neuer Fassung an `invoiceAddresses`. Vorlage
  `treasury.mail.invoiceSubject/Body` (Platzhalter zusätzlich `{anlass}`, `{aenderung}`). Manuell: `POST /invoices/:id/send`.
- Neue Rechte: `treasury.bank.view`, `treasury.payable.edit`.

## Ausbaustufe 3 – Regeln (2026-10-16, Migration 0003)
- **Bankdaten nur aus den Kassen-Einstellungen** (`treasury.bank.*`, `loadBankData`/`TreasuryService.bankData()`), kein Rückgriff
  auf `actions.bank`. Bei aktiver Kasse nutzt auch die Anmeldebestätigung von `actions` diese Daten. Fehlen sie, steht „bei der
  Kasse erfragen“ und die Übersicht warnt (`Overview.bankMissing`).
- **Mails** (`mail-html.ts`, `mail-compose.ts` `composeMail`, Modus `paid|open`): HTML mit Postentabelle und Zahlungskasten
  (Empfänger, IBAN, Betrag, Frist, Verwendungszweck); Platzhalter `{posten}`/`{zahlung}` werden als HTML-Block ersetzt. Neue
  Standardtexte greifen nur, wenn nichts gespeichert ist.
- **Rechnungs-PDF** (`documents.ts`): Eckdaten-Zeile, Postentabelle, Zahlungsblock mit **GiroCode** (`epcPayload` in `logic.ts`,
  `core.qr.dataUrl`), Verwendungszweck `invoicePurpose`. **Sammelrechnung** je Zahler: `GET /payers/:id/statement.pdf` (alle offenen).
- **Zahler aus Buchungen** (`payer-learning.ts`): Buchung mit `counterpartyIban` (verschlüsselt in `transactions.counterparty_iban_enc`)
  oder `payerId`; beim Zuordnen legt `learnPayerFromTransaction` den Zahler an bzw. ergänzt IBAN (nie überschreiben) und Mitglieder
  (bestehende Zuordnung zu anderen Zahlern bleibt). `TransactionDialog` schlägt Zahler per Autovervollständigung vor und übernimmt die IBAN.
- **Rückzahlung/Guthaben aufs Herkunftskonto**: `syncPayables` nimmt die IBAN der zugeordneten Zahlung (`PayableDesired.ibanEnc`).
- **Belege zu Auszahlungen**: `GET /payables/:id/receipts[/:entryId]` (`treasury.storage.read`, Belege aus der Abrechnung über `actions`).
- **Ablage abgeschlossener Abrechnungen** (`closed-accountings.ts`, Tabelle `filed_accountings`): `GET /closed-accountings`,
  `GET /closed-accountings/:id/pdf`, `PUT /closed-accountings/:id/filed` (`treasury.report.view`); UI im Tab Berichte.
- Tests: `tests/integration/treasury-stage3.test.ts`, `tests/unit/treasury-mail.test.ts`.
- **Direkt zuordnen beim Anlegen** (`POST /transactions` mit `transactionCreateInput`): Einnahme + `allocations` → Posten,
  Ausgabe + `payableId` → Auszahlung, beides in **derselben** DB-Transaktion (Fehler → keine Buchung); danach `finishAllocation`
  (Zahler lernen, Bestätigung, Audit) bzw. `syncReimbursementStatus`. Antwort `TransactionCreated` (`allocation`, `payableLinked`).
  Vorschau ohne Speichern: `POST /match-preview` (`suggestMatch` bzw. rein `suggestPayable`: IBAN-Ende/Name (2 Wörter) + Betrag → sicher).
  UI: `TransactionDialog` breit zweispaltig (links Buchung, rechts `BookingMatchSection` mit allen offenen Posten, Vorschläge oben;
  sichere Vorschläge automatisch, solange nichts selbst gewählt), „Weitere Buchung erfassen“ lässt den Dialog offen (Art, Konto,
  Datum, Kategorie, Aktion bleiben). Nach dem Speichern öffnet sich **kein** Zuordnen-Dialog mehr;
  `PayerCombobox` (Autovervollständigung, auch in `MarkPaidDialog`). `applyCounterparty` liegt in `counterparty.ts`.
- **Zahlung erfassen** (`mark-paid`) nimmt `counterpartyIban`/`payerId` und lernt danach den Zahler (`AllocationResult.payer`).
- Tests: `tests/integration/treasury-booking-match.test.ts`, `tests/unit/treasury-payable-match.test.ts`.

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `treasury.cash.view` | Basis: alles lesen (auch Mitgliedersuche mit E-Mails für Auswahl), Belege laden |
| `treasury.transaction.edit` / `.delete` | Buchungen, Umbuchungen, Zuordnung, Import, „Zahlung erfassen“ / löschen |
| `treasury.account.manage` | Konten und Kategorien |
| `treasury.invoice.edit` / `.delete` / `.send` | Rechnungen, Zahler, Ermäßigung, Storno, Abgleich, Aktions-Einstellungen / manuelle ohne Zahlung löschen / Erinnerungen |
| `treasury.report.view` | Berichte (JSON/PDF/CSV) |
| `treasury.settings.manage` | Kassen-Einstellungen (gespeichert per Systemkontext) |
| `treasury.storage.read/write/delete` | Belege |
| `treasury.bank.view` | IBAN von Zahlern/Auszahlungen im Klartext, Überweisungsliste mit IBAN |
| `treasury.payable.edit` | Eingangsrechnungen, Auszahlungen buchen/zuordnen/stornieren |
Empfänger-Adressen im Rechnungsdetail nur mit `invoice.edit` oder `invoice.send`.

## API (Auszug)
| Pfad | Methode | Besonderheiten |
|---|---|---|
| `/overview`, `/actions` | GET | Kontostände, offen/überfällig/Guthaben, Einnahmen ohne Zuordnung; Forderungen je Aktion |
| `/accounts[/:id]`, `/categories[/:id]`, `/settings` | GET/POST/PUT/DELETE | Konto mit Buchungen nur archivierbar (409); Namen eindeutig (409) |
| `/transactions[/:id]`, `/transfers` | GET/POST/PUT/DELETE, POST | Filter `filter=all|income|expense|unassigned`, `accountId`, `categoryId`, `actionId`, `from/to`, `search` |
| `/transactions/:id/allocations`, `…/suggestion`, `/open-lines`, `/suggestions` | PUT, GET | Zuordnen; Vorschlag; offene Posten (inkl. eigener Zuordnung); Sammelvorschläge |
| `/transactions/:id/receipt` | POST/GET/DELETE | multipart `file`, PDF/Bild ≤ 10 MB |
| `/invoices[/:id]` | GET/POST/PUT/DELETE | PUT: manuell inkl. Posten (bezahlt → Posten gesperrt, 409), aus Aktion nur Empfänger/Frist/Notiz |
| `/invoices/:id/cancel|reactivate|mark-paid|remind`, `…/lines/:lineId`, `…/pdf` | POST, PUT, GET | PDF Vorlage `stamm-brief` mit Adresse des Mitglieds |
| `/open-items[.csv]` | GET | `groupBy=payer|action`, `overdue=1`, `search` |
| `/payers[/:id]`, `/payers/suggestions`, `/members`, `/action-refs` | … | Geschwister-Vorschläge über gleiche E-Mail/Anschrift |
| `/import/preview`, `/import` | POST | multipart `file`, `accountId`, optional `mapping` (JSON); 422 mit `details.headers`, wenn Spalten fehlen |
| `/sync`, `/reminders/run` | POST | Abgleich bzw. Erinnerungsjob sofort |
| `/report[.pdf|.csv]` | GET | `from`, `to`; Anfangs-/Endbestand je Konto, Kategorie, Aktion, offene Forderungen (Stand heute) |

## Audit
`treasury.account.*`, `treasury.category.*`, `treasury.transaction.created|updated|deleted|allocated|receipt_uploaded|receipt_deleted`,
`treasury.transfer.created`, `treasury.invoice.created|updated|deleted|cancelled|reactivated|line_updated|marked_paid|pdf`,
`treasury.payer.*`, `treasury.action.settings_updated`, `treasury.sync.completed`, `treasury.reminder.sent`,
`treasury.import.completed`, `treasury.open_items.exported`, `treasury.report.generated`, `treasury.settings.updated`.
Metadata nur IDs/Zähler/Beträge – **keine** Namen, E-Mails, IBAN (Test prüft „kein @“).

## Tests
Integration `tests/integration/treasury-extensions.test.ts` (Standardkonto, Zahler-IBAN + 403 ohne `bank.view`, IBAN-Abgleich beim Import,
Anmeldung über Link → Mail mit PDF, Team-Wechsel → genau eine „Geänderte Rechnung“, Auslage → Auszahlung → `reimbursed_at` und zurück,
Eingangsrechnung + CSV ohne/mit IBAN, Audit ohne IBAN/Mail).
Integration `tests/integration/treasury.test.ts` (Abgleich, Beitragsänderung, Geschwister-Zahlung + eine Mail, Überzahlung 422,
Ist statt Soll, Storno → Guthaben, Erinnerungsstufen mit fester Uhr, Barzahlung, Sparkasse-Import + Duplikate, Bericht, Rechte,
Audit, Modul aus → 404). Unit `tests/unit/treasury-logic.test.ts`. Uhr: `setTreasuryTodayForTests`, Abgleich: `resetSyncThrottleForTests`.

## Fallen
- Dienste von `members`/`actions` und `core.mail/pdf/audit` **außerhalb** der Modul-Transaktion (PGlite).
- `syncIfStale` ist auf 1×/min gedrosselt – in Tests `POST /sync` oder `resetSyncThrottleForTests`.
- Svelte: In `$effect` keine Funktion aufrufen, die synchron Zustand liest, den sie später setzt (Endlosschleife →
  „Zu viele Anfragen“); `untrack` oder Aufruf in `setTimeout` (siehe `OverviewTab`, `ReportsTab`).
- Demo: Die Demo-DB hatte zwischenzeitlich echte SMTP-Daten; vor Tests mit Mails `node scripts/setup-demo-mail.mjs` (Mailpit) prüfen.
- Offen/bewusst nicht: keine Jahressperre, kein SEPA/FinTS, Aktions-**Ausgaben** werden nicht automatisch übernommen,
  feste Fälligkeit zurücksetzen ändert bestehende Rechnungen nicht, Guthaben wird nicht automatisch verrechnet.
