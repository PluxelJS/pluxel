# Pluxel Architecture Lab

> Status: internal workspace application and end-to-end architecture smoke. It is not published.

`projects/plugin-host` is the runnable reference host for Pluxel. It composes official rendering, storage and application capabilities,
starts the dependency chains that work without external infrastructure, and exposes the important
architecture choices through the Workbench instead of leaving them in logs-only toy examples.

The product identity is **Pluxel Architecture Lab**. `src/app.ts` imports the official Plugins,
one Report Studio application plugin and the independent Bot Workspace product, and adds a mutable directory for Package Manager's published ESM entries.
The same declaration drives Vite development, modules builds and native startup; `sources` adds discovery to the
fixed catalog. Native accepts a startup snapshot; Vite owns live updates. Package Manager owns installation and atomic publication,
while the Host owns catalog acceptance and lifecycle.

Redis and its Cache/Rates backends are loaded into the catalog but remain stopped by default.
Memory is the explicit default for both backend tokens.

## Run

```sh
vp run dev
```

Pitchfork manages the development service. Workspace builds use Vite Task with explicit build dependencies and cached outputs;
individual bundlers and declaration generators may still use their own workers.

When workspace dependencies are already built, start Vite directly for UI development without repeating
the production dependency build:

```sh
(cd projects/plugin-host && vp dev --config vite.config.ts)
```

Use the full `dev` command when dependency build outputs need preparation.

For production, run `vp run @pluxel/plugins-host#compile`, then
`vp run @pluxel/plugins-host#start` for native startup in a fresh Node process.
The launcher binds before evaluating business imports; do not preload the application or its dependency graph.
Use `vp run @pluxel/plugins-host#start:vite` after building for continuous production updates;
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

One **ReportStudioPlugin** owns the full report workflow. Select an engine for each request in the
Architecture Lab page; no renderer adapter Plugins or provider switches are needed:

```text
ReportStudioPlugin
  ├─ Rates + Cache
  ├─ ECharts -> Canvas -> Fonts
  ├─ Canvas -> Fonts
  ├─ Workers task -> Takumi worker adapter (React JSX and HeroUI v3 Card/Chip/Button)
  ├─ TakumiMarkdown -> Typst math + Takumi shared Worker
  ├─ Typst (stateless SVG compilation through the shared Workers service)
  ├─ S3 bucket:drafts + bucket:releases
  ├─ Wretch (provider-owned HTTP settings Attachment)
  └─ Otel (report metrics at /showcase/metrics)
```

ECharts, Canvas, Takumi, HeroUI and Markdown generate PNG; Typst generates SVG. The engine, title
and current Fonts revision identify a cache entry. Generation emits the Plugin-owned `generated`
event, publishes to both named buckets, records metrics and notifies the Workbench observers.
The recent-artifact list and RPC payload contain metadata; the preview image is read through its
stored artifact route.

The declared `report-render.task.tsx` constructs both JSX templates inside the shared Workers
service. The application sends business data and concrete font bytes; it creates no JSX on the
main thread. Native rendering and React Hooks execute in that task's bundle through
`@pluxel/plugin-takumi/worker`. Font snapshots are read once per Fonts provider/portable revision and
remain immutable until execution settles; `inputOwnership: 'borrowed'` avoids an extra queue-time
font copy. Worker transport still clones the bytes at dispatch. Worker-local renderer/font-set
caches can survive repeated tasks while that shared Worker remains alive.

HeroUI uses the real `@heroui/react` v3 components, passed directly as JSX to Takumi in the Worker. The
`report-card.css` stylesheet imports official HeroUI base/theme and the three component styles.
`vp run @pluxel/plugins-host#styles:report-card` compiles it with Tailwind v4 into the
committed `report-card-css.ts`; `dev` and `build` also regenerate it. The native application only
loads the compiled CSS string in the task artifact. Card, Chip and Button have been probed with Takumi's JSX resolver
and are covered by the real Plugin render test. Other React Aria components need their own
compatibility checks. Configure portable Fonts resources to render Chinese or other scripts
beyond the default font coverage.

The Markdown report includes inline and display mathematics. `createRenderer()` automatically
uses the optional Typst provider already in this catalog, then rasterizes through Takumi's shared
Worker path; there is no separate math Plugin.

The same application Plugin also registers:

- HTTP: `GET /showcase/status`, `POST /showcase/generate/:engine/:title`,
  `GET /showcase/artifacts/:id`;
- Commands: `showcase.report.generate` with `{ title, engine }`, `showcase.cache.clear`;
- Workbench: one view with an engine selector, status/artifact panels, observer and Wretch's
  provider-owned Attachment;
- one object config for admission, preview caching, output prefixes and outbound HTTP.

Inspect the single `S3Plugin` provider's `drafts` and `releases` buckets. Cache and Rates keep their
real provider edges, so their backends can still be changed to Redis after configuring it.
The four timer-only event/optional-integration registrations were removed from the runtime
catalog. Focused examples remain in `src/demo` for individual API reading and tests. Bot Workspace
keeps its own product boundary and independent sources.

## Coding agent runtime operations

The Vite configuration explicitly enables the development console. Coding agents must use this
console for runtime inspection, config edits, Plugin methods, Workbench RPC, data and logs.
The current local transport supports Unix systems; on Windows disable `devConsole` in the
configuration to run the host without the console.

From the repository root, discover the already running host and use its returned instance ID:

```sh
plugin_host_root="$(pwd)/projects/plugin-host"
vp exec pluxel dev instances --root "$plugin_host_root"
vp exec pluxel dev run projects/plugin-host/dev/inspect.ts --root "$plugin_host_root" --instance <id>
vp exec pluxel dev run projects/plugin-host/dev/inspect.ts --export health --input '{"origin":"http://127.0.0.1:3310"}' --root "$plugin_host_root" --instance <id>
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
vp run @pluxel/plugins-host#check-types
vp run @pluxel/plugins-host#check-tests
vp run @pluxel/plugins-host#compile
vp run @pluxel/plugins-host#test:runtime
```

The tests cover safe provider defaults, stopped Redis/Pi policy,
the S3 named-bucket catalog, all six real render engines, cache separation, generated events and isolated draft/release storage.
The runtime smoke uses fresh Node processes and temporary data for both launchers. It blocks Vite/compiler/watcher
imports in Native, renders Takumi/HeroUI PNG, Markdown with Typst mathematics and Typst SVG through the compiled application, checks the Workbench assets over HTTP, and requires natural exit after SIGTERM. Set `PLUXEL_SMOKE_ARTIFACTS_DIR` to retain the HeroUI and Markdown PNGs for visual inspection.

### 机器人工作区：真实插件 API、模拟业务数据

运行 dev 后，从“应用”打开“机器人工作区（模拟）”，或访问
`/__pluxel/workbench/bot-lab`。无需平台凭据，不会连接 Telegram、Discord 或企业微信。

`src/bot-lab/` 用四个真实 Plugin 验证多个插件共用一个业务列表：

- 三个来源插件各自拥有内存 `BotStore`，通过 constructor 依赖工作区插件，在 `init()` 注册来源并返回撤销函数。
- `BotWorkspacePlugin` 统一发布首页、左侧 View 列表、参数化机器人文档、右侧来源状态和底部工作区事件。
- 列表和文档通过 Workbench RPC 与 `watch()` 读取数据；保存调用绑定 `source + bot` 的独立 target，并检查版本。
- 不同来源都包含名为“客服助手”、ID 为 `support` 的机器人。搜索、业务分组、标签切换和独立草稿可用来验证身份隔离。

在“插件管理”停止 Discord 模拟来源后，列表保留其最后已知条目并标为不可用；其他来源仍可使用。来源没有单独发布页面，
且依赖方向为来源 → 工作区，因此停止来源不会撤回工作区 publication。停止工作区本身仍遵循正常的 publication 失效与页面刷新规则。
来源重启会重新创建它的模拟数据；工作区和来源重启不提供业务持久化。过期草稿不能覆盖新版本，须显式核对并重新读取。

右侧、底部扩展是**整个工作区**的状态与事件，不会假装拥有活动机器人的实体上下文。当前 API 下，单个机器人的详情、事件和草稿放在它的文档中；
左侧列表使用 `host.navigation.navigate()` 按 URL 复用文档，不读取 Shell store 或建立全局“当前机器人”。

`dev/bot-lab.ts` 提供当前 Vite 实例的只读检查、真实 Workbench API 保存以及 Discord 来源停止/启动操作。
调用前使用 `pluxel dev instances --root <absolute-root>` 发现实例，并为后续命令固定 root 和 instance。
