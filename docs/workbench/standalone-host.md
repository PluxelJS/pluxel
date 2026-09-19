---
title: 独立 Host 的 Workbench
description: 使用相同的 Workbench 服务、浏览器 SDK 与 Vite 制品编译器组合自己的 Host。
---

Workbench 可以独立组合到 Host。`@pluxel/workbench` 提供定义与 token，`/service` 安装同一个发布后端，`/client`、`/react` 和 `/federation` 提供浏览器入口。

## 声明应用

```ts
// app.ts
import { pluginNodeAddressOf } from '@pluxel/core'
import { workbenchService } from '@pluxel/workbench/service'
import { Viewer } from './viewer'

export default {
	plugins: [Viewer],
	services: [workbenchService()],
	state: { initial: { autoStart: [pluginNodeAddressOf(Viewer)] } },
}
```

Plugin 使用 Core 作者 API，以及从 Workbench 包导入的 `Workbench` token：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { Workbench } from '@pluxel/workbench'
import { UI, createBindings } from './ui-definition'

@Plugin()
export class Viewer extends BasePlugin {
	init() {
		this.ctx.require(Workbench).publish(UI, createBindings(this))
	}
}
```

`publish` 仍是 `init()` 中唯一、无条件的发布语句；定义和 renderer 的静态规则不变。Token 没有安装时立即抛出缺失能力错误。通用 Context 上的可选 `ctx.workbench` 不能证明任意 Host 都安装了 Workbench。

## Vite 制品开发

```ts
import { defineConfig } from 'vite'
import { host } from '@pluxel/host-dev/vite'
import { serviceSingletons } from '@pluxel/services/vite'
import { workbenchArtifacts } from '@pluxel/workbench/dev'

export default defineConfig({
	plugins: [serviceSingletons(), host({ entry: './app.ts' }), workbenchArtifacts()],
})
```

`workbenchArtifacts()` 使用 Host 的同一 semantic candidate；它不另行发现定义，也不复制 compiler。配置的服务准备完成后、Plugin 启动前，Host 附加初始制品。源码候选被目录接受时才提交对应制品，拒绝时丢弃准备结果。

renderer 与 Markdown 更新只更新制品，不替换整个 Host。编译器沿用 revision hashing 已读取的 source/package 文件清单来选择更新，未关联文件不会触发编译。新 renderer revision 的 building/failed 状态由现有 Workbench 可用性协议报告；已提交的不可变 URL 仍可读取。关闭会撤回更新入口并等待已接纳的编译结束。

Node 与 Workers 使用 `@pluxel/services/node`、`@pluxel/services/workers`，并在上述普通插件列表按需加入 `nodeArtifacts()`（来自 `@pluxel/services/node/vite`）。安装运行时 token 不会自动开启源码 watcher。

## 管理连接与生产制品

`workbenchService({ artifacts: { root } })` 在 Host 准备阶段装载生产 federation/Content inventories。开发工具链是可选 peer；生产服务不必安装 Vite 或 Rolldown。

受信任的宿主通过 `requireWorkbench(host.ctx)` 创建 session，通过 `createWorkbenchArtifactHandler(host.ctx)` 读取已提交制品。这些函数来自 `@pluxel/workbench/server`，不开放给 Plugin 发布 view。HTTP handler 处理 GET/HEAD、ETag 与不可变缓存头；认证、连接与 session 清理由组合它的管理 endpoint 持有。

浏览器和 producer 统一共享 `@pluxel/workbench`、`/client`、`/react`、`/internal/react` 的精确版本及同一 React 实例。修改入口后必须重新生成制品；构建契约版本为 3。

## 官方 Shell 与 HTTP

`workbenchHttp({ uiBasePath?, publicDir? })` 只将 Shell 页面与静态资源接入 HTTP。认证、管理连接与受保护的 Workbench 制品由 `managementHttp()` 持有。`servicesPreset()` 已显式组合两者；自行组合时声明现有 bindings 与准备依赖：

```ts
import { http } from '@pluxel/services/http'
import { persistence } from '@pluxel/services/persistence'
import { managementAccess } from '@pluxel/management/access'
import { management } from '@pluxel/management/service'
import { managementHttp } from '@pluxel/management/http'
import { workbenchService } from '@pluxel/workbench/service'
import { workbenchHttp } from '@pluxel/workbench/http'
import {
	WorkbenchHost,
	requireWorkbench,
	createWorkbenchArtifactHandler,
} from '@pluxel/workbench/server'

const transport = managementHttp({
	bindings: (ctx) => ({
		createWorkbench: (principal, invalidate) =>
			requireWorkbench(ctx).createSession(principal, invalidate),
		artifacts: createWorkbenchArtifactHandler(ctx),
	}),
})
const services = [
	http(),
	persistence({ mode: 'memory' }),
	managementAccess(),
	management({ workbench: true }),
	workbenchService(),
	{ ...transport, requires: { ...transport.requires, workbench: WorkbenchHost } },
	workbenchHttp({ uiBasePath: '/admin' }),
]
```

`requires` 保证绑定前 Workbench 后端已准备好，不依赖数组顺序。没有 UI 的应用可只安装 `managementHttp()`；`servicesPreset(..., { workbench: false })` 也保留认证与管理 HTTP/WebSocket 接入。

`uiBasePath` 默认为 `/`，`publicDir` 默认使用 Workbench 包内的已构建资源，也可指定部署目录中含 `.vite/manifest.json` 与 `assets/` 的目录。固定管理路径优先，业务路由先于 Shell；只有匹配 UI 路径的 HTML 导航才回退到页面，普通 API miss 保留 404。Shell 支持 HEAD 与静态资源条件请求。服务在首次 Shell 请求时读取已构建 manifest；缺失或无效会使该请求失败，并保留资源路径诊断。

已有自己的 HTTP carrier 时，可使用 `@pluxel/workbench/shell` 的 `createWorkbenchShellHandler(options)`，在业务路由未匹配后调用。它返回可调用的 fetch 函数，并通过 `matchesRequest(request)` 提供开发中间件是否接管请求的判断。此纯 handler 不管理认证或连接生命周期；`workbenchHttp()` 负责 Shell 的 Host 挂载和释放。直接创建 handler 时会立即验证已构建资源。

HTTP 组合还需安装 `elysia`，它是 `@pluxel/services` 的可选 peer。纯 Node/Workers Host 不会因此安装业务 HTTP 依赖。

## 用当前 Vite 开发 Shell 源码

默认 Shell 使用已构建资源。需要修改浏览器源码时，在现有 Vite 配置中显式增加附件：

```ts
import { defineConfig } from 'vite'
import { vitePreset } from '@pluxel/services/vite'
import { workbenchSourceShell } from '@pluxel/workbench/dev'

export default defineConfig({
	plugins: [vitePreset({ entry: './app.ts' }), workbenchSourceShell({ entry: './src/shell.ts' })],
})
```

`entry` 是相对 Vite root 或绝对文件路径，必须存在。应用仍需安装 `workbenchHttp()`；附件沿用其 UI 路径，将 HTML 交给同一 Vite 的转换链与 HMR，不创建另一个 server、管理连接或 Plugin generation。Host 替换或关闭会释放附件，重复附加到同一 Shell 会失败。

浏览器入口及其 React、CSS、路由生成配置由应用负责。开发仓库官方 Shell 时，指定 `packages/workbench-app/src/client.tsx`，并沿用 `packages/workbench-app/vite.config.ts` 对应的前端转换、共享依赖和 Sass 配置；附件不会根据 workspace 路径猜测这些配置。源码模式不要求先构建 Shell，生产构建仍需要交付已构建资源。原始模块与更新错误由现有 Vite 报告。

## 外部声明校验的上游限制

`capnweb@0.12.0` 的声明在 TypeScript 6.0.3 与 7.0.2、开启库检查时，存在两处 `TS2574`：tuple tail 使用的 `Unstubify<Tail>` 同时包含 Promise。仓库的真实 tarball consumer 保持库检查开启，并仅识别该版本 `dist/index.d.ts` 中这两处已确认诊断；其他诊断仍导致验证失败。独立 Core/Host/Services 基础组合无此例外。完整 Workbench 声明的零诊断校验需要等待上游修正版；不会通过关闭所有库检查或复制 RPC 实现掩盖它。
