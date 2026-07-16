# Governance

## 依赖方向

```text
@pluxel/core <- @pluxel/runtime <- @pluxel/runtime-dynamic
                           └──── @pluxel/runtime-static

@pluxel/cli --optional--> @pluxel/rolldown
            --optional--> @pluxel/runtime-dynamic/hmr/diagnose
```

`@pluxel/rolldown` 是 build-time tooling，不进入 runtime graph。

必须保持：core host-free、runtime 不依赖 dynamic、route 不复制 lifecycle、config persistence 不进入 core。CLI 是按命令加载的编排层，不作为 runtime 或 toolchain library API 的转发门面。

## 导出

- public export 必须对应稳定用户概念；
- internal/helper/debug 默认不导出；
- 优先明确 subpath，避免 broad barrel 隐藏依赖；
- 不为已删除设计保留兼容 alias；
- toolchain helper 只能从 toolchain/internal subpath 使用。

runtime route wiring、RuntimeState draft helper、resolver/cache/Vite helper 和 control-plane server DTO 统一从
`@pluxel/runtime/internal` 供 workspace runtime packages 使用，不创建 `shared`、`plugin-catalog`、`runtime-state`、
`protocol` 等 public-looking 作者入口。browser contract 的公开权威入口是 `@pluxel/runtime/web`。

## 变更流程

1. 先读 [`DESIGN_PRINCIPLES.md`](DESIGN_PRINCIPLES.md) 和相关领域文档。
2. 修改实现与测试。
3. 更新当前事实的唯一权威文档。
4. 审计 public exports、workspace 插件、示例和链接。
5. 如果 proposal 已实现，删除已落地部分。

公开包发生用户可见变化时，同一 PR 必须添加 Changeset。版本提交、发布前验证和 npm trusted
publishing 的维护流程见 [`RELEASING.md`](RELEASING.md)。

## 文档

- `user-docs/` 不讲内部类名、迁移历史或 toolchain helper。
- `docs/` 不复制用户教程，只解释边界和实现入口。
- package README 不重新定义仓库级插件模型。
- 当前文档不列旧 API；需要追溯时查看 Git history。
