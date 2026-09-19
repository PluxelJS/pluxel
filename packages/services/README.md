# @pluxel/services

为 Pluxel Host 提供独立服务与官方组合。导入入口不会安装服务；资源由 Host 准备和关闭。

官方应用使用三个配套入口：`/preset` 的 `servicesPreset()` 选择运行时服务，`/vite` 的 `vitePreset()` 组合开发附件，`/build` 的 `buildPreset()` 选择发行默认值。根入口的 `standardServices()` 只组合 HTTP、Commands、Node artifacts、Workers 和 Persistence，不需要 Management 或 Logging。自定义宿主可以逐项选择下列服务，开发附件使用 `/http/vite`、`/node/vite` 和 `@pluxel/workbench/dev`。开发控制台及其类型归 `@pluxel/host-dev/console`。

```ts
import { createHost } from '@pluxel/host'
import { persistence } from '@pluxel/services/persistence'
import { vault } from '@pluxel/services/vault'

const host = await createHost({
	plugins: [],
	services: [persistence('./data'), vault()],
})
try {
	await host.start()
} finally {
	await host.close()
}
```

- `/http`：原生 Elysia Plugin 路由、宿主请求边界及 `createHostHttpHandler()`。
- `/http/node`：Node carrier 与 `listenHostHttp()`；只有选择 Node listener 才引入 Node 传输实现。
- `/database`：owner 数据库 API；从 `/database/pglite` 或 `/database/postgres` 显式选择 backend。
- `/persistence`：存储 token、显式安装器、文件/内存/只读/自定义 backend。
- `/vault`：加密 owner 存储 token、类型和安装器。需要显式安装 Persistence。
- `/node`：独立 Node module 声明、artifact 解析与 owner setup/cleanup。
- `/workers`：共享 Worker 预算与调度，显式依赖 Node modules。
- `/commands`：owner 绑定的命令注册与调用；初始目录为空，由插件或宿主明确发布命令。

Plugin 基于 `@pluxel/core`，通过 `ctx.require(Vault)` 或 `ctx.require(Commands)` 读取必需能力；可选集成直接检查相应属性。服务目录类型不表示所有 Host 已安装该服务。

`this.ctx.logger` 由 Core 始终提供，插件无需 import 日志包；宿主的 `logging(plan)` 配置输出、过滤和日志存储。

完整用法与生命周期约束见 [组合 Host 服务](https://github.com/PluxelJS/pluxel/blob/main/docs/reference/runtime-services.md)。
