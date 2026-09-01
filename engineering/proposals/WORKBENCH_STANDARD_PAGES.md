# Workbench Standard Pages：未完成能力 gate

> 状态：Markdown-only Standard Page 已采纳并落地。当前 API、构建和 lifecycle 以
> [`../WORKBENCH.md`](../WORKBENCH.md)、[`../FRONTEND.md`](../FRONTEND.md)、
> [`../TOOLCHAIN.md`](../TOOLCHAIN.md) 与 [`../../docs/workbench/index.md`](../../docs/workbench/index.md)
> 为准。本文只保留尚未采纳的动态能力 gate，不是当前 API 说明或未来 API 草案。

## 已采纳的边界

当前 Standard Page 只展示 build-time Markdown：

```ts
workbench.page({
	document: workbench.markdown(import.meta.url, './guide.md'),
	placement: workbench.tab({ label: '使用说明' }),
})
```

已固定的设计决定：

- Page 属于发布它的 running Plugin generation；
- Page-only definition 使用 `publish(definition)`，没有 bindings；
- Markdown 在 build time 编译为有界 portable AST，由 Shell 渲染；
- Page-only Plugin 不生成 MF producer、React Bridge 或 Plugin browser bundle；
- Page 复用 `openView()` 的短 owner admission，不创建 RPC root、factory、quota 或 retained server lease；
- Page 没有 snapshot、refresh、watch、data invalidate、signal、action、slot 或 Config draft bridge；
- 需要动态数据或交互时使用完整 View。

OTel 的“运维说明”是当前真实调用点。它证明静态说明页值得删除 React/MF/RPC 成本，但不能证明动态 Page API 有必要。

## 仍待回答的问题

是否存在一类真实页面，同时满足：

1. 静态 Markdown 不够；
2. 完整 View 的 renderer、RPC target 和 cleanup 明显过重；
3. 数据与操作仍然简单、有界且不需要自定义布局；
4. 引入新 Page lifecycle 后，平台复杂度仍显著低于完整 View。

在出现这种调用点前，默认答案保持完整 View，不为假设场景预建协议。

已审查但未采纳的场景：

| 需求                                 | 当前结论                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------- |
| Redis：显示连接状态并执行一次 `PING` | 使用完整 View；尚无真实实现证明 Page primitive 更合适                     |
| Cache：查看并清理 consumer scope     | 使用 consumer-owned View/Attachment；authority 不属于 provider-local Page |

## Invalidation 与 signal 边界

现有 **session epoch invalidation** 是 Workbench 基础设施行为：owner、publication、artifact 或认证 authority 改变后，
旧 document 不再可信，Shell 释放 handles 并完整 reload。Standard Page 已复用它，没有新增作者 API。

候选 **data invalidation** 表示动态 snapshot “可能过期”。当前 Page 没有 snapshot，因此也没有
`watch(invalidate)`、dirty bit、自动 reread、polling 或 cleanup contract。

现有完整 View factory 的 `signal` 管理 View open lifetime。静态 Page 不运行 factory，也没有作者可见或 Page-local signal。
短 owner admission 是 Runtime 内部 lifecycle primitive，不应变成第二种取消模型。

如果未来 watch 需要 retained controller、observer transport、owner admission、cleanup、late-result guard、rate budget 或 reconnect，
它很可能已经接近完整 View。新设计必须先证明这些资源如何被拥有和释放；不能通过增加多个 signal 掩盖未闭合的 lifecycle。

## 重新评审 gate

以下候选互不承诺，也不构成实施顺序：

| 候选需求                   | 重新评审前必须具备的证据                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| bounded read-only snapshot | 真实页面证明完整 View 明显浪费，且数据 shape 和字节预算可以稳定封闭                        |
| data invalidation/watch    | 已采用 snapshot 页面出现可测量 staleness，并先闭合 admission、lease、cleanup 与 rate limit |
| short action               | 真实状态+按钮页面证明能显著减少 View 代码，且不需要 task、progress、retry 或 cancellation  |
| input action               | 已采用 action 需要少量静态输入，且不读取、共享或提交 Config draft                          |

满足 gate 后应提交独立 proposal，从真实调用点重新设计 public API、artifact version、lifecycle、failure 与测试矩阵。
不得从本文推断未来 builder、controller、watch callback、slot grammar、form contract 或 action result。

## 应停止扩张的信号

出现以下任一条件时，继续使用完整 View：

- 需要 retained per-open capability、subscription、lossless event、payload stream 或 reconnect；
- 需要 custom layout、inline expression、runtime schema 或 custom component；
- 需要 progress、background task、resume、retry policy 或用户取消；
- 需要分页/editable collection、跨 Plugin UI 或 consumer-scoped authority；
- 新 Page 协议的所有权和测试矩阵已经接近完整 View；
- Page-only 路径开始依赖 MF producer、Bridge 或 Plugin browser bundle。

完整 View 是明确的 escape hatch，不是 Standard Page 设计失败。
