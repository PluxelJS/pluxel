# @pluxel/host

组合只需要 Core 图与生命周期的插件宿主。Runtime 使用同一个 Host coordinator，并在其上安装官方服务与持久化策略。

```ts
import { pluginDefinitionAddressOf } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { MyPlugin } from './plugin.js'

const host = createHost({
	plugins: [MyPlugin],
	state: {
		autoStart: [{ definition: pluginDefinitionAddressOf(MyPlugin), variant: 'default' }],
	},
})

await host.start()
// 退出时先停止接收新操作，排空已经接纳的更新，再释放 Plugin generation 和 root effects。
await host.close()
```

`plugins` 是完整的显式定义目录，`state.autoStart` 是启动策略。未指定策略时不会自动启动目录中的插件；可以通过 `startNode()` 启动。
`updateCatalog()` 替换显式目录，并保留仍存在地址的运行意图。新定义必须经过 Pluxel 源码转换或来自已构建的插件产物。

动态发现由 `@pluxel/host-dynamic` 提供。传入 `root`、`sources` 和 `loadModule(path)` 即可组合相同的宿主。Host 不加载文件、不创建 Vite，也不实现 Node 模块缓存：调用方的 loader 负责路径解析和更新后的模块身份。失败候选保留已提交目录，通过 `onSourceError` 报告；关闭时会先停止并释放来源监听。

`assertPluginSource(ctx, requirement)` 供 Package Manager 等来源生产者验证宿主是否声明了目标来源。它不创建来源会话，也不启动监听。

`/internal` 是 Runtime 与工具链使用的框架集成入口，不是 Plugin 作者 API。

开发时使用 `@pluxel/host-dev/vite` 的 `host({ entry: './app.ts' })`。`app.ts` 默认导出同一份 `HostApplication` 声明，Vite 接入负责加载模块和动态来源；应用声明无需自己传 loader。

```ts
// app.ts
import type { HostApplication } from '@pluxel/host'
import { MyPlugin } from './plugin.js'

export default {
	plugins: [MyPlugin],
} satisfies HostApplication
```

入口或宿主配置变化会创建新宿主；插件实现更新在当前宿主内提交目录事务。失败候选不覆盖已接受的模块事实，修复缺失导入后会通过同一开发队列重新求值。

开发驱动会在来源 entry 重新发布时失效其已观察的 ESM 依赖闭包，并重新解析 package metadata。CommonJS 与 native 模块继续由 Node 执行：正常安装应发布新的不可变包路径；直接覆盖已经加载的 CommonJS/native 文件需要重启进程，不承诺清空 Node 全局模块缓存。
