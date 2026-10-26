---
paths: ["src/lib/modules/tasks/**", "tests/**/tasks*"]
---

# Modul `tasks` (Aufgaben, Kanban)

Kanban-Boards mit frei benennbaren Spalten, Aufgaben (Titel, Beschreibung, Priorität, Fälligkeit, **mehrere Zuständige**) und
**Unteraufgaben als Checkliste** (je Titel, abgehakt, optional eine zuständige Person und Fälligkeit). Boards sind freigebbar an
Principals (Stamm, Gruppe, Rolle, Mitglied, Benutzer*in) und können an **eine Aktion** gehängt werden – dann vererbt sich der Zugriff
der Aktion. Schema `mod_tasks`, Version 1.0.0 (2026-10-25), keine harten Abhängigkeiten, `optionalDependencies: ['members', 'actions']`.
Navigation „Aufgaben“ (Icon `kanban`, `order` 75).

Nutzerentscheidungen (2026-10-25): eigenes Modul **plus** Verknüpfung mit Aktionen; Spalten **frei je Board** (Start Offen · In Arbeit ·
Erledigt, genau eine Erledigt-Spalte); Unteraufgaben als **Checkliste** (keine vollwertigen Unter-Karten).

## Dateien (`src/lib/modules/tasks/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (Rechte – **keine** `defaultRoleGrants`, siehe Fallen), Benachrichtigungen, Job `due-reminders` (täglich), Hooks, Endpoints in `withTaskContext` |
| `schemas.ts` | Konstanten (`PRIORITIES`, `DEFAULT_COLUMNS`, `BOARD_COLORS`, Limits), Zod-Eingaben, DTOs (`Board`, `BoardDetail`, `TaskCard`, `TaskDetail`, `ChecklistItem`, `MyTask`, `BoardShares`, `ActionBoardInfo`), reine Helfer `dueState`, `reorder` |
| `access.ts` | `boardShareAccess` (`createShareAccess`), `loadTaskContext`/`withTaskContext` (Principal-Schlüssel + Aktions-Zugriffe **vor** der Transaktion), `resolveBoardAccess`/`requireBoardAccess`, `visibleBoardsFilter`, `boardAccessForMany`, `requireTask(…, 'read'|'edit'|'move')` |
| `boards.service.ts` | Laden in der Transaktion, Namen danach (`buildBoards`, `buildDetail`, `buildTask`, `taskDetail`), `assertAssignable`, `writeColumnOrder`, `lockBoard` (Advisory-Sperre je Board) |
| `boards.endpoints.ts` | Boards, Freigaben, `/principals`, `/boards/:id/people`, Spalten |
| `tasks.endpoints.ts` | Aufgaben, Verschieben, Unteraufgaben, `/my/tasks` |
| `notify.ts` | `notifyAssigned`, `notifyBoardShared`, `sendDueReminders` (Job), `boardLink` |
| `privacy.ts` | `onUserDeleted`, `resetAreas` (`all`, `rebuild`), `resetUsers`, `subjectExport` |
| `search.ts` | Globale Suche: Boards und Aufgaben (sichtbar wie `GET /boards`), Link `?task=` |
| `contract.ts`, `refs.service.ts` | Dienst `TaskRefsService` (`provides`, 2026-10-26): `searchBoardRefs`/`describeBoardRefs`/`searchTaskRefs`/`describeTaskRefs` – sichtbar wie `GET /boards`, prüft `tasks.board.view` selbst; Nutzer: Karten im `whiteboard` |
| `ui.ts`, `pages/` | `''` → `BoardsPage` (Karten mit Fortschritt), `:id` → `BoardPage` (Spalten, Ziehen & Ablegen, Filter, Schnell-Anlegen); `TaskDialog`, `TaskCardView`, `BoardDialog`, `helpers.ts`; Kachel `widgets/MyTasksWidget` („Meine Aufgaben“) |
| `migrations/0001_init.sql` | `boards` (UNIQUE `action_id`), `board_shares`, `board_columns`, `tasks` (`column_id` RESTRICT, `completed_at`, `reminded_on`), `task_assignees`, `task_checklist` |

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `tasks.board.view` | Grundrecht aller Endpunkte; eigene, freigegebene, über Aktionen sichtbare Boards und Boards mit eigenen Aufgaben |
| `tasks.board.create` | Boards anlegen (mit Aktion nur bei Bearbeiten-Zugriff auf die Aktion) |
| `tasks.board.view-all` / `edit-all` | alle Boards lesen / bearbeiten, teilen, löschen |

## Zugriff (`access.ts`)
Bearbeiten: System, `edit-all`, Eigentümer*in, Freigabe `edit`, verknüpfte Aktion mit Bearbeiten-Zugriff. Lesen: Freigabe `read`, `view-all`,
Aktion lesbar, **einer Aufgabe oder Unteraufgabe zugewiesen**. Sonst 404. Teilen/Löschen/Aktion umhängen nur Eigentümer*in bzw. `edit-all`.
Zugewiesene mit Lesezugriff dürfen ihre Aufgaben **verschieben** und Unteraufgaben **abhaken** (`requireTask(…, 'move')`), sonst nichts (403).
Aktions-Zugriffe kommen über `ActionsService.accessibleActions(ctx)` (neu in `actions`, ≤ 1000 Aktionen), einmal je Request.

## Regeln
- Zuständige = aktive Konten mit `tasks.board.view` (`assertAssignable`, 422); gespeicherte bleiben ohne erneute Prüfung. Vorschläge
  (`GET /boards/:id/people`): Eigentümer*in, Konten hinter Freigaben (ohne „Stamm“), bisherige Zuständige; mit `search` alle mit Recht.
- Positionen je Spalte 0…n, beim Verschieben neu nummeriert (`reorder`, unter `lockBoard`). In der Erledigt-Spalte → `completed_at`; Wechsel
  der Erledigt-Spalte gleicht alle Aufgaben ab. Spalte mit Aufgaben nur mit `?moveTo=` löschbar (sonst 409), letzte Spalte bleibt.
- Grenzen: 20 Spalten, 2000 Aufgaben je Board, 20 Zuständige, 100 Unteraufgaben (409 bzw. 422).
- Audit `tasks.board.created|updated|deleted|shared`, `tasks.column.created|updated|deleted|reordered`, `tasks.task.created|updated|deleted` –
  nur IDs/Zähler/Feldnamen. Verschieben und Abhaken werden nicht auditiert (zu häufig).

## API (`/api/v1/modules/tasks/…`, alle `tasks.board.view`, sonst angegeben)
| Methode + Pfad | Besonderheiten |
|---|---|
| GET/POST `/boards` | POST braucht `create`; `actionId` optional (409 bei zweitem Board) |
| GET `/boards/by-action/:actionId` | `{ board, canCreate }` für die Karte in der Aktion; Aktion nicht sichtbar → 404 |
| GET/PATCH/DELETE `/boards/:id` | PATCH `actionId` nur Eigentümer*in; DELETE löscht alles |
| GET/PUT `/boards/:id/shares`, GET `/principals` | wie `events`/`galleries` (`requireShareCapability`) |
| GET `/boards/:id/people?search` | Bearbeiten-Zugriff |
| POST `/boards/:id/columns`, PUT `…/columns/order`, PATCH/DELETE `…/columns/:columnId[?moveTo]` | Antwort `BoardDetail` |
| POST `/boards/:id/tasks`, GET/PATCH/DELETE `/tasks/:id`, POST `/tasks/:id/move` | `move` `{ columnId, position }` |
| POST `/tasks/:id/checklist`, PUT `…/checklist/order`, PATCH/DELETE `…/checklist/:itemId` | PATCH nur `done` = `move`-Recht |
| GET `/my/tasks?limit&done` | zugewiesen (direkt oder offene Unteraufgabe), Fälligkeit, Priorität |

## Benachrichtigungen
`task-assigned` (neu zugewiesen, auch Unteraufgaben, Sammelmail möglich), `task-due` (Job, heute/morgen fällig, einmal je Tag über
`reminded_on`; neue Fälligkeit setzt es zurück), `board-shared` (neu/hochgestuft, ohne „Stamm“). Nie an die handelnde Person.

## Aktion
`actions` zeigt in der Übersicht die Karte `ActionTasksCard` (nur REST, kein Import): Zähler + „Board öffnen“ bzw. „Board anlegen“
(Name = Aktion). Die Freigabe der Aktion gilt für das Board zusätzlich zu dessen eigenen Freigaben.

## Tests
`tests/integration/tasks.test.ts` (Standardspalten, Zugriffsmatrix inkl. Gruppe/Zuweisung/Aktion, Aufgaben + Unteraufgaben, Verschieben/Erledigt,
Reihenfolge, Validierung, „Meine Aufgaben“, Spalten, Aktion-Board und Vererbung, Audit ohne Inhalte, Fälligkeits-Job, Konto löschen, Modul aus);
E2E `tests/e2e/tasks.spec.ts` (Board anlegen, Schnell-Anlegen, Unteraufgabe abhaken, per Spaltenauswahl erledigen, per Ziehen verschieben inkl. Neuladen, Board aus der Aktion anlegen).

## Fallen
- **Keine `defaultRoleGrants` an Rollen, die andere Module verleihen** (z. B. „Amtsinhaber*in“): Die Rechte stehen dann an der Rolle, sind aber bei
  inaktivem Modul niemandem wirksam → `assertCanGrant` lehnt das Besetzen von Ämtern als „Rechteausweitung“ ab (E2E `offices.spec.ts` fiel so um).
- Beim Ziehen nie das Element unter dem Mauszeiger aus dem DOM nehmen (Platzhalter „Keine Aufgaben“ bleibt), sonst kommt in Chromium kein `drop`;
  `onDrop` berechnet die Position selbst, weil `dragleave` das Ziel vorher löschen kann.

## Offen
- Ziehen & Ablegen nur mit Maus (Touch: Knöpfe „Zurück/Weiter“, Tastatur Alt+←/→, Spalten-Auswahl im Dialog).
- Keine Kommentare, Anhänge, Labels, wiederkehrenden Aufgaben, Vorlagen; Unteraufgaben im Dialog nicht per Ziehen sortierbar (API `…/checklist/order` vorhanden).
- Zuständige ohne eigene Board-Freigabe sehen das ganze Board lesend (bewusst: Zuweisen = Einblick).
