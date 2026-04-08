# Lint And Toolchain

这份文档描述 Pluxel 当前的 lint / build-correctness 设计：哪些规则是仓库级风格与质量约束，哪些规则会在 build/HMR/test 前强制阻断，以及为什么不再在构建期偷偷改源码。

## 目标

当前设计追求 4 件事：

- 让插件 authoring 约束尽量早失败，而不是在 runtime 或 decorator metadata 阶段才暴露。
- 把“仓库代码质量”与“build 必须成立的 correctness”分层，避免为了构建链路把整套 repo lint 强塞到每次 transform。
- 保持 build/HMR/test 链路的语义纯净：可以阻断，可以注入 metadata，但不再擅自重写业务源码来“修好”作者输入。
- 让 `pnpm lint:fix` 只做可证明安全的修复；涉及语义歧义的场景保留诊断或 suggestion。

## 分层

### 1. Repo lint

入口：`oxlint.config.ts`

用途：

- 面向仓库日常开发与 CI。
- 同时启用 Oxlint 内建规则和 Pluxel JS plugin 规则。
- 包含 correctness、logging、以及经过仓库扫描后留下来的高信号规则。

特点：

- 使用源码插件入口：`./packages/workspace/src/oxlint/plugin.ts`
- 支持 `pnpm lint`
- 支持 `pnpm lint:fix`
- 忽略规则由共享常量 `pluxelOxlintIgnorePatterns` 维护

### 2. Build lint

入口：`oxlint.build.config.ts`

用途：

- 面向 build/HMR/test 这三条内部工具链。
- 只强制 build-critical correctness 规则。

特点：

- 只加载 `pluxelCorrectnessRules`
- 不启用 repo 级高信号规则，也不把 logging 规范强塞进构建期
- 仍然复用同一套 JS plugin 与 ignore 集

### 3. Rule policy

入口：`packages/workspace/src/oxlint/plugin.ts`

这里不是简单地“导出所有规则”，而是显式维护一份策略表：

- `category`
- `buildCritical`
- `remediation`

它的作用是把“规则实现”和“规则如何参与不同链路”分离：

- repo lint 使用全部规则
- build lint 只读取 `buildCritical: true`
- 文档和工具可以基于 `remediation` 判断哪些规则适合 `--fix`

## 接入点

### Repo CLI

- `pnpm lint`
- `pnpm lint:fix`

这里跑完整 `oxlint.config.ts`，用于仓库维护。

### Build

`@pluxel/build` 的默认 overlay 会先执行 `lintGuardPlugin()`，再执行语义 transform：

1. `lintGuardPlugin()`
2. `configSourcePlugin()`
3. `hmrUiBridgePlugin()`

设计含义：

- 先阻断错误 authoring
- 再做 metadata extraction / AST rewrite
- 任何 build transform 都不负责“修理”错误作者输入

### Vitest

`@pluxel/test/vitest` 在每个 project 的最终 `root` 上绑定 `lintGuardPlugin({ cwd: projectRoot })`。

这样做有两个原因：

- monorepo project 运行时只 lint 自己的 project root，不会退回仓库根重复扫描
- 和 `configSourcePlugin` 的 project-root 语义保持一致

### HMR

`buildHmrViteConfig()` 同样把 lint guard 绑定到 `opts.root`。

这样 HMR 只对当前 host/workspace root 做 build lint，而不是按 `process.cwd()` 漂移。

## 为什么不再在构建期自动修源码

以前有一类设计会在 build transform 里尝试把不合法 authoring 改写成“看起来能跑”的输出，例如把 `import type` 改成 runtime import。

当前设计放弃这条路，原因是：

- 这会把 authoring 错误静默吞掉。
- build 输出与源代码意图脱节，排错困难。
- watch/HMR 下的增量行为更难推理。
- 一旦修复超出“机械安全”边界，极容易引入隐式语义变化。

现在的原则是：

- build 链路只阻断错误，不修理源码
- repo lint 的 `--fix` 只覆盖可证明安全的修复
- 其余情况交给 suggestion 或人工改写

## Autofix 边界

`pluxelRulePolicy.remediation` 当前分为：

- `fix`
- `suggestion`
- `diagnostic`

约束如下：

- `fix`：可以进入 `pnpm lint:fix`
- `suggestion`：保留机器可辅助的改法，但不默认批量落盘
- `diagnostic`：只报错，避免语义性破坏

这保证了 build 链路和 repo lint 不会因为“过度积极修复”而掩盖真实问题。

## 类型策略

Pluxel 的 JS plugin 是面向 `oxlint` authoring API 写的，但 `oxlint@1.58.0` 只正式导出了 `RuleTester`，没有把 `Rule / Context / Diagnostic / Fixer` 这些 authoring 类型作为稳定 public API 导出。

因此当前策略是：

- 公开面使用与 oxlint authoring API 对齐的最薄结构类型
- 内部通过 `RuleTester['run']` 对 rule 形状做兼容校验
- 不把 `oxlint` 私有、不可命名的类型泄漏到 Pluxel 自己的 `.d.ts`

这不是为了兼容 ESLint，而是为了避免把 `oxlint` 当前未公开的内部类型硬编码进发布产物。

## 当前不变量

- `configs.use(...)` / `features.use(...)` 必须是 module top-level class field
- `configs.use(...)` 不能放在 `#private` 字段
- `configs.use(...)` 不能在 field initializer / constructor 里提前读取
- `configs.use(...)` 输出不能再被 `??` / `||` 重设默认值
- `@Plugin` constructor 的依赖类型不能来自 type-only import
- build/HMR/test 工具链必须先过 build lint，再进入 transform

## 维护建议

- 新规则先放进 repo lint，不要默认放进 build lint。
- 只有“确实会破坏 metadata extraction / DI / runtime correctness”的规则，才标记为 `buildCritical`。
- 不要为单个文件加例外来迁就 authoring 反模式；优先改规则边界或改代码。
- 如果 `oxlint` 未来正式导出 authoring types，可以再收紧 `packages/workspace/src/oxlint/types.ts`。
