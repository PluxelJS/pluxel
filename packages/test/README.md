# @pluxel/test

使用生产 Host 的依赖、配置与生命周期验证插件；服务显式选择，默认空列表。

```ts
// vitest.config.ts
export { default } from '@pluxel/test/vitest'
```

```ts
import { createTestHost } from '@pluxel/test'
import { elysia } from '@pluxel/services/elysia'

await using host = await createTestHost({ services: [elysia()] })
await host.start(MyPlugin)
```

| 入口           | 用途                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| `@pluxel/test` | 统一 `createTestHost()`、fork 声明、断言与诊断                                   |
| `/vitest`      | Plugin lowering 的 Vitest/Vite preset；`definePluxelVitestConfig()` 接收定制配置 |
| `/fixtures`    | 默认 VFS；watcher、child process 或原生工具需磁盘时显式选择 disk                 |
| `/unsafe`      | 框架测试用 synthetic lowering/replacement facts，不代替正常编译                  |

使用仓库要求的 Node.js 24+ 与 Vitest 5。`test.include` 选择测试文件，`pluxel.include/exclude` 选择转换源码；根入口不依赖 Vitest runtime。

完整选项、错误断言及 HTTP/Workbench/Node 测试见[测试指南](../../docs/development/testing.md)。框架测试边界见 [LLM_TESTING_GUIDE.md](./LLM_TESTING_GUIDE.md)。
