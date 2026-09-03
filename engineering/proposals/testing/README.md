# Testing API redesign proposals

> 状态：设计已冻结，尚未实现。这里的内容不是当前 API 权威；当前测试方式仍以
> [`../../../docs/development/testing.md`](../../../docs/development/testing.md) 为准。

这个目录集中记录 Pluxel test API 的重新设计。目标不是给现有测试 helper 逐个增加 alias，而是让 Plugin 作者和
coding agent 能从所验证的产品边界直接推导出最短、正确的测试路径。

## 设计目标

新的 test API 应优先满足以下约束：

1. **测试代码直接表达产品行为**：启动 Plugin、调用 HTTP/RPC、观察公开结果和资源回收，不要求调用方理解 Core slot、
   Workbench registry、reconciliation transaction 或 transport wiring。
2. **默认经过真实框架边界**：Plugin source 继续经过 semantic lowering；graph、config、lifecycle、Context ownership 和
   capability withdrawal 使用生产实现。测试只替换不属于目标边界的物理 carrier 或外部系统。
3. **一个意图一个入口**：不同时提供 `mock*`、`simulate*`、`driver*` 和 `client*` 等语义重叠的 helper。名称应说明调用的
   是真实测试边界还是测试替身。
4. **失败位置清晰**：fixture/setup 错误可以抛出；Plugin 可分支的领域失败继续使用生产 discriminated result/error；测试
   helper 不把二者压成字符串。
5. **资源所有权可见且容易正确**：保留 session、RPC capability、listener 或进程资源的 helper 必须返回与仓库惯例一致的
   disposable handle，并保证重复释放安全。
6. **Capability 默认值保持真实**：Workbench/Vault 不被测试偷偷启用；Database 保留 Runtime 的惰性 PGlite baseline；helper
   不能在 root 创建后补装 capability。
7. **Agent 的局部信息足够**：常规测试应能依靠 TypeScript autocomplete 和一个短示例完成；不要求先搜索 internal tests
   复制 registry、observer、canonical address 或 Cap'n Web disposal 样板。
8. **复用 runner 已有语言**：Core/Runtime host 保持 runner-neutral；official Vitest preset 只为 runner 无法理解的 Plugin lifecycle
   identity 增加一个 matcher。普通 object/error/poll/type assertion 不建立 Pluxel wrapper。
9. **test 不再创建第二台 dev server**：真实 smoke 运行项目 Vite command，或直接复用 production dynamic launcher；需要程序化 ownership
   时改良现有 launcher 的 ready/disposable contract，不在 `/test` 再包一个入口。

## 不把所有测试统一成一种 host

API 一致性不等于抹平测试边界。重新设计仍应区分：

- 普通纯函数和领域对象测试；
- Core graph/config/lifecycle test host；
- Runtime capability test host；
- static/dynamic route、Vite/HMR 和 artifact integration；
- Node/WebSocket 等真实 carrier conformance；
- Workbench Shell 的 React/browser 测试。

低层 host 不应为了统一外观安装高层 Runtime 能力，普通 Plugin 测试也不应为了调用一个 RPC action 启动浏览器或物理端口。

在 Runtime/static/dynamic 三条路径中，默认选择只有一条：Plugin 行为使用 `createRuntimeTestHost()`。static helper 只验证 `defineStaticRuntime()` application 的
fixed catalog、configure/prepare、bindings/env、cold boot 和 startup report；dynamic 没有 test host，项目 Vite command 和
`startDynamicDevRuntime()` 验证的是 source/HMR/physical carrier。删除外层边界后仍然成立的 assertion 必须回到 Runtime test host，
不在三层复制同一 Plugin suite。
Plugin 若确实只使用 Core graph/config/lifecycle/effects，可选更小的 `createCoreTestHost()`；一旦使用 HTTP、commands、database、Vault 或
Workbench 等 Runtime capability，就使用 Runtime host，不在 Core host 中伪造能力。

## 当前提案

- [`COMPOSABLE_HOST.md`](COMPOSABLE_HOST.md)：重新设计 Core/Runtime test host；Core 使用真实 `add/remove`，Runtime 使用真实
  `start/stop`，共同以立即完成的常用行为和 callback-scoped `commit` 取代长期 staging，并分开 public author host 与 framework
  internal harness；strict success 只返回完成信号，official Vitest adapter 提供唯一的 lifecycle issue matcher。
- [`WORKBENCH_RPC.md`](WORKBENCH_RPC.md)：为 Plugin 测试提供类型化、进程内的真实 Workbench RPC entry opener，删除各
  Plugin 重复的 internal registry/session 样板，不模拟 DOM 表单和点击。
- [`DIRECT_RPC.md`](DIRECT_RPC.md)：区分纯 `RpcTarget` object contract 与直接挂载到 `ctx.elysia` 的业务 RPC endpoint；前者
  使用 local capability membrane，后者必须按 Fetch 或 WebSocket carrier 的真实边界验证。
- [`DEV_SERVER_SMOKE.md`](DEV_SERVER_SMOKE.md)：拒绝 test-owned dev server，收敛到项目 Vite command 与唯一的 production dynamic
  programmatic launcher；coding agent 用标准 `fetch`、WebSocket 或 browser 做 physical smoke。
- [`RUNTIME_SURFACE_ALIGNMENT.md`](RUNTIME_SURFACE_ALIGNMENT.md)：定义 Plugin test、static application test 与 dynamic smoke 的
  默认选择规则，以及它们确实共享的 ready/disposal/driver vocabulary；不为表面对称建立万能 host 或额外 static launcher。

## 实施 package map

实现不得为了 import 方便跨 package 重复 export host 或 matcher：

| Entry                                  | 唯一职责                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `@pluxel/core/test`                    | runner-neutral `createCoreTestHost()`、Core types 与同一 fork ref factory |
| `@pluxel/runtime/test`                 | runner-neutral `createRuntimeTestHost()`、Runtime drivers、local RPC      |
| `@pluxel/runtime-static/test`          | `startStaticApplicationTestHost()`，验证 application wiring               |
| `@pluxel/test/vitest`                  | Vitest/Vite preset、matcher registration 与 module augmentation           |
| `@pluxel/test/fixtures`                | filesystem fixture utilities，与 Plugin host 无关                         |
| `@pluxel/test/unsafe`                  | 显式构造 synthetic lowering/replacement facts；不由 host 自动调用         |
| `@pluxel/core/internal/test`           | Core framework white-box harness；不稳定 internal contract                |
| `@pluxel/runtime/internal/test`        | Runtime framework white-box harness；不稳定 internal contract             |
| `@pluxel/runtime-static/internal/test` | raw static startup/HMR commit facts；不从 public/test entry export        |
| `@pluxel/runtime-dynamic`              | production `startDynamicDevRuntime()`；不存在 dynamic test launcher       |

`@pluxel/test` 根入口不再 re-export Core/Runtime host，旧 `createHost/withHost` 随 breaking migration 删除。Plugin test 从所验证的最小
package 导入 host；使用 `definePluxelVitestConfig` 的项目由 preset setup 自动注册 matcher，不要求每个 test file 再做 side-effect import。
包含 matcher 的 TypeScript 项目把 `vitest.config.ts` 纳入 `tsconfig.include`，让同一个 preset import 提供 module augmentation；runner-neutral
host package 不依赖 Vitest。

Core 定义共享的 `PluginForkRef`、`definePluginFork`、lifecycle failure summary 与 `PluginLifecycleAssertionError`；Runtime test entry 可以
re-export **同一个 symbol/type**，让 Runtime test 从单一 package import。这里允许 ownership-preserving re-export，但不允许重新实现、重新 brand
或把 Core/Runtime host 从 `@pluxel/test` 聚合导出。

## Prototype gates

Public surface 已按上述文档收口。下面只允许验证实现可行性，不为它们预留新的 author API：

- Plugin fork 未来的产品删除决策；本次 test v2 已选择暂时保留并使用无 mutation typed ref；
- callback draft 的 runtime escape guard 与 Core/Runtime conflict algebra 能否共享 implementation；
- Workbench local RPC capability transfer/dup 与 leaked-child diagnostics 能否无损 teardown；
- concurrent mutation/query/dispose 能否遵守 fail-fast、settlement 与 aggregate failure contract；
- Vitest matcher receiver validation和 module augmentation 能否只由 preset 提供且不污染 runner-neutral packages；
- representative migrations 是否发现当前 surface 无法表达的真实 author behavior。

external HTTP、database、worker 与 clock 继续使用各 domain 的 production seam；static/dynamic physical smoke 继续使用各自 production launcher。
prototype 不得顺手增加 global fake clock、backend admin、carrier-neutral lease、Node test host 或其他“以后可能有用”的 public surface。只有至少两个
真实 author 调用点或一个不可替代的 correctness boundary 才能重新打开 API review。

## 实施顺序与 zero gate

按依赖方向落地，避免迁移期用临时 alias 粘合：

1. 在 Core 建立 shared target/fork/failure/error 与 callback draft primitive，再实现 Core author host 和 internal harness；
2. Runtime 组合 Core primitive，实现 session lifecycle、config/HTTP/commands drivers、capability defaults 与 internal harness；
3. `@pluxel/test/vitest` 注册唯一 matcher，完成 augmentation/type fixture，再迁移 expected-failure calls；
4. 实现 Workbench/local RPC lease，先迁移 S3、Fonts 等已存在的重复 wiring；
5. 用共享 Runtime driver facade 实现 `startStaticApplicationTestHost()`，把 raw static commit report移入 internal；
6. 最后重构 production dynamic launcher 与 static/dynamic Vite `{ entry }`，用 physical conformance 验证没有第二套 boot path；
7. 全量迁移 packages/plugins/projects/templates/docs，添加各受影响 public package 的 pending Tegami major changelog。

合并前用 `rg` 和 package export/type tests 保证以下旧 public symbols/形状为零：`createHost/withHost`、`createRuntimeHost/withRuntimeHost`、
`createStaticRuntimeTestHost`、`openRuntimeSessionTestConnection`、`createDynamicDevRuntime`、无 target 的 resource
`.start()/.stop()`、无 callback
的 staged `commit()/commitAllowFail()`、`cfg()`、mutable `host.fork()`、`assert/findPluginLifecycleIssue` 与 dynamic Vite `{ config }`。internal
implementation 的同名 production transaction 不计入 gate，必须按 import path/receiver type 精确检查，不能用会误报的纯文本删除。

## 提案完成规则

某项提案被采纳并实现时必须：

1. 更新对应 package public exports 和类型测试；
2. 把当前用法写入 `docs/development/testing.md`；
3. 迁移至少两个真实 Plugin 测试，证明 API 不只适合 synthetic fixture；
4. 添加 enabled/disabled、failure 和 cleanup 验证；
5. 为用户可见的 public test package 变更添加 Tegami changelog；
6. 从本目录删除已实施内容，或只保留仍未实现的决策边界。
