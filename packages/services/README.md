# @pluxel/services

为 Pluxel Host 提供独立服务与官方组合。导入入口不会安装服务；资源由 Host 准备和关闭。

根入口的 `standardServices()` 组合 Elysia、Commands、Node artifacts 和 Workers，不加载 Management 或 Workbench 后端。官方完整应用组合使用 `@pluxel/services/preset`，Vite 附件组合使用 `@pluxel/services/vite`；应用构建统一使用 `@pluxel/rolldown` 的 `pluxel()`。自定义宿主逐项选择服务与 `/elysia/vite`、`/node/vite` 附件。开发控制台归 `@pluxel/host-vite/console`。

FS 与 TinyBase 是 Core 固定能力，通过 `ctx.fs()` 与 `ctx.tinybase` 使用；后端在 Host 的 `config.storage` 中选择一次，TinyBase 预算在 `config.tinybase` 中设置。Core 安装其精确 TinyBase 版本；只有直接导入原生 Store、Queries 等参与托管互操作的插件声明同版 peer 与 devDependency，见[插件包](../../docs/development/plugin-package.md)。

```ts
import { zenfs } from '@pluxel/core/config'
import { createHost } from '@pluxel/host'
import * as nativeFs from 'node:fs'
import { resolve } from 'node:path'
import { Passthrough } from '@pluxel/core/fs'
import { vault } from '@pluxel/services/vault'

const prefix = resolve('./data/fs')
await nativeFs.promises.mkdir(prefix, { recursive: true })
const host = await createHost({
	plugins: [],
	config: {
		storage: zenfs({
			mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
			durableMounts: ['/'],
		}),
	},
	services: [vault()],
})
try {
	await host.start()
} finally {
	await host.close()
}
```

- `/management`：认证、Host 管理投影与会话；协议与客户端使用对应子入口。
- 插件与服务的隔离测试使用 `@pluxel/test`；本包 `/internal/test` 仅供框架测试集成。
- `/elysia`：`ElysiaApp` 提供原生 Elysia Plugin 路由，`elysia()` 安装服务，`createElysiaHandler(host)` 创建 Fetch handler。
- `/elysia/node`：`listenElysia(host, options?)` 用 srvx 启动 Node listener；返回句柄的 `close()` 同时关闭 Host 与 listener。
- `/database`：owner 数据库 API，使用原生 Drizzle schema/query；从 `/database/pglite` 或 `/database/postgres` 显式选择 backend，见[数据库](../../docs/plugin-development/database.md)。
- `/vault`：加密 owner 存储 token、类型和安装器。默认借用 Core 文件后端；bindings 模式不打开加密存储。
- `/node`：独立 Node module 声明、artifact 解析与 owner setup/cleanup。
- `/workers`：共享 Worker 预算与调度，显式依赖 Node modules。
- `/commands`：owner 绑定的命令注册与调用；初始目录为空，由插件或宿主明确发布命令。

Plugin 基于 `@pluxel/core`，固定拥有[文件存储](../../docs/plugin-development/fs.md)与[状态 Store](../../docs/plugin-development/tinybase.md)能力；通过 `ctx.require(Vault)` 或 `ctx.require(Commands)` 读取必需能力；可选集成直接检查相应属性。服务目录类型不表示所有 Host 已安装该服务。

`this.ctx.logger` 由 Core 始终提供，插件无需 import 日志包；应用通过 `config.logger: logtape(nativeConfig, options)`（`@pluxel/core/config`）配置输出、过滤和日志存储，宿主查询从 `@pluxel/core/logging` 读取；省略 `logger` 不安装进程日志配置。

完整用法与生命周期约束见 [组合 Host 服务](https://github.com/PluxelJS/pluxel/blob/main/docs/host/services.md)。

`@pluxel/services/sources` 导出 `serviceSharedPackages`，供原生启动选择官方 token 的同一安装。Node 制品按实际 loaded owner 校验 inventory；运行用法见[Host 服务](../../docs/host/services.md)。
