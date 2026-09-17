# @pluxel/services

为 Pluxel Host 显式安装所需服务。导入入口不会安装服务；资源由 Host 准备和关闭。

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

- `/http`：原生 Elysia Plugin 路由与宿主请求边界；物理 listener 单独接入。
- `/database`：owner 数据库 API；从 `/database/pglite` 或 `/database/postgres` 显式选择 backend。
- `/persistence`：存储 token、显式安装器、文件/内存/只读/自定义 backend。
- `/vault`：加密 owner 存储 token、类型和安装器。需要显式安装 Persistence。
- `/node`：独立 Node module 声明、artifact 解析与 owner setup/cleanup。
- `/workers`：共享 Worker 预算与调度，显式依赖 Node modules。
- `/commands`：owner 绑定的命令注册与调用；初始目录为空，由插件或宿主明确发布命令。

Plugin 基于 `@pluxel/core`，通过 `ctx.require(Vault)` 或 `ctx.require(Commands)` 读取必需能力；可选集成直接检查相应属性。服务目录类型不表示所有 Host 已安装该服务。

完整用法与生命周期约束见 [组合 Host 服务](https://github.com/PluxelJS/pluxel/blob/main/docs/reference/runtime-services.md)。
