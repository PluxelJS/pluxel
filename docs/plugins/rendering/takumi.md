---
title: Takumi HTML 图片渲染
description: 使用 FontsPlugin 管理的可移植字体，把 HTML 或 Takumi node tree 有界地渲染为图片或 SVG。
---

`@pluxel/takumi` 用 Rust/Takumi 在 Node 上渲染 HTML/CSS 和 Takumi node tree，不启动 headless browser。适合
Open Graph 图片、社交卡片、邮件插图与服务端模板。它直接依赖 `FontsPlugin`，与 Canvas/ECharts 是并列 renderer：

```text
                  ┌─> @pluxel/canvas -> @pluxel/echarts
@pluxel/fonts ----┤
                  └─> @pluxel/takumi
```

## 安装和装配

```sh
npx nypm add @pluxel/takumi @pluxel/fonts
```

Host catalog 包含 Fonts、Takumi 与 consumer；业务 Plugin 只声明直接使用的 Takumi：

```ts
import { TakumiPlugin } from '@pluxel/takumi'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin()
export class SocialCardsPlugin extends BasePlugin {
	constructor(private readonly takumi: TakumiPlugin) {
		super()
	}

	async renderCard(title: string) {
		const result = await this.takumi.render({
			content: `<article class="card"><h1>${escapeHtml(title)}</h1></article>`,
			stylesheets: [
				'.card{display:flex;width:100%;height:100%;align-items:center;justify-content:center;background:linear-gradient(135deg,#1d4ed8,#7c3aed);color:white}',
			],
			width: 1200,
			height: 630,
			output: { format: 'webp', quality: 88 },
		})
		return result.data
	}
}
```

HTML 不执行 script。动态文本、attribute 和 CSS value 仍由业务模板负责正确编码。

## 选择输入

`content` 接受 HTML string 或 `TakumiNode`。HTML 最直接；已有结构化模板时可以提交 node tree：

```ts
await this.takumi.render({
	content: {
		type: 'container',
		style: { display: 'flex', width: '100%', height: '100%' },
		children: [{ type: 'text', text: 'Structured card' }],
	},
	width: 1200,
	height: 630,
})
```

Node graph 在 render settle 前按 borrowed contract 保持不变。任务先通过 fair queue admission，再检查 declarative shape
与结构预算；验证后的 borrowed graph 直接交给准备流程，不额外执行一次同步 clone。binary image 不允许内嵌在 node `src`，
统一使用下方有 count/bytes ceiling 的 `images` 路径。React/Preact
component 会执行用户代码，因此不直接属于 Plugin input；先用 `takumi-js` helper 转成 declarative node。

## 使用 FontsPlugin 字体

从 Fonts Workbench 上传的 managed font，以及业务 Plugin 通过 `fonts.register()` / `registerFromPath()` 注册的 font，
都会进入可移植资源集合。Takumi 按集合 revision 建立 renderer-local registry：同一 revision 只复制和注册一次，字体
删除或替换后创建新 registry。

```ts
await this.fonts.registerFromPath({
	path: fileURLToPath(new URL('../assets/BrandSans.woff2', import.meta.url)),
	family: 'Brand Sans',
})

await this.takumi.render({
	content: '<h1 class="title">Brand</h1>',
	stylesheets: ['.title{font-family:"Brand Sans"}'],
	width: 1200,
	height: 630,
})
```

这里 consumer 如果要注册随包字体，需要同时直接注入 `FontsPlugin`；仅渲染时仍只注入 Takumi。Takumi detail 的 Fonts tab
只列可移植 family。操作系统自动发现的 system font 没有 FontsPlugin-owned bytes，Canvas 可以直接使用，但 Takumi 不会
假装已加载；没有可移植字体时最终回落到 Takumi 内嵌 Geist。

## 预加载远程图片

Plugin 不执行隐式网络请求。先通过业务 HTTP capability 获取 bytes，再按 HTML/CSS 中完全相同的 URL 提供资源：

```ts
const data = await this.http.getBytes(avatarUrl)

await this.takumi.render({
	content: `<img src="${escapeHtmlAttribute(avatarUrl)}">`,
	images: [{ src: avatarUrl, data }],
	width: 1200,
	height: 630,
	signal,
})
```

缺少匹配项时返回 `TakumiError` 的 `INVALID_IMAGE`。redirect、认证、retry、SSRF allowlist 和 HTTP cache 都留在
下载能力中；Takumi 只消费已经取得的 bytes。content、stylesheets 和 image bytes 在 render settle 前不得修改；
图片 copy 在 scheduler admission 后分片进行，可在 checkpoint 取消。

## 输出、取消与错误

`render()` 支持 PNG、JPEG、WebP；`renderSvg()` 返回 SVG string。Raster result 给出 media type、logical dimensions、
DPR 与实际使用的 portable font revision。公开失败可按 `TakumiError.code` 分支，例如
`PIXELS_EXCEEDED`、`IMAGE_BYTES_EXCEEDED`、`FONT_COUNT_EXCEEDED`、`FONT_BYTES_EXCEEDED`、
`RENDER_TIMEOUT`、`RENDER_BUSY` 与 `OUTPUT_TOO_LARGE`。

Takumi raster/SVG 通过 N-API async work 在进程共享的 libuv worker pool 中执行，不是仅把同步计算包装成 Promise。
`signal`、Plugin stop/replacement 和 consumer stop/replacement 会立即撤销 Plugin queue、cooperative preparation，以及尚未
开始的 native work。已经进入 native `compute()` 的任务无法抢占；Plugin 会继续占住自己的 admission slot，等它完成后
丢弃结果并拒绝 caller。字体 registration 是同一 revision 的共享准备工作，且 Takumi 发布包装器的注册入口当前不接受
signal；单个 caller 或 provider stop 会在 registration 之间或完成后的 checkpoint 停止后续 render。

这里没有为了“render 都很重”而重复套 Worker：Takumi raster/SVG 已由 N-API 提交到共享 libuv pool，再套一层仍占同一
libuv slot，同时额外占用 runtime Worker，并复制输入和字体。剩余风险是上游同步 `fromHtml()` parser，以及 N-API 提交前
的 JS-to-Rust node/options 反序列化和 stylesheet cache parse；它们在 scheduler admission
后运行并受默认 1 MiB content ceiling 约束，但单次调用不能被 signal 抢占。结构 walk 与大 byte copy 会 cooperative yield。
大 HTML/node/stylesheet 与 SVG output 的 UTF-8 byte 计量也按 64 Ki characters 分片，可在 checkpoint 取消。

## 配置边界

```ts
host.cfg(TakumiPlugin).set({
	defaultDevicePixelRatio: 1,
	maxDevicePixelRatio: 4,
	maxWidth: 8192,
	maxHeight: 8192,
	maxPixels: 16_777_216,
	maxContentBytes: 1024 * 1024,
	maxContentNodes: 10_000,
	maxTextCharacters: 1_000_000,
	maxStylesheets: 64,
	maxStylesheetBytes: 1024 * 1024,
	maxImages: 256,
	maxImageBytes: 32 * 1024 * 1024,
	maxFonts: 256,
	maxFontBytes: 128 * 1024 * 1024,
	maxOutputBytes: 64 * 1024 * 1024,
	cacheMaxBytes: 16 * 1024 * 1024,
	maxRenderDurationMs: 30_000,
	maxConcurrentRenders: 2,
	maxQueuedRenders: 32,
	maxQueuedRendersPerConsumer: 8,
})
```

`maxContentBytes` 同时约束 HTML UTF-8 bytes，以及 structured node 的字符串与结构负载；explicit/content-referenced image
source 由 `maxImages/maxImageBytes` 约束，explicit 与 HTML-extracted stylesheet 共同受 count/bytes 约束。
`maxRenderDurationMs` 从 queue admission 开始计时，覆盖 snapshot、字体/图片准备与 native result 的有效期；已经开始的
native work 不能强制终止，可能在 deadline 后才完成并被丢弃。每个 concurrent render 占用一个进程共享的 libuv slot；
高吞吐部署应结合启动时的 `UV_THREADPOOL_SIZE` 调整 `maxConcurrentRenders`，同时给 filesystem、crypto、DNS 和其他 N-API
work 留出容量。
width/height budget 检查应用 DPR 后的 physical dimensions。font count 在任何 portable byte copy 前检查；image/font byte
limits 是输入 bytes 预算，不能把 native renderer
变成安全 sandbox；decoded image 与 glyph 内存还受 Takumi 实现影响。`maxOutputBytes` 在编码完成后检查，用于限制返回值，
不能撤销已经发生的编码成本。
