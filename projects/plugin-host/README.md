# Pluxel Architecture Lab

> Status: internal workspace application and end-to-end architecture smoke. It is not published.

`projects/plugin-host` is the runnable reference host for Pluxel. It loads every official Plugin,
starts the dependency chains that work without external infrastructure, and exposes the important
architecture choices through the Workbench instead of leaving them in logs-only toy examples.

The product identity in both routes is **Pluxel Architecture Lab**:

- `dynamic`: host-owned Vite server, all 16 official concrete Plugins source-loaded through loader
  HMR, including the dynamic-only Package Manager;
- `static`: host-owned Vite server and production freezer, the other 15 official Plugins. Package
  Manager is intentionally absent because its source-producer contract is dynamic-only.

Redis and its Cache/Rates backends are loaded into the catalog but remain stopped by default. This
keeps the host useful without a local Redis while preserving real implementation choices in the
Workbench. Memory is the explicit default for both backend tokens.

## Run

dynamic HMR:

```sh
pnpm plugin-host:dynamic
pnpm --filter @pluxel/plugins-host dynamic
```

static fixed catalog:

```sh
pnpm plugin-host:static
pnpm --filter @pluxel/plugins-host static
```

Open the Workbench and select **Architecture Lab**. One report generation exercises this graph:

```text
Rates -> admission Part
Cache -> rendering Part -> ShowcaseRenderer
                         ├─ ECharts -> Canvas -> Fonts
                         ├─ Takumi ----------> Fonts
                         └─ Canvas ----------> Fonts
S3#drafts   -> publishing Part
S3#releases -> ReleaseArchivePlugin
Wretch      -> provider-owned HTTP settings Attachment
Otel        -> report metrics at /showcase/metrics
```

The page shows the exact injected nodes, cache/rate facts, generated image, draft object key and
the Workbench location of each architecture surface. Preview metadata stays small over Cap’n Web;
the image itself is read from the stored artifact route. The same Plugin also registers:

- HTTP: `GET /showcase/status`, `POST /showcase/generate/:title`,
  `GET /showcase/artifacts/:id`;
- Commands: `showcase.report.generate`, `showcase.cache.clear`;
- Workbench: a Direct View with a fresh Cap'n Web target and observer, plus Wretch's provider-owned
  Attachment;
- nested PluginPart config for admission, rendering and publishing.

## Choices worth changing in the Workbench

- Change the `ShowcaseRenderer` dependency between ECharts, Takumi and Canvas. The consumer and its
  dependent closure restart with a newly bound caller facade.
- Inspect the two `S3Plugin` forks. `drafts` and `releases` use separate local buckets and are bound
  with per-consumer dependency overrides.
- Change `CacheBackend` or `RatesBackend` from Memory to a Redis implementation after configuring
  and starting Redis. A failed external provider blocks only its required branch.
- Edit the Report Studio Part config, Wretch Attachment settings, Fonts selection, auth setup and
  official Plugin config forms.
- Inspect plugin graph, lifecycle, logs and Agent tools; these are host-owned projections of the
  same runtime state used by the showcase.

The catalog keeps only two focused legacy scenarios that add semantics not already covered by
Report Studio: a required `EvtChannel` edge and optional-provider attach/detach. Their graph,
lifecycle and logs are visible in the Workbench. The other examples remain in `src/demo` as focused
source references and tests without cluttering the default runtime catalog.

## Loader HMR Tools

```sh
pnpm --filter @pluxel/plugins-host dynamic:prompt
pnpm --filter @pluxel/plugins-host dynamic:doctor
```

## Boundary

- Dynamic and static use the same official/showcase catalog and auto-start policy, except for the
  explicit Package Manager boundary.
- Dynamic uses a host-owned Vite server and wires loader HMR through `dynamicRuntimeVitePlugin`;
  official packages, host showcases and managed packages are ordinary mutable sources.
- Static uses a host-owned Vite server and wires the fixed catalog through `staticRuntimeVitePlugin`.
- Plugin source is always evaluated by the Pluxel Vite/Rolldown transform chain; raw TypeScript
  runners are intentionally not runtime entries.
- Workbench MF2 producers, exposes and shared policy are generated from definitions. This project
  does not hand-author a Module Federation config.

## Verify

```sh
pnpm --filter @pluxel/plugins-host typecheck
pnpm --filter @pluxel/plugins-host test
pnpm --filter @pluxel/plugins-host dynamic:doctor
pnpm --filter @pluxel/plugins-host build:static
```

The tests assert the 16/15 official catalog boundary, safe provider defaults, stopped Redis policy,
S3 fork bindings, real render/cache behavior and isolated draft/release storage.
