# Runtime Static Route

状态：startup/HMR 基线已实现。`@pluxel/runtime-static` 已提供 fixed catalog startup、startup/change report、以及轻量 static HMR 入口；ops/web/MCP 的 route-neutral 控制面仍待接入。

## 模型

static route 只有一条主线：代码声明固定插件目录，runtime config 决定哪些插件运行。

```text
defineStaticRuntime(...)
  -> fixed catalog

createStaticRuntimeHost(..., hostOptions)
  -> runtime services
  -> configService path/mode/snapshot

runtime config
  -> enabled set
  -> plugin config

runtime ops / web config / CLI / MCP
  -> enable / disable / start / stop / restart
```

`defineStaticRuntime(...)` 是纯声明；`createStaticRuntimeHost(...).start()` 才创建宿主并执行生命周期。

## API

插件目录入口：

```ts
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { AuditPlugin } from './plugins/AuditPlugin'
import { BillingPlugin } from './plugins/BillingPlugin'

export default defineStaticRuntime({
	name: 'acme-admin',
	plugins: [AuditPlugin, BillingPlugin],
})
```

宿主启动入口：

```ts
import { createStaticRuntimeHost } from '@pluxel/runtime-static'
import runtimeDefinition from './pluxel.static'

const host = await createStaticRuntimeHost(runtimeDefinition, {
	configService: {
		mode: 'file',
		path: './data/pluxel.runtime.json',
	},
})

await host.start()
```

public shape：

```ts
type StaticRuntimeDefinition = {
	name: string
	plugins: readonly PluginConstructor[]
}

type StaticRuntimeHostOptions = {
	configService?: ConfigServiceConfig
}

type StaticRuntimeHost = {
	ctx: Context
	hmr: StaticRuntimeHmrController
	start(): Promise<StaticRuntimeStartupReport>
	stop(): Promise<void>
	describeCatalog(): StaticRuntimeCatalogSnapshot
	lastReport(): StaticRuntimeStartupReport | undefined
}

type StaticRuntimeHmrController = {
	reload(definition: StaticRuntimeDefinition): Promise<StaticRuntimeHmrReport>
}
```

## 真相源

| 内容 | 来源 |
| --- | --- |
| 插件集合 | `StaticRuntimeDefinition.plugins` |
| 插件身份 | `@Plugin({ name })` metadata |
| 配置路径/模式 | `createStaticRuntimeHost(..., { configService })` |
| 启用状态 | runtime config `enabled` set |
| 插件配置 | runtime config plugin records |
| 生命周期提交 | core commit |
| 操作入口 | runtime ops / web config / CLI / MCP |

runtime config 里没有 enabled 数据时，等价于空 enabled set；插件保持 disabled。启用插件走同一条 runtime ops/config 链路。

## Startup

```text
load runtime config
build known catalog from plugin metadata
select enabled plugins from runtime config
validate selected plugin configs
produce catalog plan
apply core registry draft
commit selected plugins through core
return startup report
```

startup report 使用插件名归因：

- `started`
- `disabled`
- `config-invalid`
- `dependency-missing`
- `start-failed`
- `unknown-config-entry`
- `catalog-drift`

`unknown-config-entry` 表示 runtime config 引用了当前 fixed catalog 之外的插件名。`catalog-drift` 表示已有状态无法稳定映射到当前插件目录，例如改名、删除或无 metadata/重复插件名。

内部提交模型不以 loader 为中心，而是以 catalog plan 为中心：

```text
known catalog + runtime config
-> enabled set
-> config validation targets
-> dependency blocks
-> registry draft operations
-> core commit
-> report projection
```

这个模型可以未来下沉为 runtime common 的窄能力，但不应该把 dynamic loader 的 module registry 或 replacement API 下沉进 static route。

## Static HMR

static HMR 的简单性来自 define/start 分离：HMR 只需要 SSR import static definition entry。

```text
file change
-> Vite SSR import static definition
-> rebuild known catalog
-> compare catalog by plugin name
-> produce static catalog plan
-> validate affected enabled plugin config
-> apply registry draft operations
-> commit affected enabled plugins through core
-> report catalog drift
```

HMR import 不读取 runtime config 文件、不创建 host、不启动插件。Vite 只是 definition 的重新执行器。configService 仍由已运行 host 持有；enabled set 仍来自 runtime config。

fixed catalog 变化的处理：

- 同名插件：按 plugin name 识别为 replacement；如果 enabled 且 config valid，则替换/restart。
- 新插件：进入 catalog report，等待 runtime config 启用。
- 删除插件：进入 drift report；如果旧插件正在 registry 中运行，则从 core draft 中移除并提交停机。
- 改名插件：按删除旧插件和新增新插件处理。
- 新 ctor 配置无效：报告 `config-invalid`，不启动新 ctor；旧实现不继续冒充新 catalog，后续配置修复后再次 reload 同一 definition 仍可启动新 ctor。

static HMR 不需要 dynamic loader replacement：

| route | source ingestion | route-specific translation |
| --- | --- | --- |
| dynamic | Vite runner import dynamic module exports | `replaceModule(moduleId, exports)` 同步 module registry，再由 loader 计算 affected plugins |
| static | Vite SSR import static definition | diff old/new known catalog by plugin name，直接产出 static catalog plan |

当前 static HMR 入口归 `@pluxel/runtime-static/hmr`。该入口只接收已 import 出来的 `StaticRuntimeDefinition`，不拥有 Vite server、module graph、module id registry、package cache 或 loader batch。

## 与 runtime common 的边界

两条 route 的共通点是“从 catalog plan 到 core commit/report”，不是 loader 替换：

- configService：读取 enabled set、raw plugin config、validated config/defaults。
- config validation：schema/defaults/layout 由 core/runtime config service 执行。
- core registry draft / commit：生命周期提交统一交给 core。
- lifecycle failure projection：start failure、dependency missing、drift 都归因到 plugin name。
- route-neutral status/read model：未来供 ops/web/MCP 共享。

route-specific source ingestion 保持在各自包内：

- dynamic route 拥有 scan/package/cache/module registry/loader batch/`replaceModule(...)`。
- static route 拥有 static definition import、known catalog、plugin-name diff、drift report。

如果未来抽 runtime common，推荐抽象 `catalog plan -> core commit/report` 的窄通道；不要把 dynamic loader API 下放成 runtime common。
