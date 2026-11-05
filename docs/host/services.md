---
title: Host 服务组合与扩展
description: 使用官方服务预设快速搭建生产服务，或按需挑选服务与编写自定义服务扩展。
---

宿主（Host）除了托管插件的依赖图之外，还可以为插件提供统一的外部基础设施服务（如 HTTP、指令、文件存储、Vault 凭据和 Workbench 管理面板）。

你可以直接使用官方推荐的 `servicesPreset()` 开箱组合，也可以根据特定需求按需挑选服务甚至编写自定义服务。

## 官方服务预设（servicesPreset）

官方提供的 `servicesPreset()` 会根据当前应用配置，返回完整的运行时服务列表：

```ts
import { servicesPreset } from '@pluxel/services/preset'

export default defineHostApplication(async (startup) => ({
	services: await servicesPreset(startup, {
		workbench: true, // 启用 Workbench 管理后台（默认为 true）
	}),
}))
```

### 包含的服务模块

- **HTTP 路由**：挂载 Elysia 2 Web 框架，分发插件请求；
- **Commands 指令系统**：提供命令目录与调度能力；
- **Vault 密钥服务**：提供加密的敏感凭据存储；
- **Worker 线程池与 Node 模块加载器**：支持后台计算任务；
- **Workbench 管理后台**：提供位于 `/__pluxel/workbench` 的可视化插件管理与调试页面。

<span id="初始侧栏入口"></span>

### 初始侧栏入口

在带有 Workbench 的应用中，你可以为用户首次打开界面时预设固定的侧栏快捷入口（例如将核心业务页固定在侧边栏）：

```ts
services: await servicesPreset(startup, {
	initialShortcuts: [{ target: OrdersPlugin.nodeAddress(), entryKey: 'overview' }],
})
```

- `target`：插件的节点地址；
- `entryKey`：插件在 Workbench 声明中定义的稳定视图键；
- 这些入口仅作为用户的初始布局推荐，用户后续可以自由在界面中取消固定或重新调整。

## 按需挑选基础服务（standardServices）

如果不希望包含 Workbench 前端界面（例如纯后台无头服务），可以使用 `@pluxel/services` 导出的 `standardServices()`：

```ts
import { standardServices } from '@pluxel/services'

export default defineHostApplication(() => ({
	services: standardServices(), // 仅包含 HTTP、Commands、Node 与 Worker 服务
}))
```

## 自定义服务扩展

在 Pluxel 中，服务也是强类型的依赖提供方。你可以使用 `defineHostService()` 封装自己的全局服务：

```ts
import { defineHostService } from '@pluxel/host'

export class MetricsServiceToken {}

export function myMetricsService() {
	return defineHostService({
		token: MetricsServiceToken,
		async setup(ctx) {
			const client = createMetricsClient()

			// 注册释放逻辑，宿主关闭时自动断开
			ctx.effects.defer(() => client.disconnect())

			return client
		},
	})
}
```

在插件中，即可通过 `this.ctx.require(MetricsServiceToken)` 直接获取已就绪的客户端实例。
