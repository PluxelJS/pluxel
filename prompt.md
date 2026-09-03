# Workbench React 后续工作交接

接着审查并收尾 Workbench React renderer resource 重构。不要重新做已经完成的迁移；先读根目录
`AGENTS.md`、`.agents/rules/library-api-design.md`、`engineering/DESIGN_PRINCIPLES.md`、
`engineering/PLUGIN_SYSTEM.md`、`engineering/FRONTEND.md` 与 `engineering/WORKBENCH.md`。

## 已完成并推送

- Pluxel `architecture-convergence`: `eceaab87d61ceb29fa0945ea28b38c92d8f40f52`
- Chatbot `main`: `5e033da1ac3329429726d7aff809666c9c633620`
- Rhythm `main`: `a01869d21ca1fb14c5b46bd12a487e0082ec3450`
- 三个远端 ref 已逐一核验与本地 HEAD 一致。
- 最终 API：TanStack-compatible 字段保持顶层；Workbench 字段只在
  `workbench.subscribe` / `workbench.invalidates`；无输入读取用 `query()`，输入相关读取用
  `queryFamily()`；每次 renderer open 使用私有 `QueryClient`。
- Runtime 全套为 61 files / 505 tests passed；最终定向 resource suite 为 2 files / 34 tests passed。
- Chatbot 最终为 63 files / 384 tests passed，production + MF DTS build passed。

## 建议下一步

1. 在没有其他 `pluxel source build` 并发运行时，到 `local-projects/rhythm` 执行一次完整
   `pnpm verify`。上次按用户要求停止了继续测试，并非已知代码失败。`.oxfmtignore` 已加入
   `docs/pluxel/`，因为这些文档必须逐字镜像主仓，不能由 Rhythm formatter 改写。
2. 保留 Rhythm 用户原有的四个脏 submodule，绝对不要提交、reset、stash 或 checkout：
   `deploy/compose`、`rhythm-napi`、`vendor/gqlens`、`vendor/split-like-vscode`。
3. 单独诊断主仓现有的 plugin-host / ReportStudio 漂移：
   - 全仓 `pnpm typecheck` 已完成 58/59，唯一失败是
     `projects/plugin-host/src/showcase/ReportStudio.ts` 与测试访问不存在的 `S3.client`。
   - 全仓测试此前另有 ReportStudio fork-policy 失败：
     `RuntimeStateMutationRejectedError: Plugin definition does not allow fork nodes`。
   - 这两项与 Workbench renderer resource 改动无交叉；先确认当前 S3 与 fork policy 契约，再修，
     不要为了变绿做类型断言或放宽 runtime policy。
4. 可选的 API 精进：当前类型已明确拒绝 legacy 顶层 `watch` / `invalidates`，runtime 也对所有
   非 allowlist 字段 fail-fast；但 TypeScript 的 callback-return structural typing 仍可能接受其他
   未知字段，再到 runtime 报错。若要实现完整 compile-time exact options，必须同时证明：
   - TS 7 source typecheck 与 tsdown 生成的发布 `.d.mts` 行为一致；
   - query key、mutation variables/result 推断不退化为 `any` / `unknown` / 零参；
   - 两参数 mutation、顶层 `watch` / `invalidates` 继续由 type probe 拒绝；
   - 不引入只为讨好推断的 builder、双阶段 API 或隐式全量 TanStack option passthrough。

## 已知类型设计取舍

- input-derived `workbench.invalidates` 应显式复用 mutation variables 类型，或抽成一个有类型的
  selector；这是为了避免 TypeScript 在 factory callback 的 sibling contextual inference 中静默退成
  `any`。Rhythm 已用共享的 `invalidateAccountStatus(input: ProviderInput)` 收敛重复标注。
- `queryFn` 只暴露安全的 query-core `queryKey` / `signal`。当外层 factory 同时消费 roots 或 family
  input 时，嵌套 `queryFn` 的 tuple element 可能变宽；当前文档建议闭包捕获 input，不要为此增加
  ceremonial helper，除非找到发布声明也稳定的明显更好方案。
- 内部 Bridge owner signal 通过 module-private `WeakMap` 传递；不要重新公开到
  `WorkbenchViewHostHandle`。发布 declaration 已确认没有 `ownerSignal`。

如继续修改公开 API、类型、错误或 lifecycle，需要同步 `docs/` 与 pending `.tegami/`；不要手改版本或
`.tegami/publish-lock.yaml`。
