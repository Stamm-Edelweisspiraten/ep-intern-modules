# EP Intern – Fachmodule für Kalypzo Atrium

Die Fachmodule der Edelweißpiraten für die Plattform [Kalypzo Atrium](../kalypzo-atrium) (Core, eigenes Repo).
Alle Module liegen unter `modules/<id>/`, der Katalog unter `modules/atrium-modules.json`.

| Modul | Inhalt |
|---|---|
| `ep-stamm` | Stammesprofil: Briefkopf, Mail-Kopf, Wappen, Vorgaben (Systemname „EP Intern“, „Stamm“, KI-Ton) – **zuerst aktivieren** |
| `members` | Mitglieder & Gruppen |
| `actions` | Aktionen: Kalkulation, Zuschuss, Anmeldelink, Abrechnung |
| `treasury` | Kasse: Konten, Buchungen, Rechnungen, Jahresbeitrag |
| `events` | Termine (Serien, Tags, Freigabe, Website-API, Kalender-Abo) |
| `galleries` | Galerien |
| `offices` | Ämter |
| `orders` | Bestellungen |
| `files` | Dateien |
| `messages` | Nachrichten und Posteingang |
| `tasks` | Aufgaben (Kanban) |
| `website` | Inhalte der Stammeswebsite (Banner, FAQ, Blog) |
| `material` | Materialverwaltung |
| `whiteboard` | Whiteboards |
| `notes` | Notizen |

## Installation auf einem Server

Administration → Module → **Installieren** → Link `https://github.com/<owner>/ep-intern-modules/tree/<commit>/modules`
(oder ZIP dieses Repos) → Module auswählen; Abhängigkeiten werden vorgeschlagen. Für frische Deployments: Seed
(`ATRIUM_MODULES_SEED`, siehe `docs/deployment.md` im Core).

## Entwickeln

Der Core ist als Git-Submodul `.core` auf einen festen Tag gepinnt.

```bash
git clone --recurse-submodules <url> && cd ep-intern-modules
npm run setup        # Core-Abhängigkeiten, node_modules-Link, Pakete der Module
npm run check        # Typprüfung (Core + Module)
npm test             # Tests der Module (Vitest, PGlite)
npm run build        # Produktions-Build
npm run e2e          # Playwright (Module + modulübergreifend)
npm run demo         # Demo-Server http://localhost:4300 mit diesen Modulen
npm run check:catalog && npm run check:migrations
```

Core aktualisieren: `git -C .core fetch --tags && git -C .core checkout <tag>`, dann `npm run setup -- --force`, prüfen, committen.
Angewendete Migrationen sind unveränderlich (`check:migrations` vergleicht mit dem letzten Tag dieses Repos).

Regeln für die Arbeit an Modulen: `.core/.claude/rules/modules.md` (Muster, Rechte, Endpunkte) und `.claude/rules/module-<id>.md`.
