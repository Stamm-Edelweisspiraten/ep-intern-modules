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
| `module.ts` / `ui.ts` | Manifest, Rechte, Einstellungen `treasury.*`, Jobs `sync` (stündlich), `reminders` (täglich), `annual-fees` (stündlich), `provides`, `search`, `backup` (`treasuryBackup`), `resetAreas`/`resetUsers`, `subjectExport` (**kein** `onUserDeleted`/`onMemberDeleted`); Routen `''`, `invoices/:id`, `accountings/:id`, `settings`; Dashboard-Kacheln `pages/widgets/CashTasksWidget`, `MyInvoicesWidget` |
| `schemas.ts` | Zod + DTO-Typen + Konstanten (`DEFAULT_CATEGORIES`, `SETTING_KEYS`, Mail-Standardtexte, `MAIL_PLACEHOLDERS`) |
| `logic.ts` (rein) | Status/Summen, `distribute`, `computeDueOn`, `reminderLevelDue`, `matchMember`, `planSync`, `suggestPayers`, `suggestMatch`, Mail-Variablen, CSV-Export |
| `csv-import.ts` (rein) | CSV-Parser, `guessMapping` (Sparkasse CSV-CAMT u. a.), Betrag/Datum, Duplikat-Schlüssel |
| `db.ts` | Tx-Helfer, `today()` (= `todayBerlin()` aus `$lib/sdk/dates`, Test-Override `setTodayForTests`), Loader für Konten/Buchungen/Rechnungen, `resolveNames` (Dienste members/actions), `NEEDS_ALLOCATION_SQL`, `nextInvoiceNumber` |
| `sync.ts` | Abgleich Aktionen → Rechnungen: `syncAll` (Job, `POST /sync`), `syncAction(ctx, actionId)` (gezielt), Warteschlange |
| `allocation.ts` | `replaceAllocations` (Prüfungen, ergänzt Kategorie/Aktion), `loadMatchLines` |
| `notify.ts` | `notifyPaid`, `runReminderJob`, `sendManualReminders`, `loadBankData` |
| `service.ts` / `contract.ts` | `TreasuryService` (`provides`): `contributionsForAction`, `participantPayments`, `invoiceForRegistration`, `bankData`, `actionChanged`, `accountingClosed` für `actions`; Push-Funktionen für `orders` aus `external.ts` |
| `external.ts` | Push von `orders`: `upsertOrderInvoice`, `upsertOrderPayable`, `cancelOrderPayable`, `invoiceStatus`, `payableStatus` (keine `treasury.*`-Rechteprüfung, außerhalb von Modul-Transaktionen) |
| `annual-fee.ts` (rein) / `annual-fee.service.ts` / `annual-fee.endpoints.ts` | Jahresbeitrag: Mitgliedschaft am Stichtag, Ebenen, Planung (`annualRef`, `isMemberOn`, `isBillable`, `isLateEntry` …); Läufe anlegen/ändern/planen/versenden/nachholen; `/annual-fees[/:id]` mit Unterpfaden `preview`, `preview.pdf`, `preview-mail`, `schedule`, `unschedule`, `send`, `resend`, `catch-up` |
| `mail-compose.ts` / `mail-html.ts` (rein) | Kassen-Mails aus Vorlage + Rechnungen + Bankdaten (`composeMail`); HTML-Bausteine (`itemsTable`, `paymentBox`, `templateToHtml`, `escapeHtml`) |
| `office-notify.ts` | Amt „Kasse“: `payableNotification`, `accountingClosedNotification`, `notifyKasse` (nach der Transaktion, Fehler nur geloggt) |
| `counterparty.ts` / `payer-learning.ts` | `applyCounterparty` (IBAN der Gegenpartei verschlüsselt + HMAC, Zahler); `learnPayerFromTransaction` (Zahler aus zugeordneten Einnahmen lernen) |
| `accounts.endpoints.ts` | `/accounts[/:id[/default]]`, `/categories[/:id]`, `/settings` (`loadSettings`) |
| `transactions.endpoints.ts` | `/transactions[/:id]` inkl. `allocations`, `receipt`, `suggestion`; `/transfers`, `/open-lines`, `/match-preview`; `decorateTransactions`, `allocateAndNotify`, `finishAllocation` |
| `invoices.endpoints.ts` | `/invoices[/:id]` (cancel, reactivate, mark-paid, remind, send, pdf, `documents/:version/pdf`, `lines/:lineId`), `/payers[/:id]` (+ `iban`, `statement.pdf`, `suggestions`), `/open-items[.csv]`, `/actions[/:id/settings]`, `/action-refs`, `/members`, `/sync`, `/reminders/run`; `loadSummaries`, `loadPayers` |
| `import.endpoints.ts` | CSV-Import `/import/preview`, `/import`, Vorschläge `/suggestions` (`bulkSuggestions`) |
| `reports.endpoints.ts` | `/overview`, `/report`, `/report.csv`, `/report.pdf` (`periodReport`, `reportBlocks`) |
| `history.endpoints.ts` / `history-labels.ts` (rein) | `GET /history` (Verlauf aus dem Audit-Log, `loadHistory`); Klartexte `historyLabel`, `HISTORY_KINDS`, `HISTORY_ACTIONS` (ohne Namen/E-Mail/IBAN) |
| `family.endpoints.ts` | `GET /family-account` (`loadFamilyAccount`: Rechnungen, Zahlungen, Auszahlungen je Zahler/Mitglied, nur lesend) |
| `my.endpoints.ts` | `GET /my/invoices` (`loadMyInvoices`, Dashboard, `treasury.own.view`) |
| `search.ts` | Globale Suche (`treasurySearch`): mit `treasury.cash.view` Rechnungen (Nummer, Empfänger*in, Mitgliedsname) und Zahler; nur mit `treasury.own.view` eigene offene Rechnungen |
| `subject-export.ts` | Datenauskunft (`subjectExport`): Rechnungen/Posten, Zahlungen, Guthaben, Erinnerungen, Zahler, Auszahlungen der Person; IBAN nur maskiert |
| `backup.ts` | `treasuryBackup.rehash`: `payers.iban_hash`, `transactions.counterparty_iban_hash` mit dem Ziel-Schlüssel neu berechnen (ohne Quelle → `NULL`, `unrecoverable`) |
| `reset.ts` | Reset-Bereiche `all` (`rebuild`, alle Dateien), `transactions`, `invoices`, `payables` (`payables/`-Dateien), `annual` (`implies` `treasury:invoices`), `payers`; `resetUsers` leer |
| `documents.ts` | Rechnungs-Snapshot, PDF aus Snapshot, Fassungen (`invoice_documents`), `sendDocuments`, `refreshSentDocuments` |
| `payables.ts` | Auszahlungen: `syncPayables` (Quellen aus `actions` + Guthaben), Endpoints, Rückkanal `syncReimbursementStatus` |
| `bank.ts`, `iban.ts` | IBAN verschlüsseln/HMAC (`core.crypto.forModule('treasury').hash`), Prüfung, Maske `•••• 1234` |
| `closed-accountings.ts` | Abgeschlossene Abrechnungen: Liste, Detail, Belege, PDF, Ablage |
| `pages/` | `TreasuryPage` (Bereiche aus `navigation.ts`: Übersicht · Eingänge · Ausgänge · Buchungen · Berichte; `?tab=<bereich>&view=<unteransicht>`, alte Tab-Namen über `resolveLocation`), `IncomeSection` (Offene Posten · Rechnungen · Familien · Jahresbeitrag), `OutgoingSection` (Auszahlungen · Abrechnungen), `FamilySheet` (Familienkonto, aus allen Bereichen per `onfamily`), `StatusBadge`/`FilterChips` (einheitlich in allen Tabellen), `BulkPayDialog`/`BulkActions.ts` (Sammelaktionen), `AccountingPage`, `InvoicePage`, Dialoge (`TransactionDialog`, `AllocateDialog`, `InvoiceDialog`, `MarkPaidDialog`, `LineDialog`, `PayerDialog`, `AccountDialog`, `TransferDialog`, `ImportDialog`, `SuggestionsDialog`), `helpers.ts` |
| `pages/` (weitere) | Tabs `OverviewTab` (+`task-view.ts`), `OpenItemsTab`, `InvoicesTab`, `PayersTab`, `PayablesTab`, `AccountingsTab`, `TransactionsTab`, `ReportsTab`, `AnnualFeeTab` (+`AnnualSteps`, `AnnualChecklist`, `AnnualRatesCard`, `AnnualMessageCard`, `AnnualPreviewCard`, `AnnualRecipientsCard`, `AnnualSendCard`), `SettingsTab`/`TreasurySettingsPage`, Verlauf `HistoryPanel`/`HistoryCard`/`HistorySheet`, `BookingMatchSection`, `PayerCombobox`, `PayableDialog` |

Verweise auf andere Module (Issue #76 10-09): `payer_members.member_id`, `invoice_lines.member_id` (Mitglieder) und Aktions-/Teilnehmenden-IDs
(Rechnungen aus `actions`) ohne FK. Reset `members:all` impliziert `treasury:payers` + `treasury:annual` (→ `treasury:invoices`), `actions:all`/`participants`
`treasury:invoices`, `actions:all`/`accounting` `treasury:payables`. Die Kasse hat **kein** `onMemberDeleted`/`onUserDeleted`: Löschen eines Mitglieds lässt
Zahler-Zuordnungen und Rechnungen stehen (Buchhaltungsdaten); Benutzerverweise (`created_by` …) bleiben ebenfalls.

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
  `max(Start − daysBeforeStart, heute + minDays)` bzw. feste Fälligkeit der Aktion. Läuft stündlich, per `POST /sync` und gezielt je Aktion (siehe „Abgleich ohne Lesepfad“).
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
  `refund` (`listRefundItems`, IBAN über Mitglied → Zahler), `credit` (Guthaben aus Rechnungen). Abgleich in `syncAll`/`syncAction`;
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

## Ausgaben aus Abrechnungen + Tab „Abrechnungen“ (2026-10-16, Migration 0004)
- Auszahlungsquelle `expense` (`expense:<aktion>:<buchung>`, Label „Ausgabe aus Abrechnung“): offene bzw. von der Kasse bezahlte
  Stamm-Ausgaben aus `ActionsService.listClubExpenses` (Zweck → `description`, fällig heute). IBAN über `getClubExpenseIban`,
  Beleg über `downloadReceipt`. Rückkanal `syncActionPayableStatus` (vorher `syncReimbursementStatus`) für `reimbursement` und `expense`.
- **Auslagen erst nach Abschluss** der Aktions-Abrechnung; Wieder-Öffnen storniert unbezahlte automatisch, erneuter Abschluss reaktiviert.
- Tab **„Abrechnungen“** (`AccountingsTab`, nur `treasury.report.view`): abgeschlossene Abrechnungen + Ablage (aus „Berichte“ umgezogen);
  Detailseite `accountings/:id` (`AccountingPage`): Ergebnis, Soll/Ist, Buchungen mit Belegen/Status, Überweisungen der Kasse.
  API `GET /closed-accountings/:id` (offen/unbekannt → 404), `GET /closed-accountings/:id/receipts/:entryId` (+ `treasury.storage.read`).
- `TreasuryService.participantPayments(actionId)`: Zahlstand je Teilnehmende*r (Rechnung, Soll, bezahlt, offen,
  Status, überfällig) für die Teilnehmerliste in `actions`.
- Tests: `tests/integration/treasury-club-expenses.test.ts`. Falle: erster Einsatz eines API-Keys schreibt `lastUsedAt` ohne await –
  vor `close()` noch eine Anfrage abwarten.

## Jahresbeitrag (Migration 0005, 2026-10-16)
- Dateien: `annual-fee.ts` (rein: `isMemberOn`, `isMemberInYear`, `levelsFor`, `planAnnualInvoices`, `defaultAnnualDueOn`),
  `annual-fee.service.ts`, `annual-fee.endpoints.ts`; Tabelle `annual_fee_runs` (ein Lauf je Jahr, `status` draft|scheduled|sent,
  Sätze/Texte je Lauf aus `treasury.annual.*`), `invoices.source = 'annual'` + `annual_run_id`, `invoice_lines.fee_level`.
- **Lauf** für Jahr Y: Stichtag = `created_on` (Anlagedatum). Mitglied am Tag D: (Eintritt fehlt oder ≤ D) und (Austritt fehlt oder > D).
  Eintritt im Jahr Y **nach dem 28.02.** (29.02. zählt als danach) → nur Stamm. Zweitmitglieder zahlen nur `feeLevels`
  (spät: nur Stamm, falls enthalten). 0 € → übersprungen (`skipped`). Frist: 31.03.Y, sonst heute + `minDays`.
- **Eine Sammelrechnung je Zahler** (`payer_members`), sonst je Mitglied, mit genau **einem offenen Posten**
  „Jahresbeitrag Y – Stammesbeitrag“ = Summe aller Mitglieder und Ebenen (eine Überweisung; Migration 0006, 2026-10-17).
  Die Aufschlüsselung Mitglied × Ebene liegt in `annual_fee_items` (PDF-Tabelle, Idempotenz über `annual:<Y>:<mitglied>:<ebene>`;
  Mitglied mit vorhandener Aufschlüsselung wird übersprungen, auch storniert). Der Posten trägt `member_id` nur bei einem Mitglied,
  `source_ref = annual:<Y>:invoice:<rechnung>`. Ermäßigung gilt auf den Posten; im PDF eine Zeile „Ermäßigung“. Ältere Rechnungen
  (Posten je Ebene mit `fee_level`) bleiben gültig und werden weiter gelesen.
- **Nachberechnung** (`catch-up`, erst nach Versand): Mitglieder irgendwann im Jahr Y ohne Posten – gleiche Regel.
- Versand: Rechnungen in EINER Transaktion (`nextInvoiceNumber`), danach `sendDocuments(…, 'annual', { subjectTpl, bodyTpl })`
  mit PDF an alle `invoiceAddresses`; Vars `{jahr}`, `{mitglieder}` zusätzlich. Geplanter Versand per Job `annual-fees` (stündlich,
  `send_on <= today()`). Rechnungsfrist nie vor dem Rechnungsdatum.
- PDF: Snapshot-Feld `annual` (Jahr, Text, Mitglieder × Ebenen) → Einleitung aus `pdf_text` mit Platzhaltern + Tabelle
  Mitglied | Stamm | Gau | Landesmark | Bund | Summe (fehlende Ebene „–“); alte Snapshots ohne Feld rendern wie bisher.
- Schutz: Abgleich (`sync.ts`) betrachtet nur `source_ref LIKE 'action:%'`; Bearbeiten wie Aktions-Rechnungen (nur Empfänger/
  Frist/Notiz), Löschen 409 (stornieren). Zahlung → Kategorie „Mitgliedsbeiträge“ (`MEMBERSHIP_CATEGORY_ID`).
- API: `GET/POST /annual-fees`, `GET/PUT/DELETE /annual-fees/:id` (PUT/DELETE nach Versand 409), `GET …/preview?mode=run|catch-up`,
  `GET …/preview.pdf?mode&key`, `GET …/preview-mail?mode&key` (Standard: versendet → catch-up), `POST …/send`, `…/schedule {sendOn}`,
  `…/unschedule`, `…/catch-up`. Rechte `treasury.annual-fee.view|manage`; send/schedule/catch-up zusätzlich `treasury.invoice.send`.
- **Stichtagsregel genau** (`isBillable`): Lauf = Mitglied am Stichtag **und** im Jahr Y (Austritt ≤ 01.01.Y zahlt nicht);
  Nachberechnung = Mitglied im Jahr Y und Austritt nach dem Stichtag (oder keiner). Rechnungsfrist = Frist des Laufs, liegt sie
  zurück: heute + `minDays` (`annualInvoiceDueOn`).
- Versand in Paketen à 25, Fehler werden gezählt (`mailErrors`), nie abgebrochen; `POST …/resend` (manage + `invoice.send`,
  Audit `resent`) schickt alle nicht stornierten Rechnungen ohne zugestellte Fassung erneut (UI „Versand wiederholen“).
  Job versendet nur, wenn der Lauf unter `FOR UPDATE` noch `scheduled` und fällig ist. `PUT` auf geplanten Lauf → zurück auf Entwurf.
- **Hintergrundversand (#24, 2026-10-21)**: `POST …/send|catch-up|resend` legen die Rechnungen sofort an und antworten **202** mit dem Startstand
  (`AnnualSendResult` mit `sending: true`, `kind`, `processed`/`total`, `startedAt`/`heartbeatAt`); Mails/PDFs laufen im Hintergrund, Fortschritt je
  25er-Paket in `annual_fee_runs.last_result` (`GET /annual-fees/:id`), am Ende `sending: false` + Audit. Zweiter Versand desselben Laufs während des
  Versands → **409** (prozesslokale Sperre `activeSends` + Lebenszeichen unter `FOR UPDATE`); ohne Lebenszeichen seit 10 min gilt der Versand als
  abgebrochen (`interrupted: true`, „Versand wiederholen“). Der Job versendet weiter synchron. UI `AnnualSendCard` pollt alle 1,5 s.
  Tests: `waitForAnnualSends()`, `treasury-annual-fee.test.ts` (Hintergrundversand), `tests/unit/annual-send-state.test.ts`.
- Abgeschlossene Abrechnungen (#68): Liste mit **einem** Kassen-Aufruf (`TreasuryService.contributionsForActions`) und einer Modul-Transaktion;
  PDF prüft per `ActionsService.isAccountingClosed`. Test `treasury-closed-accountings-perf.test.ts`.
- Lesen braucht zusätzlich `treasury.cash.view`; E-Mail-Adressen in der Vorschau nur mit `invoice.send`/`invoice.edit`
  (sonst `emails: []`, `emailCount`). Mehr als 999 Mitglieder (inkl. Ausgetretener) → 409 (Grenze von `listMemberContacts`).
  Rate-Limit 30/min auf `preview.pdf`, `send`, `catch-up`, `resend`.
- Audit `treasury.annual-fee.created|updated|deleted|scheduled|sent|catch-up|resent` (nur IDs/Zähler/Beträge).
- Tests: `tests/unit/annual-fee.test.ts`, `tests/integration/treasury-annual-fee.test.ts`.

## Mail-Abwahl je Mitglied (2026-10-17)
- `members` liefert `MemberContact.mailOptOut`; `NameMaps.memberMailOptOut` (`resolveNames`). `invoiceAddresses(inv, names, category?)` filtert nur bei Kategorie:
  abgewählte Mitglieder liefern keine Adresse; haben **alle** Mitglieder der Posten abgewählt, entfallen auch Rechnungs- und Zahleradresse. Eine gemeinsame Elternadresse
  (Geschwister) bleibt, solange mindestens ein Kind nicht abgewählt hat.
- **Nur `notifyPaid`** übergibt `'payment-confirmation'`. Erinnerungen, Rechnungen, Jahresbeitrag, Änderung/Storno bleiben ungefiltert (verbindlich).
  Rechnung ohne Adresse gilt weiter als benachrichtigt (`paid_notified_at` gesetzt). Test: `tests/integration/members-own.test.ts`.

## Vergangene Aktionen (`ReceivableSource.isPast`, 2026-10-18)
- `planSync` **friert** Aktionen mit `isPast` ein: keine neuen Rechnungen, bestehende Zeilen (offen/bezahlt/storniert) werden weder
  aktualisiert noch auto-storniert noch reaktiviert (Zeilen werden über `action:<id>:…` der eingefrorenen Menge zugeordnet). Flag weg → normal.
  Ausgeschlossene Aktionen (`action_settings.excluded`) behalten ihr Verhalten (Storno).
- `TreasuryService.invoiceForRegistration` liefert für vergangene Aktionen `null` (Anmeldebestätigung ohne Rechnungs-PDF/Zahlungsblock;
  `isPast` per `listReceivableSources({ actionIds })`).
- `GET /actions` (`ActionReceivables`) hat `isPast: boolean`; Aktion bleibt in der Liste, Zahlen aus vorhandenen Rechnungen.
- Unverändert: Ist-statt-Soll (`contributionsForAction`), Auszahlungen (`syncPayables`: Auslage/Ausgabe/Rückzahlung/Guthaben).
- Tests: `tests/integration/treasury-past.test.ts`, Unit `planSync` in `tests/unit/treasury-logic.test.ts`.

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
| `treasury.annual-fee.view` / `.manage` | Jahresbeitrag: Läufe und Vorschau sehen / anlegen, ändern, versenden (+ `invoice.send`) |
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
| `/family-account?payerId=…\|memberId=…` | GET | `FamilyAccount` (`family.endpoints.ts`): Zahler, Kinder, alle Rechnungen, Zahlungen, Auszahlungen, Summen; Mitglied mit Zahler → dessen Konto; genau ein Parameter (422) |
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
Audit, Modul aus → 404). Unit `tests/unit/treasury-logic.test.ts`. Uhr: `setTodayForTests` (`$lib/sdk/dates`, zentral für alle Module); Abgleich in Tests per `POST /sync` (Lesepfade gleichen nicht ab).

## Fallen
- Dienste von `members`/`actions` und `core.mail/pdf/audit` **außerhalb** der Modul-Transaktion (PGlite).
- Lesende Endpunkte gleichen **nie** ab. Ändert ein Test Aktionsdaten direkt per SQL, danach `POST /sync`; über die `actions`-API gleicht die Kasse sofort ab.
- Svelte: In `$effect` keine Funktion aufrufen, die synchron Zustand liest, den sie später setzt (Endlosschleife →
  „Zu viele Anfragen“); `untrack` oder Aufruf in `setTimeout` (siehe `OverviewTab`, `ReportsTab`).
- Demo: Die Demo-DB hatte zwischenzeitlich echte SMTP-Daten; vor Tests mit Mails `node scripts/setup-demo-mail.mjs` (Mailpit) prüfen.
- Offen/bewusst nicht: keine Jahressperre, kein SEPA/FinTS, bereits bezahlte Stamm-Ausgaben erzeugen keine Kassenbuchung,
  feste Fälligkeit zurücksetzen ändert bestehende Rechnungen nicht, Guthaben wird nicht automatisch verrechnet.

## Zwischenabrechnungen aus Aktionen (Snapshot-Modell, 2026-10-18)
- Auslagen sind freigegeben, sobald eine ZA sie enthält oder die Abrechnung abgeschlossen ist: **eine** Auszahlung je (Aktion, Person),
  Schlüssel `reimb:<aktion>:<person>`, Beschreibung „Auslagen <Aktion>“; neue Auslagen in späteren ZAs lassen dieselbe Auszahlung wachsen.
  Rückkanal `markReimbursed(…, null)`; Erstattung wird nur zurückgenommen, wenn an der Auszahlung gar nichts bezahlt ist (keine Doppelzahlung).
- Altdaten mit ZA-Schlüssel `reimb:<aktion>:<person>:<interimId>`: unbezahlte storniert der Abgleich, bezahlte bleiben (Rückkanal No-op).
- Tab „Abrechnungen“: Aktionen mit ZA als „Zwischenabgerechnet (N)“, PDF ansehen/herunterladen je ZA
  (`GET /closed-accountings/:id/interims/:interimId/pdf`). Tests: `tests/integration/treasury-interim.test.ts`.

## Push an verknüpfte Konten (2026-10-25)
- `push-notify.ts`: zusätzlich zu den Mails an die Kontaktadressen (unverändert) Push an die mit den Mitgliedern der Rechnung verknüpften Konten
  (`MembersService.listLinkedUserIds`): Typen `invoice` (neue Rechnung/Jahresbeitrag/Bestellung, nicht bei Änderung/Storno), `payment-confirmation`
  (nur wenn die Bestätigung tatsächlich verschickt wird), `reminder` – alle `pushOnly`, Standard **Aus**, sichtbar mit `treasury.own.view`. Text ohne IBAN.

## Amt „Kasse“ und Benachrichtigungen (2026-10-19, Modul `offices` optional)
- Manifest: `optionalDependencies` + `offices`; Vorlage `offices: [{ key: 'kasse', name: 'Kasse', notifications: [`payable-created` „Neue Überweisung
  steht an“, `accounting-closed` „Abrechnung abgeschlossen“ (inkl. Zwischenabrechnung)] }]`. Das Amt legt `offices` einmal an (danach normales Amt).
- `office-notify.ts`: `OFFICE_KEY = 'kasse'`, `payableNotification` (Art, Empfänger*in, Betrag, Zweck, Aktion – **keine IBAN**; Link
  `/modules/treasury?tab=outgoing&view=payables`), `accountingClosedNotification` (final → `/modules/treasury/accountings/<actionId>`, ZA → Tab
  Abrechnungen), `notifyKasse(ctx | null, items)` – ohne aktives `offices` nichts, wirft nie, `null` = Systemkontext `treasury-sync`.
- Auslöser **nach** der Transaktion: neu angelegte Auszahlungen aus dem Abgleich (`syncPayables` → `runSync`) und `POST /payables` (je Vorgang **ein**
  Aufruf, gebündelt); `TreasuryService.accountingClosed(ctx, { actionId, actionName, kind: 'final'|'interim', number? })` (`contract.ts`), aufgerufen
  von `actions` nach Abschluss bzw. nach Anlegen einer Zwischenabrechnung.
- Empfänger: Inhaber*innen des Amts an ihre Konto-Adresse, Modus je Person im Profil (Sofort/Täglich/Aus), siehe `module-offices.md`.

## Bestellungen aus `orders` (2026-10-19, Migration 0007)
- Push statt Abgleich: `TreasuryService.upsertOrderInvoice|upsertOrderPayable|cancelOrderPayable|invoiceStatus|payableStatus` (`external.ts`, Vertrag in
  `contract.ts`), aufgerufen von `orders` außerhalb von Transaktionen, **ohne** Kassen-Rechteprüfung. `invoices.source = 'order'` + `source_key` (UNIQUE,
  `order:<id>`), Posten `order:<id>:<item>` mit `member_id`; `invoice_documents.reason = 'order'`; `payables.source = 'order'` (`order-supplier:<id>`).
- Schutz: `syncPayables` lädt nur `source NOT IN ('manual','order')`; Bestell-Rechnungen wie Aktions-Rechnungen (Posten gesperrt, Löschen 409), Filter-Chip
  „Bestellung“. Von Hand stornierte Bestell-Rechnungen werden durch neue Posten nicht reaktiviert. Details: `module-orders.md`. Test `treasury-orders.test.ts`.

## Dashboard (2026-10-20)
- `GET /my/invoices` (Recht `treasury.own.view`, Rolle „Mitglied“ per `defaultRoleGrants`, `my.endpoints.ts`): offene/teilbezahlte Rechnungen der
  **verknüpften** Mitglieder (`listLinkedMembers`, ausgetretene fehlen), nur eigene Namen, Verwendungszweck `invoicePurpose`, Bankdaten `loadBankData`
  (`null` ohne Inhaber/IBAN); kein `syncIfStale`. Kacheln `treasury:mine` (Meine offenen Rechnungen) und `treasury:tasks` (Aufgaben aus `/overview`,
  Texte in `pages/task-view.ts` – zusammen mit `OverviewTab.svelte` pflegen). Test `tests/integration/treasury-my.test.ts`.

## Abgleich ohne Lesepfad, Mahnlauf mit Reservierung (2026-10-20, Migration 0008, Issues #12/#57/#58)
- **GET-Endpunkte sind seiteneffektfrei** (`syncIfStale` entfernt): kein Schreiben, kein Mailversand beim Lesen (Übersicht, Dashboard-Kachel, Rechnungen,
  Offene Posten, Auszahlungen, Familienkonto, Import-Vorschläge, Buchungen).
- **Vollabgleich** `syncAll(ctx|null)` nur im stündlichen Job `treasury.sync` und per `POST /sync` („Jetzt abgleichen“, Knopf in der Übersicht und im Menü „Mehr“,
  Rate-Limit 30/min); setzt `sync_state.last_sync_at` = „Stand des letzten Abgleichs“ (Übersicht). Antwort enthält `documents { invoices, mailsSent, mailErrors }`.
- **Gezielter Abgleich** `syncAction(ctx, actionId)`: Rechnungen der Aktion (`source_ref LIKE 'action:<id>:%'`), Auszahlungen der Aktion
  (`syncPayables(members, { actionIds })` – gewünschte und vorhandene Auszahlungen mit demselben Kriterium gefiltert), Versand geänderter Rechnungen der Aktion.
  Auslöser: `TreasuryService.actionChanged(ctx, actionId)` (wirft nie) – `actions/treasury-sync.ts` umhüllt in `actions/module.ts` **alle schreibenden**
  `/actions/:id…`-Endpunkte und `/actions/import` (ausgenommen Freigaben, Formular, Belegdateien, Kosten-Link, Kalkulation speichern), nach dem Handler;
  öffentliche Anmeldung über `invoiceForRegistration` bzw. ohne E-Mail `notifyTreasury(null, id)`; `PUT /actions/:id/settings` der Kasse.
- **Warteschlange** (#58): alle Abgleiche eines Prozesses laufen nacheinander; ein Lauf liest seine Quellen erst beim Start (sieht also den Commit des Aufrufers).
  Gleiche noch nicht gestartete Läufe (Art, Aktion, auslösende Person) werden zusammengelegt; Schreibphase zusätzlich unter `pg_advisory_xact_lock(hashtext('treasury.sync'))`.
  Audit `treasury.sync.completed` mit `scope` (`all|action`), `target` = Aktion, Akteur = Auslöser*in bzw. System.
- **`refreshSentDocuments(ctx, scope)`**: `string[]` = genau diese Rechnungen; Standard `{ changedSince: 'latest-document', actionId? }` = nur versendete Rechnungen mit
  `updated_at > letzte Fassung − 5 min`. Prozessweit hintereinandergeschaltet (keine doppelte „Geänderte Rechnung“). Kontakte gesammelt: `resolveNames` lädt
  `NameMaps.contacts` per `loadContactsByIds` (ein `listMemberContacts`-Aufruf je 1000 IDs), `buildSnapshot` nutzt die Map; `sendDocuments(…, preloaded)` lädt nicht neu.
- **Mahnlauf** (#57): `claimReminders` reserviert je Rechnung die Stufe **vor** dem Versand (`reminders.status = 'pending'`, unter `pg_advisory_xact_lock(hashtext('treasury.reminders'))`,
  nur wenn noch keine gleiche/höhere Stufe existiert; automatische Stufen zusätzlich Unique-Index `reminders_auto_level_uq (invoice_id, level) WHERE NOT manual`).
  Zugestellt → `status = 'sent'`; fehlgeschlagen → Reservierung gelöscht (nächster Lauf versucht erneut); scheitert die Bestätigung, bleibt `pending` (keine Doppelmail).
  Migration 0008 markiert Alt-Dubletten automatischer Stufen als `manual`. `POST /reminders/run` Rate-Limit 10/min (Job-Claim des Core ist für Module nicht erreichbar; die Reservierung schützt).
- Grenzen: Änderungen in `members` (Name/Geburtsdatum → Mitgliedszuordnung) und Guthaben aus Kassen-Vorgängen ohne Rechnungsbearbeitung (z. B. Buchung löschen) erscheinen erst
  mit dem stündlichen Abgleich bzw. „Jetzt abgleichen“. Mehrinstanzbetrieb: Warteschlange ist prozesslokal, die Advisory-Locks gelten instanzübergreifend.
- Tests: `tests/integration/treasury-sync-readonly.test.ts` (GETs → 0 Mails/keine DB-Änderung, sofortige Wirkung von Aktions-Änderungen, 50 Rechnungen → 1 Kontakt-Aufruf,
  öffentliche Anmeldung nur eigene Aktion, Anmeldung während laufendem Vollabgleich mit Rechnung, Mahnlauf parallel/SMTP-Fehler/Reservierung).

## Listen in SQL, Belegprüfung, Einstellungen, Tests (2026-10-21, Issues #22/#44/#52/#55/#59/#61)
- **Kennzahlen je Rechnung in SQL**: `invoiceMetricsSql(where)` (Alias `m`: `due_cents`, `paid_cents`, `open_cents`, `credit_cents`, `cancelled`,
  `payer_id` über `PAYER_SQL`) – gleiche Regeln wie `invoiceTotals`; `invoiceStatusSql(status, today)` für `open|partial|paid|cancelled|unpaid|overdue`.
  `GET /invoices`: Filter, Status, Sortierung (Rechnungsdatum ↓, Nummer ↓), `count`, Summen und `LIMIT/OFFSET` in SQL; nur die Seite wird samt Posten
  geladen und aufgelöst. Mit `search` (Umlaute egal, auch Mitglieds-/Aktionsnamen) schlanke Kandidatenliste ohne Posten, Namen gesammelt.
  `openStats` (Übersicht/Bericht) per Aggregat; Offene Posten laden nur Rechnungen mit offen/Guthaben; `loadMatchLines` nur offene bzw. die eigene Buchung;
  Suche (`search.ts`) per `ORDER BY … LIMIT`. Zuordnung Zeilen → Rechnung per `groupBy` (Map) statt `filter`. `resolveNames` lädt Kontakte je 1000 und
  Aktionsnamen je 200 (keine stillen Kappungen).
- **Belege** (Buchung, Auszahlung, Bestellungs-Push): Inhalt muss zum Typ passen (`detectReceiptType`, Magic Bytes) → sonst 422.
- **Einstellungen** `PUT /settings`: `core.settings.setMany(ctx, …)` – atomar, mit dem Kontext der Person (Schreibrecht der Schlüssel = `treasury.settings.manage`).
  Seite Einstellungen: Ladefehler → `ErrorState` mit „Erneut versuchen“ statt leerer Konten/Kategorien; Formular der Kassen-Einstellungen erscheint nur nach erfolgreichem Laden.
- **Eindeutige Namen**: Konten/Kategorien über `isUniqueViolation` → 409 mit eigenem Text; `savePayer` fängt `payer_members_member_idx` → 409.
- `POST /invoices/:id/send` mit unbekannter Rechnung → 404 (vorher 201 ohne Wirkung).
- Abrechnungs-Detail (`GET /closed-accountings/:id`) liefert `categoryLabels` (aus `ActionsService.accountingCategoryLabels()`); `AccountingPage` importiert nichts mehr aus `actions/schemas`.
- Tests: `tests/integration/treasury-gaps.test.ts` (Umbuchung, Erlass, Versand, Aktions-Einstellungen, Kategorien/Konten, Belege, CSV/PDF-Exporte, Zahler,
  Auswahllisten, Auszahlungs-Zuordnung/-Belege, Einstellungen atomar), `tests/unit/treasury-endpoint-coverage.test.ts` (**jeder** Kassen-Endpunkt muss in einem
  Integrationstest vorkommen oder begründet in `UNTESTED` stehen), `tests/unit/treasury-group-receipt.test.ts`.

## Sicherheit, Integrität, Datenauskunft (2026-10-21, Issues #67/#73/#30)
- `GET /payables/:id/receipts/:entryId`: bei Auslagen (`reimbursement`) nur Belege aus `listReimbursementReceipts(aktion, person, za)` – Belege anderer
  Personen derselben Aktion → 404. Alle Datei-Antworten (Buchungs-/Auszahlungsbelege, Abrechnungs-PDFs, Abrechnungsbelege) über `secureFileResponse`.
- Verlauf (`history.endpoints.ts`): `core.audit.listForModule(ctx, 'treasury', { targets })` (nur Kassen-Einträge, mit Kontext).
- Migration 0009: verwaiste `invoices.annual_run_id` → NULL, dann FK auf `annual_fee_runs` (`ON DELETE SET NULL`, `NOT VALID` + `VALIDATE`);
  Indizes `transactions_category_idx`, `transactions_import_batch_idx`, `payables_payer_idx`. `transactions.transfer_id` ist bewusst **kein** FK
  (gemeinsame Kennung beider Umbuchungsseiten, Löschen entfernt immer beide). Test `tests/integration/treasury-migration-integrity.test.ts`.
- Best-effort-Fehler (Namen der Ablage) über `logBestEffort`.
- **Datenauskunft** `subject-export.ts` (`subjectExport` in `module.ts`): Rechnungen mit Posten der Mitglieder der Person (bei Sammelrechnungen **nur**
  eigene Posten/Jahresbeitrags-Aufschlüsselung), Zahlungen je Posten, offen/Guthaben, Erinnerungen, Fassungen (nur Liste), Zahler (IBAN maskiert,
  andere Mitglieder nur als Anzahl), Auszahlungen an Mitglied/Zahler. Nie Hash/Chiffrat. Benachrichtigungs-Einstellungen gibt es in der Kasse nicht.
  Test `tests/integration/privacy-subject-export-treasury.test.ts`.

## Handy und Tablet (2026-10-26, Konzept „Kasse mobil – Bedienkonzept“)
- Geräteklasse über `deviceLayout()` (`SharedData.layout`): **Handy** < 640 px, **Tablet** 640–1366 px mit Touch, sonst **Desktop (unverändert)**.
  Jeder Tab hat dafür einen eigenen Zweig `compactView` (Handy + Tablet) neben der Desktop-Tabelle; Logik/Dialoge werden geteilt.
- **Handy** (`TreasuryPage`): kompakter Kopf (Bereich, Kontostand, ⋯), **Bereichsleiste unten** (`MobileTabBar`: Übersicht · Eingänge · Neu · Ausgänge ·
  Buchungen), Unteransichten als `ScrollPills`, Berichte über ⋯. Blatt „Neu erfassen“ (Zahlung erfassen, Buchung, Überweisung als bezahlt, Kontoauszug,
  Umbuchung) und Blatt ⋯ (Zuordnungsvorschläge, Neue Rechnung, Jetzt abgleichen, Berichte, Einstellungen). Besuchte Bereiche bleiben geladen (Filter,
  Unteransicht), Scrollstand je Bereich. Listen (`OpenItemsTab`, `InvoicesTab`, `PayablesTab`, `TransactionsTab`) als `TouchList` mit Suche + Filterblatt
  (`CompactFilter`), Antippen → Aktionsblatt der Zeile, **lange drücken → Auswahlmodus** (`SelectionBar`, Sammelaktionen ersetzen die Bereichsleiste).
  Übersicht als Aufgabenliste + Kennzahlen zum Wischen. Rechnungsseite mit fester Aktionsleiste unten (PDF + Zahlung erfassen), Rest im Blatt hinter ⋯;
  „Zurück“ führt per `history.back()` in die Liste, wenn man aus der Kasse kam.
- **Tablet**: Reiter oben wie am Desktop, „Neu“ und ⋯ als Menüs (Popover); Offene Posten, Auszahlungen und Buchungen als **Liste | Details**
  (rechts die angetippte Zeile mit Hauptaktion); Filter als Popover; Auswahl über lange drücken oder „Auswählen“.
- **Zahlung erfassen** (`PaymentCapture.svelte`, Logik `payment-capture.ts`): Handy = Blatt in 3 Schritten (Betrag per Tastenfeld + Konto + Datum → Wer
  (offene Posten nach Familie/Person, passender Betrag zuerst, Badge „passt“) → Zuordnen (älteste Fälligkeit zuerst, beim Start aus einer Rechnung deren
  Posten zuerst; Rest bleibt ohne Zuordnung)); Tablet = ein zweispaltiger Dialog. Bucht über `POST /transactions` mit `allocations`, `payerId`,
  `notify`; danach „Rückgängig“ (löscht die Buchung), außer es ging schon eine Bestätigung raus. „Danach weitere Zahlung erfassen“ lässt Konto/Datum stehen.
- Entscheidungen aus dem Konzept (Empfehlungen übernommen): Bereichsleiste unten; **keine Wischgesten** auf Karten; Zahlung in 3 Schritten; ＋ als Blatt mit
  5 Wegen; Kontostand dauerhaft im Kopf. Toasts bleiben oben (nicht über der Leiste). Kein Sammel-„Als bezahlt“ für Rechnungen (es gibt keinen Endpunkt).
- Tests: Unit `treasury-payment-capture.test.ts`, E2E `treasury-mobile.spec.ts` (Handy, Tablet, Desktop unverändert).

