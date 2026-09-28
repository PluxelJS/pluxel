# @pluxel/host

组合 Plugin catalog、运行意图、动态来源与显式服务。`services` 省略时只有 Core 能力；官方组合见[Host 服务](../../docs/reference/runtime-services.md)。

```ts
import { defineHostApplication } from '@pluxel/host'
import { MyPlugin } from './plugin.js'

export default defineHostApplication(() => ({ plugins: [MyPlugin] }))
```

这段声明只把 Plugin 加入 catalog，不自动启动。应用 startup、启动策略、env/file bindings 与开发/生产接线见[宿主配置](../../docs/getting-started/host-setup.md)。

| 入口                       | 用途                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `@pluxel/host`             | `defineHostApplication()`、`createHost()`、配置输入绑定               |
| `/dynamic`                 | `dynamicSource()` 与文件来源集成                                      |
| `/dynamic/source-producer` | 来源生产者校验 Host 声明，不授予 catalog 管理权                       |
| `/internal/protocol`       | 框架共享的无 IO 执行/更新协议；其他 internal 入口不供 Plugin 作者使用 |

直接使用 `createHost()` 时等待服务准备完成后 `start()`，并在退出时等待幂等 `close()`。Host 关闭自己的工作，不关闭借用的 storage backend。

来源负责发现路径，loader 负责模块求值，Host 负责接受 catalog 与生命周期。Vite 开发集成位于 `@pluxel/host-dev`；原生生产 loader 遇到已求值路径重新发布会要求重启。工程不变量见 [HOST.md](../../engineering/HOST.md)。
