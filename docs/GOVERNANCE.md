# Governance

这份文档记录仓库级不变量。它们比某个局部实现更重要，修改前需要确认设计意图。

## 依赖方向

当前方向：

```text
@pluxel/core <- @pluxel/runtime <- @pluxel/runtime-dynamic <- @pluxel/cli
```

`@pluxel/build` 是 build-time tooling，不进入 runtime service graph。

必须保持：

- core host-free。
- runtime 不依赖 runtime-dynamic。
- loader HMR mode 安装到已有 runtime `Context`。
- build 只做 build-time metadata/rewrite/lint。
- config persistence 不进入 core。

## 包边界

公开包：

- `@pluxel/core`
- `@pluxel/runtime`
- `@pluxel/runtime-dynamic`
- `@pluxel/cli`
- `@pluxel/test`

internal/private 包：

- 其他 workspace packages，除非明确提升。
- `@pluxel/core-di` 当前是 internal/private prototype。
- `packages/plugins/*` 是 workspace 内置插件和宿主样例，不属于发布包集合。

## 导出规则

- public exports 保持显式。
- 避免新增隐藏真实依赖关系的 barrel/re-export 层。
- 优先使用明确 package subpath，而不是 broad `export *`。
- 不为了短期兼容添加长期维护的模糊 surface；除非有明确迁移需求。

## 文档规则

- 当前实现写在对应领域文档。
- 未来计划写在 `docs/proposals/`。
- 提案实现后，必须把已实现行为迁入当前领域文档，并缩短或删除提案段落。
- 包内 README 说明包入口和本包特有约束；仓库级设计链接到 `docs/*.md` 顶层文档。

## LLM 维护规则

- 先读 `docs/README.md` 的阅读顺序，再改代码。
- 改 core 时确认没有引入 runtime/loader-hmr/build 依赖。
- 改 runtime 时确认没有 import runtime-dynamic/HMR 入口。
- 改 loader HMR 时确认没有重新定义 runtime 协议。
- 改 build plugin 时确认最终产物不会残留 authoring/hmr-only 语义。
- 改配置链路时确认 core 校验和 runtime 持久化仍分离。
