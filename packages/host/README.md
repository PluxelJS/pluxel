# @pluxel/host

组合 Plugin catalog、运行意图、配置与显式服务。`services` 省略时只有 Core 能力；官方组合见[Host 服务](../../docs/host/services.md)。

```ts
import { defineHostApplication } from '@pluxel/host'
import { MyPlugin } from './plugin.js'

export default defineHostApplication(() => ({ plugins: [{ plugin: MyPlugin, autoStart: true }] }))
```

每个插件条目设置其节点的配置、启动意图与 fork。绑定、动态来源和部署示例由[Host 配置](../../docs/host/configuration.md)维护。

| 入口                     | 用途                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| 根入口                   | `defineHostApplication()`、`runHostApplication()`、`createHost()`、配置输入绑定                     |
| `/browser`               | 在浏览器或 Web Worker 中创建 Host，可配置 ZenFS                                                     |
| `/cloudflare`            | 在 Workers handler 内创建请求 Host，使用请求内文档和只读 Vault bindings                             |
| `@pluxel/agent-sdk/host` | Script 类型与直接借用 Host 的 `createScriptScope`；[Agent SDK](../../docs/development/agent-sdk.md) |
| `/sources`               | `PluginSource` 数据类型、producer 检查 `requirePluginSource()` 和 consumption policy                |
| `/internal/protocol`     | 框架共享的无 IO 执行/更新协议                                                                       |

`createHost()` 接受已求值的 plugins。先 `start()`，退出时等待幂等 `close()`。借用的 storage backend 由提供方关闭。 [Cloudflare 请求 Host](../../docs/host/configuration.md#cloudflare-请求-host)

`runHostApplication(entry, { startup, sharedPackages })` 接收预编译入口路径，在共享绑定内求值默认工厂与固定 imports，再一次扫描来源，不创建 watcher。全新 Node launcher 必须在业务闭包首次求值前调用；Node hook 无法证明此前任意缓存依赖的完整绑定。Core/Host 与显式 `sharedPackages` 先检查版本再绑定同一安装，制品通过实际 loaded owner 校验。`@pluxel/host-vite` 在开发或生产持续更新同一应用合同。来源 producer 的回执仅确认发布，实际 consumption 为 `next-start` 或 `live`。内部约束见 [HOST](../../engineering/HOST.md)。
