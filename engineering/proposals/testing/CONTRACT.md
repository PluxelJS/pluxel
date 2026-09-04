# Testing v2 normative contract

> 状态：release candidate，尚未实现。本文是 `engineering/proposals/testing/` 唯一的规范性摘要；其他文件解释依据、反例、领域细节与验收矩阵。
> 当前用户 API 仍以 [`../../../docs/development/testing.md`](../../../docs/development/testing.md) 为准。

## 1. 选择边界

| 要验证的不可删除事实                                             | 唯一默认入口                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 纯函数、普通对象                                                 | 无 host                                                                 |
| Core graph/config/lifecycle/effects                              | `@pluxel/core/test.createCoreTestHost()`                                |
| Plugin + Runtime capability                                      | `@pluxel/runtime/test.createRuntimeTestHost()`                          |
| fixed static application 的 configure/prepare/bindings/cold boot | `@pluxel/runtime-static/test.startStaticApplicationTestHost()`          |
| dynamic source、Vite/HMR、HTTP/WebSocket carrier                 | 项目 Vite command 或 `@pluxel/runtime-dynamic.startDynamicDevRuntime()` |
| static deployment artifact、TLS、filesystem/assets               | 启动真实 artifact                                                       |
| Workbench renderer/Shell                                         | React/browser test                                                      |

删除外层 application/source/carrier 后仍成立的 assertion 必须回到更小的 host。同一 Plugin behavior 不在 Runtime/static/dynamic 三层复制。

## 2. Package ownership

| Entry                         | 唯一职责                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `@pluxel/core/test`           | Core author host、shared target/fork/failure/error                           |
| `@pluxel/runtime/test`        | Runtime author host、shared Core value re-export、Runtime drivers、local RPC |
| `@pluxel/runtime-static/test` | static application test host                                                 |
| `@pluxel/test/vitest`         | Pluxel Vitest/Vite preset、唯一 lifecycle matcher 与 augmentation            |
| `@pluxel/test/fixtures`       | filesystem fixtures                                                          |
| `@pluxel/test/unsafe`         | synthetic lowering/replacement facts                                         |
| `@pluxel/*/internal/test`     | workspace framework/privileged protocol tests，不进入作者文档                |
| `@pluxel/runtime-dynamic`     | production dynamic launcher；没有 `/test` launcher                           |

`@pluxel/test` 根入口删除。它不再承担 Core symbol barrel、host 或 setup side effect。`PluginForkRef` 与 `definePluginFork()` 只在 Core 实现一次；
Runtime test entry 可原 symbol re-export。

## 3. Vitest 5.0.0 runner baseline

Testing v2 的唯一 runner baseline 是**精确的 `vitest@5.0.0`**。实施时 workspace catalog 与 lockfile 都必须解析到
`5.0.0`，不接受 `^5`、`latest`、Vitest 4 compatibility alias，已安装的 `@vitest/*` companion package 也必须使用与其匹配的
`5.0.0` release。Vitest 5.0.0 的环境前提是 Node.js `>=22.12.0` 与 Vite `>=6.4.0`；CI、开发容器、package `engines` 与
本地文档必须在 runner upgrade 同一批完成校验。

这不是只改 catalog 的依赖升级。所有 test source、benchmark、`vitest.config.*`、inline/referenced project、setup/custom environment、
reporter、browser command、custom matcher、test CLI 和 snapshot/report artifact consumer 都必须使用 Vitest 5.0.0 的 API 与语义。
不得通过 `clearMocks: false`、旧 entrypoint re-export、wrapper、降级 types 或未迁移的 helper 恢复 Vitest 4 行为；确有产品语义需要
显式选择非默认配置时，必须在相应 test/config 旁说明事实，并由独立 test 证明它不是 compatibility residue。

其中 Pluxel 的 matcher declaration 是 v5 形状，`R` 保留普通 assertion 与 async assertion 的正确返回类型，`T` 表示 received value：

```ts
declare module 'vitest' {
	interface Matchers<R, T> {
		toHavePluginLifecycleIssue(
			target: PluginTestTarget,
			expected?: PluginLifecycleIssueExpectation,
		): R
	}
}
```

[`MIGRATION.md`](MIGRATION.md#vitest-500-runner-migration) 是此 baseline 的 exhaustive migration checklist 和 final zero gate。
只要其中任一仍是 Vitest 4 写法、旧默认语义或未审计的 5.0 behavior change，Testing v2 就不能冻结。

## 4. Host command model

public host 只有五种调用语法：同步 factory、立即完成的 host lifecycle command、同步 callback draft、同步 committed-state query、domain
driver/disposable lease。同一个 receiver 上不混合 staged 与 immediate mutation。

- Core：`add/remove/restart/replaceDefinition/commit/commitExpectFail/require/isRunning`。
- Runtime：`start/stop/restart/replaceDefinition/commit/commitExpectFail/require/isRunning`。
- Runtime drivers：`config.patch`、`http.origin/fetch`、`commands.execute/list`、`workbench.open`。
- static application host：共享 Runtime drivers与只读 query，没有 fixture lifecycle mutation。
- dynamic resource：只有 physical `origin`、existing production `ctx` authority、`dispose()`；标准 client 直接连接 origin。

常用 lifecycle method 立即提交并等待稳定。复杂、同一 application boundary 的多变化使用同步 `commit(change => ...)`。draft 不可 async、
return、逃逸、嵌套或观察中间状态；矛盾 command 在 prepare 前失败。mutation 与 config patch 共享 fail-fast exclusive gate，不建立隐藏 queue。

Runtime 的 `change.forks.remove(ref)` 必须独占一次 `commit()`；与任何其他 draft command 混用时，在 production work 前 fail-fast。
production durable-fork 删除是 stop → flush config/logging → durable remove 的多阶段 PONR 序列。test host 复用这条真实 use case，不把它
伪装成可与 graph/session mutation 原子合并的 coordinator update。

## 5. State 与 config

catalog availability、process session intent、durable auto-start policy、actual lifecycle、desired config、applied config 是六个独立事实。
不提供 `enable/disable`。Runtime public author host 不暴露 auto-start policy；Core 不出现 Runtime session/policy 词汇。

dependency selection 的 `requirement` 接受 `PluginToken`，因为正常 provider slot 可以由 abstract Plugin token 定义；被 materialize 的
provider/default candidate 才要求 concrete `PluginConstructor`，consumer/provider node target 才使用 `PluginTestTarget`。不要把 abstract
requirement 强行伪装成可实例化 constructor。

`initialConfig`/draft seed 只建立首次 lifecycle 前的 fixture state。已提交 config 或进入过 lifecycle 后必须使用 production-like
`host.config.patch()`；helper 不根据当前状态切换语义。constructor 尚无公开 config generic 时接受 `RawPluginConfig`，不伪造 autocomplete。

## 6. Result 与 failure

strict lifecycle command 成功返回 instance 或 `void`；lifecycle postcondition 失败抛唯一 public
`PluginLifecycleAssertionError`。expected lifecycle failure 使用 `commitExpectFail()`；完全成功也视为 assertion failure。programming、invalid graph、
persistence、capability-disabled 与 setup failure不包装成 lifecycle failure。

唯一 summary 形状为：

```ts
type PluginTestCommitSummary = Readonly<{
	lifecycleReport: Readonly<{
		ok: boolean
		issues: readonly PluginTestLifecycleIssue[]
	}>
}>
```

Vitest 只增加 `toHavePluginLifecycleIssue()`。message 用于诊断，不是稳定分支协议；helper diagnostics 不输出 config、secret、credential 或 RPC
payload。

## 7. Instance、driver 与 privileged protocol

`start/add/require()` 返回当前 raw Plugin instance，适合观察 Plugin 自身公开状态、领域 seam 与 owner-bound capability。它不模拟
constructor dependency 的 caller-bound facade：验证 `ctx.caller`、consumer admission 或跨 Plugin API 时，必须建立真实 Consumer Plugin 并从注入
facade 调用。

public author host 不暴露 root `ctx` 或 backend admin。现有 `host.ctx.*` 调用必须逐项分类：

- commands/Workbench publication：迁入对应 public driver；
- Plugin-owned database/Vault 状态：从 running instance 的 owner-bound handle或 package domain fixture进入；
- Core/Runtime root service、transaction、failure injection：迁入 internal harness；
- 官方 Auth 等 privileged Management provider conformance：使用 `@pluxel/runtime/internal/test` 的最小 root authority，并保留至少一条真实
  Runtime Session carrier smoke。它不证明一般 Plugin 作者需要 public Management test driver。

只有两个独立 author consumer 或一个无法替代的 public correctness boundary 出现后，才另行设计 Management author driver。

## 8. RPC 与 Workbench ownership

`createLocalRpcClient(target)` 只验证本地 Cap'n Web object contract，不验证 Elysia/transport。传入 target/service 是 borrowed；返回 stub 只拥有
client capability graph。caller 显式拥有 target 的领域资源。

`host.workbench.open({ target, entry, principal, location? })` 经过真实 publication/session/layout/open 与 local Cap'n Web membrane。返回
`Readonly<Value> & Disposable`，按 entry kind 精确推导；static Content 的 discriminant 在类型上没有 root，interactive Content 才有 root stub。
setup failure复用 production Workbench stable code（存在时）和普通 `Error`/`TypeError`，不新增 test-only error hierarchy。

WebSocket、Origin、framing、disconnect 必须走 real carrier；不得通过 local stub 或 `http.fetch()` 宣称已验证。

## 9. Resource 与 cancellation

host/static/dynamic resource 实现 `AsyncDisposable + dispose(): Promise<void>`；Workbench/local RPC lease 实现同步 `Disposable`。重复/并发 dispose
共享同一次 settlement。host-owned leaked child 会先 best-effort cleanup，再以非敏感 aggregate diagnostics 使 host disposal 失败。

`startDynamicDevRuntime({ entry, signal? })` 的 signal 只取消未完成 startup；abort 必须在 reject 前清理部分资源。factory resolve 后由 returned
resource 独占 lifetime，原 signal 不再自动关闭它。host lifecycle mutation 沿用 production timeout/settlement，不增加全局 timeout 或假取消。

## 10. Freeze gates

public declarations 只有在以下条件同时满足后从 release candidate 变为 frozen：

1. workspace 以精确 Vitest `5.0.0` 安装并通过其完整 runner migration checklist；
2. compile-only matrix 覆盖 callback、tuple、fork、negative surface、matcher augmentation 与 static binding inference；
3. Core/Runtime host prototype 覆盖并发、rollback、partial lifecycle failure、replacement/stale target 与 teardown；
4. Workbench/local RPC prototype证明 deep-copy、transfer/dup、withdrawal 与无泄漏；
5. Auth privileged Management、S3/Fonts Workbench、Package Manager failure/commands、fork/replacement、static application 与 dynamic smoke 完成代表迁移；
6. versioned agent eval 在只给 `.d.ts`、quick start 与 fixture 的条件下通过；
7. exact import/receiver-aware zero gate、package exports、用户文档与 Tegami changelog 同步。

Prototype 若证明签名无法诚实实现，必须回到本文修改 contract；不得用 alias、额外 option 或 overload 掩盖 blocker。
