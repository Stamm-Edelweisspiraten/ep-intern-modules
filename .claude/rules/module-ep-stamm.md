---
paths: ["modules/ep-stamm/**"]
---

# Modul Stammesprofil (`ep-stamm`)

Profil-Modul der Edelweißpiraten (seit Kalypzo Atrium Phase N, 2026-11-01): Der Core ist neutral, dieses Modul liefert das bisherige
Aussehen von EP Intern über Core-Hooks. Keine Rechte, keine Navigation, keine Migrationen, keine Daten. Mit aktivem Modul sieht EP Intern
aus wie vorher; deaktiviert → neutraler Core.

## Dateien
- `atrium-module.json` (id `ep-stamm`, „Stammesprofil“, `permissions: []`), `module.ts` (`defineModule` mit den Hooks).
- `letterhead.ts`: `STAMM_TEMPLATES` = `createLetterTemplate` mit IDs `brief`, `briefkopf`, `briefkopf-quer` (ersetzen die Core-Vorlagen gleicher
  ID, alte IDs `stamm-*` laufen über die Core-Aliase), `stammLetterhead` (Kopf: Lilie, „Christliche / Pfadfinderschaft / Deutschlands e.V.“,
  Wappen an `geo.mark`/`geo.title`/`geo.emblem`; Fußzeile `FOOTER_TEXT_LINES` = CPD-Vereinsnachweis, hochkant zwei Zeilen, quer ein Absatz).
  Maße kommen aus der Core-Geometrie (`letterGeometry`), Referenz `docs/reference/briefkopf_stamm_adressfeld_page_1.png`.
- `defaults.ts`: `STAMM_SETTING_DEFAULTS` (`settingDefaults`, wirken nur bei aktivem Modul und ohne gespeicherten Wert): `core.system.name`
  „EP Intern“, `core.org.everyoneLabel` „Stamm“, `core.system.locale` „de“, `core.mail.footerText` (Vereinsnachweis), `core.ai.style.tone`,
  `core.ai.style.greeting` „Gut Pfad!“, `core.ai.style.context` (evangelischer Pfadfinderstamm).
- `assets/`: `lilie.png`/`wappen.png` (PDF, hochauflösend), `mail-lilie.png`/`mail-wappen.png` (Mail, klein), `icons/*` (frühere App-Icons
  mit Wappen; `icon-512.png` = `brandingLogo`).
- `mailBranding`: Titel mit Zeilenumbrüchen, `mark` Lilie (alt „Pfadfinder-Lilie“), `emblem` Wappen (alt „Wappen“, nur mit `core.mail.showEmblem`).
- `brandingLogo`: Wappen als Logo für Favicon/App-Icons/Seitenleiste/Login, solange kein Logo hochgeladen ist.

## Regeln
- Texte bleiben deutsch (Modul der Organisation, kein i18n nötig).
- Nichts Fachliches hier ablegen – nur Aussehen und Vorgaben. Neue Hooks zuerst im Core (`ModuleDefinition`) anlegen.
- Demo: `scripts/seed-demo-modules.mjs` aktiviert `ep-stamm` zuerst.
- Tests: `tests/unit/letterhead.test.ts` (Maße, Lilie/Wappen, Vereinsnachweis, Vorgaben), `tests/integration/ep-stamm.test.ts`
  (Ersatz nur bei aktivem Modul, gespeicherte Einstellungen gewinnen, Mail-Kopf, Logo/Icons).

## Offen
- `static/icons/badge-96.png` (Android-Statusleiste) ist neutral und lässt sich nicht per Modul ersetzen.
- Typ-Badge „Alle“ in Freigabe-Listen (`PRINCIPAL_TYPE_LABELS.everyone`) zeigt nicht „Stamm“; der Name des Eintrags kommt aus
  `core.org.everyoneLabel` bzw. dem `everyoneLabel` des Moduls.
