---
title: Takumi JSX / HTML 图片渲染
description: 使用原生 Takumi API 或共享 Worker，将 JSX、HTML 与 node tree 渲染为图片、SVG 和动画。
---

`@pluxel/plugin-takumi` 将 [Takumi](https://takumi.kane.tw/docs/) 渲染引擎接入插件系统。它支持将 React JSX、HTML 字符串或 Takumi Node Tree 渲染为 PNG/WebP 图片、SVG 矢量图或动图，且内置了基于 Worker 线程池的高效离线渲染支持。

核心 API 提供两种执行方式：

| 渲染目标 | 主线程直接渲染 | 线程池异步渲染（推荐） | 输出格式 |
| :--- | :--- | :--- | :--- |
| 位图图片 | `render(input, options)` | `renderInWorker(input, options)` | `Buffer` / `Uint8Array` |
| SVG 矢量图 | `renderSvg(input, options)` | `renderSvgInWorker(input, options)` | `string` (SVG) |
| 动图序列 | `renderAnimation(options)` | `renderAnimationInWorker(options)` | `Buffer` / `Uint8Array` |

## 安装与装配

在工作区中添加依赖：

```sh
vp exec pluxel pncat add @pluxel/plugin-takumi
```

在插件中注入并渲染一张社交媒体卡片：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { TakumiPlugin } from '@pluxel/plugin-takumi'

@Plugin()
export class SocialCardsPlugin extends BasePlugin {
	constructor(private readonly takumi: TakumiPlugin) {
		super()
	}

	renderCard(title: string, signal?: AbortSignal) {
		return this.takumi.renderInWorker(
			{
				type: 'container',
				style: {
					display: 'flex',
					width: '100%',
					height: '100%',
					alignItems: 'center',
					justifyContent: 'center',
					backgroundColor: '#1d4ed8',
					color: 'white',
				},
				children: [{ type: 'text', text: title, style: { fontSize: 64 } }],
			},
			{ width: 1200, height: 630, format: 'webp', quality: 88, signal },
		)
	}
}
```

- 生成结果直接为 WebP 图片二进制数据，可直接写入文件或作为 HTTP 响应发送。

## 使用 HTML 字符串在 Worker 中渲染

调用方可以直接传入带 CSS 的 HTML 模板：

```ts no-twoslash
const png = await this.takumi.renderInWorker('<h1 class="title">项目运营周报</h1>', {
	width: 1200,
	height: 630,
	css: '.title { font-size: 72px; color: #0f766e; }',
	fonts: [{ name: 'Report Sans', data: fontBytes }],
	format: 'png',
	signal,
})
```

`renderInWorker` 内部会自动使用宿主的共享 Worker 线程池，避免 HTML 解析与 CSS 计算阻塞应用主线程。

## 结合 React 与 HeroUI v3 组件

在支持 TSX 的插件中，可以直接使用 React 组件甚至成熟的 UI 库（如 HeroUI）声明界面，Takumi 会在服务端直接解析虚拟 DOM：

```tsx no-twoslash
import { Card } from '@heroui/react'

return this.takumi.render(
	<Card className="w-full h-full">
		<Card.Header>
			<Card.Title>项目报告</Card.Title>
			<Card.Description>2026 年度经营分析</Card.Description>
		</Card.Header>
		<Card.Content>本季度核心指标已全部达成。</Card.Content>
	</Card>,
	{ width: 1200, height: 630, css, fonts, format: 'png', signal },
)
```

若需将组件执行本身也移入 Worker 线程，可在子模块中通过 `defineWorkerTask` 定义专用的渲染任务，并在 Worker 内导入 `@pluxel/plugin-takumi/worker` 进行渲染。

## 字体与图片资源管理

### 字体注册
Takumi 渲染中文或自定义字体时，需传入对应的字体字节：

```ts no-twoslash
import { readFile } from 'node:fs/promises'

const fontData = await readFile(new URL('./assets/BrandSans.woff2', import.meta.url))

const image = await this.takumi.render('<h1 class="title">Pluxel</h1>', {
	width: 1200,
	height: 630,
	fonts: [{ name: 'Brand Sans', data: fontData }],
	css: '.title { font-family: "Brand Sans"; font-size: 72px; }',
})
```

若宿主安装了 `FontsPlugin`，可调用其 `portableFonts` 接口读取系统或上传的字体字节后传入。

### 图片加载
图片可以通过 URL 远程加载，或直接提供已下载的二进制数据：

```ts no-twoslash
await this.takumi.render('<img src="https://assets.example.com/logo.png">', {
	width: 1200,
	height: 630,
	images: [{ src: 'https://assets.example.com/logo.png', data: logoBytes }],
	signal,
})
```

## 渲染缓存与资源回收

- Takumi 底层会自动复用字形缓存、图片解码与解析后的 CSS 规则。
- 当传入 `AbortSignal` 并触发取消时，Worker 线程会及时中止排队与执行，释放占用的内存资源。
- 插件卸载或重载时，该插件提交的所有在途渲染任务都会被自动取消。
