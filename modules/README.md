# Module

Hier liegen Erweiterungsmodule (`src/lib/modules/<id>/`). Der Core liefert bewusst keine
Fachmodule aus. Siehe `docs/module-development.md`.

Minimaler Aufbau:

```
src/lib/modules/<id>/
├── module.ts        # export default defineModule({ manifest, settings, endpoints, migrations })
├── ui.ts            # export default { routes: { '': () => import('./pages/Index.svelte') } }
└── pages/…
```

Module duerfen `$lib/sdk/*` sowie die UI-Bausteine `$lib/components/{ui,layout}` importieren, aber nichts
aus `$lib/server/*` (ESLint-Regel `no-restricted-imports`).
