# Modul `messages` (Nachrichten)

E-Mails an Mitglieder, Gruppen und frei eingegebene Adressen aus dem Intern-Bereich: Rich-Text-Editor, mehrere Anhänge, wählbarer Absender
(persönlich `vorname.nachname@domain`, Funktions-Adressen der eigenen Ämter, Gruppen-Adresse, Stamm-Adresse),
Einzelversand je Empfänger im Hintergrund, Verlauf mit Status je Empfänger. Schema `mod_messages`, Version 1.0.0,
`dependencies: ['members']`, `optionalDependencies: ['offices']`. Navigation „Nachrichten“ (Gruppe „Stamm“, Icon `mail`).

## Dateien (`src/lib/modules/messages/`)
| Datei | Inhalt |
|---|---|
| `ui.ts` | Routen `''` → `HistoryPage`, `new` → `ComposePage`, `:id` → `MessageDetailPage` |
| `module.ts` | Manifest (Rechte), Einstellungen `messages.*`, Jobs `resume` (stündlich) und `cleanup` (täglich), Endpoints |
| `schemas.ts` | Konstanten (Limits, Rechte-/Einstellungsschlüssel), Zod `recipientsInput`/`sendInput`, DTOs |
| `sender.ts` (rein) | `personalAddress`, `slugPart`, `firstGivenName`, `splitFullName`, `isValidDomain`, `dedupeAddresses` |
| `html.ts` (Server) | `sanitizeBody` (sanitize-html, Whitelist), `htmlToText` (Klartext-Fassung), `plainDocument` (HTML für „Einfach“) |
| `sender.service.ts` | `loadSettings`, `listSenders(ctx)`, `requireSender(ctx, key)` (prüft den Absender serverseitig erneut) |
| `recipients.service.ts` | `resolveRecipients(ctx, input)`: Mitglieder/Gruppen → eindeutige Adressen, Bereichsprüfung; freie Adressen (`addresses`) zuletzt angehängt |
| `delivery.service.ts` | `createMessage`, `previewMessage`, `getMessage`, `listMessages`, `retryMessage`, Versand (`deliver`), `resumeDeliveries`, `cleanup` |
| `messages.endpoints.ts` | REST (siehe unten) |
| `pages/` | `HistoryPage`, `ComposePage`, `MessageDetailPage`, `helpers.ts` |
| `migrations/0001_init.sql` | `messages`, `message_recipients`, `message_attachments` |

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `messages.message.send` | Nachrichten senden, eigene Nachrichten/Verlauf sehen. Empfänger: mit `members.member.view` (Gruppen zusätzlich `members.group.view`) alle, als Gruppenleitung (`members.led-member.view`) nur die Mitglieder der eigenen Gruppen |
| `messages.message.view-all` | Nachrichten aller Personen sehen |
| `messages.settings.manage` | Einstellungen ändern (Schreibrecht der Modul-Einstellungen) |

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
- Der Schlüssel (`personal`, `stamm`, `office:<id>:<adresse>`, `group:<id>`) kommt vom Client, die Adresse nie: unbekannt/nicht erlaubt → **403**.

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

## Offen
Opt-out/Abbestellen, Vorlagen, zeitgesteuerter Versand, Platzhalter („Hallo {{vorname}}“), Test-Mail an sich selbst, Anhang-Download im Verlauf.
