# Architecture

## 目标

- runtime 只需要 `new Context()` 就能工作（核心 services + 稳定协议/路由）。
- HMR/Vite 只存在于 `@pluxel/hmr`，并且只能 **attach 到既有 ctx**（不允许反向耦合）。
- 依赖链清晰可追踪，避免“多层 index/barrel + 隐式重导出”造成理解成本上升。

## 包边界与依赖方向

依赖方向只允许：

`@pluxel/core` → `@pluxel/runtime` → `@pluxel/hmr` → `@pluxel/cli`

含义：

- `@pluxel/core`：Context/DI/插件生命周期与最小运行时基建（对外稳定）。
- `@pluxel/runtime`：kernel services（loader/package/scan/http/config/plugin-interaction/...）+ Web 协议与稳定路由。
- `@pluxel/hmr`：workspace diagnose + Vite dev server + runner + pipeline + watch（通过 ctx 操作 runtime）。
- `@pluxel/cli`：对外命令行入口（构建/脚手架/HMR 相关命令）。

## Runtime kernel（`@pluxel/runtime`）

### 启动模型

- import `@pluxel/runtime` 后即可 `new Context()`。
- services 通过 side-effect 注册（见 `packages/runtime/src/runtime/register.ts`）。
- 对外稳定入口：
  - `ctx.http.fetch`（HTTP 边界）
  - `ctx.loader`（插件启停/commit/replace/prune）
  - `ctx.packageService`（安装/卸载/失效/运行时缓存管理）
  - `ctx.scanService`（工作区扫描与入口解析）

### 关键事件契约

- `runtime:resolverCacheInvalidated`
  - 由 `ScanService.invalidateResolverCache()` 发出
  - HMR runner / package loaders 等长生命周期模块必须监听并清理派生缓存
  - 事件契约：`packages/runtime/src/events.ts`

### 当前状态（务实结论）

目前的 runtime/hmr 关系已经达到本轮重构目标：

- `@pluxel/runtime` 可以独立作为 kernel 工作；
- `@pluxel/hmr` 只做启动期 wiring + dev host 能力；
- UI extension 编译链已经收敛为 runtime 内部 store + hmr 注入 compiler，不再是 “registry/service 双层状态机”。

但这里也有几项 **刻意接受** 的残留，而不是继续追求概念纯度：

- runtime 的内部 control-plane / web 协议里仍保留较多 `hmr` 命名；
- runtime 仍直接承载 internal RPC / SSE / MCP / logs / extensions 这些 control-plane 入口；
- logger helper 默认语义仍偏向 HMR host。

这些残留目前不视为架构失败，原因很简单：

- 它们没有重新引入 runtime -> hmr 的实现反向依赖；
- 它们主要是命名/归属层的技术债，而不是状态模型错误；
- 如果现在继续把它们硬拆成更多 host/control-plane 概念，复杂度上升会快于收益。

因此当前原则是：

- **优先保持单一、可追踪的实现**
- **除非出现第二种非-HMR host 需要复用同一套 control-plane，否则不为“语义绝对纯净”继续拆层**

## HMR dev host（`@pluxel/hmr`）

### startup-only

- 标准入口：`@pluxel/hmr/host`（diagnose → new `Context` → wiring → start）
- dev host 会写入 dev-only config keys（例如 `ctx.config.hmrService`），但 runtime 本身不包含 Vite 逻辑。

### Path/Resolve 标准

- HMR 所有 path/fs/resolve 相关逻辑优先复用 `@pluxel/runtime/shared`。
- 在 HMR 内部只保留 Vite 语义层的薄封装（例如把 Vite id 归一化到 fs path）。

### 单例桥接（runner 与 host）

runner 必须与 host 共享部分模块的“单例语义”（decorators、DI tokens、全局 registry 等），否则会出现：

- 同一个逻辑模块被评估两次
- token/装饰器身份不一致
- singleton guard 触发或隐性状态分裂

桥接配置位置：`packages/hmr/src/dev/hmr/config.ts`（`REQUIRED_BRIDGE_MODULES` / `REQUIRED_BRIDGE_PROVIDERS`）。
