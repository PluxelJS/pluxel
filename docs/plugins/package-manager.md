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

- 连接 URL 为市场后端的基础接口地址（不含 `/v1`）。
- 连接可指向 Worker 主站或只读目录镜像。镜像保留发行的来源和摘要，插件及依赖仍通过 pnpm 配置选择的 registry 获取。 [镜像部署](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/README.md#只读镜像)
- 未配置市场时，仍支持通过直接输入 npm package spec（如 `@acme/example-plugin@^2.0.0`）进行安装。
- 市场卡片显示包名、简介、仓库所有者、分类、来源、标签和 registry 最新版本。点击卡片查看详情，点击 `@PluxelJS` 等所有者筛选其仓库下的包，仓库链接可直接打开项目。详情中也可以按所有者回到结果，或按 `Esc` 返回之前的筛选、分页和焦点。
- **Overview** 展示 registry 提供的 README、许可证和已检查的版本数。**Versions** 可以阅读某个已检查版本随包发布的 README。带有 `ts`、`sh`、`json` 等语言标记的代码块会随页面主题高亮，长行可在代码块内横向滚动。
- 宽面板的筛选栏在结果左侧，窄面板点 **Filters** 展开。仓库所有者、分类、标签和来源支持多选，同一组取并集，各组同时生效。官方状态可选全部、官方或社区。可单独移除已选条件，也可点 **Clear filters** 清空筛选。
- 所有者来自包声明的 GitHub 仓库路径，公开 npm 和私有 registry 都使用这一规则。其他地址仍可打开，所有者显示为未知。跨 registry 同名包分别占一张卡片，详情、版本和安装都使用卡片上标明的来源。发行的发布证明可在版本详情中查看。
- Workbench 只在 registry 与已核验的安装来源一致时标记已安装版本、提示更新。其他来源的同名包会指出名称冲突。旧记录或直接安装缺少来源证据时显示本地版本和 **source unknown**。在新的市场预览中可核对来源变更，确认后才更新记录。

### 在 Workbench 一起安装多个精确版本

1. 打开 **Marketplace**，勾选所需包的卡片。在上方清单中分别选择精确版本。registry 的 `latest` 出现在当前已检查的版本页时会被预选。可以翻页选择旧版或预发行版，也可以打开 **Versions** 阅读某次发行的依赖、来源证明和摘要，再用 **Add to selection** 加入清单。
2. 继续搜索、翻页或切换市场。清单保留已选项和明确选择的版本。一批最多安装 100 个不同包名，每个包名对应一个市场、registry 和版本。更换同名包的来源时，先从清单移除原来的选择。
3. 点 **Review selection**。包管理器逐一读取所选发行并核对应用的 npm 来源，再用一次 pnpm 安装准备整个依赖图。在预览中核对新增、升级、降级和依赖变化，展开 **Sources and integrity** 可以查看每个选中包的市场、registry 和完整性摘要。准备失败会指出出错项，已发布的包保持原状态。
4. 点 **Confirm installation** 发布这份预览的插件入口。页面报告实际已发布的包和失败项。**Installed** 显示受管版本和宿主报告的插件状态。宿主可以即时接纳入口，也可能在下次启动时接纳。

**Metadata only** 表示市场尚未检查该包的可安装发行。仍可打开卡片浏览。要直接从应用配置的 npm registry 安装，在 **Direct install** 输入 `@scope/plugin@1.2.3`，多包可分行填写，然后预览并确认。

在 **Installed** 可按包名或插件名搜索，用 **Running only** 查看宿主报告正在运行的插件。宿主装配的包也会显示，只有受包管理器管理的包可以在这里卸载。勾选受管包后点 **Review removal**，核对版本、宿主报告及生效时机，再确认移除。受管选择发生变化时需要重新审阅。撤回入口失败时，页面保留 **Retry removal** 以便重试。

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
	console.log('已发布入口', result.succeeded)
	if (!result.ok) console.error('发布失败', result.failed)
}
```

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

安装发布后，自动化脚本通过 Host 当前 catalog 发现插件并操作。尚无类型时，同步控制材料后再编写强类型方法调用，见[动态安装后的发现与操作](../development/plugin-control.md#动态安装后的发现与操作)。
