# Pluxel Architecture Lab

> Status: internal workspace application and end-to-end architecture smoke. It is not published.

`projects/plugin-host` is the runnable reference host for Pluxel. It loads every official Plugin,
starts the dependency chains that work without external infrastructure, and exposes the important
architecture choices through the Workbench instead of leaving them in logs-only toy examples.

The product identity is **Pluxel Architecture Lab**. `src/app.ts` imports the official Plugins,
showcases and focused demos, and adds a mutable directory for Package Manager's published ESM entries.
The same declaration drives Vite development, modules builds and native startup; `sources` adds discovery to the
fixed catalog. Native accepts a startup snapshot; Vite owns live updates. Package Manager owns installation and atomic publication,
while the Host owns catalog acceptance and lifecycle.

Redis and its Cache/Rates backends are loaded into the catalog but remain stopped by default.
Memory is the explicit default for both backend tokens.

## Run

```sh
pnpm --filter @pluxel/plugins-host dev
```

For production, run `pnpm --filter @pluxel/plugins-host build`, then
`pnpm --filter @pluxel/plugins-host start` for native startup in a fresh Node process.
The launcher binds before evaluating business imports; do not preload the application or its dependency graph.
Use `pnpm --filter @pluxel/plugins-host start:vite` after building for continuous production updates;
`vite.runtime.config.ts` loads the compiled factory independently of the development config. Mutable data lives in `PLUXEL_DATA_ROOT`
(default: `.pluxel` relative to `startup.root`), shared by Package Manager,
persistence and local S3 storage. Keep this directory outside `dist`; use an absolute
`PLUXEL_DATA_ROOT` when deploying or launching from a different working directory.

Open `/__pluxel/workbench` on the displayed Vite address and select **Architecture Lab**. Set
`PLUXEL_WORKBENCH=false` to run without the Workbench UI; Management remains installed.
The reference host seeds configuration and startup policy in memory on each fresh startup;
Plugin persistence and stored showcase artifacts still use the configured data directory.
The application explicitly allows 30 seconds for Plugin startup, including cold Node artifact compilation in development.
This policy is shared by all three launchers; Core's default remains unchanged.

One report generation exercises this graph:

```text
Rates -> admission Part
Cache -> rendering Part -> ShowcaseRenderer
                         ├─ ECharts -> Canvas -> Fonts
                         ├─ Takumi ----------> Fonts
                         └─ Canvas ----------> Fonts
S3 bucket:drafts   -> publishing Part
S3 bucket:releases -> ReleaseArchivePlugin
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
- Inspect the single `S3Plugin` provider. Its bounded `drafts` and `releases` bucket catalog keeps
  the two storage domains explicit without provider forks or dependency overrides.
- Change `CacheBackend` or `RatesBackend` from Memory to a Redis implementation after configuring
  and starting Redis. A failed external provider blocks only its required branch.
- Edit the Report Studio Part config, Wretch Attachment settings, Fonts selection, auth setup and
  official Plugin config forms.
- Inspect plugin graph, lifecycle and logs; these are host-owned projections of the same runtime
  state used by the showcase.

The catalog keeps only two focused scenarios that add semantics not already covered by
Report Studio: a required `EvtChannel` edge and optional-provider attach/detach. Their graph,
lifecycle and logs are visible in the Workbench. The other examples remain in `src/demo` as focused
source references and tests without cluttering the default runtime catalog.

## Coding agent runtime operations

The Vite configuration explicitly enables the development console. Coding agents must use this
console for runtime inspection, config edits, Plugin methods, Workbench RPC, data and logs.
The current local transport supports Unix systems; on Windows disable `devConsole` in the
configuration to run the host without the console.

From the repository root, discover the already running host and use its returned instance ID:

```sh
plugin_host_root="$(pwd)/projects/plugin-host"
pnpm exec pluxel dev instances --root "$plugin_host_root"
pnpm exec pluxel dev run projects/plugin-host/dev/inspect.ts --root "$plugin_host_root" --instance <id>
pnpm exec pluxel dev run projects/plugin-host/dev/inspect.ts --export health --input '{"origin":"http://127.0.0.1:3310"}' --root "$plugin_host_root" --instance <id>
```

Multiple Vite processes can share this project root, so always keep the selected instance ID for subsequent `run`, `result` and `cancel` commands. Add ordinary named exports to
project-local `dev/*.ts` files for further operations; edits do not restart the dev host or replay
previous operations. The default `inspect.ts` export returns current Plugin status. Its `health` export checks
the real showcase and Workbench HTTP routes and returns bounded logs; set `origin` to the address reported by the selected instance.

Follow the [development console guide](../../docs/development/dev-console.md) for typed config,
explicit service access and recovery. Scripts import `DevConsole` from `@pluxel/host-vite/console` and use `dev.ctx` with service APIs; they pass `dev.signal` and release their own service resources. Isolated regressions continue to use the test host.

## Boundary

- `src/app.ts` owns fixed Plugins, mutable sources, service configuration and startup policy.
- `src/app.ts` uses `servicesPreset()` from `@pluxel/services/preset` for the official service set, data location and optional Workbench.
- `vite.config.ts` uses `vitePreset()` from `@pluxel/services/vite`; it combines the shared development driver with attachments for installed official services.
- `tsdown.config.ts` uses `pluxel({ delivery: 'modules' })` from `@pluxel/rolldown`; package imports and compiled Node/Workbench artifacts are preserved.
- Managed entries and Package Manager's data share the explicitly configured application-local directory.
- Plugin source is compiled by Pluxel Vite/Rolldown; native startup evaluates precompiled ESM and validates its ABI and identity.
- Workbench MF2 producers, exposes and shared policy are generated from definitions. This project
  does not hand-author a Module Federation config.

## Verify

```sh
pnpm --filter @pluxel/plugins-host typecheck
pnpm --filter @pluxel/plugins-host test
pnpm --filter @pluxel/plugins-host build
pnpm --filter @pluxel/plugins-host test:runtime
```

The tests cover safe provider defaults, stopped Redis/Pi policy,
the S3 named-bucket catalog, real render/cache behavior and isolated draft/release storage.
The runtime smoke uses fresh Node processes and temporary data for both launchers. It blocks Vite/compiler/watcher
imports in Native, checks the compiled showcase and Workbench assets over HTTP, and requires natural exit after SIGTERM.
