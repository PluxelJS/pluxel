# @pluxel/host

组合 Plugin catalog、运行意图、配置与显式服务。`services` 省略时只有 Core 能力；官方组合见[Host 服务](../../docs/host/services.md)。

```ts
import { defineHostApplication } from '@pluxel/host'
import { MyPlugin } from './plugin.js'

export default defineHostApplication(() => ({ plugins: [MyPlugin] }))
```

声明只将 Plugin 加入 catalog。启动策略、env/file bindings、来源和启动示例由[Host 配置](../../docs/host/configuration.md)维护。

| 入口                 | 用途                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- |
| 根入口               | `defineHostApplication()`、`runHostApplication()`、`createHost()`、配置输入绑定          |
| `/agent`             | 可移植 `Script`、`ScriptSdk` 与执行内核；[自动化脚本](../../docs/development/scripts.md) |
| `/agent/node`        | 受信任 Node 工厂加载与 Host 所有的运行                                                   |
| `/agent/transport`   | 两种载体共用的 Cap’n Web 控制 target 与普通 Promise 客户端                               |
| `/agent/socket`      | 私有 Unix socket 的原生 Cap’n Web carrier                                                |
| `/sources`           | 纯数据 `pluginSource()`、producer 检查 `requirePluginSource()` 和 consumption policy     |
| `/internal/protocol` | 框架共享的无 IO 执行/更新协议                                                            |

`createHost()` 只接受已求值的 plugins；先 `start()`，退出时等待幂等 `close()`。Host 不关闭借用的 storage backend。

`runHostApplication(entry, { startup, sharedPackages })` 接收预编译入口路径，在共享绑定内求值默认工厂与固定 imports，再一次扫描来源，不创建 watcher。全新 Node launcher 必须在业务闭包首次求值前调用；Node hook 无法证明此前任意缓存依赖的完整绑定。Core/Host 与显式 `sharedPackages` 先检查版本再绑定同一安装，制品通过实际 loaded owner 校验。`@pluxel/host-vite` 在开发或生产持续更新同一应用合同。来源 producer 的回执仅确认发布，实际 consumption 为 `next-start` 或 `live`。内部约束见 [HOST](../../engineering/HOST.md)。
