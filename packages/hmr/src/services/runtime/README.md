# runtime (Scan / Package / Loader / HMR)

`@pluxel/hmr` 的 runtime 层由 4 个核心服务组成：

- `scan/`：工作区扫描图 + 入口解析（workspace / installed fallback）。
- `package/`：插件包的安装/卸载/加载/恢复，并把模块导出注入到 Loader。
- `loader/`：插件声明层与运行层的唯一协调者（module exports → plugin declarations/runtime）。
- `hmr/`：基于 Vite SSR runner 的“服务端 HMR”执行流水线（watch → invalidate → evaluate → inject → commit）。

`shared/` 是这些服务共用的底层工具（缓存与解析），不单独算作一个服务。

## 依赖关系（建议保持的层次）

目标：保持依赖方向单一，避免“互相调用导致语义纠缠”。

- `shared`：最底层工具（无业务依赖）。
- `scan`：只依赖 shared（解析/缓存），不依赖其他服务。
- `loader`：只依赖 core/container（声明/运行），不依赖 scan/hmr/package。
- `package`：依赖 `scan + loader`（解析入口 → import → 注入）。
- `hmr`：依赖 `scan + loader`（workspace entry rewrite + runner 注入）。

## 两个全局不变量（所有服务都必须守住）

### 1) `moduleId` 必须稳定可比较

Loader/Package/HMR 的契约是：相同模块在任何路径形态（`file:`、`/ @fs /`、root-relative URL path、真实绝对路径）下，
最终都要落到同一个 canonical `moduleId`，否则会出现：

- prime cache 命中失败（runner 以为是另一个模块）
- 运行时重复评估（触发 singleton guard，如 `@pluxel/context`）
- moduleGraph 追溯不稳定（批处理受影响集合扩大/缩小不确定）

约定：

- Loader 注入与声明层只使用 clean fs path（`/abs/path/to/file.ts`）。
- HMR 路径归一化由 `hmr/HmrPathResolver` 负责，并且要区分：
  - **Vite root-relative URL path**（应 rebase 到 serverRoot）
  - **真实 FS 绝对路径**（应保持不变，即使在 scanRoots 外）

### 2) runtime singleton 必须唯一实例（host === runner）

HMR 的 runner 会在独立的模块评估环境里执行 TS/ESM。
对 decorators、DI tokens、基类、Context 实现等 singleton 来说：

- host 与 runner 必须共享同一 exports 实例（===），否则会出现 “同类型不同 ctor identity” 的隐性错误。

机制：

- `deps.bridgeModules`：把这些 specifier 的 host exports bridge/prime 到 runner cache。
- `deps.bridgeProviders`：当某个“逻辑模块”被内联到另一个包时，把逻辑 specifier 映射到实际提供者（例如 legacy 的 `@pluxel/context` → `@pluxel/core`）。

## 统一解析与缓存（exsolve + shared cache）

runtime 的“解析”最好统一口径，否则会出现：

- Scan/HMR/Package 解析出的入口不同（同一包不同 entry）
- 缓存失效语义不同步（install/remove 后某处还拿着旧解析）

当前推荐：

- 使用 `exsolve` 作为解析实现（可控 export conditions + 可缓存）。
- 共享同一个 resolve cache map（`scanService.resolverCache`）给 HMR runner 与 PackageInstaller。
- 统一失效入口：调用 `scanService.invalidateResolverCache()`，并通过事件 `runtime:resolverCacheInvalidated` 让 HMR/工具清理派生解析缓存。
- resolver 实例按 group/key 做小型 SIEVE/second-chance 缓存（避免无限增长但保持热点）。
- 统一使用 `shared/conditions.ts` 提供的条件常量，避免不同服务“各自拼 conditions”。
- 统一使用 `shared/resolution.ts` 的封装（`getCachedResolver` / `resolveModulePath`），保证 dist 解析的“ESM 优先”具备确定性。

参考：`shared/exsolve.ts`、`shared/conditions.ts`、`shared/resolution.ts`、`scan/ScanService.resolverCache`。

## 阅读入口（建议）

如果你要快速理解整体：

1. `scan/DESIGN.md`：入口解析/扫描图与缓存语义。
2. `loader/DESIGN.md`：module exports 如何变成插件声明与运行态。
3. `hmr/DESIGN.md`：HMR 的不变量、桥接、路径归一化与流水线。
4. `package/DESIGN.md`：installed/market 包的状态机与 loader 注入方式。
