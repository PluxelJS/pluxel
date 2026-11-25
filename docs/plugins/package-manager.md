---
title: 插件市场与包管理器
description: 连接插件市场，或直接通过受控 pnpm 环境安装与更新插件包。
---

> `@pluxel/plugin-package-manager` 目前主要供 Pluxel 工作区内使用。完整包状态见 [Package 矩阵](../reference/package-matrix.md)。

`@pluxel/plugin-package-manager` 在 Node 宿主中用 pnpm 与原生绑定安装、更新和卸载 npm 插件，再发布标准的 `.mjs` 入口。Node 原生加载器可在下次启动时扫描目录，托管 Vite 可在线接纳变更。LLRT 和 React Native 示例在开发机解析依赖，在设备上安装已经编译好的 JS，再重载运行时。 [跨平台开发与交付](../host/runtime-portability.md#开发与交付)

## 宿主装配

在 `plugins` 中给 `PackageManagerPlugin` 声明启动意图和管理目录，再用 `sources` 接纳该目录发布的入口。

```ts no-twoslash
import { resolve } from 'node:path'
import * as nativeFs from 'node:fs'
import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'
import { Passthrough } from '@pluxel/core/fs'
import { resolveHostEnv } from '@pluxel/host/environment'
import { PackageManagerPlugin } from '@pluxel/plugin-package-manager'

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
		plugins: [
			{
				plugin: PackageManagerPlugin,
				autoStart: true,
				config: {
					rootDir: managedPackagesRoot,
					ignoreScripts: true,
					allowBuilds: [],
					minimumReleaseAgeMinutes: 1_440,
				},
			},
		],
		sources: [{ directory: resolve(managedPackagesRoot, 'entries'), include: ['*.mjs'] }],
		services: await servicesPreset(startup),
		coreConfig: {
			zenfs: {
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			},
		},
	}
})
```

## 配置项与安全策略

包管理器配置参数如下：

| 参数                       | 类型 / 默认值                        | 说明                                                               |
| :------------------------- | :----------------------------------- | :----------------------------------------------------------------- |
| `rootDir`                  | `string` (`.pluxel/managed-plugins`) | 宿主专用的隔离 pnpm 项目目录                                       |
| `ignoreScripts`            | `boolean` (`true`)                   | 是否禁用 npm 依赖中的安装脚本（如 `postinstall`）                  |
| `allowBuilds`              | `string[]` (`[]`)                    | 允许执行构建/原生编译脚本的包名白名单                              |
| `minimumReleaseAgeMinutes` | `number` (`1440`)                    | 拒绝安装发布时间少于指定分钟数的包（默认 24 小时，防范供应链投毒） |
| `markets`                  | `Array<{ id, url }>` (`[]`)          | 远程插件市场连接端点列表                                           |
| `npmMirrors`               | `string[]`（默认包含 npmmirror）     | 安装公共 npm 的已检查发行时，允许 pnpm 使用的镜像地址              |

在包管理器节点的 `envBindings` 中加入：

```ts no-twoslash
import { envBinding } from '@pluxel/host'
import { PackageManagerConfig } from '@pluxel/plugin-package-manager'

envBinding({
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
	"markets": [{ "id": "community", "url": "https://plugins.example.com" }]
}
```

URL 使用主站或只读目录镜像的基础地址，省略 `/v1`。要从 npmmirror 下载包，在应用的 `.npmrc` 中设置 `registry=https://registry.npmmirror.com/`。市场里仍按 **npm** 筛选；自建公共 npm 镜像可加入 `npmMirrors`，独立发布包的私有 registry 可登记为单独来源。scope 的专属 registry 优先。[市场来源配置](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/README.md#本地运行与来源配置) · [只读目录镜像](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/README.md#只读镜像)

### 浏览市场和版本

在 **Marketplace** 按包名搜索，也可按仓库所有者、类别、标签和来源筛选。窄屏点 **Filters** 展开。每组可多选，各组条件同时生效。点击所有者可筛出其仓库下的包，点卡片进入详情；按 `Esc` 返回原来的筛选、分页和焦点。

- **Overview** 显示 registry README 和包资料。包名与标签栏滚动时吸顶。宽屏侧栏可跳到 README 章节，窄屏可展开 **Plugin details**。若该元数据版本已有检查记录，**Requirements** 会列出 Core 范围、必需和可选插件。
- **Versions** 列出已检查的发行。展开版本可读归档内的 README、依赖、摘要和发布证明。点依赖可查看同一来源的包及其版本是否满足上级范围。缺少收录记录时，可点 **Search all sources** 查找其他来源。
- **Metadata only** 表示目前仅有包资料。遇到跨 registry 的同名包，请核对卡片上的来源。Workbench 依据已核验的安装来源标记更新；直接安装或旧记录缺少来源证据时显示 **source unknown**。

### 在 Workbench 一起安装多个精确版本

1. 勾选包卡片并选择精确版本，也可以在 **Versions** 中点 **Add to selection**。清单会随搜索、翻页和切换市场保留。每个包名选一个来源，单次最多 100 个包。
2. 点 **Review selection**。预览列出新增、升级、降级、依赖变化，以及每个自动加入的必需插件由谁引入。可选插件可手动加入。遇到范围冲突或需要换源时，返回清单显式选择版本及来源，再次审阅。
3. 在 **Host impact** 查看每个受管入口预计新增、替换、移除的根插件，以及当前默认节点、fork、运行状态和直接依赖它们的节点。包没有声明控制清单时，预览仍列出 Host 已知的使用方，将导出变化标为未核实。多个来源共用的定义也会单独标明变化未核实。候选声明的必需或可选插件在预计目录中缺少 provider 时，即使候选尚未启用，预览也会列出缺项。**Projected Host policy changes** 显示整批发布后，按当前启用意图会更换或失去的必需 provider，以及新增或解除的阻塞。预测使用包声明的自有根与保留的 Host 定义。候选首次重导出的外部插件在实际加载时才能发现。遇到缺失的声明，**Dependency projection incomplete** 会列出受影响的包、定义和原因。
4. 在 **Sources and integrity** 核对来源和摘要，点 **Confirm installation** 发布已审阅的入口。确认返回 `INVALID_PLAN` 时，重新准备并核对。`HOST_GRAPH_BUSY` 表示有 Host 操作待结算，待其结束后重新审阅。`SOURCE_CONFLICT` 会指出已由应用或其他来源提供的定义，先调整对应来源。发布回执逐包列出入口结果。在 **Installed** 查看受管版本，点节点名查看实际运行状态。若节点因当前配置需要的宿主服务缺失而启动失败，可在这里查看原因。

### 查找市场以外的插件

在 **Find plugins** 输入关键词，或直接检查包名、版本和标签。搜索使用应用的 pnpm registry，默认优先查找 Pluxel 相关包。可输入 scope 缩小范围，或勾选 **Search all registry packages** 扩大到普通 npm 结果。这个入口在未配置市场时也可使用。

点 **Check package** 查看精确版本、Core peer 范围、宿主版本和根入口。兼容的候选可点 **Review installation**；多包可在 **Review multiple package names** 中分行填写。包管理器在实际文件上复核当前宿主兼容性和根 JavaScript 导出；声明了 `pluxel.control` 的包还须提供根插件定义。普通传递依赖由 pnpm 安装。

### 管理和卸载

安装回执的 **Manage installed packages** 会打开 **Installed**。可以按包名、插件名、版本搜索，或用 **Running only** 查看正在运行的节点。受管包支持单包 **Uninstall**，也可勾选多个包后点 **Review removal**。筛选保留勾选项，并提示有多少项已隐藏。应用随附的包由应用自己的依赖配置管理。

核对包名、版本、运行状态及生效时机后确认移除。如果受管选择在审阅后改变，需要重新审阅；选择已移除但入口尚未撤回时，点 **Retry removal** 重试。

### 在同一查看器阅读本地包和公共 npm 包

在 **Installed** 点包名查看实际安装版本、许可证和 README，点 **Dependencies** 沿普通、可选或 peer 依赖打开当前包使用的副本。缺少 README 或可选依赖时，查看器会标明原因。点插件节点名则打开对应节点的运行状态。

在市场搜索框输入完整包名，未找到时点 **Look up … on public npm** 可匿名阅读其 registry README。打开未收录的依赖时也可以这样查询，查看器会沿用上一级声明的版本范围。公共 npm 查看器只提供阅读；要安装请使用 **Find plugins**。

### 独立 React 市场组件

文档站的「插件市场」页面位于 `/market`。其他站点也可以用同一组件和公开市场地址嵌入只读目录：

```tsx
import { createMarketplaceData, Marketplace } from '@pluxel/plugin-package-manager/marketplace'

const data = createMarketplaceData('https://plugins.example.com')

export function Catalog() {
	return <Marketplace data={data} colorScheme="light" />
}
```

需使用其他传输时可以传入自己的 `MarketplaceData`。其中 `Packages` 读取分页包列表，`Facets` 读取当前条件下的选项和计数，`Package`、`Releases`、`Release` 读取详情。两个目录读取器接收同一套筛选条件，只有 `Packages` 接收游标和页大小。Workbench 通过这个接口连接当前应用，再为同一组件组合卡片和发行操作。每个打开的 Workbench 文档管理自己的清单、预览、确认和卸载。

## 两阶段安装（Prepare 与 Confirm）

为保障安装安全性与版本可控性，交互式流程采用两阶段执行：

1. **准备阶段（Prepare）**：pnpm 解析版本树并下载依赖到私有修订版本（Revision）中。系统生成预览计划，包含精确安装版本、哈希与受影响的依赖。
2. **确认阶段（Confirm）**：校验预览未过期且文件完整后，正式将插件入口（`entries/*.mjs`）发布到生效目录。

从代码安装市场中选定的版本时，把所有坐标一起传给 `prepareMarketInstall`。把返回的计划交给用户审阅，确认操作提交同一个 `plan.id`。

```ts no-twoslash
const registry = 'https://registry.npmjs.org'
const selection = [
	{ marketId: 'community', registry, name: '@acme/charts', version: '2.1.0' },
	{ marketId: 'community', registry, name: '@acme/fonts', version: '1.4.0' },
]
const prepared = await packages.prepareMarketInstall(selection)
if (!prepared.ok) {
	console.error('准备失败', prepared.failed)
	return
}

// 由界面展示计划并等待用户确认
if (await confirmInUI(prepared.plan)) {
	const result = await packages.confirmInstall(prepared.plan.id)
	console.log('已发布入口', result.published)
	console.log('已撤回入口', result.withdrawn)
	if (!result.ok) console.error('确认失败项', result.failed)
}
```

确认回执的 `succeeded` 列出成功的请求包。包已是所选版本且入口完好时，请求也能成功。`published` 和 `withdrawn` 分别列出本次审阅范围内完成发布和撤回的入口，可包含顺带修复或撤回的其他包。若保存安装选择后仅部分入口生效，这两个列表只包含已达到目标状态的入口，失败项见 `failed`。

直接从 npm 安装时用 `packages.prepareInstall(['@acme/example-plugin@^2.0.0'])` 生成计划，同样要确认后才发布。计划默认有效期为 10 分钟。脚本也可以通过 `Commands` 调用单步安装。

## 命令系统调用

包管理器注册了标准 Commands 命令：

```ts no-twoslash
import { Commands } from '@pluxel/services/commands'

// 直接安装
const installed = await ctx.service(Commands).execute('package.install', {
	specs: ['@acme/example-plugin@^2.0.0'],
})
if (installed.isErr()) throw new Error(installed.error.message)

// 卸载插件
const removed = await ctx.service(Commands).execute('package.remove', {
	specs: ['@acme/example-plugin'],
})
if (removed.isErr()) throw new Error(removed.error.message)
```

支持的命令列表：

- `package.prepare({ specs })`：生成两阶段安装预览计划。
- `package.confirm({ planId })`：确认指定计划，返回与 `packages.confirmInstall(planId)` 相同的回执。
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

安装发布后，自动化脚本通过 Host 当前 catalog 发现插件并操作。尚无类型时，同步控制材料后再编写强类型方法调用，见[动态安装后的发现与操作](../development/plugin-control.md#动态安装后的发现与操作)。
