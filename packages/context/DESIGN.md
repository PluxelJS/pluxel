# Context kernel 实现取舍

公开用法见[组合 Context host](../../docs/reference/context-hosts.md)。本包是同步、host-neutral 的固定能力 kernel；Plugin graph、服务准备和资源释放由上层拥有。

## 固定 shape 与稳定 owner

Host 编译前选择 descriptor、property 与 scope，编译后冻结 plan/prototype。没有运行期安装、任意子集 isolate 或 capability mutation。`overrides` 只能替换已声明 descriptor，并保持 scope/property。

| Scope      | 缓存与共享                                         |
| ---------- | -------------------------------------------------- |
| root       | 每 root 一份 value                                 |
| scope      | scope 及其 child 共享 value                        |
| owner-view | root 共享 backing，每 Context/view 缓存独立 facade |

共享 backend 不通过可变 `ctx` 表示调用者。owner facade 可缓存并跨 await 使用；不能通过修改共享对象 owner 或 ambient async context 替代其身份。

## 编译与读取

Compilation 为 root/scope/owner cache 分别分配数字 slot，并生成 scope-specialized resolver。owner-view 同时需要 root backing slot 和 owner facade slot。projected getter 捕获 factory 与 slot；显式 `resolveContextCapability()` 另做 descriptor identity lookup 和 receiver validation。

创建 root/scope/child/view 不调用 capability factory。scope 创建新的 scope cache，child 复用父 scope，view 复用 source root/scope；owner cache 延迟到首次访问。未安装能力不进入 plan，未读取能力不构建 value。没有 property 的能力只编译 resolver。

构造 cycle、falsy value、factory 失败及重试有独立缓存状态。不要把 falsy 当成未初始化，也不要把失败的半成品缓存成成功值。

## 修改时保留的取舍

- owner facade 的首次分配换取可缓存、并发稳定的 owner；backend 仍按 root 共享。
- compilation 是 root 创建前的冷成本；Context 创建不扫描 capability。
- property getter 与显式 resolve 有不同验证成本，不能混为一项性能指标。
- 不预分配未使用的 owner cache；不为 getter 微基准复制 cache 指针而忽略 Context 创建和内存成本。

优化须同时检查 getter、显式 resolve、root/scope/child/view 创建、owner cold miss、plan compilation 和内存；并保留多 host、cached handle、并发 owner、cycle、failed factory retry 与上层 cleanup ownership 的正确性。

## 性能基线与解释边界

执行：

```sh
pnpm --filter @pluxel/context bench
```

基准只运行当前实现。历史实现和历史对照结果由 Git 保存。

2026-08-24，使用相同 root/scope/owner/mixed workload 顺序切换生产实现的 benchmark 中，direct private-state resolver 的
cached explicit resolve 约为 `10.8–14.1 ns/op`，重复 state validation 的 resolver 约为 `13.5–14.8 ns/op`；mixed
root/scope/owner 路径约从 `14.1 ns/op` 降至 `11.5–11.7 ns/op`。入口仍保留 receiver validation、descriptor Map 与
scope-specialized resolver call；这些路径不应与 projected property getter 混为一谈。

host plan compilation 随 capability 数量增长，属于 host/root 之前的一次性冷成本；Context 创建不按 capability 数量扫描或构造
value。owner facade 只在对应 owner 实际首次访问时创建。
