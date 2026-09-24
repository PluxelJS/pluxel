# @pluxel/host-dev

在 Vite 中加载 Pluxel 应用、执行 HMR 并提供在线开发控制台。

```ts
import { host } from '@pluxel/host-dev/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [host({ entry: './app.ts', devConsole: true })] })
```

`app.ts` 默认导出 `defineHostApplication(factory)`。官方服务应用可改用 `@pluxel/services/vite` 的 `vitePreset()`；`host()` 本身不安装官方服务附件。

| 入口       | 用途                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- |
| `/vite`    | `host()` 与显式 singleton 选择；[工具链](../../docs/development/tooling.md)                  |
| `/console` | `defineDevConsole()` 与当前应用操作类型；[开发控制台](../../docs/development/dev-console.md) |

应用、动态插件与控制台共享专用 `pluxel` environment。默认 SSR 和第三方 `ssrLoadModule` 独立，不能用其中的 Plugin constructor 操作 Host 实例。源码变更由同一串行队列处理，失败候选不覆盖已接受事实。

HMR、工厂重建、恢复和关闭约束见 [HMR.md](../../engineering/HMR.md)；开发诊断不自动安装日志 sink，输出配置见[日志](../../docs/runtime/logging.md)。
