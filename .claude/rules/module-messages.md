---
paths: ["src/lib/modules/messages/**", "tests/**/messages*", "scripts/seed-demo-inbox.mjs", "website/src/lib/age-range.ts", "website/src/routes/kontakt/**", "website/src/routes/probestunde/**"]
---

# Modul `messages` (Nachrichten)

E-Mails an Mitglieder, Gruppen und frei eingegebene Adressen aus dem Intern-Bereich: Rich-Text-Editor, mehrere Anhänge, wählbarer Absender
(persönlich `vorname.nachname@domain`, Funktions-Adressen der eigenen Ämter, Gruppen-Adresse, Stamm-Adresse),
Einzelversand je Empfänger im Hintergrund, Verlauf mit Status je Empfänger, **Posteingang** (Catch-all per IMAP, siehe unten). Schema `mod_messages`, Version 1.6.0,
`dependencies: ['members']`, `optionalDependencies: ['offices']`. Navigation „Nachrichten“ (Icon `mail`, `order` 70) und „Postfächer“ (`admin: true`, Verwaltung, siehe unten).

## Dateien (`src/lib/modules/messages/`)
| Datei | Inhalt |
|---|---|
| `ui.ts` | Routen `''` → `InboxPage`, `sent` → `HistoryPage`, `new` → `ComposePage` (`?reply=<id>[&mode=reply-all]`, `?forward=<id>`), `admin` → `MailboxAdminPage`, `inbox/:id` → `InboxMessagePage`, `:id` → `MessageDetailPage`; `profileSections` „Posteingang“ (`InboxNotificationsCard`) |
| `module.ts` | Manifest (Rechte), Einstellungen `messages.*` inkl. `messages.imap.*`/`messages.inbox.retentionDays`, Jobs `resume` (stündlich), `inbox-poll` (jede Minute), `cleanup` (täglich), `onUserDeleted`/`subjectExport` (`privacy.ts`), Endpoints |
| `mailbox.ts` (rein) | Postfach-Schlüssel, `buildAddressIndex`/`routeAddresses` (Zuordnung, Mehrdeutigkeit), `senderKeyFor`/`mailboxKeyForSender`, `prefixedSubject` |
| `imap.client.ts` | Hülle um `imapflow` (`fetch`, `move`, `close`), Testersatz `setImapConnectorForTests` |
| `inbound-parse.ts` | `parseInbound` (`mailparser`): Adressen, Zustell-Empfänger, Message-IDs, Spam/Automatik/`X-EP-Intern`, `Authentication-Results`, `serverSpamScoreOf` (`X-Spam-Score`, `score=` in `X-Spam-Status`, `X-Rspamd-Score`) |
| `spam-rules.ts` (rein) | Spam-Bewertung `scoreSpam` (Punkte + Gründe, Schwelle `SPAM_THRESHOLD` 5), `extractLinks`, `baseDomain`, `parseSenderPattern`, `matchSenderRule` |
| `spam.service.ts` | `loadSpamEnvironment`/`evaluateSpam` (Abruf), `markSpam` („Spam“/„Kein Spam“), Sperr-/Vertrauensliste `listSenderRules`/`createSenderRule`/`deleteSenderRule`, `loadOwnDomains` |
| `mailbox.service.ts` | `loadMailboxDirectory` (systemweit: Adresse → Postfach + berechtigte Konten), `accessibleMailboxes(ctx)`, `requireMailbox` |
| `inbound.service.ts` | `pollInbox` (Abruf, Zuordnung, Speichern, erst danach IMAP-MOVE), `testConnection`, `cleanupInbox`, `loadInboxConfig` |
| `inbox.service.ts` | Postfächer mit Ungelesen-Zähler, Liste, Detail (cid-Bilder als `data:`), gelesen/Papierkorb, Zuordnen, Anhänge, `composePrefill` |
| `inbox-notify.service.ts` | Benachrichtigungen `inbox-new`/`inbox-replied` über `core.notifications`, `notificationScopesFor`, Übernahme alter Einstellungen |
| `extra-mailbox.service.ts` | Zusätzliche Postfächer und Weiterleitungen: Verzeichnis-Einträge (`extraDirectoryEntries`, `loadAliasRows`), `myExtraMailboxes(ctx)`, Verwaltung (CRUD, Adresskonflikt 409, Löschen → „Nicht zugeordnet“), Freigabe-Suche |
| `mailboxes-admin.endpoints.ts` | REST der Verwaltung `/admin/…` (Recht `messages.mailbox.manage`) |
| `folders.ts` (rein), `folders.service.ts` | Ordner je Postfach: Baum/Pfad/Tiefe/Zyklus; Anlegen/Umbenennen/Verschieben/Löschen, `moveMails`, `bulkAction`, `mailboxStats` (Zähler je Ordner) |
| `trial.service.ts`, `age-range.ts` (rein, Kopie `website/src/lib/age-range.ts`) | Probestunden-Formular der Website → Postfach der passenden Gruppe (siehe unten); Altersangaben lesen (`parseAgeRange`, `groupsForAge`) |
| `inbox.endpoints.ts`, `privacy.ts` | REST des Posteingangs; Löschen beim Konto-Löschen, Datenauskunft |
| `schemas.ts` | Konstanten (Limits, Rechte-/Einstellungsschlüssel), Zod `recipientsInput`/`sendInput`, DTOs |
| `sender.ts` (rein) | `personalAddress`, `slugPart`, `firstGivenName`, `splitFullName`, `isValidDomain`, `dedupeAddresses` |
| `html.ts` (Server) | `sanitizeBody` (sanitize-html, Whitelist), `htmlToText` (Klartext-Fassung), `plainDocument` (HTML für „Einfach“) |
| `sender.service.ts` | `loadSettings`, `listSenders(ctx)`, `requireSender(ctx, key)` (prüft den Absender serverseitig erneut) |
| `recipients.service.ts` | `resolveRecipients(ctx, input)`: Mitglieder/Gruppen → eindeutige Adressen, Bereichsprüfung; freie Adressen (`addresses`) zuletzt angehängt |
| `delivery.service.ts` | `createMessage`, `previewMessage`, `getMessage`, `listMessages`, `retryMessage`, Versand (`deliver`), `resumeDeliveries`, `cleanup` |
| `messages.endpoints.ts` | REST (siehe unten) |
| `pages/` | `InboxPage`, `MailboxTree` (Ordnerbaum mit Drag & Drop und Rechtsklick), `FolderDialog`, `MoveToFolderDialog`, `inbox-drag.svelte.ts`, `InboxMessagePage`, `InboxNotificationsCard`, `MessagesTabs`, `HistoryPage`, `ComposePage`, `MessageDetailPage`, `MailboxAdminPage` (Reiter Postfächer | Weiterleitungen), `ExtraMailboxDialog`, `helpers.ts` |
| `migrations/0001_init.sql`, `0002_layout.sql`, `0003_inbox.sql`, `0004_inbox_folders.sql`, `0005_spam.sql`, `0006_extra_mailboxes.sql` | `messages`, `message_recipients`, `message_attachments`; Layout; Posteingang (`inbox_messages`, `inbox_attachments`, `inbox_reads`, `inbox_notification_prefs`, `inbox_poll_state`, Spalten für Verlauf/Message-IDs an `messages`/`message_recipients`); Ordner (`inbox_folders`, `inbox_messages.folder_id`); Spam; Zusatzpostfächer (`extra_mailboxes`, `extra_mailbox_shares`, `mailbox_aliases`) |

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `messages.message.send` | Nachrichten senden, eigene Nachrichten/Verlauf sehen. Empfänger: mit `members.member.view` (Gruppen zusätzlich `members.group.view`) alle, als Gruppenleitung (`members.led-member.view`) nur die Mitglieder der eigenen Gruppen |
| `messages.message.view-all` | Nachrichten aller Personen sehen |
| `messages.settings.manage` | Einstellungen ändern (Schreibrecht der Modul-Einstellungen), IMAP-Verbindung testen |
| `messages.inbox.stamm` | Postfach der Stamm-Adresse lesen (zusätzlich zu `send`) |
| `messages.inbox.manage` | „Nicht zugeordnet“ sehen/zuordnen/löschen, „Jetzt abrufen“ |
| `messages.mailbox.manage` | Verwaltungsseite „Postfächer“: zusätzliche Postfächer anlegen/ändern/löschen/freigeben, Weiterleitungen verwalten |
| `messages.website.contact` | **nur** Website-Endpunkte des Kontakt- und Probestunden-Formulars – Scope für den API-Key der Stammeswebsite |

Rolle „Gruppenleitung“ bekommt `messages.message.send` per `defaultRoleGrants` (einmalig), damit Leitungen ihr Gruppen-Postfach lesen.

Keine `messages.storage.*`-Rechte: Anhänge liegen im Core-Storage und werden nur vom System (Versand/Aufräumen) gelesen, nie direkt ausgeliefert.

## Einstellungen (Administration → Einstellungen → Module)
`messages.domain` (Domain der persönlichen Adressen, leer = keine), `messages.personal.enabled`, `messages.replyTo.default` (`account` = E-Mail des
Kontos, `sender` = Absenderadresse; im Formular änderbar), `messages.maxRecipients` (Standard 500, max. 5000).

## Absender (`GET /senders`)
- **Persönlich**: `vorname.nachname@domain` – Name aus dem als **eigenes Konto** verknüpften Mitglied (`MembersService.getOwnMemberName`, `is_self`), sonst aus dem
  Kontonamen (erstes Wort = Vorname, letztes = Nachname). Bei mehreren Vornamen zählt nur der **erste**; „Anna-Lena“ bleibt; ä→ae, ß→ss, Akzente weg. Der
  Mailserver muss das Senden als diese Adresse erlauben (sonst schlägt der Versand je Empfänger fehl).
- **Amt**: alle Adressen der Ämter, bei denen die Person Inhaber*in ist (`OfficesService.listOwnOfficeEmails`).
- **Gruppe**: Kontakt-E-Mail (`groups.contact_email`, Website-Steckbrief) der Gruppen, die die Person leitet (`MembersService.listLedGroups`).
- **Stamm**: `core.organization.email` (Name `core.organization.name`).
- **Zusätzlich**: zusätzliche Postfächer mit Freigabe „Lesen und senden“ (`kind: 'extra'`, Schlüssel `extra:<id>`).
- Der Schlüssel (`personal`, `stamm`, `office:<id>:<adresse>`, `group:<id>`, `extra:<id>`) kommt vom Client, die Adresse nie: unbekannt/nicht erlaubt → **403**.

## API (`/api/v1/modules/messages/…`)
| Methode + Pfad | Recht | Besonderheiten |
|---|---|---|
| GET `/senders` | send | `{ senders, accountEmail, replyToDefault, personalHint }` |
| POST `/recipients/resolve` | send | `{ memberIds, groupIds, excludeMemberIds, addresses }` → `{ recipients[{memberId,name,address}], members, withoutEmail[], exited, external, maxRecipients }` (freie Adresse: `memberId`/`name` = `null`); 60/min; Antwort 201 (jedes POST) |
| POST `/preview` | send | `previewInput` `{ senderKey?, layout?, subject, bodyHtml }` (Betreff/Text dürfen leer sein) → `{ html, subject, from }`: gleiche Bereinigung + Layout wie beim Versand (`core.mail.preview`, Bilder als `data:`), nichts gespeichert/gesendet; fremder Absender 403; 60/min |
| POST `/messages` | send | **multipart**: Feld `data` (JSON `sendInput`) + Dateien `files` (≤ 10, je ≤ 10 MB, zusammen ≤ 20 MB, nur Typen aus `DEFAULT_ALLOWED_CONTENT_TYPES` mit Magic-Byte-Prüfung); 10/600 s; 201 mit `MessageDetail`; Versand läuft danach im Hintergrund |
| GET `/messages` | send | Verlauf (eigene, mit `view-all` alle), `limit`/`offset` |
| GET `/messages/:id` | send | Detail mit Empfängerstatus; fremd ohne `view-all` → 404 |
| POST `/messages/:id/retry` | send | fehlgeschlagene Empfänger erneut; 409 bei laufendem Versand/ohne Fehler/entfernten Anhängen |

## Aussehen und Zustellbarkeit (Spam-Wert)
- **Aussehen** je Nachricht (`layout`, Migration 0002, Standard aus `messages.layout.default`): `stamm` = Stamm-Layout (Kopf, Signatur, Fußzeile, Logo als CID-Anhang),
  `plain` = einfache Mail wie aus einem Mailprogramm (`layout: false`: kein Kopf/Bild/Signatur, nur Text + schlankes HTML ohne Tabellen/Farben).
- **Immer multipart/alternative** (Text + HTML); Logo/Wappen mit `alt`-Text, `<title>` im Layout; keine Tracking-Pixel, keine externen Bilder.
- **Header** (`core/mail.ts`): `Message-ID` mit der **Domain der Absenderadresse**, `Reply-To`, `List-Unsubscribe: <mailto:Stamm-Adresse>` (`core.mail.sendMessage` `unsubscribe`),
  kein `Precedence: bulk`. Versand mit kurzer Pause (250 ms) zwischen den Mails.
- **Betreff-Hinweis** im Formular bei Großbuchstaben oder mehr als zwei `!`/`?`.
- **Absender-Domain ≠ Mailserver-Domain** (`core.smtp.from`): `SendersResponse.deliverabilityHint` weist auf SPF/DKIM/DMARC hin – ohne diese landen Mails eher im Spam
  oder werden abgelehnt. Checkliste: SPF (Mailserver autorisiert), DKIM-Signatur für die Absender-Domain, DMARC-Eintrag, rDNS/Reverse-DNS des Servers, Server darf als
  `vorname.nachname@domain` senden (Alias/Catch-all), neue Domains langsam „aufwärmen“. Der echte Spam-Wert hängt am Mailserver/DNS und ist nur mit einer Testmail an einen Spam-Checker messbar.

## Oberfläche (`ComposePage`)
Ein Eingabefeld „An“ (Combobox mit Trefferliste getrennt nach E-Mail-Adresse/Gruppen/Mitgliedern, Pfeiltasten/Enter/Backspace); gewählte Empfänger als Chips darunter: **Gruppen in
Gruppenfarbe**, **Mitglieder grau**, **freie Adressen** mit Mail-Symbol (Enter/Komma/Semikolon/Verlassen übernimmt eine gültige Adresse, Einfügen mehrerer Adressen übernimmt alle gültigen).
Die Empfänger-Karte ist `overflow-visible` (sonst schneidet `Card` die Trefferliste ab). Karte „Nachricht“ mit Reitern **Schreiben | Vorschau**: Vorschau (Von/An/Antwort/Betreff/Anhänge +
`<iframe srcdoc sandbox>` mit dem Mail-HTML aus `POST /preview`, 400 ms verzögert, nur bei offenem Reiter, Ergebnis per `untrack` gelesen); der Schreiben-Bereich bleibt eingehängt (`hidden`). Darunter Anzahl Adressen/Mitglieder, ohne Adresse, ausgetreten, einzelne Mitglieder ausschließbar. Danach Absender, Antwortadresse,
Aussehen, Betreff, Editor, Anhänge. Seiten laden **ohne** reaktive Lesezugriffe im `$effect` (`untrack`), Polling nur bei laufendem Versand und sichtbarem Tab –
sonst Endlosschleife → 429 (Regression, E2E `tests/e2e/messages.spec.ts`).

## Ablauf und Regeln
- **Freie Adressen** (`addresses`, ≤ 100, Zod-E-Mail, klein geschrieben): darf jede*r mit `messages.message.send` (Nutzerentscheidung 2026-10-21), auch ohne Mitgliederrechte;
  gehört eine Adresse schon zu einem gewählten Mitglied, bleibt dessen Zeile. In `message_recipients` mit `member_id`/`name` = `NULL`.
- `createMessage`: Absender prüfen → Empfänger auflösen (Adressen immer serverseitig, Duplikate unabhängig von Groß-/Kleinschreibung zusammengefasst, Geschwister mit
  gleicher Adresse bekommen **eine** Mail) → Text bereinigen → Anhänge in den Storage (`messages/<id>/<uuid>-<name>`) → eine Transaktion → Audit `messages.message.created`
  → `startDelivery`. Core-Services nie in der Modul-Transaktion.
- **Versand** (`deliver`): Empfänger in Blöcken atomar „beanspruchen“ (`pending`→`sending`), je Block 3 parallele Mails über `core.mail.sendMessage`, Status je Empfänger
  (`sent`/`failed` mit kurzer Fehlermeldung), danach Zähler/Status (`sending|done|partial|failed`) und Audit `messages.message.sent` (nur Zähler). Hängende `sending`-Zeilen
  (> 10 min) setzt der Job `resume` zurück und setzt den Versand fort (idempotent).
- **Datenschutz**: Audit ohne Adressen/Betreffe; Nachrichten werden nach 365 Tagen gelöscht, Anhänge nach 30 Tagen (Job `cleanup`).
- Einzelversand: keine sichtbare Verteilerliste; kein Abbestellen/Opt-out (Vereinsmitteilungen) – offen.

## Core-Erweiterungen dafür
- `MailMessage` (`core/mail.ts`) um `from`, `fromName`, `replyTo`; `formatSender` baut `"Name" <adresse>` und verwirft Steuerzeichen/ungültige Adressen (Header-Injection).
- `core.mail.sendMessage` (`core/index.ts`): wie `send`, aber mit Absender/Antwortadresse und bis zu 10 Anhängen (20 MB, keine ausführbaren Endungen).
- `core.mail.preview({ text, html, layout })` (`previewMailHtml` in `core/mail.ts`): HTML-Dokument wie beim Versand (Stamm-Layout mit `data:`-Bildern, ohne Layout unverändert) – nur für Vorschauen.
- Bausteine: `RichTextEditor` (`$lib/components/ui/rich-text-editor`, Tiptap v3, `bind:value` als HTML), `MembersService.listGroupMemberIds|listLedGroups|getOwnMemberName`,
  `OfficesService.listOwnOfficeEmails`.
- Einstieg aus anderen Seiten: Mitglieder- und Gruppenliste (Knopf „E-Mail senden“, nur mit Recht `messages.message.send`) übergeben die Auswahl per
  `sessionStorage['messages:compose']` (`{ groupIds, members[{id,name}] }`) an `/modules/messages/new`.

## Tests
`tests/unit/messages-sender.test.ts` (Adressbildung, Umlaute, Bereinigung, Header-Injection), `tests/integration/messages.test.ts` (Absender, Empfänger-Bereich,
Versand mit From/Reply-To/Anhängen, Fehler + Wiederholen, Validierung/Limits, Verlauf-Zugriff, Audit, Jobs).

## Posteingang (2026-10-22, v1.1.0, Migr. 0003)
Problem: viele Absenderadressen ohne echtes Postfach → Antworten gingen verloren. Lösung: ein **Catch-all-Postfach**, das der Job `messages.inbox-poll`
(`schedule: { everyMinutes: 1 }`, Core-Erweiterung) per IMAP abruft. Entscheidungen des Nutzers: IMAP-Abruf; Sichtbarkeit wie Absenderrechte;
unzuordenbare Mails in „Nicht zugeordnet“ für die Verwaltung; nach dem Import auf dem Server in den Ablageordner verschieben.
- **Postfächer** (Schlüssel wie Absender, persönlich mit Konto-ID): `personal:<userId>` (nur die Person), `office:<amtId>:<adresse>` (alle Inhaber*innen),
  `group:<id>` (alle Leitungen mit eigenem Konto), `stamm` (zusätzlich `messages.inbox.stamm`), `unassigned` (`messages.inbox.manage`). Alles setzt
  `messages.message.send` voraus; Zugriff wird **je Request** neu berechnet (`accessibleMailboxes` über `listSenders`), fremd → 404.
- **Abruf** (`pollInbox`, höchstens 50 Mails je Lauf, je Prozess ein Lauf): Verzeichnis aller Adressen (`loadMailboxDirectory`: persönliche Adressen aller
  Konten mit `send` über `core.permissions.usersWith` + `MembersService.listSelfMemberNames`, `OfficesService.listOfficeMailboxes`, `MembersService.listGroupMailboxes`,
  Stamm) → Zuordnung über `Delivered-To`/`X-Original-To`/… (Bcc) dann An/Cc; **gleiche persönliche Adresse für mehrere Konten** → `unassigned` (Grund
  `ambiguous`); je Postfach eine Zeile, Doppelimport-Schutz `UNIQUE (mailbox_key, dedupe_key)` (Message-ID bzw. SHA-256 des Rohtexts); Anhänge in den Speicher
  (`messages/inbox/<id>/…`, nicht erlaubte Typen nur vermerkt `skipped_attachments`, ohne Speicher 503 → Mail bleibt im Eingang); **erst nach dem Commit** IMAP-MOVE.
  Eigene Benachrichtigungen (`X-EP-Intern`) werden übersprungen (Schleifenschutz). Mails > 25 MB nur angeschnitten (`truncated`). Letzter Abruf in `inbox_poll_state`.
- **Anzeige**: HTML über `sanitizeInbound` (Whitelist inkl. Tabellen, CSS nur sichere Eigenschaften ohne `url()`, keine Skripte/Formulare/`<style>`,
  Links `target=_blank rel=noopener noreferrer`, **externe Bilder entfernt** und gezählt `blocked_images`), `cid:`-Bilder ≤ 2 MB als `data:` (Magic Bytes),
  Dokument mit eigener CSP im `<iframe srcdoc sandbox>`. Anhänge per `secureFileResponse` (Download, `?inline=1` nur sichere Typen). Badges „Spam“
  (`X-Spam-Flag`), „Absender nicht bestätigt“ (`Authentication-Results` DMARC/DKIM/SPF fail). Gelesen je Person (`inbox_reads`), Papierkorb gemeinsam.
- **Antworten/Weiterleiten**: `GET /inbox/:id/compose?mode=reply|reply-all|forward` → Vorbelegung (Absender des Postfachs, Adressen, „Re:“/„Wg:“, Zitat);
  `sendInput.replyOf|forwardOf|forwardAttachmentIds` (Bezug 404 ohne Zugriff). Versand setzt `In-Reply-To`/`References` und eine eigene
  `Message-ID` **je Empfänger** (`message_recipients.message_id_header`) → eingehende Antworten landen im selben `thread_id` (Verlauf in der Detailansicht).
  Mit eingeschaltetem Posteingang ist die Antwortadresse standardmäßig die **Absenderadresse**. `messages.mailbox_key` merkt das Postfach des Absenders.
- **Benachrichtigungen** (seit 2026-10-25 über `core.notifications`: Typen `inbox-new`/`inbox-replied`, `scoped` je Postfach über `forUser`, Kanal
  Aus · E-Mail · Beides · Push im Core-Profilreiter; `InboxNotificationsCard` und `GET/PUT /me/notifications` entfernt, alte `inbox_notification_prefs`
  einmalig übernommen und gelöscht; mehrere neue Mails eines Abrufs = eine Sammelmail je Person). Nicht bei Spam/Automatik/„Nicht zugeordnet“; `inbox-replied` an alle **anderen** Berechtigten eines gemeinsamen Postfachs.
- **Gesendet je Postfach** (2026-10-23): Filterleiste Alle | Ungelesen | Spam | Papierkorb | **Gesendet** (nicht bei „Nicht zugeordnet“) →
  `GET /mailboxes/sent?mailbox&search` (`listMailboxSent`): Nachrichten mit `mailbox_key` = Postfach, Altbestand ohne `mailbox_key` über die
  Absenderadresse (persönlich nur eigene). **Gemeinsame Postfächer: alle Berechtigten sehen auch die Mails der anderen** und dürfen sie öffnen
  (`getMessage` prüft zusätzlich `sentViaAccessibleMailbox`). Detail-Rücklink mit `?mailbox=` zurück ins Postfach.
- **Zähler**: Ungelesen-Zahl je Postfach als runder `CountBadge` (ab 10 „9+“); Seitenleiste „Nachrichten“ über `navBadge` = `unreadTotal`
  (alle eigenen Postfächer **ohne** „Nicht zugeordnet“), aktualisiert nach Lesen/Ungelesen/Löschen/Abruf (`refreshNavBadges`).
- **API** (alle `send`, sonst angegeben): GET `/mailboxes`, GET `/mailboxes/sent`, GET `/mailboxes/all` (manage), GET `/inbox?mailbox&filter=all|unread|spam|trash&search`,
  GET `/inbox/:id` (markiert gelesen), GET `/inbox/:id/compose`, POST `/inbox/:id/read|unread|restore`, DELETE `/inbox/:id`, POST `/inbox/:id/assign` (manage,
  benachrichtigt), GET `/inbox/:id/attachments/:aid`, POST `/inbox/poll` (manage), POST `/inbox/test` (manage + settings.manage), GET/PUT `/me/notifications`.
- **Aufbewahrung** (Job `cleanup`): Papierkorb und „Nicht zugeordnet“ nach 30 Tagen, sonst `messages.inbox.retentionDays` (365). Ablageordner auf dem Mailserver bleibt.
- **Datenschutz**: Audit `messages.inbox.received|deleted|restored|assigned` nur mit Zählern; `onUserDeleted` löscht das persönliche Postfach samt Anhängen;
  `subjectExport` (gesendete Nachrichten, persönliches Postfach als Metadaten, Einstellungen). IMAP-Server steht in `docs/security.md` → „Externe Empfänger“.
- **Core-Erweiterungen**: Jobs `{ everyMinutes }` + Tick 1 min; `core.mail.sendMessage({ messageId, inReplyTo, references })` → `{ messageId }`;
  `core.mail.send({ autoSubmitted })`; `core.permissions.usersWith(key)`; `ModuleSettingDefinition.secretBoundTo` (IMAP-Passwort verfällt bei neuem
  Server/Port/Benutzer). Abhängigkeiten `imapflow` 2.2.10, `mailparser` 3.9.36 (fest gepinnt).
- **Tests**: `tests/unit/messages-inbox.test.ts`, `tests/integration/messages-inbox.test.ts` (IMAP-Ersatz), E2E `messages.spec.ts` (Posteingang ohne IMAP).
  Demo: GreenMail in `docker-compose.demo.yml` (IMAP `127.0.0.1:1143`), `node scripts/seed-demo-inbox.mjs`. Einrichtung: `docs/deployment.md`.
- **Offen**: echter Provider-Catch-all ungeprüft (nur GreenMail); Namensänderung → alte persönliche Adresse wird „Nicht zugeordnet“; Mehrinstanz-Betrieb
  (Sperre je Prozess); kein IMAP IDLE (Verzögerung bis 1 min); keine Volltextsuche im Inhalt; keine Labels; Dashboard-Kachel fehlt.

## Ordner im Posteingang (2026-10-23, v1.2.0, Migr. 0004)
Nutzerentscheidung: eigene Ordner mit Unterordnern **je Postfach**; in gemeinsamen Postfächern (Amt, Gruppe, Stamm) **sehen und ändern alle
mit Zugriff** dieselben Ordner (gemeinsam sortieren), im persönlichen Postfach nur die Person. Drag & Drop und Rechtsklick.
- **Daten**: `inbox_folders(id, mailbox_key, parent_id FK CASCADE, name, created_by, …)`, Name eindeutig je Ebene (Unique-Index auf
  `lower(name)`), `inbox_messages.folder_id` (FK `ON DELETE SET NULL`, `NULL` = Posteingang).
- **Regeln** (`folders.service.ts`): Zugriff über `accessibleMailboxes` (fremd → 404), ≤ 3 Ebenen, ≤ 100 Ordner je Postfach (Advisory-Sperre je
  Postfach), Name ≤ 100 → doppelt 409; Zyklus/zu tief/Elternordner aus anderem Postfach → 422; „Nicht zugeordnet“ hat keine Ordner (422).
  Sortierung alphabetisch (kein manuelles Umsortieren). Ordner löschen nimmt Unterordner mit, Mails gehen in den **Posteingang**.
  Mails verschieben nur **innerhalb desselben Postfachs** (anderes Postfach = „Zuordnen“, das `folder_id` zurücksetzt). Papierkorb/Spam bleiben
  Flags: gelöschte Mails behalten den Ordner, Wiederherstellen bringt sie zurück. Neue Mails/Antworten landen immer im Posteingang.
- **API** (alle `send`): POST `/folders` `{ mailbox, parentId, name }`, PATCH `/folders/:id` `{ name?, parentId? }`, DELETE `/folders/:id`
  → `{ deleted, movedMessages }`, POST `/inbox/move` `{ ids ≤ 200, folderId|null }` → `{ moved, previous }` (für Rückgängig), POST `/inbox/bulk`
  `{ ids, action: read|unread|delete|restore }`; GET `/inbox?folder=inbox|<id>` (bei `filter=spam|trash` postfachweit); GET `/mailboxes` liefert je
  Postfach `folders` (mit `unread`/`total`), `inboxUnread`, `spamCount`; Detail `folderId` + `folderPath`.
  GET `/mailboxes/details?mailbox&folder?` (`folderDetails`) → Anzahl (inkl. Unterordner/direkt), Ungelesene, Größe (Summe `size`), Anhänge,
  Ordner, Spam/Papierkorb (nur Postfach), Zeitraum, angelegt von/am (Ordner), Zugriff (Namen, nur gemeinsame Postfächer) – Rechtsklick → „Details“
  auf Postfach, Posteingang und Ordner (`FolderDetailsDialog`).
- **Oberfläche**: `MailboxTree` (Postfächer aufklappbar, Zustand in `localStorage` `messages:inbox-tree`; Posteingang, Ordner, gedämpft Gesendet/Spam/
  Papierkorb, „Ordner anlegen“; kein Hinweis „gemeinsam“ am Postfach (Nutzerwunsch); Rechtsklick und „…“ (auch Shift+F10): Unterordner anlegen, Umbenennen, Verschieben nach …, Löschen; Ordner per
  Ziehen in andere Ordner bzw. auf den Postfach-Kopf = oberste Ebene; zugeklappte Ziele öffnen nach 600 ms). Liste: Checkboxen, Sammelleiste
  (Verschieben nach / Gelesen / Ungelesen / Löschen bzw. Wiederherstellen), Zeilen ziehbar (markierte zusammen, Ziehbild „N Nachrichten“), Rechtsklick
  auf Zeilen, Rückgängig-Toast nach Verschieben/Löschen. Filter nur Alle | Ungelesen; URL `?mailbox=&folder=`. Mobil: Knopf mit Pfad → Sheet mit dem
  Baum (ohne Drag & Drop, Long-Press = Kontextmenü). Detail: „Verschieben nach …“ im Menü, Ordnerpfad, Rücklink in den Ordner.
- **Datenschutz/Audit**: `messages.inbox.folder-created|folder-updated|folder-deleted`, `messages.inbox.moved`, Sammel-Papierkorb mit `count` – nur
  Zähler/`shared`, **keine Ordnernamen**. `onUserDeleted` löscht die persönlichen Ordner, `created_by` → `NULL`; `subjectExport` enthält `personalFolders`.
- **Tests**: `tests/unit/messages-folders.test.ts`, `tests/integration/messages-inbox-folders.test.ts`, E2E `messages.spec.ts` (Ordner anlegen/
  umbenennen/löschen per Rechtsklick). Drag & Drop von Mails ist nur manuell geprüft (E2E hat keine Posteingangs-Mails).

## Spam-Schutz (2026-10-24, v1.3.0, Migr. 0005)
Nutzerentscheidungen: eindeutiger Spam kommt in den **Spam-Ordner** (nie verworfen); **eine** Sperr- und Vertrauensliste für alle
Postfächer; „Spam“/„Kein Spam“ darf **jede*r mit Zugriff** auf das Postfach, das ändert die Liste.
- **Bewertung beim Abruf** (`scoreSpam`, rein): Punkte je Regel, ab **5** Spam. Absenderprüfung fehlgeschlagen (4), gefälschte eigene Domain
  bei fehlgeschlagener Prüfung (+4), Anzeigename mit fremder Adresse (3), Reply-To fremde Domain ohne `pass` (2), Server-Markierung (6) bzw.
  Server-Wert ≥ 3 (2), ausführbarer/gefährlicher Anhang auch als doppelte Endung (5) bzw. Makro-Office (3), Link zeigt andere Domain als Ziel (3),
  Link auf IP (3), Linkverkürzer (2), > 20 Links bei wenig Text (1), Betreff-Muster (2), Großbuchstaben (1), `!?$€` ×3 (1), keine Message-ID (1),
  Datum > 1 Tag in der Zukunft (2), ≥ 10 Mails desselben Absenders in 60 min (3), bekannter/vertrauter Absender mit fehlgeschlagener Prüfung (+2).
- **Vorrang**: Sperrliste → immer Spam (`blocklist`). Vertrauensliste **oder bekannter Absender** (Mitglieder-Adressen über `listMemberContacts`
  ≤ 1000, Konten mit `send`, alle je angeschriebenen Adressen aus `message_recipients`, eigene Domains) → nie Spam, **außer** DMARC/DKIM/SPF schlägt fehl.
  Domain-Einträge treffen Subdomains; Adresse vor Domain, genaueste Domain gewinnt.
- **Gegen Fehlalarme (2026-10-25)**: **eigene Mails** (Message-ID steht in `message_recipients.message_id_header`) sind nie Spam;
  **Antworten auf unsere Mails** (In-Reply-To/References auf eine eigene Message-ID) gelten als bekannter Absender; Reply-To auf eine
  bekannte/eigene Adresse zählt nicht; Formmerkmale (Großbuchstaben, Satzzeichen, Message-ID, viele Links, Datum) zusammen höchstens
  `FORM_POINTS_MAX` (2); bestandene Prüfung −2 (`auth-pass`, nicht gegen die Server-Markierung, in der UI ausgeblendet); Link-Abweichung
  zählt nicht, wenn die angezeigte Domain die des bestätigten Absenders ist (Klickzähler in Newslettern).
  `authResultOf` wertet nur die Zeilen des **obersten** Servers (`authserv-id`) und nur eindeutige Fehler: `dmarc=fail` (nicht bei `arc=pass`)
  oder hartes `spf=fail` ohne bestandenes DKIM/SPF; `softfail`/`neutral`/`temperror`/DKIM-Fehler allein → `none`.
- **Einstellung** `messages.spam.enabled` (Standard an): aus → nur Server-Markierung + Listen/bekannte Absender. Listen gelten immer.
- **Daten**: `inbox_messages.spam_score`, `spam_reasons` (jsonb `{code,label,points}[]`), `spam_source` `server|rules|blocklist|user` (Altbestand mit
  `spam` → `server`), `spam_marked_by/at`; Tabelle `sender_rules(kind block|allow, match_type address|domain, pattern, note, origin manual|button,
  created_by)` UNIQUE `(match_type, pattern)`, ≤ 2000 Einträge. Umgebung (Listen, bekannte Adressen) wird nur geladen, wenn der Abruf Mails hat.
- **API** (`send`): POST `/inbox/spam` `{ ids ≤ 200, spam, remember = true }` → `{ changed, remembered }`: markiert (`user`), merkt Absender-**Adressen**
  (nie eigene Domains) und verschiebt weitere nicht gelöschte Mails desselben Absenders **in den Postfächern der Person** mit; fremd → 404.
  Verwaltung (`messages.inbox.manage`): GET/POST `/spam/rules` (`{ kind, value, note? }`, Adresse oder Domain/„@domain“; Duplikat oder andere Liste → 409,
  ungültig oder eigene Domain sperren → 422), DELETE `/spam/rules/:id`.
- **Anzeige**: Detail mit `spamScore`, `spamReasons`, `spamSource`; Hinweis mit Gründen, Links bei Spam **unklickbar** (`neutralizeLinks`, Ziel im Tooltip),
  Knopf „Kein Spam“, Menü „Spam“; Liste: Sammelleiste und Rechtsklick „Spam“/„Kein Spam“; Seitenkopf „Spam-Schutz“ (nur Verwaltung) → `SpamRulesDialog`
  (Reiter Gesperrt/Vertrauenswürdig, Eintragen, Entfernen mit Rückgängig). Spam löst keine Benachrichtigung aus und wird nach **30 Tagen** gelöscht
  (`INBOX_SPAM_DAYS`, ab Markierung bzw. Import).
- **Audit**: `messages.inbox.spam-marked` (`count`, `spam`, `remembered`), `messages.spam.rule-created|rule-deleted` (`kind`, `matchType`) – **keine Adressen**.
  `onUserDeleted`: `spam_marked_by`, `sender_rules.created_by` → `NULL`.
- **Tests**: `tests/unit/messages-spam.test.ts`, `tests/integration/messages-spam.test.ts`, Upgrade `messages-spam-migration.test.ts`.
- **Grenzen**: keine externen Blocklisten/rspamd (bewusst, keine Daten an Dritte); bekannte Mitglieder-Adressen nur der ersten 1000 Mitglieder;
  Phishing ohne die genannten Merkmale wird nicht erkannt; Schwelle/Punkte nur im Code einstellbar.

## Kontaktformular der Website (2026-10-25, v1.4.0, keine Migration)
Nutzerentscheidung: Anfragen von der Stammeswebsite landen **im Posteingang „Stamm“** (statt SMTP an eine feste Adresse); Spam-Schutz
**Proof-of-Work (ALTCHA-artig, selbst gebaut, keine Dritten) + Zeitfalle + Formular-Token**, dazu Honeypot und Rate-Limits der Website.
- Dateien: `contact-pow.ts` (rein: `createChallenge`, `verifySolution`, `contactDedupeKey`; `POW_MAX_NUMBER` 100 000, `MIN_FILL_MS` 3 s,
  `MAX_AGE_MS` 2 h), `contact.service.ts` (`contactChallenge`, `receiveContact`, `contactText`), `contact.endpoints.ts`; Zod `contactInput` in `schemas.ts`.
- **Aufgabe**: `salt = <24 hex>.<Ausstellungszeit ms>`, `challenge = SHA-256(salt + n)`, Signatur = `core.crypto.forModule('messages').hash`
  (HMAC, kein gespeicherter Hash → kein `backup.rehash` nötig). Prüfung: Form, Signatur (zeitkonstant), Lösung, ≥ 3 s, ≤ 2 h.
  **Einmalig** über `dedupe_key = contact:<challenge>` (UNIQUE je Postfach) → zweite Einlösung **409** (die Website wertet 409 als „schon angekommen“).
- **Ablage**: wie eine eingegangene Mail in `inbox_messages` (`stamm`; ohne `core.organization.email` → `unassigned`, Grund `unknown`), Absender/Reply-To
  = eingegebene Adresse (klein), Betreff „Kontaktanfrage über die Website“, Text mit Name/E-Mail/Telefon und Hinweis „nicht geprüft“, kein Spam-Flag.
  Danach Audit `messages.inbox.contact-received` (`{ mailbox }`, keine Daten) und Benachrichtigung `inbox-new` an die Berechtigten des Postfachs.
- API: GET `/website/contact/challenge` (300/60 s), POST `/website/contact` (60/3600 s, 201 `{ received: true }`, 422 mit `details.pow`).
- Tests: `tests/unit/messages-contact.test.ts`, `tests/integration/messages-contact.test.ts`, Website-Solver `tests/unit/website-pow.test.ts`.

## Probestunden-Formular der Website (2026-10-25, v1.5.0, keine Migration)
Nutzerwunsch: Eltern fragen auf der Website (`/probestunde`) eine Probestunde an – Name und **Alter** des Kindes, Name, E-Mail, Telefon (Pflicht),
Nachricht (freiwillig) –, die **passende Gruppe** bekommt die Nachricht.
- API: POST `/website/trial` (Scope `messages.website.contact`, 60/3600 s, 201 `{ received: true, group: <slug>|null }`), Zod `trialInput`
  (`childName`, `childAge` 3–30, `name`, `email`, `phone` Pflicht, `message` ≤ 2000, `groupSlug` optional, `pow`). Aufgabe wie beim Kontaktformular
  (`/website/contact/challenge`); **eine Aufgabe gilt über alle Postfächer und beide Formulare nur einmal** (409).
- Gruppe (`pickTrialGroup`): gewählter Website-Slug vor Alter; sonst `groupsForAge` über `MembersService.listWebsiteGroupRefs()` (neuer Dienst: Gruppen mit
  `on_website` + Slug, Meute vor Sippe) und die Altersangabe der Gruppe: seit 2026-10-27 Zahlen `ageMin`/`ageMax` (`groupAgeRange`), nur bei Altbestand ohne
  Zahlen der Freitext („6 bis 10 Jahre“, „ab 15“, „11–14“, „16+“, „bis 10“, „unter 10“); passt keine genau, die nächstgelegene (Hinweis im Text).
  Gruppen ohne Altersangabe zählen nie.
- Ablage (`storeWebsiteRequest` in `contact.service.ts`, gemeinsam mit dem Kontaktformular): Postfach `group:<id>`, wenn es im Verzeichnis steht
  (Kontakt-E-Mail der Gruppe) **und** mindestens eine Leitung mit eigenem Konto und `send` mitliest; sonst Stamm-Postfach mit Hinweis „bitte weiterleiten“,
  ohne Stamm-Adresse „Nicht zugeordnet“. Betreff „Probestunde: <Kind> (<Alter> Jahre)“, Antwort an die eingegebene Adresse, Benachrichtigung `inbox-new`.
- Audit `messages.inbox.trial-received` nur `{ mailbox: group|stamm|unassigned }`.
- Tests `tests/unit/messages-trial.test.ts` (Altersangaben, Auswahl, Kopie gleich), `tests/integration/messages-trial.test.ts`, Website-Parser in `website-contact.test.ts`.

## Zusätzliche Postfächer und Weiterleitungen (2026-10-26, v1.6.0, Migr. 0006)
Verwaltung unter Administration → Module → „Postfächer“ (`/modules/messages/admin`, Recht `messages.mailbox.manage`).
- **Zusätzliche Postfächer** (`extra_mailboxes`: Name, Adresse klein + eindeutig, Beschreibung): Schlüssel `extra:<id>` (`MailboxKind` `extra`, gemeinsam,
  Icon `AtSign` im Baum). Freigaben `extra_mailbox_shares` (Muster `<obj>_shares`, Typen `group|member|user`, Stufe `read` = Lesen, `edit` = Lesen und
  senden). Zugriff je Request über `principalKeysFor` + `principalMatchSql` (`myExtraMailboxes`, höchste Stufe); Gruppe = verknüpfte Konten der Mitglieder
  und Leitungen. Nur Konten mit `messages.message.send`. Verzeichnis (`loadMailboxDirectory`) über `principalUserIds(…, { permission: send })`.
- `accessibleMailboxes`: Zusatzpostfächer mit `senderKey` nur bei `edit`; `listSenders` bietet nur `edit` als Absender an (`requireSender` → sonst 403).
  Aus einem Nur-Lesen-Postfach geht Antworten/Weiterleiten trotzdem (`canReply`), die Vorbelegung hat dann `senderKey: null` (eigener Absender).
- **Weiterleitungen** (`mailbox_aliases`: Adresse → `target_key`): im Verzeichnis als zusätzlicher Eintrag mit Alias-Adresse und Schlüssel/Name/Konten des
  Ziels (`MailboxEntry.alias = true`; nicht als Zuordnungsziel in `GET /mailboxes/all`). Unbekanntes Ziel → übersprungen → „Nicht zugeordnet“.
  Alias-Domains zählen automatisch als eigene Domains (`ownDomains` aus dem Verzeichnis). Nichts wird nach außen weitergeleitet.
- **Adressen eindeutig**: Konflikt mit jeder Verzeichnis-Adresse (persönlich, Amt, Gruppe, Stamm, zusätzlich, Weiterleitung) → **409**; in der Transaktion
  zusätzlich unter Advisory-Sperre `messages:mailbox-addresses` gegen die eigenen Tabellen. Persönliche Adressen von Konten **ohne** `send` werden nicht geprüft.
- **Löschen**: Mails → `unassigned` (`folder_id = NULL`, Grund `unknown`, Gelesen-Status weg; liegt dieselbe Mail schon in „Nicht zugeordnet“, entfällt die
  Kopie samt Anhängen), Ordner und Weiterleitungen auf das Postfach gelöscht. Gesendete Nachrichten behalten `mailbox_key`.
- **API** (alle `messages.mailbox.manage`): GET/POST `/admin/mailboxes`, PATCH/DELETE `/admin/mailboxes/:id` (`shares[{type,id,level}]`, `validatePrincipals`;
  bestehende Freigaben bleiben gültig, `describePrincipals`), GET `/admin/principals?search=` (`searchPrincipals`, Typen group/member/user,
  `PRINCIPAL_SEARCH_RATE_LIMIT`), GET `/admin/aliases` (`{ aliases, targets }`, Ziele = Verzeichnis ohne Weiterleitungen, nach Art sortiert), POST `/admin/aliases`
  `{ address, targetKey }` (422 unbekanntes Ziel/„Nicht zugeordnet“), DELETE `/admin/aliases/:id`.
- **Audit** `messages.mailbox.created|updated|deleted` (`shares`, `addressChanged`, `movedMessages`, `deletedAliases`), `messages.alias.created|deleted` (`targetKind`) –
  keine Adressen/Namen.
- **Datenschutz**: `onUserDeleted` löscht `user:`-Freigaben des Kontos und Weiterleitungen auf `personal:<userId>`, `created_by` → `NULL`; neu `onMemberDeleted`
  löscht `member:`-Freigaben. Kein Reset-Bereich im Modul (es gibt keinen).
- **Oberfläche** `MailboxAdminPage`: Hinweis (Adressen müssen im Catch-all ankommen, Zugriff nur mit „Nachrichten senden“), Reiter Postfächer (`DataTable`, Freigaben als
  Badges, Mails, Menü Bearbeiten/Löschen mit `ConfirmDialog`) | Weiterleitungen (Adresse → Ziel, fehlendes Ziel als Warnung). `ExtraMailboxDialog` mit `SharePanel`
  (Stufen „Lesen“/„Lesen und senden“, gespeichert erst mit dem Formular). Ziele im `SelectField` als „Art: Name (Adresse)“ (keine Gruppen-Überschriften).
- **Tests**: `tests/integration/messages-extra-mailboxes.test.ts` (IMAP-Ersatz), Schlüssel `extra:` in `tests/unit/messages-inbox.test.ts`, E2E `messages.spec.ts`
  (Zusatzpostfach + Weiterleitung anlegen, Konflikt).
- **Offen**: echter Provider-Catch-all für die neuen Adressen ungeprüft; Benachrichtigungs-Einstellungen gelöschter Zusatzpostfächer bleiben im Core liegen.

## Offen
Opt-out/Abbestellen, Vorlagen, zeitgesteuerter Versand, Platzhalter („Hallo {{vorname}}“), Test-Mail an sich selbst, Anhang-Download im Verlauf.
