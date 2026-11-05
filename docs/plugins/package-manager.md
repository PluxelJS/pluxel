---
title: 插件市场与包管理器
description: 连接插件市场，或直接通过受控 pnpm 环境安装与更新插件包。
---

> `@pluxel/plugin-package-manager` 目前主要供 Pluxel 工作区内使用。完整包状态见 [Package 矩阵](../reference/package-matrix.md)。

`@pluxel/plugin-package-manager` 允许宿主在独立的受管目录中通过 pnpm 安装、更新和卸载第三方 npm 插件。插件包被下载并解压后，包管理器会为每个插件生成标准的 `.mjs` 入口包装文件，由宿主的动态目录来源（Directory Source）加载。

## 宿主装配

在宿主配置中启用包管理器需要配置四个关键项：
1. 在 `plugins` 列表中声明 `PackageManagerPlugin`；
2. 在 `sources` 中注册对应的受管插件入口目录；
3. 在 `policy.autoStart` 中将其加入随宿主自启列表；
4. 在 `config.records` 中配置管理路径与安全规则。

```ts no-twoslash
import { zenfs } from '@pluxel/core/config'
import { resolve } from 'node:path'
import * as nativeFs from 'node:fs'
import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'
import { Passthrough } from '@pluxel/core/fs'
import { resolveHostEnv } from '@pluxel/host/environment'
import { PackageManagerPlugin } from '@pluxel/plugin-package-manager'
import { pluginSource } from '@pluxel/host/sources'

const packageManagerNode = PackageManagerPlugin.nodeAddress()

export default defineHostApplication(async (startup) => {
	const dataRoot = resolve(
		startup.deployment?.root ?? startup.root,
		resolveHostEnv(startup.env).dataRoot,
	)
	const managedPackagesRoot = resolve(dataRoot, 'managed-plugins')
	const prefix = resolve(dataRoot, 'fs')
	await nativeFs.promises.mkdir(prefix, { recursive: true })

	return {
		name: 'managed-plugins',
		plugins: [PackageManagerPlugin],
		sources: [
			pluginSource({
				kind: 'directory',
				path: resolve(managedPackagesRoot, 'entries'),
				include: ['*.mjs'],
			}),
		],
		services: await servicesPreset(startup, {}),
		policy: { autoStart: [packageManagerNode] },
		config: {
			records: [
				{
					owner: packageManagerNode,
					config: {
						rootDir: managedPackagesRoot,
						ignoreScripts: true,
						allowBuilds: [],
						minimumReleaseAgeMinutes: 1_440,
					},
				},
			],
		},
		runtime: {
			zenfs: zenfs({
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			}),
		},
	}
})
```

## 配置项与安全策略

包管理器配置参数如下：

| 参数 | 类型 / 默认值 | 说明 |
| :--- | :--- | :--- |
| `rootDir` | `string` (`.pluxel/managed-plugins`) | 宿主专用的隔离 pnpm 项目目录 |
| `ignoreScripts` | `boolean` (`true`) | 是否禁用 npm 依赖中的安装脚本（如 `postinstall`） |
| `allowBuilds` | `string[]` (`[]`) | 允许执行构建/原生编译脚本的包名白名单 |
| `minimumReleaseAgeMinutes` | `number` (`1440`) | 拒绝安装发布时间少于指定分钟数的包（默认 24 小时，防范供应链投毒） |
| `markets` | `Array<{ id, url }>` (`[]`) | 远程插件市场连接端点列表 |

通过 `envBinding` 将配置项与环境变量绑定：

```ts no-twoslash
import { envBinding } from '@pluxel/host'
import { PackageManagerPlugin, PackageManagerConfig } from '@pluxel/plugin-package-manager'

envBinding(PackageManagerPlugin, {
	config: {
		schema: PackageManagerConfig,
		mapping: {
			minimumReleaseAgeMinutes: 'PLUGIN_MINIMUM_RELEASE_AGE',
			ignoreScripts: 'PLUGIN_IGNORE_SCRIPTS',
		},
	},
})
```

## 连接插件市场

在配置中加入 `markets` 数组即可接入插件市场服务：

```json
{
	"markets": [
		{ "id": "community", "url": "https://plugins.example.com" }
	]
}
```

- 连接 URL 为市场后端的基础接口地址（不含 `/v1`）。
- 未配置市场时，仍支持通过直接输入 npm package spec（如 `@acme/example-plugin@^2.0.0`）进行安装。
- 市场列表支持按分类、官方标记和标签筛选包，并提供 README、依赖项与校验元数据。

### 独立 React 市场组件

`@pluxel/plugin-package-manager/marketplace` 导出了无宿主依赖的 React 市场组件：

```tsx
import { Marketplace, type MarketplaceData } from '@pluxel/plugin-package-manager/marketplace'

export function Catalog({ data }: { data: MarketplaceData }) {
	return <Marketplace data={data} colorScheme="light" />
}
```

宿主传入 `MarketplaceData`（包含 `Packages`、`Package`、`Releases`、`Release` 数据读取器）即可完成市场浏览页面的渲染。

## 两阶段安装（Prepare 与 Confirm）

为保障安装安全性与版本可控性，交互式流程采用两阶段执行：

1. **准备阶段（Prepare）**：pnpm 解析版本树并下载依赖到私有修订版本（Revision）中。系统生成预览计划，包含精确安装版本、哈希与受影响的依赖。
2. **确认阶段（Confirm）**：校验预览未过期且文件完整后，正式将插件入口（`entries/*.mjs`）发布到生效目录。

在业务代码中执行两阶段安装：

```ts no-twoslash
const prepared = await packages.prepareInstall(['@acme/example-plugin@^2.0.0'])
if (!prepared.ok) {
	console.error('准备失败:', prepared.failed)
	return
}

console.log('待安装包版本:', prepared.plan.packages)

// 用户在界面确认后，根据同一 plan.id 提交确认
const installed = await packages.confirmInstall(prepared.plan.id)
if (!installed.ok) {
	console.error('安装确认失败:', installed.failed)
}
```

预览计划默认有效期为 10 分钟。对于无需人工确认的脚本自动化场景，也可以使用 `Commands` 服务直接调用单步安装。

## 命令系统调用

包管理器注册了标准 Commands 命令：

```ts no-twoslash
import { Commands } from '@pluxel/services/commands'

// 直接安装
const installed = await ctx.require(Commands).execute('package.install', {
	specs: ['@acme/example-plugin@^2.0.0'],
})
if (installed.isErr()) throw new Error(installed.error.message)

// 卸载插件
const removed = await ctx.require(Commands).execute('package.remove', {
	specs: ['@acme/example-plugin'],
})
if (removed.isErr()) throw new Error(removed.error.message)
```

支持的命令列表：
- `package.prepare({ specs })`：生成两阶段安装预览计划。
- `package.confirm({ planId })`：发布指定计划的插件。
- `package.install({ specs })`：一步完成依赖解析与安装发布。
- `package.remove({ specs })`：从受管目录中撤回指定插件的包装入口。

## 受管目录布局

包管理器的状态与文件存储于 `rootDir` 下：

```text
.pluxel/managed-plugins/
  published-installation.json  # 当前生效安装状态与版本记录
  revisions/<id>/             # 各修订版本的 package.json、lockfile 与物理文件
  slots/                      # 跨版本共享的不可变依赖缓存
  entries/*.mjs               # 供宿主动态加载的插件入口 Wrapper 文件
  .writer/                    # 进程级写锁，防止多进程并发损坏
```

- 进程内采用单写者模型，初始化与变更操作严格串行。
- 卸载插件时，系统会移除对应的 `entries/*.mjs` 入口文件；在 Vite 开发模式下系统会自动感知更新，在生产 Native 运行时通常在下一次重启时生效。
