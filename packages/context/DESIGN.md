# Context kernel 设计取舍

本文解释 `@pluxel/context` 为什么从 pre-1.0 的 Service registry 与双 mapping，转向固定 host shape、分生命周期
slot 和 owner-view。重点不是罗列两套数据结构，而是说明它们分别在建模什么、旧模型的正确性边界、当前模型放弃了什么，以及
为什么当前寻址层数更少，cached getter 在 micro-benchmark 中仍可能略慢。

公共用法以 [`README.md`](./README.md) 和
[`docs/reference/context-hosts.md`](../../docs/reference/context-hosts.md) 为准。pre-1.0 实现只作为可执行基线保存在
[`legacy/`](./legacy/README.md)，不属于当前公共 API。

## 先说结论

双 mapping 与确定性并不互斥。双 mapping 是一种运行时间接寻址结构，不是旧模型错误的根源。旧模型真正的限制是：

1. 它把 Context 建模为可以对任意 Service 做 selective isolate 的实例空间 overlay；
2. 它又让一个共享 Service 对象通过可变 `service.ctx` 同时表示当前 owner；
3. registration、override 和 Context shape 属于全局可变状态。

当前模型不再提供运行时 `isolate([A, C])`。host 在 root 创建前已经为每项 capability 固定 `root`、`scope` 或
`owner-view` 生命周期，因此运行时不必再从 service identity 映射到动态 instance identity。host compile 会把 descriptor
提前降成 scope-local numeric slot，普通 `ctx.foo` 直接读取对应 cache。

这可以理解为把旧的：

```text
capability -> runtime mapping -> selected instance key -> instance
```

改成：

```text
capability --host compile--> fixed scope + numeric slot
                                      |
                                      v
                                values[slot]
```

当前模型在 Context/scope 创建、固定 shape 和 owner 正确性上更可预测，但这不自动保证每次 getter 都更快。数据结构层数只是
成本的一部分；私有 state 间接访问、cycle sentinel、失败重试语义和 JavaScript 引擎的 inline cache 同样决定热路径结果。

## 旧模型究竟是什么

### Context 是实例空间 overlay

旧 Context 是全局 Service registry。`registerService()` 为 Service 分配 service symbol，在全局
`Context.prototype` 安装惰性 getter。每个 Context 持有 `mapping` 和 `instances`：

```text
service symbol
      |
      v
mapping: service symbol -> instance symbol
      |
      v
instances: instance symbol -> Service instance
```

普通 Context 中，service symbol 和 instance symbol 相同。`isolate()` 为选中的 Service 建立原型 overlay：

```ts
child.instances = Object.create(parent.instances)
child.mapping = Object.create(parent.mapping)

for (const service of isolatedServices) {
	child.mapping[serviceKey] = Symbol(service.name)
}
```

因此每次 scoped Service 访问都动态回答一个问题：

> 当前 Context 对这项 Service 是继承父实例，还是使用自己的隔离实例？

这个模型有真实优势：

- `isolate([A, C])` 可以隔离任意 Service 子集，B 和 D 继续继承；
- `extend()` 直接复用 mapping 和 instances，不创建 overlay；
- mapping 只改变 instance key，不复制未触及的 Service；
- Service 集合很小且对象 shape 稳定时，symbol property lookup 对 V8 非常友好；
- 数据结构紧凑，惰性构造自然落在最终选中的 instance space。

这就是双 mapping 的概念基础和优雅之处。只要“任意 Context 可以在运行时改变任意 Service 的实例归属”仍是需求，这一层动态
选择就不能凭空消失；可以换实现，但必须保留某种等价的间接信息。

### mapping 没有决定实现与 owner

旧 mapping 只决定实例槽位。另两个维度由其他全局或可变机制承担：

- `overrideService()` 重写全局 `Context.prototype` getter，以选择 implementation；
- getter 返回共享实例前改写 `service.ctx`，以表示本次访问的 owner。

所以旧模型实际混合了三个不同问题：

| 问题                           | 旧模型的答案                                 |
| ------------------------------ | -------------------------------------------- |
| 这项能力使用哪个实现？         | 全局 prototype getter 当前捕获的 constructor |
| 这个 Context 使用哪个实例？    | `mapping -> instances` overlay               |
| 当前调用或资源属于哪个 owner？ | 共享实例上的可变 `service.ctx`               |

双 mapping 只解决第二个问题。后两个问题不能因为 instance lookup 很优雅，就自动获得确定语义。

## 根本正确性冲突：共享对象上的可变 owner

旧 getter 命中共享 Service 后执行：

```ts
if (service.ctx !== currentContext) service.ctx = currentContext
return service
```

这里存在一个不可能同时满足的三元组：

1. 不同 owner 得到同一个 Service 对象；
2. `service.ctx` 表示取得该对象的 owner；
3. 返回的 Service 可以缓存、跨越 `await`，并被多个 owner 并发使用，同时仍保留原 owner。

例如：

```ts
const actionsA = contextA.actions
await something()
void contextB.actions
actionsA.register('task')
```

若 A/B 返回同一对象，第二次读取已经把 `actionsA.ctx` 改成 B。之后的 registration、logger fields、effects cleanup 或
invocation gate 都可能错误归属 B。再次读取 getter只能再次改写共享字段，无法修复已经缓存或正在异步使用的 handle。

旧模型选择了“共享 facade identity + 读取时 rebinding”，牺牲 cached handle 的稳定 owner。当前 Runtime 必须支持 Plugin、Part
和 dependency caller 并发持有 handle，因此选择：

```text
shared root backend
├── stable facade for Plugin A
├── stable facade for Plugin B
├── stable facade for PluginPart
└── stable facade for dependency caller
```

owner-view 不复制 backend；它只让每个 owner 得到不同且可缓存的投影：

```ts
contextA.actions !== contextB.actions
contextA.actions.backend === contextB.actions.backend
contextA.actions.owner === contextA
contextB.actions.owner === contextB
```

这里放弃的是“不同 owner 必须看到同一个 facade 对象”，不是 backend 共享。

### 双 mapping 能否实现 stable owner

可以。可以把旧结构扩展成：

```text
backendMapping[capability] -> backendKey
rootInstances[backendKey]  -> shared backend

viewMapping[capability]    -> viewKey
ownerInstances[viewKey]    -> stable owner facade
```

这个设计没有正确性冲突，但它已经引入独立的 backend cache 和 per-owner view cache。若 host shape 固定，再把两个 mapping 在
host compile 时提前求值，结果正是当前的：

```text
rootValues[rootSlot]  -> shared backend
ownerValues[viewSlot] -> stable owner facade
```

因此当前设计不是因为双 mapping “不确定”而排斥它，而是在取消 dynamic selective isolate 后，运行时 mapping 不再提供额外
信息，可以被预编译 slot 取代。

## 另一项冲突：全局可变 Context shape

旧 registration 和 override 修改同一个 `Context.prototype`：

- 不同 host 不能独立组合同名属性和实现；
- disabled capability 的全局 getter仍然存在；
- late registration/override 会改变既有 Context 的可见 shape；
- getter replacement 不会自动迁移已经缓存的实例；
- HMR、ESM/CJS 或 workspace duplicate evaluation 难以维持明确的 host identity。

这同样不是双 mapping 的固有限制。可以为每个 host 建立独立 mapping 和 prototype。当前 plan-local frozen prototype 就是在做
这件事，并进一步把 capability 集合编译成专用 getter。

当前约束是：host authority 在创建 root 前一次确定 shape，之后 Plugin 不能安装、替换或删除 Runtime capability。override
只能作为 host compile 的输入，且必须保持 descriptor、scope 与 projected property 不变。

## 当前模型：提前固定生命周期，而不是动态 isolate

### 三个正交生命周期

当前 host 为每项 capability 显式选择一种语义：

| Scope        | 缓存位置                           | 共享边界                                          | 用途                                                      |
| ------------ | ---------------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| `root`       | `rootValues[slot]`                 | 整个 root                                         | registry、pool、clock、共享 coordinator                   |
| `scope`      | `scopeValues[slot]`                | 一个 scope 及其 children                          | generation、request、session 状态                         |
| `owner-view` | root backing + `ownerValues[slot]` | backend 按 root 共享，facade 按 Context/view 隔离 | owner-bound registration、logging、cleanup、caller facade |

这不是预测某次运行会调用 `isolate([A, C])`，而是从公共模型中移除了这项运行时自由度：

- `createScope()` 为所有 scope capability 建立新的生命周期空间；
- `createChild()` 继承父 scope cache；
- `createContextView()` 继承 source root/scope cache，但获得新的 owner-view cache；
- capability 的 scope 在 host compile 后不能按单个 Context 改变。

旧模型中的“实例是否隔离”被拆成两个更明确的问题：

1. backend/value 属于哪个生命周期？
2. 共享 backend 是否需要针对当前 owner 投影稳定 facade？

### host compile 是 runtime mapping 的提前求值

host compile 遍历 installation，把 descriptor identity 映射到 resolver，并为三个 cache namespace 独立编号：

```text
descriptor --host compile--> scope-specialized resolver + numeric slot

rootValues[slot]
scopeValues[slot]
ownerValues[slot]
```

owner-view 取得两个 slot：root slot 保存 backing，owner slot 保存 facade。projected property 的 getter直接捕获 scope、factory
和 slot；正常 `ctx.foo` 不查询 installation token，不查 descriptor Map，也不在读取时判断 scope。

descriptor Map 只用于：

- host compile 的重复 descriptor 检查和 resolver 建立；
- `resolveContextCapability(ctx, descriptor)` 的显式 object-identity lookup。

### 创建与严格惰性

| 操作                       | 新建内容                           | 复用内容                       |
| -------------------------- | ---------------------------------- | ------------------------------ |
| `createRoot()`             | Context state、root/scope 空 cache | compiled plan                  |
| `createScope()`            | Context state、scope 空 cache      | root cache                     |
| `createChild()`            | Context state                      | root cache、parent scope cache |
| `createContextView()`      | Context state                      | source root/scope cache        |
| 首次 owner capability 读取 | owner cache、该 capability facade  | root backing                   |

未读取的 capability 不运行 factory。未读取任何 owner capability 的 Context 共用冻结空数组哨兵，不分配 owner cache。
disabled capability 不进入 plan，也不创建 backend、cache value 或 facade。

root、scope 和 owner 的 slot 分别编号，因此一个生命周期的 capability 不会拉长另一个 cache。没有 projected property 的
capability 只编译 resolver，不创建 getter closure。

## 为什么 mapping 少了，getter 仍可能更慢

“numeric array slot 比双 object mapping 更少一步”是源码层面的事实，但不能直接推出 JavaScript machine-code 层面一定更快。
对 cached hit，两条路径实际执行的工作如下。

### 旧 scoped getter

```ts
const instanceKey = this.mapping[serviceKey]
const instance = this.instances[instanceKey]
if (instance) {
	if (instance.ctx !== this) instance.ctx = this
	return instance
}
```

它表面上有两次 lookup，但有几个有利条件：

- `serviceKey` 和常规 `instanceKey` 是稳定 symbol；
- mapping、instances 和 getter closure 长期保持 monomorphic shape；
- 普通非 isolate 路径通常是同一个 mapping/instances 对象；
- 旧 root getter甚至不经过 mapping，只读 `root.instances[serviceKey]`；
- cached 判断使用简单 truthy branch，不区分 `undefined`、construction cycle 和合法 falsy value；
- 它没有私有 state brand access、foreign-kernel receiver validation或失败重试状态机。

V8 可以对这种稳定 symbol lookup 建立很有效的 inline cache。源码中“两个方括号”不等于两次昂贵的通用哈希查询。

### 当前 projected getter

以 scope getter 为例：

```ts
const state = implementation.#state
const values = state.scopeValues
const current = values[slot]
if (current === CONSTRUCTING) throw cycleError
if (current !== undefined) return current
return constructAndCache(...)
```

它不做 descriptor Map lookup，但仍包含：

1. 私有字段 `#state` 访问及对应 brand/representation 约束；
2. 从 state 再读取 scope-specific cache pointer；
3. numeric array slot 读取；
4. `CONSTRUCTING` cycle sentinel 检查；
5. `undefined` miss 检查，使 `0`、`false`、空字符串和 `null` 都能成为合法缓存值；
6. miss 时的 construction-cycle、factory failure 清理和 retry 语义。

owner-view cached hit 同样先读 private state，再读 `ownerValues[slot]`；首次 miss 还需要惰性分配 owner cache、解析或创建 root
backing，并调用 `createView()` 构造稳定 facade。

所以当前 getter 的差距不是“Map 比 array 快”，也不是双 mapping 被证明更适合新语义，而是旧 getter在更弱的 contract 下形成了
非常短且易于 JIT 优化的路径。当前 getter省掉动态 instance selection，却增加了 private state、稳定 falsy caching、cycle
detection 和 retry contract。

### property getter 与 explicit resolve 不是同一路径

projected `ctx.foo` 使用 plan-local scope-specialized getter，直接读取 slot。它不重复显式入口的 receiver 和 foreign-kernel 检查。

`resolveContextCapability(ctx, descriptor)` 必须：

1. 验证 receiver 是当前 kernel 的 Context；
2. 通过 descriptor identity Map 取得 resolver；
3. 调用 scope-specialized resolver；入口已经验证 receiver，因此 resolver 直接读取同一 Context 的 private state 和 cache slot；
4. 对 absent 或 foreign descriptor 给出确定诊断。

因此 explicit resolve 明显慢于 property getter是预期结果，不能拿它代表日常 `ctx.foo` 成本。

## 完整成本与得失

### 当前模型获得什么

- owner/caller handle 可以缓存、跨 `await` 并并发使用，owner identity 不漂移；
- backend 仍按 root 共享，不需要为每个 Plugin 复制连接池或 registry；
- 每个 host 有独立且冻结的 Context shape；
- disabled capability 完全不进入 plan；
- capability scope 在 host compile 后确定，不存在 late mutation；
- Context/scope/child 创建不扫描 capability，也不构建 selective-isolate mapping overlay；
- factory construction cycle、合法 falsy value、失败清理和下次 retry 都有明确语义；
- graph/effects 和领域 service 明确拥有 prepare、cleanup 与 withdrawal，不再依赖 Context 通用生命周期协议。

### 当前模型放弃或支付什么

- 不再支持 `isolate([A, C])` 这种任意 Service 子集 overlay；
- 每个 Context 有私有 state；
- 实际读取 owner capability 后，每个 owner 还需要 cache 和 facade；
- owner-view 首次读取必然比“返回共享对象并改写 `ctx`”多一次 facade 构造，但两者语义不等价；
- host plan compilation 成为 root 创建前的冷路径成本；
- projected getter 比旧 getter多 private state/cache 间接访问和完整 cache-state branch；
- public host Context 不再是自由扩展对象，plan/prototype 在编译后冻结。

### 旧模型仍然适合什么

如果一个系统确实满足以下条件，旧 overlay 仍可能是更合适的设计：

- Service 集合和 Context shape 可以是进程全局的；
- 主要需求是按任意 Service 子集做动态 isolate；
- Service 不携带 owner，或者每次调用显式传入 owner；
- 不缓存 owner-bound handle，且没有跨异步并发 attribution；
- late registration/override 的全局影响是可接受 contract。

因此迁移不是证明双 mapping 普遍较差，而是当前 Pluxel 的问题边界已经改变。

## 可选设计为什么没有采用

### 保留共享 Service，每次显式传 Context

```ts
service.register(ctx, input)
```

这样可以保留单一 Service identity，也没有 owner 漂移。它适合底层 backend，但会让 owner-bound public API 重复传递 Context，并把
“调用者是否传对 owner”变成每个调用点的责任。

### 使用 AsyncLocalStorage 传播 owner

动态 invocation scope 适合命令或请求 carrier，但不能自然定义脱离 carrier 的 cached handle 属于谁，也会让同步、host-neutral
的 Context kernel 依赖平台动态上下文。Runtime 可以在具体 invocation 边界使用 async context，但它不能替代 Context value 本身的
稳定 owner identity。

### 每次 getter 都创建 bound closure/facade

语义正确，但会在每次读取时分配。按 owner 缓存这些对象后，就是当前 owner-view。

### 保留双 mapping，但增加 backend/view 两层

语义也正确。但在 immutable host shape 下，mapping 结果不会随 Context 动态改变；保留每次 runtime lookup 只会重复已经在 host
compile 时知道的信息。将它预编译成 root/owner slot 后，就是当前表示。

## 性能基线与解释边界

执行：

```sh
pnpm --filter @pluxel/context bench
pnpm --filter @pluxel/context bench:compare-legacy
```

2026-08-23，Node 24，同进程 comparison benchmark 的一次记录：

| 路径                             | 当前 mean | 当前 median |   旧 mean | 旧 median |
| -------------------------------- | --------: | ----------: | --------: | --------: |
| cached root getter               |   1.80 ns |     1.73 ns |   1.13 ns |   1.12 ns |
| cached scope getter              |   1.88 ns |     1.78 ns |   1.13 ns |   1.08 ns |
| cached stable owner getter       |   1.95 ns |     1.84 ns |   1.20 ns |   1.18 ns |
| alternating owner getter         |   1.76 ns |     1.73 ns |   1.19 ns |   1.17 ns |
| child creation                   |  82.59 ns |    78.62 ns |  80.53 ns |  75.78 ns |
| scope/selective-isolate creation |  85.37 ns |    81.48 ns | 199.26 ns | 186.22 ns |

这些数字说明的是趋势，而不是跨机器阈值：

- 旧 cached getter 在当前 V8 上更快，差距通常小于一纳秒；
- 当前 Context/scope 创建不建立 selective overlay，尤其 scope 创建明显更便宜；
- owner 行不是相同对象语义：旧路径返回同一对象并修改 `ctx`，当前路径返回 stable per-owner facade；
- 微基准中的循环形状、对象 polymorphism 和 JIT tiering 都可能改变绝对数值，应优先比较同进程成对路径；
- 一次 logger、registration、Map mutation、validation 或 I/O 通常远大于 getter 差距；极热循环仍可安全缓存当前 stable view。

2026-08-24，使用相同 root/scope/owner/mixed workload 顺序切换生产实现的 benchmark 中，direct private-state resolver 的
cached explicit resolve 约为 `10.8–14.1 ns/op`，重复 state validation 的 resolver 约为 `13.5–14.8 ns/op`；mixed
root/scope/owner 路径约从 `14.1 ns/op` 降至 `11.5–11.7 ns/op`。入口仍保留 receiver validation、descriptor Map 与
scope-specialized resolver call；这些路径不应与 projected property getter 混为一谈。

host plan compilation 随 capability 数量增长，属于 host/root 之前的一次性冷成本；Context 创建不按 capability 数量扫描或构造
value。owner facade 只在对应 owner 实际首次访问时创建。

## 已评估但未保留的优化

把 root、scope、owner 三个 cache pointer 复制到每个 Context 的独立私有字段，可把 getter进一步降到约
`1.4–2.0 ns/op`。同一实验中，root/scope 创建从约 `70–90 ns/op` 上升到约 `125–165 ns/op`，并增加每个 Context 的字段
占用，因此未保留。

把边界校验放回 projected getter 会增加常规 `ctx.foo` 成本；从 explicit resolve 入口删除校验则会降低跨 kernel 和 forged
value 的诊断确定性。当前实现将两条路径分开，只在入口验证成功后让 scope-specialized resolver 直接读取 private state。

预先为每个 Context 分配完整 owner cache 会减少首次读取分支，但会让不使用 owner capability 的 Context 承担分配成本，因此
未采用。

## 设计判断

旧双 mapping 是一个优秀的动态实例空间 overlay。当前 kernel 没有保留它，不是因为好设计与确定性冲突，而是因为当前 contract
不再允许 runtime selective isolate：capability 生命周期已经在 host compile 时固定，动态 mapping 没有新的选择需要表达。

真正必须修复的正确性问题，是共享 facade 上的 mutable owner、全局可变 Context shape，以及 Context kernel 与资源生命周期协议
的混合。stable owner 要求显式 owner 参数、动态 invocation carrier，或者 per-owner handle；当前设计选择了可缓存的 per-owner
view，同时继续共享 root backend。

因此评估后续优化时，不能只数源码 lookup 层数，也不能只报告 cached getter。至少必须同时报告：

- projected property getter；
- explicit descriptor resolve；
- root/scope/child/view 创建；
- owner-view cold miss 与 cached hit；
- host plan compilation；
- Context、cache 和 facade 的内存变化；
- 多 host、cached handle、并发 owner、construction cycle、failed factory retry 和 cleanup ownership 正确性。

只有在这些语义和成本保持可比时，才有依据判断另一种 mapping、slot 或 state layout 是否更好。
