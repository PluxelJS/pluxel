# Runtime Loader Dev Mode Proposal

状态：已采纳目标设计。本文记录 runtime-loader dev mode 的收敛边界：不保留兼容入口，不提供 `@pluxel/hmr` facade，不维护旧配置文件名或旧 subpath。

## 目标结论

HMR 不再是一层独立产品概念，也不再是独立包。它是 loader route 的开发模式：

```text
@pluxel/core
  owns plugin graph / DI / lifecycle / config validation

@pluxel/runtime
  owns host services / config persistence / ops / web API / status projection

@pluxel/runtime-loader
  owns dynamic catalog / scan / package / module registry / replaceModule
  owns dev mode: Vite runner / watch / moduleGraph / source submission
```

最终依赖方向：

```text
core <- runtime <- runtime-loader <- cli
```

runtime common 仍然不 import Vite、不理解源码入口、不拥有 moduleGraph。Vite、watch、runner、插件 UI 源码编译都属于 `@pluxel/runtime-loader` 的 dev 子路径。

CLI 是最外层命令聚合器，不是 loader dev 的领域所有者。`pluxel dev` 可以由 `@pluxel/cli` 暴露，但 workspace discovery、profile merge、diagnose、snapshot build、path normalization 必须归 `@pluxel/runtime-loader/dev`。CLI 可以做交互式编辑和命令编排，不能复制或重写 loader dev 的发现规则。

## 为什么合并

当前 HMR 适配器永远只服务 loader route：

```text
source change
-> Vite moduleGraph
-> runner import
-> loader batch replaceModule
-> core commit
```

这里真正稳定的领域对象是 `loader batch`、`replaceModule`、module registry 和 runtime/core commit。Vite 只是开发期 source execution 的实现。把它做成独立 `@pluxel/hmr` 包会制造一层额外心智模型：用户需要理解 runtime、loader、hmr 三个包，但 HMR 实际没有自己的 runtime 路线。

合并后心智模型变成：

- `@pluxel/runtime`：宿主能力和控制面。
- `@pluxel/runtime-loader`：动态插件路线；普通模式支持 scan/package/dynamic module，dev mode 支持热替换。

## 公开入口

目标态只保留这些入口：

```text
@pluxel/runtime-loader
@pluxel/runtime-loader/register
@pluxel/runtime-loader/services
@pluxel/runtime-loader/dev
@pluxel/runtime-loader/plugin
```

不保留：

```text
@pluxel/hmr
@pluxel/hmr/host
@pluxel/hmr/plugin
@pluxel/hmr/plugin-build
@pluxel/hmr/diagnose
@pluxel/hmr/snapshot
```

也不提供这些旧入口的 re-export、compat facade、deprecated wrapper 或条件导出。

## 配置入口

目标态配置名使用 loader dev 语义，不再使用 HMR 作为顶层命名：

```text
pluxel.loader.dev.jsonc
```

这个配置描述：

- workspace roots。
- dev entries。
- exclude/include。
- dependency conditions。
- Vite/dev-server 选项。
- builtins preload。
- 插件 UI dev build 选项。

不保留 `pluxel.hmr.jsonc` 读取逻辑，也不做自动迁移。实现这次架构收敛时，所有 CLI、诊断、测试 fixture 和文档应一次性改到新配置名。

### Snapshot 路径语义

`LoaderDevWorkspace` snapshot 使用 root-relative path 作为稳定交换格式。host 启动时以 `root/cwd` 做唯一解析基准。

- `roots`：配置 discovery scope 的展开结果，供诊断和 UI 展示。
- `enabledEntries`：实际进入 HMR source submission 的入口。
- `includedEntries`：来自显式 include globs 的入口。
- `watchRoots`：HMR/Vite watch 和 `server.fs.allow` scope。

`watchRoots` 不等于 discovery roots，也不等于 enabled entries。它允许自动包含 enabled workspace package 的 workspace dependency closure，但这个 closure 只影响文件监听和 Vite 文件访问，不会自动加载、启用或提交 dependency package。

边界规则：

- `watchRoots` 可以包含 workspace shared package，因为 enabled plugin 可能 import 它。
- `watchRoots` 可以包含未 enabled 的 plugin dependency package，但 diagnose 必须 warning，提示 profile 可能缺失依赖插件。
- `watchRoots` 不能绕过 `omitPackages` 把 builtin/double-load package 拉回 source watch。
- `enabledEntries` 只能来自 profile enabled package 和显式 include，不能由 dependency closure 隐式扩展。

## 服务模型

loader 的非 dev 能力：

```text
scan/package input
-> module id
-> exported plugin ctors
-> plugin name
-> enabled config bit
-> core registry draft
-> core commit
```

loader dev mode 在同一个 loader 实例上增加 source submission：

```text
file change
-> Vite moduleGraph affected ids
-> runner import changed module
-> loader.beginBatch()
-> batch.replaceModule(moduleId, exports)
-> loader sync affected runtime modules
-> core commit
-> dev summary
```

`replaceModule` 和 `beginBatch` 属于 loader，不属于 dev mode。dev mode 只是调用它们的 source-driven producer。这样不启动 dev mode 时，动态 loader 仍然可以通过 package install、manual reload 或 host 操作做模块替换。

推荐命名：

```ts
class LoaderService {
	beginBatch(): LoaderBatch
	replaceModule(moduleId: string, exports: unknown): Promise<LoaderChangeReport>
}

class LoaderHmrService {
	start(): Promise<void>
	stop(): Promise<void>
	reload(files?: string[]): Promise<LoaderHmrSummary>
}
```

`LoaderHmrService` 持有 `LoaderService`，但不重新定义 loader registry、runtime protocol 或 lifecycle commit。`dev` 是入口/配置域，`hmr` 是其中负责热替换的具体能力名。

## 新入口形态

标准 host 入口应该以 loader dev 命名，不再出现 HMR，也不拆成 public `plan` / `boot` 两段。需要 dry-run 或预检时走诊断 API；正常启动就是创建 host、启动 host：

```ts
import {
	createLoaderDevHost,
	defineLoaderDevConfig,
} from '@pluxel/runtime-loader/dev'

const config = await defineLoaderDevConfig({
	root: process.cwd(),
	configPath: 'pluxel.loader.dev.jsonc',
	profile: process.env.PLUXEL_DEV_PROFILE ?? 'dev',
})

const host = await createLoaderDevHost({ config })
await host.start()
```

返回对象建议：

```ts
interface LoaderDevHost {
	ctx: Context
	loader: LoaderService
	hmr: LoaderHmrService
	workspace: LoaderDevWorkspace
	start(): Promise<void>
	stop(): Promise<void>
}
```

已有 runtime `Context` 时，不再使用 `attach*` 命名。推荐用 install/enable 语义，因为这是给 loader route 安装 dev mode，不是把独立 HMR 子系统挂到 runtime 上：

```ts
import { installLoaderHmr } from '@pluxel/runtime-loader/dev'

const installed = await installLoaderHmr(ctx, {
	config,
	workspace,
})

await installed.hmr.start()
```

诊断和配置入口：

```ts
import {
	diagnoseLoaderDevWorkspace,
	defineLoaderDevConfig,
} from '@pluxel/runtime-loader/dev'
```

插件作者入口：

```ts
import { ui, worker } from '@pluxel/runtime-loader/plugin'
```

命名规则：

- public type 分层使用：`LoaderDev*` 表示配置/host/workspace，`LoaderHmr*` 表示热替换 controller、summary 和 dependency config。
- 内部实现可以保留 hot/reload 术语；public API 只在表达热替换能力时使用 `Hmr`。
- `dev` 表示 loader dev mode；`reload` / `replace` 表示一次模块提交；`hot` 只适合作为日志或 summary 里的行为描述。

只保留两个 public subpath 语义：

- `/dev`：host、Vite dev server、config、diagnose、workspace、summary。
- `/plugin`：插件作者源码里的 `ui(...)` / `worker(...)` bridge。

插件 UI 的正式构建不属于 runtime-loader public surface；如果需要 public helper，应由 build/toolchain 侧拥有，而不是重新在 loader dev 里暴露 `plugin-build`。

## 删除抽象清单

实现时应直接删除或改名这些 public 抽象，不做 wrapper：

| 当前抽象 | 目标态 |
| --- | --- |
| `@pluxel/hmr` | 删除，使用 `@pluxel/runtime-loader/dev` |
| `@pluxel/hmr/host` | 删除，使用 `@pluxel/runtime-loader/dev` |
| `@pluxel/hmr/plugin` | 删除，使用 `@pluxel/runtime-loader/plugin` |
| `@pluxel/hmr/plugin-build` | 删除；正式构建 helper 归 build/toolchain 侧，不挂到 runtime-loader dev public surface |
| `@pluxel/hmr/diagnose` | 删除，诊断函数从 `@pluxel/runtime-loader/dev` 导出 |
| `@pluxel/hmr/snapshot` | 删除，workspace/diagnostics type 从 `@pluxel/runtime-loader/dev` 导出 |
| `attachHmrRuntime(...)` | 删除，使用 `installLoaderHmr(ctx, ...)` |
| `startHmrRuntime(...)` | 删除，使用 `createLoaderDevHost(...)` 后 `host.start()` |
| `HMRService` | 删除，使用 `LoaderHmrService` |
| `HMRConfig` | 删除，使用 `LoaderHmrConfig` |
| `HmrWorkspaceSnapshot` | 删除，使用 `LoaderDevWorkspace` 或 `LoaderDevDiagnostics` |
| `HMR summary` | 删除，使用 `LoaderHmrSummary` |
| `HmrAdapter` / `RouteHmrAdapter` | 不新增，loader dev mode 直接提交 loader batch |
| `pluxel.hmr.jsonc` | 删除，使用 `pluxel.loader.dev.jsonc` |

这些不是 deprecated rename，而是设计收敛。实现 PR 不应该留下 alias、兼容 subpath、兼容配置读取、自动迁移或 runtime warning。

## Runtime 控制能力

runtime common 应该暴露 route-neutral lifecycle/config ops：

- start plugin。
- stop plugin。
- restart plugin。
- enable plugin。
- disable plugin。
- patch config。
- reset config。
- validate config。
- read status/startup report。

这些 op 不关心插件来自 loader scan、package install 还是未来 static suite。route 负责把 catalog/startup state 映射给 runtime common；core 负责真正生命周期提交。

配置修改的行为应该显式：

- 默认只 patch 和 validate 持久化配置。
- 需要影响运行中插件时走 `restart plugin` 或 `restart affected`。
- 不把“修改配置后是否热应用”做成隐式副作用。

## 插件 UI 开发链路

作者侧 bridge 归到 loader dev：

```ts
import { ui, worker } from '@pluxel/runtime-loader/plugin'
```

dev mode 消费 `ui(...).bind(ctx)`，把源码入口编译成可运行 remote。build 期仍由 build plugin 把 authoring bridge 改写为 runtime packaged 注册语义：

```ts
ctx.ext.ui.remote.packaged()
```

runtime 永远不理解 source `entryPath`，也不反向读取 loader dev 配置。

## Vite 边界

Vite 是唯一 dev runner 实现，放在 `@pluxel/runtime-loader/dev` 和 dev service 内部。不要再抽象 `HmrAdapter`、`RunnerAdapter` 或 `RouteHmrAdapter`，除非出现第二个真实实现。

包结构必须避免默认入口加载 Vite：

- `@pluxel/runtime-loader` 默认入口不 import Vite/chokidar/MF dev build。
- `@pluxel/runtime-loader/services` 只导出 loader/runtime route 服务。
- `@pluxel/runtime-loader/dev` 才可以依赖 Vite、watch、runner、plugin UI dev compiler。
- 构建配置应保证 dev-only 依赖不会进入普通 loader consumer 的 runtime graph。

固定使用 Vite 后，下面这些概念都应该压缩掉：

- 不需要 `RunnerAdapter`：public API 直接说 `vite`、`dev server`、`moduleGraph`。
- 不需要 `HmrAdapter` / `RouteHmrAdapter`：loader dev mode 直接把 Vite 产物提交给 loader batch。
- 不需要 runner provider/plugin system：没有第二个 runner 时不要设计 provider contract。
- 不需要 source executor 抽象层：Vite SSR runner 就是 source execution。
- 不需要通用 watch abstraction：watch 行为由 Vite/chokidar 集成承担，只在 summary 里暴露结果。
- 不需要把 Vite config 包一层通用 dev config：`LoaderDevConfig` 可以直接包含 Vite/dev-server 字段。
- 不需要把 module graph 抽象成 route-neutral graph：moduleGraph 是 dev-only diagnostic，不进入 runtime common。
- 不需要单独 `/dev/vite` subpath：Vite 是唯一实现，Vite helper 直接从 `/dev` 导出或保持内部。
- 不需要单独 `/diagnose` / `/snapshot` subpath：诊断和 workspace read model 都是 loader dev 的一部分，从 `/dev` 导出。

保留的边界只剩两个：

- Vite 边界：源码如何被 import、watch、定位 affected module。
- Loader 边界：module exports 如何通过 `replaceModule` / batch 进入 runtime/core commit。

这能把“source runner -> HMR adapter -> route adapter -> loader replacement”压成：

```text
Vite source event
-> LoaderHmrService
-> LoaderService batch
-> core commit
```

## CLI 边界

`@pluxel/cli` 继续作为仓库级命令入口，负责 `pluxel dev`、`pluxel build`、scaffold 等命令聚合。不要把 loader dev 的发现逻辑迁回 CLI。

推荐边界：

- `@pluxel/runtime-loader/dev` 拥有 headless 能力：读写 loader dev config、profile merge、workspace scan、diagnose、snapshot build、host create/install。
- `@pluxel/cli` 拥有交互层：参数解析、TUI、确认提示、输出格式、命令组合。
- CLI 需要展示中间扫描结果时，可以调用 runtime-loader 的 headless API，但不能复制 discovery/path/dependency closure 规则。

不建议把完整 `pluxel dev` CLI 实现搬进 `@pluxel/runtime-loader` 默认包面：

- 会把 `gunshi`、Ink、React 等 CLI/TUI 依赖引入 runtime-loader 的发布依赖心智。
- 会新增 `@pluxel/runtime-loader/cli` 之类概念，抵消这次压缩入口的收益。
- 默认入口必须继续保持非 CLI、非 Vite dev graph 的普通 loader consumer 友好。

如果后续 CLI 逻辑继续变厚，应优先把可测试的 headless usecase 下沉到 `@pluxel/runtime-loader/dev`，让 CLI 只保留 shell/TUI，而不是让 runtime-loader 直接拥有命令行框架。

## Static suite 的关系

static suite 仍是 runtime common 的未来第二条 route，但它不需要继承 loader dev mode。

如果未来 fixed catalog 也需要开发热替换，应先证明它不是 loader route 能覆盖的场景，再设计 `@pluxel/static-suite/dev`。不要为了对称性在 runtime common 里预留 HMR adapter。当前目标只承认一个事实：动态 loader 的 dev hot replacement 由 loader 自己拥有。

## 删除边界

这次设计不是渐进兼容迁移。实现时应删除旧概念，而不是桥接旧概念：

- 删除 `@pluxel/hmr` package。
- 删除 `pluxel.hmr.jsonc` 配置入口。
- 删除 `HMRService` 作为 public class 名称，改为 `LoaderHmrService`。
- 删除 `attachHmrRuntime` 命名，改为安装/启动 loader dev mode 的 API。
- 删除 docs 中“runtime-loader <- hmr”的依赖层。
- 删除 package export condition 文档里把 `@pluxel/hmr` 当产品入口的表述。

可以在 git history 中保留旧实现供考古，但新文档和新 API 不描述兼容策略。

## 非目标

- 不把 Vite 放进 `@pluxel/runtime`。
- 不把 dev mode 做成多 runner 插件系统。
- 不为了 static suite 预留抽象 adapter。
- 不让 runtime control-plane 暴露 module id、Vite id、moduleGraph 这类 loader/dev 细节。
- 不保留旧 `@pluxel/hmr` import path。
