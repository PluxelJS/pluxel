# Agent Rules (do not break)

这份规则用于约束后续 agent/LLM 的改动风格，目标是：**依赖链清晰、理解成本低、无额外兼容成本**。

## 总体

- 不要为了抽象而抽象；服务间引用是表达真实依赖的必要手段。
- 但也不要用“多层入口 + 纯转发”隐藏依赖图（LLM 会迷路，维护会变慢）。

## 导出与文件结构

- 公共导出必须显式、小而稳定（避免 `export *` 扩散导出面）。
- 避免新增只做 re-export 的 `index.ts`/barrel 文件；除非它是 package subpath 的必要入口。

## Runtime / HMR 边界

- runtime 不包含 Vite/HMR 逻辑；dev-time 只放在 `@pluxel/hmr`。
- HMR 只能 attach 到既有 ctx；禁止让 runtime 反向依赖 hmr。
- path/fs/resolve 相关逻辑优先复用 `@pluxel/runtime/shared`，不要在 HMR 再造第二套。

## 发布与依赖

- 只发布 5 个包（core/runtime/hmr/cli/test），其它包必须 private，并通过 `tsdown noExternal` 内联。
- 以 `packages/build/tests/packaging-invariants.test.ts` 为最终约束，不要绕过测试。
