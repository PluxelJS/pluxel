---
title: 在独立 Host 中接入 Workbench
description: 使用模块化服务，在自定义宿主中手动装配 Workbench 运行后端与 Web 资源分发。
---

虽然官方推荐使用包含完整开箱体验的 `servicesPreset()`，但在某些高度定制的工程中（例如将 Workbench 嵌入特定内部控制台或自定义 HTTP 网关），你可以通过 `@pluxel/workbench` 手动装配各个组件。

## 宿主端服务装配

在应用入口中挂载 `workbenchService()`：

```ts
// app.ts
import { defineHostApplication } from '@pluxel/host'
import { workbenchService } from '@pluxel/workbench/service'
import { ViewerPlugin } from './viewer'

export default defineHostApplication(() => ({
	plugins: [ViewerPlugin],
	services: [workbenchService()],
	policy: {
		autoStart: [ViewerPlugin.nodeAddress()],
	},
}))
```

插件代码无需任何修改，继续使用标准的 `this.ctx.workbench?.publish()`。如果宿主没有挂载 `workbenchService()`，可选链 `?.` 会安全跳过，保证业务插件能独立在无头环境下运行。

## 配合 Vite 接入开发编译

在本地开发时，配合使用 `@pluxel/workbench/vite` 提供的编译器插件，支持 React 组件与 Markdown 的热重载：

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { host } from '@pluxel/host-vite'
import { serviceSingletons } from '@pluxel/services/vite'
import { workbenchArtifacts } from '@pluxel/workbench/vite'

export default defineConfig({
	plugins: [serviceSingletons('./app.ts'), host({ entry: './app.ts' }), workbenchArtifacts()],
})
```

## 挂载 Web 静态资源（workbenchHttp）

通过 `workbenchHttp` 将 Workbench Shell 的静态前端资源挂载至自定义路径（如 `/admin`）：

```ts
import { elysia } from '@pluxel/services/elysia'
import { managementAccess } from '@pluxel/services/management/access'
import { management } from '@pluxel/services/management/service'
import { managementHttp } from '@pluxel/services/management/http'
import { workbenchService } from '@pluxel/workbench/service'
import { workbenchHttp } from '@pluxel/workbench/http'

const services = [
	elysia(),
	managementAccess(),
	management({ workbench: true }),
	workbenchService(),
	managementHttp(),
	workbenchHttp({ uiBasePath: '/admin' }),
]
```

启动后，访问 `http://localhost:3000/admin` 即可进入工作台。
