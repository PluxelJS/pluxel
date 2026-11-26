---
title: 服务端字体
description: 发现、注册和管理服务端字体，并为 Canvas、ECharts 与 Takumi 提供统一字体资源。
---

`@pluxel/plugin-fonts` 统一管理服务端环境中的字体资源：自动发现宿主操作系统已安装字体、注册插件随包携带的字体文件、管理从控制台上传的自定义字体，并为 Canvas、ECharts 和 Takumi 等渲染引擎提供统一的字体查找与字节分发接口。

<span id="何时直接使用-fontsplugin"></span>

## 何时直接注入 FontsPlugin

- 插件自身打包了 `.ttf`、`.otf`、`.woff` 或 `.woff2` 静态字体文件，需要在服务端渲染前完成注册。
- 业务代码需要查询可用字体族（Font Families）或所绑定 Fonts 节点的默认字体。
- 编写自定义渲染插件，需要感知字体变化信号（`revision`）以刷新文本测量缓存。
- 在插件的 Workbench 标签页、路由或面板修改所绑定 Fonts 节点的默认字体偏好。

若仅是使用 Canvas、ECharts 或 Takumi 进行普通渲染，通常直接依赖对应的渲染插件即可，无需单独注入 `FontsPlugin`。

## 安装与装配

在工作区中添加依赖：

```sh
vp exec pluxel pncat add @pluxel/plugin-fonts
```

在插件中声明注入：

```ts twoslash
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin()
export class ReportsPlugin extends BasePlugin {
	constructor(private readonly fonts: FontsPlugin) {
		super()
	}
}
```

## 注册随插件分发的字体

如果插件携带了专属字体资产，可以在 `init()` 生命周期中进行注册：

```ts twoslash
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { BasePlugin, Plugin } from '@pluxel/core'
import { fileURLToPath } from 'node:url'

@Plugin()
export class ReportsPlugin extends BasePlugin {
	constructor(private readonly fonts: FontsPlugin) {
		super()
	}

	protected override async init() {
		await this.fonts.registerFromPath({
			path: fileURLToPath(new URL('../assets/ReportSans.woff2', import.meta.url)),
			family: 'Report Sans',
		})
	}
}
```

- `registerFromPath()` 接受本地绝对路径，并校验文件大小限制。
- 如果已经将字体读取到内存（如 Buffer 或 `Uint8Array`），可直接调用 `this.fonts.register({ data, family })`。
- 注册句柄与插件生命周期绑定：当插件停止或重载时，注册的字体资源会自动注销，防止内存泄漏。

## 读取字体信息与默认字体

```ts no-twoslash
// 获取当前所有可用字体族的快照
const families = this.fonts.families

// 获取所绑定 Fonts 节点解析后的默认字体
const current = this.fonts.defaultFont

// 字体版本修订号（注册变化时递增，可用于测量缓存失效）
const revision = this.fonts.revision
```

默认字体的解析优先级如下：

1. 宿主通过配置明确指定的 `defaultFamily`；
2. 管理员在控制台中持久化保存的默认偏好；
3. 当前操作系统的默认系统字体；
4. 兜底回退至通用 `sans-serif`。

### 导出可移植字体字节

针对独立的纯 WebAssembly 或原生渲染引擎（如 Takumi），无法直接共享 Canvas 全局字体库。此时可通过 `portableFonts` 按需获取字节：

```ts no-twoslash
const snapshot = this.fonts.portableFonts

for (const font of snapshot.fonts) {
	const fontBytes = await this.fonts.readPortableFont(font.id, { signal })
	// 注册到独立渲染引擎的私有 Registry 中
}
```

## 宿主配置与环境变量绑定

在 FontsPlugin 节点的 `envBindings` 中指定静态字体文件与默认字体族。

```ts no-twoslash
import { envBinding } from '@pluxel/host'
import { FontsConfig } from '@pluxel/plugin-fonts'

envBinding({
	config: {
		schema: FontsConfig,
		mapping: {
			files: 'FONT_FILES',
			defaultFamily: 'FONT_FAMILY',
		},
	},
})
```

示例环境变量：

- `FONT_FILES='["/app/fonts/CustomSans.ttf"]'`
- `FONT_FAMILY='Custom Sans'`

常用配置项与其默认值：

| 配置项              | 默认值    | 说明                                     |
| :------------------ | :-------- | :--------------------------------------- |
| `files`             | `[]`      | 宿主启动时自动加载的字体文件绝对路径列表 |
| `defaultFamily`     | 自动检测  | 默认字体族名称                           |
| `maxManagedFonts`   | `64`      | 控制台持久化上传的字体数量上限           |
| `maxFontBytes`      | `16 MiB`  | 单个字体文件最大字节限制                 |
| `maxTotalFontBytes` | `256 MiB` | 动态注册字体的总内存占用上限             |

## 在工作台修改字体节点的默认偏好

`FontsWorkbench.selection` 提供字体目录和选择器。选择值通过 `provider.setPreferredFamily()` 保存到所绑定的 Fonts 节点，所有使用该节点的插件共享同一份默认偏好。有效的宿主配置 `defaultFamily` 优先决定最终采用的字体。

下面的报表插件在自己的详情页放置“默认字体”标签。构造函数注入的 `this.fonts` 指定实际保存偏好的节点。

```ts no-twoslash
import { BasePlugin, Plugin, defineServiceRef } from '@pluxel/core'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { FontsWorkbench } from '@pluxel/plugin-fonts/workbench'
import { workbench, type Workbench } from '@pluxel/workbench'

const WorkbenchRef = defineServiceRef<Workbench>()

export const ReportsWorkbench = workbench.define(import.meta.url, {
	fonts: FontsWorkbench.selection.place({ kind: 'tab', label: '默认字体' }),
})

@Plugin()
export class ReportsPlugin extends BasePlugin {
	constructor(private readonly fonts: FontsPlugin) {
		super()
	}

	protected override init() {
		this.ctx.service(WorkbenchRef)?.publish(ReportsWorkbench, {
			fonts: { provider: this.fonts },
		})
	}
}
```

如果一份报表的选择只能影响该报表，可以用双向 Attachment 让消费方提供读写报表字体的 RPC target。两端的绑定和写入示例见[由消费方保存选择](../../workbench/composition.md#由消费方保存选择)。

## 错误处理与业务 Result 封装

在面向用户的字体上传或注册场景中，可将预期的输入异常转换为结构化 Result：

```ts twoslash
import { Result, TaggedError } from '@pluxel/core/better-result'
import {
	FontsError,
	type FontsPlugin,
	type FontRegistration,
	type FontRegistrationInput,
} from '@pluxel/plugin-fonts'

export class FontRejected extends TaggedError('FontRejected')<{
	reason: 'invalid_font' | 'too_large'
}> {}

export async function registerBrandFont(
	fonts: FontsPlugin,
	input: FontRegistrationInput,
): Promise<Result<FontRegistration, FontRejected>> {
	try {
		return Result.ok(await fonts.register(input))
	} catch (error) {
		if (error instanceof FontsError && error.code === 'INVALID_FONT') {
			return Result.err(new FontRejected({ reason: 'invalid_font' }))
		}
		if (error instanceof FontsError && error.code === 'FONT_TOO_LARGE') {
			return Result.err(new FontRejected({ reason: 'too_large' }))
		}
		throw error
	}
}
```
