# Packaging / Publishing

## 发布目标

对外发布只有 5 个包：

- `@pluxel/core`
- `@pluxel/runtime`
- `@pluxel/hmr`
- `@pluxel/cli`
- `@pluxel/test`（仅测试/工具链；不应被生产代码 runtime 依赖）

其它 workspace 包一律视为 **internal/private**（允许存在于仓库内，但不应成为用户安装负担）。

注意：internal/private 并不等于“不能 import”。有些内部包仍会配置 `exports` 供仓库内复用（例如 `@pluxel/context`），但它们依然必须保持 `private: true`，不进入发布集合。

## 约束（必须遵守）

1) **internal/private workspace 包不能出现在发布包的 runtime `dependencies` / `optionalDependencies`**
2) internal/private workspace 包如果被实现使用，必须通过 `tsdown noExternal` **内联到产物**
3) internal/private 包必须显式标记 `"private": true`

这些约束由测试强制：

- `packages/build/tests/packaging-invariants.test.ts`

## 为什么要内联（noExternal）

目标是让用户安装时只需要那 5 个发布包 + 常规 npm 依赖，而不会被迫安装/对齐仓库里的内部包版本。

典型例子：

- `@pluxel/context` 在某些工作区会被内联到 `@pluxel/core`；runner 侧不能再导入第二份 `@pluxel/context` 实现。
  - HMR 的 bridgeProviders 会把 `@pluxel/context` 映射为 `@pluxel/core`（见 `packages/hmr/src/dev/hmr/config.ts`）。

## 修改依赖时的检查清单

- 新增 workspace 包依赖前先判断：它是否应该对外发布？
  - 如果不是：标记 `"private": true`，并确保仅被发布包通过 `noExternal` 内联（而不是 runtime dependencies）。
- 修改发布包的 `package.json` 后务必跑：
  - `pnpm --filter @pluxel/build test`（包含 packaging invariants）
