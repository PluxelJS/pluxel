# Takumi Markdown Plugin 设计

@pluxel/takumi-markdown 是 TakumiPlugin 的 required consumer，也是一个普通的
Pluxel Plugin；它不向 Runtime 添加 Markdown capability、全局 parser、theme registry 或新的 renderer
pool。业务 consumer 只注入 TakumiMarkdownPlugin，取得 caller-generation-owned
MarkdownRenderer handle。

## 选择的边界

- Markdown document、GFM table 和静态 fenced code 属于 HTML/CSS 文档渲染，最后交给 Takumi 的
  table/layout engine；它们不复用 @pluxel/canvas/table。
- Canvas table 适合调用方已经拥有 rows、columns 和 native context 的静态报告最后一公里；ECharts
  继续是图表能力。Markdown package 不重新实现这些成熟领域。
- Rangi 以 fixed language alias mapping 和 classes-only HTML 提供有限、可预测的静态高亮。没有
  Shiki grammar/theme 管理、自动语言检测或在线下载，也不把任意高亮器配置暴露为 host contract。
- Satteri 只编译 Markdown，不编译 MDX；raw Markdown HTML 固定关闭，并在所有 HAST pass 后再次移除。

## admission、生命周期与取消

createRenderer() 在 provider generation 正常运行时 snapshot extension list 和 default theme，并把 handle
的 close effect 归属到当前 dependency caller generation。consumer/provider stop、replacement 或 manual
close() 都会 abort queued/running work，再等待已有 Promise settle；它不会留下可跨 generation 复用的
renderer。

一次 render() / renderSvg() 先取得 TakumiPlugin.reserveRender()。因此满队列时不会执行
source byte walk、Satteri parse、Rangi、trusted extension factory、asset copy 或 Typst dispatch。reservation
的 linked signal 覆盖 Markdown prepare 与 final render；在最终 native work 已提交后，Takumi 保留 capacity
直到 native settlement，不能把 abort 描述成强制抢占。

## 扩展和资源所有权

extension 是 startup-time 的受信任代码，不是用户 Markdown、数据库记录或 HTTP request 可以携带的
untrusted plugin declaration。每次 accepted render 都按 renderer array order 调用 factory；factory 可以：

- 声明有限的 Satteri feature requirement；
- 返回 ordered MDAST/HAST plugin entries；
- 通过此次 MarkdownExtensionContext.assets 添加支持的 image bytes。

extension error 规范化为 MarkdownError('EXTENSION_FAILED')，已有稳定 Markdown/Takumi/Typst/Worker
失败保持自己的 code。asset sink 不接受 caller-selected URL、不 fetch、不暴露 image map；它对生成 bytes 做
count/per-item/total budget、cooperative copy 和 opaque pluxel://markdown-internal/ source allocation。
caller input 不得占用该 namespace。sink 只在 render scope active 时有效，收尾后使用它会失败。

## 有界准备

source UTF-8、MDAST/HAST node、generated HTML、code block count/bytes 和 generated assets 都有独立
ceiling。大字符串计量、tree walk 和 byte copy 在 checkpoint 让出 event loop，并观察 reservation signal。
Takumi 继续负责 final content/style/image/dimension/output budget；Markdown 不试图绕开或放宽下游 host
policy。

tests 在 Runtime host 验证 GFM table、raw HTML removal、Rangi order、queue-full 不运行 factory、asset/error
ownership 和 handle close。Typst integration 的 worker artifact smoke test 位于 optional package；它验证 SVG
asset 进入同一次 final Takumi render，而不是嵌套 renderer。
