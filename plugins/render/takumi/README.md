# @pluxel/takumi

`@pluxel/takumi` 基于 [Takumi](https://github.com/kane50613/takumi) 的 Node 原生 renderer，
把 HTML 或 Takumi node tree 渲染为 PNG、JPEG、WebP 或 SVG。Plugin 统一应用物理像素、输入资源、
输出、cache、并发和队列预算，并将 `@pluxel/fonts` 作为 required dependency。

```ts
import { TakumiPlugin } from '@pluxel/takumi'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin()
export class CardsPlugin extends BasePlugin {
	constructor(private readonly takumi: TakumiPlugin) {
		super()
	}

	render(title: string) {
		return this.takumi.render({
			content: `<main class="card"><h1>${escapeHtml(title)}</h1></main>`,
			stylesheets: [
				'.card{display:flex;width:100%;height:100%;align-items:center;justify-content:center;background:#0f172a;color:white}',
			],
			width: 1200,
			height: 630,
		})
	}
}
```

Host catalog 包含 `[FontsPlugin, TakumiPlugin, CardsPlugin]`，业务 Plugin 只注入自己直接使用的
`TakumiPlugin`。`render()` 返回 caller-owned `Buffer`；`renderSvg()` 返回 SVG 字符串。Raster 默认输出 PNG，
JPEG/WebP 的 quality 与 WebP lossless 通过互斥 `output` variant 表达。

## 字体

FontsPlugin 的 managed upload 与 `register()` / `registerFromPath()` 字体会进入内容寻址的
`portableFonts` 投影。Takumi 为每个字体 revision 创建 renderer-local registry，复制每个资源一次并复用
Takumi 自己的 parsed resource cache；字体删除或替换后新 revision 不会继续看见旧 registry。

平台自动发现的系统字体只有 Canvas native registry 能看到，FontsPlugin 不拥有其文件 bytes，因此不会伪装成
Takumi 可移植资源。Takumi 放置通用的 provider-owned Fonts selection Attachment；selector 展示 Fonts 的完整 provider
catalog，而 Takumi 的 headless render 路径仍只 replay 真正拥有 bytes 的 portable families。如果 provider-wide default
指向不可移植的系统 family，Takumi 依次使用可移植 families，再回落到上游内嵌 Geist last-resort font。

## 图片、取消和调度

TakumiPlugin 不执行隐式网络请求。HTML/CSS/node tree 的 image source 必须是 string；对应 HTTP(S) 或内存命名图片必须在
`images` 中按相同 `src` 提供 bytes；下载、认证、redirect、retry 与 origin policy 由 Wretch 或业务 HTTP capability
负责。content、stylesheets 和 images 在 render settle 前不得修改；任务先完成 fair queue admission，再 cooperative
snapshot 图片 bytes。结构化 node 使用 borrowed graph，不再做第二次同步 clone；大字符串 UTF-8 计量与 byte copy 都会
分片。remote URL 缺少匹配资源会以 `INVALID_IMAGE` 失败。

Takumi 的 raster/SVG 核心计算通过 N-API async work 运行在进程共享的 libuv pool，因此 Plugin 不再把它套进
`ctx.workers`。那样仍会占用同一个 libuv slot，并额外占住 Runtime Worker。Plugin 自己做 caller-aware 有界 admission
和 owner round-robin；默认只并发两个 native render，给 Node 的其他 libuv work 留出容量。尚未开始的 native work 可由
`AbortSignal` 撤销；已经运行的 work 不能抢占，Plugin 会保留 slot，完成后丢弃结果。Takumi 发布包装器的字体注册当前
不接受 signal，而且相同 revision 的准备工作由多个调用共享；取消发生在字体准备期间时会在 registration 之间或
完成后的 checkpoint 生效，旧 build 不能回写下一 generation。

HTML 的 `fromHtml()` 仍是上游同步 parser；它在 scheduler admission 后运行，但单次 parser 调用不能被抢占。默认 1 MiB
content ceiling 与 node/text/stylesheet/image-source 上限约束这段剩余主线程风险，node walk 和大 byte copy 则会分段让出
event loop；SVG output 的 UTF-8 byte check 同样 cooperative。

## 文档 adapter

普通调用继续使用 `render()` / `renderSvg()`。需要在 Takumi admission 之后、最终 native render 之前执行有界文档准备的
官方 adapter 使用 `reserveRender()`：它取得一次 caller-owned、一次性的 fair slot，并在其 `signal` 下完成准备，再只调用一次
`reservation.render()` 或 `reservation.renderSvg()`。未 commit 的 `close()` 立即释放 slot；commit 后会取消结果但等待 native work
真正结束才归还容量。这个窄 seam 不暴露 scheduler、owner key 或可复用 permit。

`@pluxel/takumi-markdown` 是首个消费者，提供 GFM 表格、固定代码高亮和可选受限 Typst 数学；业务 Plugin 通常应直接使用它的
`createRenderer()`，而不是自行操作 reservation。

配置默认限制 8192×8192 physical dimensions、16,777,216 pixels、64 total stylesheets、256 distinct image sources、
32 MiB image inputs、256 个 / 128 MiB portable fonts、64 MiB output、30 秒 request deadline、2 个 concurrent
renders 和 32 个 queued renders。完整配置与行为见
[`docs/plugins/rendering/takumi.md`](../../../docs/plugins/rendering/takumi.md)，设计边界见 [`DESIGN.md`](DESIGN.md)。

示例中的 `escapeHtml()` 代表业务自己的可信模板编码；Takumi 渲染 HTML/CSS，不执行浏览器脚本。
