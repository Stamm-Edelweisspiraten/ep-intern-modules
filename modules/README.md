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

Module dürfen `$lib/sdk/*`, die UI-Bausteine `$lib/components/{ui,layout,forms}` sowie `$lib/forms`, `$lib/pdf-lists`
und `$lib/utils` importieren; fremde Module nur als `import type` aus `$lib/modules/<id>/contract`, nichts aus
`$lib/server/*` (ESLint, siehe `docs/module-development.md` → „Erlaubte Importe“).
