---
title: 配置插件宿主
description: 用一份 HostApplication 组合插件、服务、开发工具和生产部署。
---

Host 拥有插件目录、运行策略和服务生命周期。应用入口默认导出 `defineHostApplication(factory)` 声明的 `HostApplicationFactory`；Vite 和生产构建读取同一个入口。
插件只依赖 Core 和实际使用的服务，不需要全局 Runtime。

## 选择组合

- 自定义或轻量宿主：`@pluxel/host`，只安装显式列出的服务。
- 官方服务器组合：`servicesPreset()`，包括 HTTP、Commands、Node artifacts、Workers、Persistence、Vault、Logging、Management 和默认启用的 Workbench。
- 无管理页面的常用基础组合：`standardServices()`，包括 HTTP、Commands、Node artifacts、Workers 和 Persistence。

Database 单独安装；关闭 Workbench 不会关闭插件业务能力。详细服务列表与资源归属见[组合 Host 服务](../reference/runtime-services.md)。

## 应用入口

```ts no-twoslash
import { resolve } from 'node:path'
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { servicesPreset } from '@pluxel/services/preset'
import { TodoPlugin } from '@app/todo'

export default defineHostApplication(async (startup) => {
	const environment = resolveHostEnv(startup.env)
	return {
		name: 'my-app',
		plugins: [TodoPlugin],
		services: await servicesPreset(startup, {
			persistence: resolve(startup.root, environment.dataRoot, 'persistence'),
			workbench: environment.workbench ?? true,
		}),
		state: { initial: { autoStart: [pluginNodeAddressOf(TodoPlugin)] } },
		configRecords: {
			initial: [{ owner: pluginNodeAddressOf(TodoPlugin), config: { maxItems: 100 } }],
		},
	}
})
```

`plugins` 表示代码可用，不代表自动启动。`state.initial.autoStart` 选择冷启动时运行的节点，插件自己的 required dependencies 由图统一处理。

配置工厂每次创建新 Host 时执行，可以读取 `env`、`bindings`、`root` 和 `deployment`。构建不会执行它。
Vite 和生产构建都要求入口直接默认导出 `defineHostApplication(内联工厂)`：工厂直接返回对象，或在块中以唯一、无条件的最后一条顶层 `return` 返回对象；返回对象不使用 spread。生产构建中的 `plugins` 使用直接数组或模块级 const/imported 数组，不使用条件、函数调用或 startup 计算。构建只分析静态清单，不执行工厂。没有环境绑定时，Vite 可运行条件插件数组。

静态清单的数组必须始终保留声明时的成员：不要在模块、工厂、helper 或 callback 中修改、通过别名修改，或用动态 import 追加插件。构建会拒绝工厂中的明显修改、别名和向 helper 传递数组；`map`、`slice` 等只读使用可以保留，但 callback 也不得修改原数组。这是部署合同，有限语法检查不能证明任意 JavaScript 的副作用。需要可变插件时，使用显式 `sources`。

`prepare({ host, startup })` 在服务与开发附件准备完成后、插件启动前执行；适合应用级硬前提。资源获取成功后立即登记到明确的 owner，清理失败不会跳过其他资源。

`configRecords` 和 `state` 默认存于内存。安装 Persistence 不会隐式持久化 Host 的配置或策略；需要保存时，显式提供借用的 document storage，见[服务与存储组合](../reference/runtime-services.md)。已有持久文档优先于启动 seed。

## Vite 开发

```ts no-twoslash
import { defineConfig } from 'vite'
import { vitePreset } from '@pluxel/services/vite'
import { hostEnv } from '@pluxel/host/environment'

export default defineConfig({
	server: { host: hostEnv.hostBind ?? '127.0.0.1', port: hostEnv.hostPort ?? 3000 },
	plugins: [vitePreset({ entry: './src/app.ts', devConsole: true })],
})
```

自定义宿主可以使用 `@pluxel/host-dev/vite` 的 `host()` 并显式组合服务开发附件。应用、动态插件和控制台共享 Host 专用的 `pluxel` Vite environment；默认 SSR 和第三方 SSR 加载保持独立。插件源码必须经过 Pluxel lowering，执行空间边界见[工具链说明](../development/tooling.md#source-build-boundary)。
React 页面由应用显式安装 React Vite plugin。

配置工厂 identity 变化时重新求值完整配置并重建 Host，固定插件的 import 更新也可能触发重建。工厂求值失败保留旧 Host。动态来源更新若未使工厂失效，则复用本次配置并提交 catalog replacement。失败候选保留旧实现；已提交后的 init 失败则报告新一代的生命周期问题，不声称旧代仍然运行。
在线检查与修改见[开发控制台](../development/dev-console.md)。

## 动态来源

```ts no-twoslash
import { dynamicSource } from '@pluxel/host/dynamic'

const sources = [
	dynamicSource({
		kind: 'directory',
		path: './managed-plugins',
		include: ['*.mjs'],
	}),
]
```

将 `sources` 放在应用声明中。来源负责发现入口，包安装由应用或 Package Manager 负责；新入口进入同一个 Host catalog，是否运行仍取决于策略。
Vite 支持动态新增、更新、删除；来源入口变化不等于监视安装包内部所有源码。生产原生 ESM 支持首次加载、新路径和删除；修改已求值入口需要重启。

## 配置环境变量

`@pluxel/host/environment` 提供 `env`、`hostEnv`、`resolveHostEnv(input)`。显式参数用于根据本次 startup 环境解析，不依赖修改 `process.env`。

| 变量                                    | 含义                                                              |
| --------------------------------------- | ----------------------------------------------------------------- |
| `PLUXEL_DATA_ROOT`                      | 数据目录默认值，省略为 `.pluxel`；应用决定子目录                  |
| `PLUXEL_HOST_BIND` / `PLUXEL_HOST_PORT` | 物理 listener 地址与端口                                          |
| `PLUXEL_WORKBENCH`                      | 由应用传给服务组合的页面开关                                      |
| `PORTLESS_URL`                          | 开发外部 origin；存在时可采用 `HOST` / `PORT`，显式 Pluxel 值优先 |

普通部署变量可以绑定到固定插件的实际 schema：

```ts no-twoslash
import { defineHostApplication, envBinding } from '@pluxel/host'
import { OrdersPlugin, OrdersConfig } from '@app/orders'

export default defineHostApplication(() => ({
	plugins: [OrdersPlugin],
	envBindings: [
		envBinding(OrdersPlugin, {
			config: { schema: OrdersConfig, mapping: { endpoint: 'ORDERS_ENDPOINT' } },
		}),
	],
}))
```

宿主导入插件用于 `configs.use()` 的同一 schema；绑定 helper 从其 input 类型推导字段，Host 在启动时核对 schema 一致。优先级为基础值、已保存值、env；env 控制的字段只读且不写入配置文件。字段映射与构建生成 `.env.example` 的约束见[插件配置](./configuration.md)。

## 生产构建

```ts no-twoslash
import { defineConfig } from 'tsdown'
import { buildPreset } from '@pluxel/services/build'

export default defineConfig({
	entry: './src/app.ts',
	plugins: [buildPreset()],
})
```

自定义组合使用 `@pluxel/rolldown` 的 `pluxel()`。生产 bootstrap 通过 `@pluxel/host` 启动同一应用，HTTP handler/listener 属于 `@pluxel/services/http/*`。
`launcher` 可以选择 `node`、`fetch` 或 `host`；资源 variant 与服务安装是不同决定。动态插件需要的额外 framework 入口通过 `sourceFrameworks` 明确声明。

交付和搬离工作区验证见[发行物](../development/distribution.md)。Node 已有回归覆盖；其他平台需要独立验证网络与原生依赖，不能只凭 Fetch 类型兼容推定支持。

## 测试

插件测试统一使用 `@pluxel/test` 的 `createTestHost()`，按需显式组合服务。它们是隔离宿主，不能代表已经运行的开发应用。具体调用见[测试插件](../development/testing.md)。
