# @pluxel/services

为 Pluxel Host 提供独立服务与官方组合。导入入口不会安装服务；资源由 Host 准备和关闭。

官方应用组合使用 `@pluxel/services/preset` 的 `servicesPreset(startup, options?)`，包含 Elysia、Commands、Node artifacts、Workers、管理能力与可选 Workbench。通过预设选项配置各安装器，设置 `workbench: false` 保留管理能力。Vite 附件组合使用 `@pluxel/services/vite`，应用构建使用 `@pluxel/rolldown` 的 `pluxel()`。[服务组合](../../docs/host/services.md)

自定义宿主与隔离测试逐项选择服务与 `/elysia/vite`、`/node/vite` 附件。Node 与 Vite 共用 `@pluxel/agent-sdk/host` Script SDK，Host-vite 负责当前项目模块图的装载与更新。官方预设用 `managementHttp: { scripts: true }` 显式授权 Node 上传执行。[自动化脚本](../../docs/development/scripts.md)

FS、TinyBase 与 Vault 是 Core 固定能力，通过 `ctx.fs()`、`ctx.tinybase` 与 `ctx.vault` 使用。应用通过 `coreConfig.zenfs` 选择文件后端，通过 `coreConfig.tinybase` 设置 TinyBase 预算，并通过 `coreConfig.vault` 选择凭据后端。直接导入原生 Store、Queries 等参与托管互操作的插件声明同版 TinyBase peer 与 devDependency。[插件包](../../docs/development/plugin-package.md)

```ts
import { createHost } from '@pluxel/host'
import * as nativeFs from 'node:fs'
import { resolve } from 'node:path'
import { Passthrough } from '@pluxel/core/fs'

const prefix = resolve('./data/fs')
await nativeFs.promises.mkdir(prefix, { recursive: true })
const host = await createHost({
	plugins: [],
	coreConfig: {
		vault: { backend: 'encrypted' },
		zenfs: {
			mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
			durableMounts: ['/'],
		},
	},
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
- `/node`：独立 Node module 声明、artifact 解析与 owner setup/cleanup。
- `/workers`：共享 Worker 预算与调度，显式依赖 Node modules。
- `/commands`：owner 绑定的命令注册与调用；初始目录为空，由插件或宿主明确发布命令。

Plugin 基于 `@pluxel/core`，固定拥有[文件存储](../../docs/plugin-development/fs.md)、[状态 Store](../../docs/plugin-development/tinybase.md)与[凭据](../../docs/plugin-development/vault.md)能力；通过 `ctx.service(Commands)` 等读取已安装的必需服务；可选集成通过 `defineServiceRef<Service>()` 取得引用，再调用 `ctx.service(ref)`。服务目录类型不表示所有 Host 已安装该服务。

`this.ctx.logger` 由 Core 始终提供。应用通过 `coreConfig.logtape` 配置输出、过滤和日志存储，配置后宿主可通过 `root.logging` 查询运行时。

完整用法与生命周期约束见 [组合 Host 服务](https://github.com/PluxelJS/pluxel/blob/main/docs/host/services.md)。

`@pluxel/services/sources` 导出 `serviceSharedPackages`，供原生启动选择官方服务声明的同一安装。Node 制品按实际 loaded owner 校验 inventory；运行用法见[Host 服务](../../docs/host/services.md)。
