# Core lifecycle benchmark：cascade 回退调查交接

> 状态：待专项 profile / A-B 验证
>
> 记录日期：2026-08-14
>
> 对比：base `eb022d86affb7054dd3471bbf6bb2ee7c3875f89` → head `907b9f28f01a23aa6763bc9ea49acc4591fdcfee`
>
> 环境：Node.js 24.18.0，Tinybench time 2000ms / warmup 1000ms

## 1. 目的与当前结论

本文给后续性能调查 session 提供可直接执行的起点。当前没有实施优化，下面的原因判断仍需通过 profile 和隔离实验验证。

当前结论：这不是整体性能退化，而是大范围 dependent cascade 的稳定逐插件开销。常见的 leaf restart、leaf HMR、leaf unregister、增量 add 和 config-heavy restart 均明显加速；回退集中在一次停止或重建约 100–201 个插件的操作。

回退百分比很大，但最大绝对增加约 1.36ms。以本 PR 换来的生命周期正确性、owner generation 隔离、dependent 一致性和增量 DI 能力来看，不建议回滚架构；建议在不削弱语义的前提下收回这笔固定开销。

最值得优先证伪的假设位于 `BasePlugin.getLifecycleRuntime()` 和 `closeOwnerInvocations()`：

- base 对没有 `stop()` 的插件令 `runtime.stop` 为 `undefined`；head 对所有插件都安装了 `async stop` wrapper。
- benchmark 中的插件没有 `init()`、`stop()`，也没有创建 owner invocation lease。
- head 仍会对每个停止的空插件执行 `await closeOwnerInvocations(ctx)`。
- `closeOwnerInvocations(owner, reason = new Error('Plugin owner stopped'))` 的默认参数会在每次调用时先构造带 stack 的 `Error`，即使该 owner 在 `WeakMap` 中根本没有 gate。
- fast path 还会创建/等待一个已完成的 Promise；停止调度默认 `concurrency: 1`，这类逐节点成本会线性累加。

报告呈现出的额外成本约为每个受影响插件 6.5–7.2µs，与上述 eager `Error` + async/Promise fast path 的形状高度吻合。它是目前的首要假设，不是已经证明的结论。

## 2. PR benchmark 原始信号

报告门槛：延迟增加超过 5%、绝对增加超过 0.01ms，且当前和参考 RME 均不超过 10%。19 项 tracked task 中有 6 项 regression。

### 2.1 回退项

| Task | Base ms | Head ms | 绝对增加 | 相对变化 |
| --- | ---: | ---: | ---: | ---: |
| unregister: root cascade (star) | 1.208 | 2.533 | +1.325ms | +109.69% |
| unregister: chain middle cascade | 0.885 | 1.557 | +0.672ms | +75.93% |
| restart: root (star) | 3.639 | 5.003 | +1.364ms | +37.48% |
| hmr: replace root (star) | 3.986 | 5.326 | +1.340ms | +33.62% |
| large: replace root | 4.121 | 5.430 | +1.309ms | +31.76% |
| restart: chain middle | 2.571 | 3.286 | +0.715ms | +27.81% |

这些任务的 RME 约 4–5%，方向可信。报告中 3 个 RME 超过 10% 的是 cold-build 项，只应作为方向参考。

### 2.2 明显改善或不变的项

| Task | Base ms | Head ms | 相对变化 |
| --- | ---: | ---: | ---: |
| incremental: add leaf (star) | 0.123 | 0.076 | -38.21% |
| restart: leaf (star) | 0.075 | 0.046 | -38.67% |
| hmr: replace leaf (star) | 0.123 | 0.088 | -28.46% |
| unregister: leaf cascade (star) | 0.125 | 0.093 | -25.60% |
| restart: chain leaf | 0.076 | 0.050 | -34.21% |
| config: inject-heavy restart | 0.074 | 0.044 | -40.54% |
| large: add leaf | 0.213 | 0.191 | -10.33% |
| large: replace leaf | 0.243 | 0.211 | -13.17% |
| no pending op | 约 0.001 | 约 0.001 | 基本不变 |

冷启动大图为 `20.934 → 21.721ms`（+3.76%），但该项 RME 为 10.19%，不能据此宣称存在稳定冷启动回退。

## 3. 为什么判断为“逐插件固定成本”

默认场景：

- star：1 个 root + 200 个 leaf。
- chain：200 个节点，middle 是下标 100，因此 middle cascade 影响约 100 个节点。
- large：额外加入 800 个与 star 无关的 independent plugin。
- 所有 benchmark plugin 都是空 `BasePlugin` subclass，没有生命周期 hook 或业务 I/O。

按实际 cascade 节点数摊销：

| 场景 | 影响节点数 | Head - Base | 额外成本/节点 |
| --- | ---: | ---: | ---: |
| star root unregister | 201 | 1.325ms | 约 6.59µs |
| star root restart | 201 | 1.364ms | 约 6.79µs |
| star root HMR | 201 | 1.340ms | 约 6.67µs |
| large root HMR | 201 | 1.309ms | 约 6.51µs |
| chain middle unregister | 100 | 0.672ms | 约 6.72µs |
| chain middle restart | 100 | 0.715ms | 约 7.15µs |

这个一致性很强：restart、replace、unregister 两种拓扑都落在相同量级。large root HMR 即使带有 800 个无关节点，也没有比普通 star 多出相应成本，说明当前小 diff 基本保持局部，没有显现随全图规模增长的失控遍历。

还可以利用 unregister 缩小范围：unregister 不包含后续重启，却与 restart/HMR 出现几乎相同的逐节点额外量。因此优先调查 stop-side，比先调查新实例创建、config injection 或 start scheduler 更有根据。

报告的 `cascade tax` 比值会进一步放大观感。例如 root HMR tax 使用 root HMR / leaf HMR；head 的 leaf HMR 本身快了约 28%，分母变小后，该比值的相对增幅会大于 root HMR 原始延迟增幅。性能决策应优先看原始延迟和绝对增加。

## 4. 已核对的实现事实

### 4.1 首要候选：owner invocation stop wrapper

相关文件：

- `packages/core/src/plugins/composition/BasePlugin.ts`
- `packages/core/src/internal/owner-invocations.ts`
- `packages/core/src/plugins/runtime/PluginActor.ts`
- `packages/runtime/src/services/CommandsService.ts`

base 的生命周期 runtime：

```ts
stop: typeof plugin.stop === 'function' ? plugin.stop.bind(plugin) : undefined
```

head 的生命周期 runtime：

```ts
stop: async (signal: AbortSignal) => {
	await closeOwnerInvocations(ctx)
	if (typeof plugin.stop === 'function') await plugin.stop(signal)
}
```

同时，新 helper 当前为：

```ts
export function closeOwnerInvocations(
	owner: Context,
	reason: unknown = new Error('Plugin owner stopped'),
): Promise<void> {
	return ownerInvocations.get(owner)?.close(reason) ?? Promise.resolve()
}
```

由此产生三个可分离成本：

1. 每个 stop 都 eager 构造一个 `Error`，通常还会抓取 stack。
2. 没有 gate 的 owner 仍创建 `Promise.resolve()`，外层 wrapper 也始终是 async。
3. `PluginActor` 在 base 空插件上跳过 `runtime.stop`，head 则每个插件都进入并 await 该分支。

该变化来自 `35fc6273 feat(commands): add default CLI and owner lifecycle`。建议先单独比较 `35fc6273^` 与 `35fc6273`，再做局部 A-B 实验。

需要保留的语义是：generation 停止时必须先拒绝新调用、abort 已接纳调用并等待 lease 释放，然后才能执行插件 `stop()`。优化 fast path 不能改变这个顺序。

一个值得验证而非直接照抄的方向是：让“没有 gate / 没有 active lease”的 close fast path 同步完成，且仅在确有 gate 时创建默认 reason；对 active lease 仍返回并等待真实 Promise。由于这些是 internal API，可以调整实现，但仍需检查所有调用者及 Effects cleanup。

### 4.2 当前不应优先归因的代码

- `stopPluginsTopo()` 的 reverse-topo 实现在 base 与 head 相同。它确有 Map/Set/Promise 调度成本，也可能继续优化，但不能解释本次 base → head 的新增差值。
- `DependentClosureCollector.ts` 在两个对比 SHA 间没有差异。它同样不是这次 regression 的直接来源。
- no-op commit 保持约 0.001ms，说明 commit lock 和 early exit 没有普遍变慢。
- 多 800 个无关节点没有放大 root HMR 的绝对差值，因此“每次 cascade 都扫描整个图”不是当前数据支持的首要解释。

### 4.3 次级候选

若 owner invocation 实验不能解释大部分差值，再按以下顺序调查：

1. `PluginActor.onStop` 中新增 `runtime.stop` 分支后的 Promise/microtask 数量。
2. `LifecycleManager.stopLifecycle()` 的 send / waitForStopped 稳态路径。
3. `EffectsService.dispose()` 与 shutdown/runtime/final phase；确认空 Effects scope 是否存在可消除的 Promise 链。
4. `Runtime.deleteMany()`、per-key revision 和 retained cache bookkeeping。它更可能影响 restart/HMR，不能单独解释 unregister。
5. commit summary、availability watcher 和 lifecycle report 的逐 affected-node 分配。
6. start scheduler / Context 与 Logger 隔离。它们只解释 restart/HMR 的剩余差值，不应先用于解释 unregister。

## 5. 这些成本换来的语义为何不能直接删除

本 PR 范围很大：全仓对比约 1400 files、`+92,371/-58,782`；仅 core/context 约 122 files、`+7,230/-5,752`。不能把所有差值归于单个提交，也不能因“重构很多”自动接受回退。

与本 benchmark 决策直接相关的收益包括：

- 新内部增量 DI graph：committed/draft graph、dirty slots、reverse dependents、affected closure 和实例 revision 管理。
- provider restart/replacement 默认重启 required dependent closure，避免 dependent 继续持有旧 provider generation。
- `4452e982 fix(runtime): preserve dependent state across restarts` 修复重启期间实例缓存一致性。
- owner invocation admission/abort/drain，禁止旧 generation command wrapper 越过 stop/replacement 边界。
- plugin Context/caller 隔离及 per-plugin Effects 资源归属。
- optional plugin availability、instance watcher、runtime update rollback 和 HMR 一致性。

当前约束以以下文档为准：

- `docs/DESIGN_PRINCIPLES.md`
- `docs/PLUGIN_SYSTEM.md`
- `docs/RUNTIME.md`
- `docs/HMR.md`
- `.agents/rules/library-api-design.md`

特别不能为了 benchmark：

- 将默认 cascade 改为 `cascadeDependents: false`。
- 在 dependent 停止前先停止 provider。
- 让旧 generation handle 在 replacement 后继续接收调用。
- 跳过 Effects dispose、错误报告或 failed-start eviction。
- 未验证语义便把 stop 并行化；当前默认 `stopConcurrency = 1` 也承担确定性兼容要求。
- 添加只针对 benchmark plugin 的分支。

## 6. 建议的调查顺序

### Step A：先确认结果可复现

使用同一 Node major、同一台机器、base/head 交替运行。先执行原始比较：

```bash
PLUXEL_BENCH_TIME=5000 \
pnpm bench:core:compare \
  eb022d86affb7054dd3471bbf6bb2ee7c3875f89 \
  907b9f28f01a23aa6763bc9ea49acc4591fdcfee
```

结果位于 `.bench-results/core/{base,head}/plugin-lifecycle.{json,md}`。建议至少运行 3 次，保留每次独立的 `PLUXEL_BENCH_RESULT_DIR`，最后比较中位数，不要只挑最好的一次。

### Step B：定位首次引入点

先比较 owner lifecycle commit 前后：

```bash
PLUXEL_BENCH_TIME=5000 \
pnpm bench:core:compare 35fc6273^ 35fc6273
```

若绝大部分 6–7µs/节点在该提交出现，就不必先对整个超大 PR 做 noisy git bisect。若没有出现，再对 base → head 分段二分。

### Step C：做三个隔离 A-B 实验

实验仅用于定位时可以保留在本地，不要把削弱语义的版本提交：

1. 只将默认 `Error` 改为 gate 存在后再创建，其他行为不变。
2. 在 1 的基础上，让 no-gate close 返回同步 fast path，避免无意义的 resolved Promise。
3. 保留 active-lease drain，测量“无 gate”“gate 但 active=0”“gate 且 active>0”三条路径。

每一步都重新跑六个 cascade task及 leaf 对照。若实验 1 单独收回约 1.3ms，就说明 Error stack allocation 是主因；若实验 2 继续显著改善，则 Promise/microtask 是第二来源。

注意：`scripts/core-bench-compare.sh` 在 head ref 等于当前 `HEAD` 时直接使用当前工作区，因此能测到未提交的本地实验修改；运行前应确认没有混入无关改动。

### Step D：profile，而不是继续猜

Tinybench 当前会运行全部 19 个 task。为了获得清晰 profile，可以临时增加 task filter，或制作只注册以下任务的本地 probe：

- `unregister: root cascade (star)`：只看 stop/unregister。
- `restart: root (star)`：stop + delete + instantiate/start。
- `unregister: leaf cascade (star)`：fast-path 对照。

可使用 Node CPU profile：

```bash
mkdir -p .bench-results/core/profile
node --cpu-prof \
  --cpu-prof-dir=.bench-results/core/profile \
  --experimental-strip-types \
  scripts/core-bench-node-runner.mjs \
  packages/core/bench/pluginLifecycle.bench.ts
```

优先查看：

- `Error` 构造 / stack capture。
- `closeOwnerInvocations`、`OwnerInvocationGate.close`。
- Promise reaction / microtask。
- `PluginActor` stop transition 与 `waitForStopped`。
- `EffectsImpl.dispose`。
- `Runtime.deleteMany` 和 `InstanceStore` revision。

单次 `performance.now()` 包围每个微步骤本身可能显著扰动 6µs 级路径。如需埋点，应累计计数和总耗时，并在 benchmark 外统一输出。

### Step E：正确性与性能一起验收

至少执行：

```bash
pnpm --filter @pluxel/core typecheck
pnpm --filter @pluxel/core test -- \
  tests/OwnerInvocations.test.ts \
  tests/PluginService.cascade.test.ts
pnpm --filter @pluxel/runtime test -- \
  tests/services/commands-service.test.ts
pnpm --filter @pluxel/core build
```

若改动触及 owner invocation resource lifecycle，还应增加/保留以下测试：

- no-gate close 不分配 gate，且同步 fast path 不改变结果。
- active lease 被 abort，close 必须等待 lease.dispose()。
- gate close 后拒绝新的 enter。
- plugin `stop()` 必须发生在 invocation drain 之后。
- command registration 的 Effects cleanup 与 plugin stop 不会死锁。
- replacement 后旧 wrapper 不可调用，新 generation 可正常进入。

## 7. 建议验收标准

功能底线：上述 lifecycle、cascade、commands 测试全部通过，且不改变文档规定的 generation/Effects 顺序。

性能目标分两级：

- 首轮成功：收回至少 70% 的 cascade 绝对回退，leaf/增量路径不得回退超过 gate（5% 且 0.01ms）。
- 理想目标：六个 cascade 项回到 base 的 5% 门槛内，同时保留当前 leaf restart/HMR、incremental add 和 config injection 的改善。

由于 CI runner 有噪声，最终判断应基于同 runner 多次 base/head 交替结果；cold-build RME 未降到 10% 以下时不作为阻塞项。

可同时观察 per-node slope：调整 star leaves 为 50/100/200/400，若修复有效，`Head - Base` 对节点数的斜率应显著下降，而不是只改善固定截距。

```bash
PLUXEL_BENCH_STAR_LEAVES=400 \
PLUXEL_BENCH_CHAIN_LENGTH=400 \
PLUXEL_BENCH_TIME=5000 \
pnpm bench:core:compare \
  eb022d86affb7054dd3471bbf6bb2ee7c3875f89 \
  HEAD
```

## 8. 新 session 开始时的最短清单

1. 读本文和 PR benchmark artifact。
2. 确认当前 HEAD、Node 版本及工作区状态。
3. 重跑一次 base/head，验证 cascade slope 仍在约 6–7µs/节点。
4. 比较 `35fc6273^ → 35fc6273`。
5. 首先验证 eager default `Error`，其次验证 no-gate Promise fast path。
6. 用 root unregister profile 隔离 stop-side，再看 restart 的剩余成本。
7. 保留 owner drain、reverse-topo、Effects cleanup 和 dependent restart 语义。
8. 跑 core/runtime 定向测试及最终 benchmark，多次取中位数后再下结论。
