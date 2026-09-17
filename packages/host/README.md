# @pluxel/host

用显式服务清单组合插件宿主；省略清单时只安装 Core 能力。Runtime 使用同一个 Host coordinator，并在其上安装官方服务与持久化策略。

```ts
import { pluginDefinitionAddressOf } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { MyPlugin } from './plugin.js'

const host = await createHost({
	plugins: [MyPlugin],
	state: {
		initial: {
			autoStart: [{ definition: pluginDefinitionAddressOf(MyPlugin), variant: 'default' }],
		},
	},
})

await host.start()
// 退出时先停止接收新操作，排空已经接纳的更新，再释放 Plugin generation 和 root effects。
await host.close()
```

`createHost()` 返回 Promise，完整校验服务声明和固定插件目录后创建 root，完成服务准备才返回宿主。`services` 是正向服务清单，省略时不安装附加服务。服务准备失败会释放已创建资源，并拒绝创建；不会返回半初始化的宿主。

服务作者从 `@pluxel/core/host` 定义 token 和同步 Context descriptor，使用 `defineHostService({ name, capabilities, requires, prepare })` 组织安装声明。`requires` 用 token 声明依赖，`prepare({ ctx, dependencies, effects })` 按该声明取得类型化的值；Host 不自动安装 provider。准备依赖必须能在 root 读取，不能使用 owner-only token。重复能力、属性冲突、缺失依赖和依赖循环都在工厂执行前拒绝。

声明可用于多个 Host；每个 Host 独立准备服务。资源获取放在 `prepare()`，成功后立即登记到该次调用的 `effects`，不要在安装声明求值时打开连接。Host 按依赖顺序准备，先停止 Plugin generation，再按相反顺序释放服务。各服务内部的 effects phase 不改变服务之间的清理顺序。`close()` 幂等并复用原来的 Promise；清理失败不阻止其他资源清理。

`configRecords: { initial, storage, mode }` 和 `state: { initial, storage, mode }` 支持借用文档存储；省略 storage 时使用内存，提供时默认 writable，可显式 readonly。已有记录优先于 initial；Host 关闭排空自己的写入，不关闭借用的 backend。完整示例见[组合 Host 服务](../../docs/reference/runtime-services.md)。

`plugins` 是完整的显式定义目录，`state.initial.autoStart` 是启动策略。未指定策略时不会自动启动目录中的插件；可以通过 `startNode()` 启动。
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
