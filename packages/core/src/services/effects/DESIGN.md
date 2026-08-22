# EffectsService — 最终设计（Codex-ready，优雅 & 高性能）

> 前提：你已经通过 `Context` isolate 实现 **每插件独立 Context/DI 容器**。  
> 本设计只负责 **单个 Context 内**的副作用/资源生命周期管理：注册、事务回滚、卸载清理。  
> 不做跨插件全局映射；插件卸载（registry/unload）由外层流程负责。

---

## 0. 目标与硬约束

### 0.1 目标

- 用极少 API 原语，覆盖插件生命周期中的资源/副作用管理：
  - 事件订阅/注销、路由注册/反注册、timer、连接、后台任务、扩展点注册等
- 性能最优先（但不牺牲可推理性）：
  - init-heavy（大量注册）
  - unload-heavy（集中清理）
  - 运行时变更少

### 0.2 硬约束（必须满足）

1. **结构性 at-most-once**：任何条目最多执行一次
   - 不依赖用户写幂等 dispose
   - 不依赖“调用方别重复调用”的约定
2. **unload 必须 drain**：清理过程中新增的条目，也必须在同一次 unload 中被清理
   - 避免 snapshot-only / swap-set 导致漏清理
3. **API 极简且语义硬**：不要 add/addMany、不要啰嗦工厂模式
4. 与原生 ES `using` **可组合**：可在块结束时提前释放，并自动避免 unload double-free
5. 异步工作必须通过可释放 handle 或可等待 cleanup 显式纳管，不发布只通知、不托管的 ambient signal

---

## 1. 核心抽象

### 1.1 Cleanup

- `cleanup(): void | Promise<void>`
- 语义：撤销副作用/释放外部资源（不是通用任务队列）

### 1.2 DisposableLike

- `dispose(): void | Promise<void>`

### 1.3 Guard（唯一关键句柄）

Guard 代表 registry 内的一个条目，提供：

- `dispose()`：**立即执行并从 registry 注销**（at-most-once）
- `cancel()`：**只注销不执行**（少用：释放责任转移给别处）
- `active`：调试/分支用

ES `using` 组合：

- `Symbol.dispose / Symbol.asyncDispose` 映射到 `dispose()`

> Guard 是“优雅 + 正确性”的核心：  
> 用户提前释放后，unload 不会再释放（结构保证），彻底消除 double-free 风险。

---

## 2. 对外 API（最小原语集）

> 通过 DI 注入 `ctx.effects: Effects`（或把 methods 再转发到 ctx）  
> **核心原语只有三条 + 两个结构化能力**。

### 2.1 `effects.defer(cleanup, meta?) -> Guard`

登记一个 cleanup，unload 时执行（默认 LIFO，默认 phase=runtime）。

典型：

- `effects.defer(() => bus.off("msg", onMsg))`
- 如果 `on()` 返回 off：`effects.defer(bus.on("msg", onMsg))`
- `effects.defer(() => clearInterval(id))`

### 2.2 `effects.own(disposable, meta?) -> Guard`

登记一个 DisposableLike 资源对象。

典型：

- `effects.own(conn)`
- `effects.own(transport)`
- `effects.own(worker)`

### 2.3 `effects.acquire(acquire, release, meta?) -> Promise<T>`

通用模式（避免工厂/适配器啰嗦）：

1. `const value = await acquire()`
2. 自动登记 `release(value)` 为 unload cleanup
3. 返回 `value`

典型：

- timer: `acquire(() => setInterval(...), id => clearInterval(id))`
- connect: `acquire(connect, c => c.close())`
- subscribe: `acquire(() => bus.on(...), off => off())`

**异常安全硬契约（MUST）：**

- `value` 获取成功后，若“登记 release”失败（例如 disposed/frozen），必须立刻 `await release(value)`（best-effort），然后 **重新抛出登记失败的错误**，避免泄漏。

> 注：如果你需要“提前释放 acquire 的结果”，建议在 acquire 内部同时拿到 Guard（实现方式见 §4.3），或直接不用 acquire 改用 defer/own。

### 2.4 `effects.scope(meta?) -> EffectsScope`

创建子作用域（模块化/提前释放）：

- 子 scope 拥有独立 stacks/entries（或独立 entry 区间），对外 API 相同（defer/own/acquire/transaction）
- 子 scope 本身可被父 `own`（自动纳管），保证 unload 传递
- 子 scope `dispose()` 之后，父 unload 不会重复释放（依赖 at-most-once）

### 2.5 `effects.transaction(fn) -> Promise<R>`

**effects registry 的事务**（不是 DB 事务）。

适用：

- 插件 init / 重新配置：中途失败要回滚已登记副作用，避免半初始化泄漏

语义：

- `transaction` 内提供 `tx` view（与 effects API 相同）
- `fn(tx)` 成功：commit（**no-op**）
- `fn(tx)` 失败：rollback（执行并注销 tx 期间登记的所有条目），再抛出错误

关键实现：**checkpoint unwind + freeze**（见 §4.4）

### 2.6 异步任务所有权

EffectsService 不暴露 ambient lifetime signal。signal 只通知协作式取消，既不表示任务所有权，也不能让
`dispose()` 找到并等待未登记的 Promise；把它放在 effects 上会产生“已传 signal 就已回收”的错误契约。

默认模式：

- 后台任务返回 `DisposableLike`，其 `dispose()` 完成停止接单、取消和等待退出，再交给 `effects.own()`；
- 已有 task handle 使用 `effects.defer(() => task.cancel())`，其中 `cancel()` 必须在任务真正停止后才 settle；
- 底层只接受 `AbortSignal` 时，局部 `AbortController` 属于 task/resource 实现，并在其 cleanup 中 abort 后 await；
- request、command、timeout signal 属于调用边界，不由 EffectsService 合成；
- 只有通过 `defer()` / `own()` / `acquire()` 登记的工作才进入 drain 与错误聚合。

---

## 3. Meta 与 phase（可选 view，零映射）

### 3.1 Meta（可选）

```ts
type Meta = {
	tag?: string
	phase?: Phase // 可选；不用 phase 时永远是 runtime
	critical?: boolean // 仅影响观测等级，不改变默认错误策略
}
```

### 3.2 Phase 的最终定位（重要）

- phase **不是核心能力**，不强制使用
- phase 仅作为低成本排序/语义点：**一个 view，默认写入 meta.phase**
- 实现上只是 **多个栈**（通常 1 或 3 个），不引入 “phase->container map” 的额外对象分配
- 若完全不用 phase：内部只保留一个 runtime 栈，phase API 可不暴露或不常用（零成本）

推荐固定三段（当你真的需要硬顺序时）：

- `shutdown` → `runtime` → `final`  
  同 phase 内：LIFO

---

## 4. 语义契约（写死，防 Codex 走偏）

### 4.1 Entry at-most-once 状态机（必须）

每个条目 entry 具备状态：

- `ACTIVE -> RUNNING -> DONE`

所有执行路径统一走 `run(entryId)`：

- 手动 `Guard.dispose()`
- scope.dispose()
- effects.dispose()（unload）
- transaction rollback unwind

**run 行为（MUST）：**

- 仅当 `state=ACTIVE` 时触发执行，并立刻置为 `RUNNING`
- 若执行返回 Promise，则缓存该 Promise
- 若 `state=RUNNING`，再次调用 `run()` 必须 **返回同一个 in-flight Promise**
- 若 `state=DONE`，`run()` 为 no-op（返回已完成 Promise）

执行完成后：

- `state=DONE`
- 清空引用：`a[id]=null; b[id]=null; meta[id]=null; promise[id]=null`

### 4.2 Service 状态机：LIVE / DISPOSING / DISPOSED（必须）

- `LIVE`：允许 register
- `DISPOSING`：允许 register（用于满足 drain），但受 §4.3 约束
- `DISPOSED`：禁止 register，抛 `EffectsDisposedError`

### 4.3 unload 入口唯一化：`effects.dispose()` == drain（并发幂等）

- 对外只提供一个卸载清理入口：`effects.dispose()`
- `effects.dispose()` 语义就是 **drain to empty**
- `dispose()` 必须 **幂等且共享 in-flight**：
  - 并发/重复调用返回同一个 Promise
  - 完成后再调用返回稳定的已完成 Promise（成功或失败）

#### 4.3.1 drain 算法（推荐 pop-until-empty）

为确保“cleanup 中新增条目也会被清理”，对每个 phase 栈（按 phase 顺序）：

- `while (stack not empty) { id = stack.pop(); await run(id) }`

#### 4.3.2 Phase 单调性（关键修正，MUST）

为保证多 phase 下也满足“同次 drain 清理 re-entrant 注册”：

- dispose（或 rollback unwind）进行中维护 `currentPhaseIndex`
- **任何新注册的 `meta.phase` 若早于 `currentPhaseIndex`，必须被强制提升到 `currentPhaseIndex`**
- 这样无需多轮扫描即可保证 drain 完整性，且不引入额外映射结构

### 4.4 transaction 的实现（checkpoint unwind + freeze，最终版本）

transaction 开始时记录 checkpoint：

- `cp[phase] = stack[phase].length`

**freeze 外部注册（强烈推荐，MUST）：**

- transaction 执行期间，非 tx view 的 register 操作抛 `FrozenError`
- tx view 允许 register
- 支持 await：防止事务期间外部逻辑污染本次事务边界

**嵌套事务（写死策略，MUST）：**

- 允许嵌套：用 `freezeDepth` 计数；每层持有自己的 checkpoint
- commit/rollback 只影响本层 checkpoint 区间；最外层退出时解除冻结

commit：

- `unfreeze`（depth--）
- no-op（条目已在同一 stacks 中，checkpoint 只是边界）

rollback：

- 对每个 phase：从当前长度 pop 到 cp：
  - `id = stack.pop()`
  - `await run(id)`（执行并注销）
- rollback unwind 期间同样适用 §4.3.2 Phase 单调性
- `unfreeze`（depth--）
- rethrow

### 4.5 disposed/frozen 行为

- `DISPOSED` 后 register：抛 `EffectsDisposedError`
- `DISPOSING` 期间 register：允许，但 phase 受 §4.3.2 约束
- frozen 状态下：
  - 外部 effects.\* register 抛 `FrozenError`
  - tx view 允许 register

### 4.6 错误策略（最终默认）

- continue-on-error：单个 cleanup 失败不阻断其它 cleanup
- 收集错误并在 `dispose()` 结束时抛 `AggregateError`（或按 runtime 习惯返回 result + logger）
- `critical` 仅用于观测与告警级别（除非你显式配置 fail-fast）

### 4.7 ES `using` 互操作契约（必须写清）

- 若 cleanup/资源释放可能是异步：必须用 `await using` 或显式 `await guard.dispose()`
- `Symbol.dispose` 仅适用于保证同步释放的条目；若检测到返回 Promise，可选择抛错提示（实现自定，但契约固定）

---

## 5. 内部数据结构（最终建议）

> 目标：注册 O(1)，执行局部性好，尽量少分配。

### 5.1 栈（phase 栈）

- 默认只保留 `runtime` 栈（不用 phase 时）
- 若启用 phase，则保留 3 个栈：`shutdown/runtime/final`
- 栈元素存 `entryId`（整数）

### 5.2 entry 表（并行数组，JIT 友好）

建议使用并行数组避免大量对象分配：

- `kind[id]`: CLEANUP | DISPOSABLE | RELEASE
- `state[id]`: ACTIVE | RUNNING | DONE
- `a[id]`:
  - CLEANUP: cleanup fn
  - DISPOSABLE: disposable object
  - RELEASE: acquired value
- `b[id]`:
  - RELEASE: release fn
  - else: null
- `promise[id]`：RUNNING 时缓存 in-flight Promise（用于并发共享）
- `meta[id]`（可选，dev/obs）

执行后清空引用降低泄漏风险/GC 压力：

- `a[id]=null; b[id]=null; meta[id]=null; promise[id]=null`

### 5.3 id 复用（避免长生命周期 Context 膨胀）

- 维护 `freeIds: number[]`
- `run/cancel` 后将 `id` 归还到 `freeIds`
- register 时优先复用 freeIds；无则增长 arrays

### 5.4 Guard（最小闭包/最小状态）

Guard 只保存：

- `scopeRef`（或 service instance）
- `entryId`

并调用：

- `dispose() => scope.run(entryId)`
- `cancel() => scope.cancel(entryId)`（cancel：标记 DONE 并回收 id，不执行 cleanup）

---

## 6. 与 Context/DI 的集成（落地方式）

- `@Injectable({ key: "effects", methods: [...] })`
- 每个 `Context` 持有一个 `EffectsService` 实例（由于 isolate，天然每插件隔离）
- Host 卸载流程在合适时机调用 `await ctx.effects.dispose()`

> 重要：effects 不负责 Plugin graph transaction。
> 它只负责释放资源/撤销副作用。卸载流程应由 host 层编排。

---

## 7. 推荐卸载流程（host 层）

1. runtime coordinator prepare `dematerializeNode` transaction
2. 关闭内部 owner invocation admission，abort 并等待已接纳调用退出
3. `await ctx.effects.dispose()`（drain；包含 `init()` 返回的 cleanup/disposable）
4. 提交已验证 graph，并由 coordinator 同步 desired/applied/catalog projection

Plugin generation 不直接改写 Core graph。若未来提供 self-disable，应由 runtime host-policy capability
更新 desired state 后统一 reconcile；effects 仍只负责当前 generation 的资源释放。

---

## 8. 使用范式（最短路径）

- 订阅（on 返回 off）：
  - `effects.defer(bus.on("msg", onMsg), { tag: "event:msg" })`
- 订阅（无返回 off）：
  - `effects.defer(() => bus.off("msg", onMsg), { tag: "event:msg" })`
- 资源：
  - `effects.own(conn, { tag: "db:main" })`
- acquire：
  - `await effects.acquire(connect, c => c.close(), { tag: "db:conn" })`
- 子模块：
  - `const component = effects.scope({ tag: "component:x" }); component.defer(...); await component.dispose()`
- init 回滚：
  - `await effects.transaction(async (tx) => { tx.defer(...); tx.own(await connect()); ... })`

---

## 9. Implementation Checklist（Codex must-follow）

### Core correctness

- [ ] entry 状态机：ACTIVE->RUNNING->DONE；`run(id)` 只触发一次执行
- [ ] RUNNING 下 `run(id)` 返回同一个 in-flight Promise（并发共享）
- [ ] Guard.dispose() 调用 `run(id)`；Guard.cancel() 标记 DONE 且回收 id，不执行
- [ ] `effects.dispose()` 使用按 phase 顺序的 pop-until-empty ⇒ drain 语义
- [ ] 清理过程中新增条目仍在同一次 dispose 内被清理
- [ ] service 状态：LIVE/DISPOSING/DISPOSED；DISPOSED 后 register 抛 `EffectsDisposedError`
- [ ] `effects.dispose()` 幂等：并发/重复调用共享同一个 Promise

### Phase correctness

- [ ] dispose / rollback unwind 期间维护 `currentPhaseIndex`
- [ ] 新注册若 phase 早于 currentPhaseIndex ⇒ 强制提升到 currentPhaseIndex（Phase 单调性）
- [ ] 该规则同样适用于 rollback unwind

### Transaction correctness

- [ ] 记录 checkpoint：`cp[phase] = stack[phase].length`
- [ ] freeze 外部 register；仅 tx view 允许 register；支持 await
- [ ] 支持嵌套事务：freezeDepth + 每层独立 checkpoint
- [ ] commit=no-op；rollback pop 到 checkpoint 并逐个 `await run(id)`；finally 解冻

### Acquire correctness

- [ ] acquire 成功后登记 release；若登记失败（disposed/frozen）⇒ best-effort `await release(value)` 后 rethrow

### Performance hygiene

- [ ] 不做 snapshot allocations（no Array.from）
- [ ] entry 并行数组；run 后清空引用；支持 id 复用避免膨胀
- [ ] meta 可选；可 dev-gate 或编译剔除

### Error handling

- [ ] continue-on-error；收集错误；dispose 结束抛 AggregateError（或返回结构化结果）
- [ ] logger hook 使用 meta.tag（若存在）

### ES `using` interop

- [ ] Guard 实现 `Symbol.dispose / Symbol.asyncDispose` 映射到 dispose()
- [ ] 文档契约：异步释放必须用 `await using` 或显式 await

---

## 10. 为什么这是“最终最优”

- Guard + entry 状态机（含 RUNNING promise 共享）提供结构性 at-most-once，且并发安全
- pop-until-empty + Phase 单调性保证 re-entrant 注册在同次 dispose/rollback 内被清理（真正 drain）
- transaction checkpoint unwind 使成功路径 commit=no-op，失败路径自动回滚且 await 安全
- Context isolate 无需全局映射；内部结构极简、局部性好
- phase 可选且零映射；不用时几乎零成本，用时也不破坏 drain 语义
