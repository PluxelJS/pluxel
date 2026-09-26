# @pluxel/services

为 Pluxel Host 提供独立服务与官方组合。导入入口不会安装服务；资源由 Host 准备和关闭。

根入口的 `standardServices()` 只组合 Elysia、Commands、Node artifacts、Workers 和 Persistence，不加载 Management、Logging 或 Workbench 后端。官方完整应用组合使用 `@pluxel/services/preset`，开发与发行使用 `@pluxel/services/vite`、`@pluxel/services/build`。自定义宿主逐项选择服务与 `/elysia/vite`、`/node/vite` 开发附件。开发控制台归 `@pluxel/host-dev/console`。

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

- `/logging`：显式 Host 日志安装、策略与有界存储；`/logging/protocol` 是浏览器安全的 DTO。
- `/management`：认证、Host 管理投影与会话；协议与客户端使用对应子入口。
- 插件与服务的隔离测试使用 `@pluxel/test`；本包 `/internal/test` 仅供框架测试集成。
- `/elysia`：`ElysiaApp` 提供原生 Elysia Plugin 路由，`elysia()` 安装服务，`createElysiaHandler(host)` 创建 Fetch handler。
- `/elysia/node`：`listenElysia(host, options?)` 用 srvx 启动 Node listener；返回句柄的 `close()` 同时关闭 Host 与 listener。
- `/database`：owner 数据库 API；从 `/database/pglite` 或 `/database/postgres` 显式选择 backend。
- `/persistence`：存储 token、显式安装器、文件/内存/只读/自定义 backend。
- `/vault`：加密 owner 存储 token、类型和安装器。需要显式安装 Persistence。
- `/node`：独立 Node module 声明、artifact 解析与 owner setup/cleanup。
- `/workers`：共享 Worker 预算与调度，显式依赖 Node modules。
- `/commands`：owner 绑定的命令注册与调用；初始目录为空，由插件或宿主明确发布命令。

Plugin 基于 `@pluxel/core`，通过 `ctx.require(Vault)` 或 `ctx.require(Commands)` 读取必需能力；可选集成直接检查相应属性。服务目录类型不表示所有 Host 已安装该服务。

`this.ctx.logger` 由 Core 始终提供，插件无需 import 日志包；宿主的 `logging(plan)` 配置输出、过滤和日志存储。

完整用法与生命周期约束见 [组合 Host 服务](https://github.com/PluxelJS/pluxel/blob/main/docs/reference/runtime-services.md)。
