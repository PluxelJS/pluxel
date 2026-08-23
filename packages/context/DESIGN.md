# Context kernel 设计取舍

本文记录 `@pluxel/context` 当前设计的约束和取舍。公共用法以 [`README.md`](./README.md) 和
[`docs/reference/context-hosts.md`](../../docs/reference/context-hosts.md) 为准。pre-1.0 实现只作为可执行基线保存在
[`legacy/`](./legacy/README.md)，不属于当前公共 API。

## 旧模型

旧 Context 是全局 Service registry。`registerService()` 为 Service 分配 service symbol，在
`Context.prototype` 安装惰性 getter；每个 Context 持有 mapping 和 instances：

```text
service symbol
      │
      ▼
mapping: service symbol -> instance symbol
      │
      ▼
instances: instance symbol -> Service instance
```

普通 Context 中两个 symbol 相同。`isolate()` 为选中的 Service 建立 overlay：

```ts
child.instances = Object.create(parent.instances)
child.mapping = Object.create(parent.mapping)

for (const service of isolatedServices) {
	child.mapping[serviceKey] = Symbol(service.name)
}
```

结果是：

- 未隔离 Service 沿两条原型链复用父实例；
- 被隔离 Service 使用新的 instance symbol，在 child instances 中惰性创建；
- 普通 `extend()` 直接复用 mapping 和 instances，不创建 overlay；
- `isolate([A, C])` 可以只隔离指定 Service 子集。

mapping 只选择实例槽位。旧 `overrideService()` 通过重写全局 `Context.prototype` getter 选择 replacement
constructor，因此实例隔离是 per-Context 的，实现替换和 Context shape 是进程全局的。

旧模型的数据结构少、cached getter 路径短，并支持任意 Service 子集隔离。这些性质由 legacy tests 和 comparison benchmark
保留。

## 旧模型不满足的当前约束

### Owner identity 依赖共享可变字段

旧 getter 返回共享 Service 前会把 `service.ctx` 改成当前 Context：

```ts
if (service.ctx !== currentContext) service.ctx = currentContext
return service
```

调用方缓存 Service、调用跨越 `await`，或多个 owner 并发读取同一 Service 时，已取得的对象不会保留原 owner。再次读取 getter
只能再次改写同一个字段。

当前 Runtime 要求 commands、HTTP、workers、node modules、vault 和 workbench 共享 root backend，同时把注册、调用 gate、
日志和 cleanup 绑定到稳定的 Plugin、Part 或 dependency caller。共享对象上的 mutable `ctx` 不能提供这个保证。

### 全局 prototype 不能表示多个并存 host shape

旧 registration 和 override 修改同一个 `Context.prototype`：

- 不同 host 不能独立组合同名属性和实现；
- disabled capability 的全局 getter仍然存在；
- late registration/override 会改变既有 Context 的 shape；
- 已缓存实例又不会随 getter replacement 自动迁移。

当前约束是 launcher 在 root 创建前一次确定 shape，之后 Plugin 不能安装或替换 Runtime capability。

### Context 同时承担了过多协议

旧 Context 同时承载 config 合并、Service registration、方法代理和通用 `prepareServices()`。当前架构由 graph/effects 拥有资源
启动与清理；Context kernel 只负责同步、严格惰性的 capability resolution，因此不提供通用 prepare/dispose 协议。

## 当前模型

host 编译时，descriptor identity 映射到 resolver。root、scope 和 owner 分别使用独立的连续 slot namespace：

```text
descriptor --host compile--> resolver + scope-local slot

rootValues[slot]   每个 root 一份
scopeValues[slot]  每个 scope 一份，child 共享
ownerValues[slot]  每个 Context/view 一份，首次 owner capability 读取时创建
```

owner-view 同时取得两个 slot：root slot 保存共享 backing，owner slot 保存 per-owner facade。

```text
root backing
├── Plugin A facade
├── Plugin B facade
├── PluginPart facade
└── dependency caller facade
```

每个 facade 固定绑定一个 owner；缓存或跨异步边界使用不会被其他 Context 的读取改变。

### 创建与复用

| 操作                       | 新建内容                          | 复用内容                       |
| -------------------------- | --------------------------------- | ------------------------------ |
| `createRoot()`             | root state、root/scope 空 cache   | compiled plan                  |
| `createScope()`            | Context state、scope 空 cache     | root cache                     |
| `createChild()`            | Context state                     | root cache、parent scope cache |
| `createContextView()`      | Context state                     | source root/scope cache        |
| 首次 owner capability 读取 | owner cache、该 capability facade | root backing                   |

未读取的 capability 不运行 factory。未读取任何 owner capability 的 Context 共享一个冻结空数组哨兵，不分配 owner cache。
disabled capability 不进入 plan，也不创建 backend、cache value 或 facade。

root、scope 和 owner 的 slot 分别编号，因此一个生命周期的 capability 不会拉长另外两个生命周期的 cache。plan 直接保存
descriptor 到 resolver 的 Map；不保留第二个 resolver array、installation 列表或额外 prototype 引用。没有 projected
property 的 capability 只编译 resolver，不创建 getter closure。

### 热路径与边界检查

有 projected property 的 capability 使用 scope-specific getter。getter 直接读取私有 state 和 cache slot，并保留 construction
cycle 检查。它不重复显式 resolve 所需的 receiver/foreign-kernel validation。

`resolveContextCapability()` 先验证 Context，再通过 descriptor Map 取得 resolver。不存在的 descriptor、跨 kernel Context 和
跨 kernel descriptor 仍走完整诊断路径。

factory 返回 `undefined` 视为错误；construction failure 会清除 sentinel，下一次读取可以重试。`0`、空字符串和 `null` 都是
有效缓存值。

## 成本与限制

- `createScope()` 隔离全部 scope capability，不支持旧 `isolate([A, C])` 的任意子集 overlay；
- 每个 Context 有私有 state；实际使用 owner capability 后，还有 owner cache 和 per-owner facade；
- owner-view 首次读取必须创建 facade，不能与“返回共享对象并改写 `ctx`”具有相同冷路径成本；
- Context 不可作为自由扩展对象；public host 创建的 Context 不可扩展，plan/prototype 在编译后冻结；
- host plan compilation 是 root 创建前的冷路径成本；
- projected getter 比旧 getter多一次私有 state/cache 间接访问；
- 显式 resolve 比 property getter 多 receiver validation 和 descriptor Map lookup。

这些成本对应固定 shape、host isolation、stable owner、cycle detection 和失败重试语义。

## 性能基线

执行：

```sh
pnpm --filter @pluxel/context bench
pnpm --filter @pluxel/context bench:compare-legacy
```

2026-08-23，Node 24，同进程 comparison benchmark 的一次结果：

| 路径                             | 当前 mean | 当前 median |   旧 mean | 旧 median |
| -------------------------------- | --------: | ----------: | --------: | --------: |
| cached root getter               |   1.80 ns |     1.73 ns |   1.13 ns |   1.12 ns |
| cached scope getter              |   1.88 ns |     1.78 ns |   1.13 ns |   1.08 ns |
| cached stable owner getter       |   1.95 ns |     1.84 ns |   1.20 ns |   1.18 ns |
| alternating owner getter         |   1.76 ns |     1.73 ns |   1.19 ns |   1.17 ns |
| child creation                   |  82.59 ns |    78.62 ns |  80.53 ns |  75.78 ns |
| scope/selective-isolate creation |  85.37 ns |    81.48 ns | 199.26 ns | 186.22 ns |

owner 行不是相同对象语义：旧路径返回同一对象并改写 `ctx`；当前路径返回稳定的 per-owner facade。数字只用于观察同一机器和
引擎上的趋势，不是跨平台阈值。

独立 kernel benchmark 中，descriptor Map 直接保存 resolver 后，cached explicit resolve 的代表性结果约为 `8–9 ns/op`；此前
numeric index 加 resolver array 的路径约为 `14–16 ns/op`。

## 已评估但未保留的优化

把 root、scope、owner 三个 cache pointer 复制到每个 Context 的独立私有字段，可把 getter进一步降到约
`1.4–2.0 ns/op`。同一实验中，root/scope 创建从约 `70–90 ns/op` 上升到约 `125–165 ns/op`，并增加每个 Context 的字段
占用，因此未保留。

把边界校验放回 projected getter 会增加常规 `ctx.foo` 成本；从显式 resolve 删除校验则会降低跨 kernel 和 forged value 的
诊断确定性。当前实现将两条路径分开。

预先为每个 Context 分配完整 owner cache 会减少首次读取分支，但会让不使用 owner capability 的 Context 承担分配成本，因此
未采用。

## 当前结论

旧 mapping overlay 适合全局 Service 集合和选择性实例隔离。当前 kernel 面向固定 host shape、Plugin generation scope、共享
backend、stable owner/caller identity 和 graph/effects 资源所有权，两者解决的问题不同。

当前实现保留 root/scope/backing 的实例复用，只为实际读取 owner capability 的 Context 创建 facade。剩余 getter差距小于一
纳秒；已验证的进一步缩减方案会增加 Context 创建或实例内存。没有证据支持继续增加 fast path。

后续优化必须同时报告 property getter、显式 resolve、Context 创建、scope 创建、owner cold/hot path 和内存变化，并保持多
host、cached handle、并发 owner、construction cycle、failed factory retry 和 cleanup ownership 验证。
