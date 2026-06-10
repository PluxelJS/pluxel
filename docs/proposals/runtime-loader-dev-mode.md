# Runtime Loader Dev Mode Proposal

状态：未来设计提案。当前代码仍存在 `@pluxel/hmr` 包和 `pluxel.hmr.jsonc` 配置；本文描述下一次架构收敛后的目标形态。目标形态不保留兼容入口，不提供 `@pluxel/hmr` facade，不维护旧配置文件名或旧 subpath。

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
@pluxel/runtime-loader/dev/vite
@pluxel/runtime-loader/plugin
@pluxel/runtime-loader/plugin-build
@pluxel/runtime-loader/diagnose
@pluxel/runtime-loader/snapshot
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

class LoaderDevService {
	start(): Promise<void>
	stop(): Promise<void>
	reload(files?: string[]): Promise<LoaderDevSummary>
}
```

`LoaderDevService` 持有 `LoaderService`，但不重新定义 loader registry、runtime protocol 或 lifecycle commit。

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

Vite 是唯一 dev runner 实现，放在 `@pluxel/runtime-loader/dev/vite` 和 dev service 内部。不要再抽象 `HmrAdapter`、`RunnerAdapter` 或 `RouteHmrAdapter`，除非出现第二个真实实现。

包结构必须避免默认入口加载 Vite：

- `@pluxel/runtime-loader` 默认入口不 import Vite/chokidar/MF dev build。
- `@pluxel/runtime-loader/services` 只导出 loader/runtime route 服务。
- `@pluxel/runtime-loader/dev` 才可以依赖 Vite、watch、runner、plugin UI dev compiler。
- 构建配置应保证 dev-only 依赖不会进入普通 loader consumer 的 runtime graph。

## Static suite 的关系

static suite 仍是 runtime common 的未来第二条 route，但它不需要继承 loader dev mode。

如果未来 fixed catalog 也需要开发热替换，应先证明它不是 loader route 能覆盖的场景，再设计 `@pluxel/static-suite/dev`。不要为了对称性在 runtime common 里预留 HMR adapter。当前目标只承认一个事实：动态 loader 的 dev hot replacement 由 loader 自己拥有。

## 删除边界

这次设计不是渐进兼容迁移。实现时应删除旧概念，而不是桥接旧概念：

- 删除 `@pluxel/hmr` package。
- 删除 `pluxel.hmr.jsonc` 配置入口。
- 删除 `HMRService` 作为 public class 名称，改为 loader dev 语义。
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
