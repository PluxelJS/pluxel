# Future Architecture Directions

> 状态：research backlog。本文保存尚未证明全面优于当前设计的方向，不进入
> [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md) 定义的当前架构，也不能作为实现时顺手扩张的依据。

## 使用规则

每个方向只有同时满足以下条件，才能升级为独立 proposal：

1. 明确指出删除的当前 API、状态与实现；
2. 替代设计覆盖 package build、Vite source、HMR、static/dynamic host 和测试；
3. 证明复杂度没有只从作者面转移到 compiler、artifact protocol 或 launcher；
4. 提供真实 workspace Plugin/use case，而不只依赖 synthetic fixture；
5. 给出可判定的验收与否决条件。

## 1. Decoratorless Plugin declaration

候选作者模型：root named export 的 concrete `BasePlugin` subclass 自动成为 Plugin，展示名使用 static fact：

```ts
export class OrdersPlugin extends BasePlugin {
	static readonly displayName = 'Orders'
}
```

潜在收益：删除 `@Plugin` 与 legacy decorator transform，root export 同时成为 declaration/identity namespace。

尚未证明：

- root re-export 多 Plugin package（以 `@pluxel/redis` 为基准）；
- abstract base、inherited constructor、import alias 与同包 token；
- package ESM/d.ts/multi-output 与 Vite source facts 等价；
- HMR export rename/replacement 的 slot 稳定与诊断；
- concrete exported helper subclass 被意外 catalog 化的治理；
- JavaScript authoring 与未 lowering 产物的错误质量。

实验必须把 decoratorless 与“薄 `@Plugin({ displayName })` marker”比较。若 marker 显著简化 semantic discovery 或错误定位，保留一个 decorator
可能比追求零 decorator 更清晰。最终不得同时支持两种 declaration。

## 2. Browser config representation

当前 schema source string + `new Function('v', 'f', ...)` 有 CSP、闭包限制和 import rewrite 成本，但替换方案尚未证明更小：

### Serializable FormPlan

build/runtime 从 Valibot object schema 生成冻结 plan，browser 只渲染，服务端负责权威 validation。

否决条件：为了即时 validation 复制整个 Valibot constraint/transform semantics，形成第二种 schema language。

### Browser schema artifact

toolchain 生成独立 browser-safe schema module，Workbench 通过正常 artifact/module loader 执行，不传输或 eval 源码字符串。

否决条件：需要第二套 compiler/watcher/cache，或不能复用现有 Workbench artifact、CSP 与 HMR pipeline。

研究应先完成当前单 object schema 重构，再以真实复杂 schema 对比生成代码、删除量、client validation、CSP 和 HMR。

## 3. First-class multi-instance nodes

候选方向是用 `PluginInstanceSlot(definition slot, host-local instance key)` 取代 synthetic fork subclass、metadata clone 与 fork registry。

尚未决定：

- default `PluginRef`、required constructor 与 optional ref 指向 default instance 还是显式 instance；
- host 如何声明 additional instance，是否需要新的 define-style ref；
- instance config、enablement、provider selection 与 HMR 的 address contract；
- 删除 `ForkablePlugin` 后如何证明 Plugin 支持安全多实例；
- Redis/S3 named resource manager 是否反而是更小模型。

当前重构只把 fork identity 结构化为 `PluginNodeSlot(definition, forkId)`，不改变 fork 作者语义或 synthetic implementation。

## 4. Context capability kernel

当前 `registerService`、`Injectable`、`RootService`、`OverrideOf`、constructor/string isolation 与 prototype proxy 过宽。候选方向是：

```text
object-identity capability declaration
  -> host explicit install
  -> root or per-generation owner view
```

目标是删除 module-evaluation global registration、runtime override 和 string identity，而不是把 registry 改写成 launcher 的巨大 factory 参数表。

研究必须覆盖 core/runtime-static/runtime-dynamic/test host、按需 Workbench/Vault、service override 测试、Context getter hot path 与 package dependency
方向。没有 composition API prototype 和 benchmark 前不进入当前重构。

## 5. Workbench root management transport

当前 root catalog/status/group query 使用 internal GraphQL，config/dependency/status mutation 与 resource 使用 Cap'n Web RPC；部分 mutation 重复。

候选是删除 internal GraphQL/GQLoom/GQLens，统一 typed Runtime RPC。升级前必须确认：

- 没有独立 external GraphQL consumer；
- GQLens selection/cache/invalidation 可以被更小的 client resource 替代；
- grant-bound Plugin RPC 与 root management RPC 继续隔离；
- 删除的 schema/codegen/build 量大于新增 client cache/projection。

## 6. Dependency binding contract

当前 host default provider 与 per-consumer parameter-index override 共享部分 resolver/mutation/commit 逻辑，但语义层次都真实存在：

```text
default:  capability token -> provider
override: dependency edge  -> provider
```

未来可以把它们收敛成一套 binding policy，但不能删除 default：未来新增 consumer 必须继承 host 选择。主要未决问题是 dependency edge 的稳定
identity；裸 parameter index 会随 constructor 重排漂移，而新增显式 role 又可能扩大作者面。

当前重构只把现有两类 state 的 Plugin name 换成结构化 slot/address，不改变选择语义。

## 7. Workbench catalog classification

可以研究用 exact package/Plugin refs 取代 plugin-name string、trailing `*` prefix 与最长匹配规则，并默认按 canonical package root 分类。

但 host 的跨包产品分类、用户 assignment/order 与 route navigation group 是真实 UI policy，不能因为 Plugin identity 不再用字符串就一并删除。
需要以实际 host 配置证明 prefix matching 没有产品价值，再建立独立 proposal。

## 明确不进入研究目标

- required dependency 改为 type-only import：required package 本来就必须存在，value import 更诚实；
- 把 database lineage/migration 简化成普通 effects；
- 删除 Workbench opaque grant/generation；
- 合并 RuntimeState、Config、Workbench preference 与 log policy 为通用 settings store；
- 把 effects/logger/config owner view 强行实现成 Plugin，使 graph 递归启动自身。
