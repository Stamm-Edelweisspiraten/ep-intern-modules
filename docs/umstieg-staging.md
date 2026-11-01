# Umstieg EP Intern → Kalypzo Atrium + Module-Repo (Phase 9, Runbook)

Stand 2026-11-01. Drei Stufen; jede ist allein lauffähig und hat einen Rückweg. Die Datenbank bleibt in allen Stufen
dieselbe: Modul-IDs, Migrationsnamen und -prüfsummen ändern sich nicht.

| Stufe | Quelle des Deployments | Module | Stand |
|---|---|---|---|
| **R2** | `ep-intern-2`, Branch `staging` | im Image (eingebaut, „builtin“) | **gepusht** (`a2d8c99`, Phasen 1–7 + Docker-/Compose-Fixes) |
| **R2b** | `ep-intern-2`, Branch `staging` | im Image + neues Modul `ep-stamm` | lokal committet (Phase N + Supervisor-/ESLint-Fixes), **nicht gepusht** |
| **R3** | `kalypzo-atrium` (Core, ohne Module) | per Seed aus `ep-intern-modules` am festen Commit | lokal vorbereitet unter `K:\atrium-split` |

## 0. Vor jeder Stufe

1. Datensicherung in der App: Administration → Datensicherung → Export (alle Bereiche, mit Dateien) → `.epbackup`/`.atriumbackup` sicher ablegen.
2. Zusätzlich `pg_dump` der Staging-Datenbank (Dokploy → Datenbank-Container):
   `pg_dump -U ep_intern -Fc ep_intern > staging-YYYY-MM-DD.dump`.
3. Wartungsfenster ankündigen (R3: Neubau beim ersten Start dauert im Container mit 1 CPU einige Minuten).

## 1. R2 prüfen (läuft bereits)

- Dokploy: Deploy von `a2d8c99` grün? (Der vorherige Push `fa624ef` konnte wegen des nicht deklarierten Volumes
  `atrium-data` scheitern – `a2d8c99` behebt das.)
- Compose-Stack hat jetzt das Volume `atrium-data` und `mem_limit` 4 GB für `app`; der Server braucht dafür freien RAM.
- `GET /api/v1/health` → 200. Administration → Module: alle Module „aktiv“, Herkunft „eingebaut“.
- Optional: Modul-Installation testen (kleines Test-ZIP), danach wieder entfernen.

## 2. R2b: Phase N auf Staging

1. `git push origin staging` im Repo `ep-intern-2` (Autodeploy).
2. **Sofort danach** als Admin: Administration → Module → **„Stammesprofil“ (`ep-stamm`) aktivieren**. Ohne das Modul
   sieht Staging neutral aus (Systemname „Kalypzo Atrium“, neutrale Icons, Briefkopf ohne Wappen, Freigabe „Alle“ statt „Stamm“).
3. Prüfen: Login-Seite/Seitenleiste (Name „EP Intern“, Wappen), Einstellungen → PDF (Vorlagen „Ersetzt durch Modul:
   Stammesprofil“), Einstellungen → E-Mail-Layout (Lilie, Wappen), eine Rechnung/einen Bericht als PDF, Freigabe-Dialog („Stamm“).
4. Sprache: Einstellungen → Allgemein → Sprache steht durch `ep-stamm` auf Deutsch; Englisch je Person im Profil.
5. Rückweg: `ep-stamm` deaktivieren ändert nur das Aussehen; Code-Rückweg = vorheriges Deployment in Dokploy.

## 3. R3 vorbereiten (GitHub)

1. Auf GitHub (privat) anlegen: `kalypzo-atrium`, `ep-intern-modules`, `ep-website`.
2. Lokal pushen:
   ```bash
   cd K:/atrium-split/kalypzo-atrium    && git remote add origin https://github.com/CrayonGamerHD-Philipp/kalypzo-atrium.git    && git push -u origin main --tags
   cd K:/atrium-split/ep-intern-modules && git remote add origin https://github.com/CrayonGamerHD-Philipp/ep-intern-modules.git && git push -u origin main
   cd K:/atrium-split/ep-website        && git remote add origin https://github.com/CrayonGamerHD-Philipp/ep-website.git        && git push -u origin main
   ```
   Das Submodul `.core` zeigt relativ auf `../kalypzo-atrium` → nach dem Push automatisch auf das GitHub-Repo daneben.
3. GitHub-Token (fein granular, nur Lesen von `ep-intern-modules`) für den Server erzeugen.
4. `ep-intern-2` auf GitHub archivieren (erst nach erfolgreichem R3).

## 4. R3 auf Staging

1. Dokploy-Stack der App auf das Repo `kalypzo-atrium` (Branch `main`) umstellen; gleiche Compose-Datei
   `docker-compose.dokploy.yml` (Volumes/Namen unverändert → Datenbank und Dateien bleiben).
2. Umgebung ergänzen:
   - `ATRIUM_MODULES_SEED` = Inhalt von `deploy/staging.seed.json` dieses Repos (eine Zeile JSON, Commit = gepushter Stand von `ep-intern-modules`)
   - `ATRIUM_GITHUB_TOKEN` = Token aus 3.3
   - `ATRIUM_MODULE_INSTALL=supervisor` (Standard), `APP_MEM_LIMIT=5g` (Neubau aller Module braucht knapp 4 GB)
3. Deploy. Ablauf beim ersten Start: Supervisor startet den mitgelieferten Build (nur Core) → lädt die Module am Commit →
   baut → Probelauf → Neustart mit Modulen. In der Zwischenzeit sind die Module „Nicht installiert“ (Daten bleiben).
4. Prüfen: Administration → Module (alle wieder aktiv, Herkunft GitHub + Commit), Stichproben in Kasse, Mitglieder, Aktionen,
   Termine; PDF und Mail; Health.
5. Stammeswebsite: neuer Dokploy-Stack aus `ep-website` (`docker-compose.dokploy.yml`), Domain auf `website:3001`,
   `WEBSITE_API_URL` = öffentliche Adresse des Intern-Bereichs, `WEBSITE_API_KEY` wie bisher. Danach den Dienst `website`
   im alten Stack entfernen (ist in `kalypzo-atrium` nicht mehr enthalten).
6. Rückweg: Stack wieder auf `ep-intern-2`/`staging` (R2b) stellen – Datenbank ist kompatibel; `module_install`-Einträge
   bleiben stehen und stören nicht.

## 5. Updates nach R3

- Module: Änderung in `ep-intern-modules` committen/pushen → Administration → Module → „Nach Updates suchen“ → Aktualisieren.
- Core: neuer Tag in `kalypzo-atrium` → Submodul `.core` im Module-Repo nachziehen und prüfen → Deploy des Core-Stacks;
  der Supervisor baut die Module beim Start gegen den neuen Core neu.

## Lokaler Probelauf (2026-11-01, bestanden)

Docker, PostgreSQL 17, App mit `read_only`, `cap_drop ALL`, 2 CPU, 4 GB:

1. **R2-Image** (`ep-intern-2`, Phase N) gegen frische Datenbank, alle 15 Module aktiviert, Mitglied/Aktion/Termin angelegt.
2. **R3-Image** (`kalypzo-atrium` v2.0.0-pre.2, ohne Module) gegen **dieselbe** Datenbank und dasselbe Volume: startet, Module
   „Nicht installiert“, Daten unberührt.
3. Module per Panel aus dem ZIP von `ep-intern-modules` installiert (alle 15): Neubau + Probelauf + Neustart **107 s**.
4. Vergleich vorher/nachher: `module_migration` (Namen + Prüfsummen), `module_state`, Rechte, Rollenrechte, `role_grant_applied`,
   Daten – **identisch**; alle Module aktiv, Seiten und API liefern die Daten, Stammesprofil wirkt (Name „EP Intern“, Wappen).
5. Container-Neustart: Supervisor startet direkt die gebaute Generation mit Modulen.

Dabei gefunden und behoben: Installer lehnte Repo-Archive mit `.github/`/`.claude/` ab (jetzt übersprungen); Modul-Pakete
wurden doppelt neben dem Core installiert (`prosemirror-model` zweimal → Notizen kaputt; jetzt dedupliziert).

**Speicher:** Spitze beim Neubau aller Module **3,98 GiB** (inkl. laufender App und Datei-Cache) bei Limit 4 GB – für Staging
`APP_MEM_LIMIT=5g` setzen (oder `ATRIUM_BUILD_HEAP=2560`). Den GitHub-Weg (Seed mit Token) prüft erst der echte R3-Schritt.
