# Refactor Prompt

你在一个新 session 中继续 Pluxel runtime 重构。先阅读：

- `docs/proposals/vite-owned-runtime-routes.md`
- `docs/proposals/static-runtime-enterprise-refactor.md`
- `docs/proposals/static-fetch-native-runtime.md`
- `docs/RUNTIME.md`
- `docs/HMR.md`
- `packages/context/src/Context.ts`
- `packages/runtime-static/src/internal/host.ts`
- `packages/runtime-dynamic/src/vite.ts`
- `packages/runtime/src/runtime/register/static.ts`
- `packages/runtime/src/runtime/register/full.ts`
- `packages/runtime/src/services/http/HttpService.ts`

允许大改服务边界、入口、exports、默认配置、测试和文档。优先追求设计清晰、少概念、可维护、实用；不需要为了旧的过度抽象保守兼容。

## 不可破坏原则

### 1. 一份 runtime config，两种 launcher

static 和 dynamic 都必须采用同一心智模型：

```text
route-neutral runtime config
-> direct launcher
-> Vite launcher
```

- `pluxel.static.ts` / `pluxel.dynamic.ts` 是 runtime config，不是 Vite config。
- `vite.config.ts` 是 host-owned Vite config，只安装 `staticRuntimeVitePlugin({ config })` / `dynamicRuntimeVitePlugin({ config })`。
- direct launcher 不按路径加载 config，只消费应用已经 import 好的 config 对象。
- Vite launcher 才通过 Vite SSR import 按路径加载 config，并拥有 watcher/HMR/build-time lowering。

目标 API：

```ts
// static
import { defineStaticRuntimeConfig, createStaticRuntime } from '@pluxel/runtime-static'
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'

// dynamic
import { defineDynamicRuntimeConfig, createDynamicRuntime } from '@pluxel/runtime-dynamic'
import { dynamicRuntimeVitePlugin } from '@pluxel/runtime-dynamic/vite'
```

`/vite` 可以为兼容 re-export config helper，但新文档和新代码应从主入口 import `defineXxxRuntimeConfig(...)`，避免 runtime config 文件依赖 Vite surface。

### 2. Static 轻，Dynamic 全

- static direct launcher 追求 fetch-native / `tsdown` minimal。
- dynamic direct launcher 默认加载 dynamic route、loader、scan、package manager、workspace diagnose、HMR 相关服务，不追求最小打包；Vault 仍通过显式 service subpath 启用。
- 不要为了 static 目标削弱 dynamic。

### 3. Elysia 是唯一 HTTP framework

- 不新增多 framework adapter。
- GraphQL 是 HTTP 能力，可以默认存在，不作为独立 service 概念。
- 插件 HTTP authoring 面向 Elysia；低层 escape hatch 只保留 fetch mount。

### 4. 少造 public 概念

不要新增这些二级概念：

- preset / managed preset
- capability registry
- service declaration
- asset subsystem
- runtime service manager
- generic framework adapter registry

能用 runtime config、Elysia route/mount、logger sink、persistence backend、显式 import 解决的，就不要再命名一个 public subsystem。

### 5. Import-driven services 保留

`Context` 已经支持 import-driven service registration：

- `@Injectable` / `@RootService` 在模块 import 时注册 getter 到 `Context.prototype`。
- 服务实例 lazy 创建。
- TypeScript 通过 module augmentation 增强 `Context.Services` / `Context.RootServices`。

不要重写 DI。重构重点是入口、模块边界、默认注册和 heavy import graph。

## Static 目标

`@pluxel/runtime-static` 主入口就是 production static/fetch direct launcher。它应该导出：

- `defineStaticRuntimeConfig(...)`
- `createStaticRuntime(config) -> { ctx, fetch, start, stop }`
- plugin authoring 基础类型从 `@pluxel/runtime` 转出；子路径只用于显式额外能力

示例：

```ts
// pluxel.static.ts
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'

export default defineStaticRuntimeConfig({
	name: 'orders-api',
	plugins: [OrdersPlugin],
})
```

```ts
// worker.ts
import { createStaticRuntime } from '@pluxel/runtime-static'
import config from './pluxel.static'

const runtime = await createStaticRuntime(config)

export default {
	fetch: runtime.fetch,
}
```

```ts
// vite.config.ts
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'

staticRuntimeVitePlugin({ config: './pluxel.static.ts' })
```

static 主入口默认能力：

- plugin lifecycle / fixed catalog / core commit
- `ctx.http`：Elysia + GraphQL + plugin route/mount
- `ctx.configService`
- `ctx.runtimeState`
- `ctx.pluginData`
- `ctx.logger`：logger core 默认可用；console/file sink 可配置、可替换
- `ctx.registry` / `ctx.effects` / `ctx.events`
- `ctx.root.persistence`

static 主入口不得默认拉入：

- Vite / Rolldown / chokidar
- Node http / Node stream
- Vault implementation
- web-management bundle
- dynamic loader/package/scan

## Dynamic 目标

`@pluxel/runtime-dynamic` 主入口应该导出：

- `defineDynamicRuntimeConfig(...)`
- `createDynamicRuntime(config) -> { ctx, start, stop, ... }`

示例：

```ts
// pluxel.dynamic.ts
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	configPath: 'pluxel.loader.hmr.jsonc',
	profile: 'dev',
})
```

```ts
// headless.ts
import { createDynamicRuntime } from '@pluxel/runtime-dynamic'
import config from './pluxel.dynamic'

const runtime = await createDynamicRuntime(config)
await runtime.start()
```

```ts
// vite.config.ts
import { dynamicRuntimeVitePlugin } from '@pluxel/runtime-dynamic/vite'

dynamicRuntimeVitePlugin({ config: './pluxel.dynamic.ts' })
```

dynamic 可以默认加载 dynamic route/HMR 服务；不要对它套 static import graph 最小化约束。Vault 仍保持显式 optional boundary。

## Persistence

把旧 `FsService` 替换/改名为窄 `PersistenceService`，挂在 `ctx.root.persistence`。它不是 Node fs 镜像，只表达 runtime 数据持久化语义。

API 目标：

```ts
type PersistenceCapability = 'durable' | 'ephemeral' | 'readonly'

type PersistenceEntry = {
	key: string
	kind: 'file' | 'directory'
	size?: number
	updatedAt?: Date
}

type PersistenceNamespace = {
	get(key: string): Promise<Uint8Array | undefined>
	getText(key: string): Promise<string | undefined>
	put(key: string, value: Uint8Array | string, options?: { atomic?: boolean }): Promise<void>
	delete(key: string): Promise<void>
	list(prefix?: string): AsyncIterable<PersistenceEntry>
	stat(key: string): Promise<PersistenceEntry | undefined>
}

type PersistenceService = {
	capability: PersistenceCapability
	namespace(name: string): PersistenceNamespace
	preflight(requirement?: { durable?: boolean; writable?: boolean }): Promise<void>
}
```

规则：

- config/state/plugin-data/file-logger/vault 等 runtime 服务通过 namespace 复用同一 backend。
- backend 可以是 file、memory、database、KV、object storage、Durable Object 或 host 自定义实现。
- Worker 临时 fs 可以是 `ephemeral` backend；需要 durable 时必须 fail fast。
- 不暴露完整 Node fs API。
- 不提供 watcher。
- 不把它当业务文件系统；业务文件能力应是业务 service。
- 不在 static production 主入口顶层 import Node-only backend 或 `chokidar`。

## 可选大能力

只保留两个真正大的 optional boundary：

- `@pluxel/runtime/services/vault`
- `@pluxel/runtime/services/web-management`

Vault：

- 插件需要 vault 时显式 import。
- static host 不得无条件 bootstrap vault。
- import 后获得类型增强和 runtime getter。
- 环境不满足时由 vault 自己 preflight/fail fast。

Web management：

- `ctx.ext`、SSE、runtime web UI、management panel、runtime UI log sink 共同进退。
- 不引入 managed preset。
- 最小 static 主入口不包含它。
- 需要时显式 import `@pluxel/runtime/services/web-management`，再在 runtime config 中启用 `http.management`。

Assets 不做独立 subsystem。业务资源用 Elysia route/mount；管理 UI assets 随 web-management。

## 原始问题与守卫项

- `@pluxel/runtime` 顶层不得导入 full registration；只允许 static/common services。
- `runtime-static` 不得依赖 `@pluxel/runtime/services` broad barrel，也不得走 `@pluxel/runtime/base`。
- static host 不得无条件 `bootstrapHostVault(this.ctx)`；vault 只由显式 `@pluxel/runtime/services/vault` 边界启用。
- `ConfigService` / `RuntimeStateStore` / `PluginDataService` 不得依赖 `chokidar` 或 `ctx.root.fs`。
- `FsService` / Node fs mirror 抽象必须移除，统一使用窄 `PersistenceService`。
- `ExtensionService`、SSE、RPC、SignalDB、management UI 共同归入 web-management 可选边界。
- logger file sink 保留 sink 自由替换，不引入 logger 平台抽象。

## 落地顺序

1. 建立轻默认作者入口：
   - `@pluxel/runtime` 导出 `BasePlugin`、`Plugin`、`Context`、`Config` 等，只 import static/common runtime register。
   - dynamic/dev common registration 由 `@pluxel/runtime/register/full` 和 dynamic launcher 显式加载；Vault/Web management 不从 `full` 隐式进入。

2. 统一 config + launcher API：
   - `@pluxel/runtime-static` 导出 `defineStaticRuntimeConfig(...)` / `createStaticRuntime(config)`。
   - `@pluxel/runtime-static/vite` 导出 `staticRuntimeVitePlugin(...)`，兼容 re-export config helper。
   - `@pluxel/runtime-dynamic` 导出 `defineDynamicRuntimeConfig(...)` / `createDynamicRuntime(config)`。
   - `@pluxel/runtime-dynamic/vite` 导出 `dynamicRuntimeVitePlugin(...)`，兼容 re-export config helper。
   - `defineStaticRuntime(...)` 不再保留；新代码只使用 `defineStaticRuntimeConfig(...)`。

3. 重构 static 主入口 import graph：
   - 只依赖 `@pluxel/runtime` common surface 和 static 默认能力。
   - 不依赖 full runtime registration。
   - 移除无条件 vault bootstrap。

4. 重构 persistence：
   - `ctx.root.fs` 迁到 `ctx.root.persistence`。
   - ConfigService / RuntimeStateStore / PluginDataService / logger policy 改用 persistence namespace。
   - 拆 backend，标注 `durable` / `ephemeral` / `readonly`。
   - 移除 production 顶层 `chokidar`。

5. 重构 HTTP：
   - 保留 Elysia。
   - GraphQL 作为 HTTP 能力。
   - management/web UI/SSE 只在 web-management import 后挂。
   - 不新增 router adapter；只保留 fetch mount escape hatch。

6. 整理 optional boundaries：
   - vault 独立 import。
   - web-management 合并 ext/SSE/runtime web UI/management panel/UI log sink。
   - assets 留给 Elysia route/mount 和 web-management 内部。

7. 增加 tests：
   - static direct launcher smoke test。
   - static Vite launcher 仍加载同一 config。
   - dynamic direct launcher smoke test。
   - dynamic Vite launcher 仍加载同一 config。
   - static bundle/import graph guard。
   - `+vault`、`+web-management` 组合 smoke tests。

8. 更新 docs / READMEs / package exports。

## 验收标准

- static/dynamic 都是一份 route-neutral runtime config，两种 launcher。
- `vite.config.ts` 仍是唯一 Vite config；runtime config 不接受 nested Vite/HMR config。
- static app 可以被 `tsdown` 打成 fetch-native ESM。
- static production import graph 不包含 Vite/Rolldown/chokidar/Node http/Node stream/Vault/web-management/dynamic loader，除非显式选择对应能力。
- dynamic direct launcher 可启动 full dynamic runtime，且 dynamic Vite HMR 行为不回退。
- 插件 lifecycle、fixed catalog、enabled state、dependencies、config validation、effects cleanup、commit report 正常。
- Elysia plugin routes 和 fetch mount 正常。
- GraphQL HTTP 默认可用。
- config/state/pluginData/logger 默认存在；未注入 backend 时使用 memory/ephemeral persistence，可配置 durable backend。
- `PersistenceService` 替代 `FsService`，不是完整 Node fs 抽象。
- Vault 只有被插件/host import 时才进入 bundle。
- web-management 未 import 时，`ctx.ext` / management panel / runtime web UI / SSE 不进入 static 主入口 bundle。
- 所有 fail fast 都包含 service id、原因和修复建议。
