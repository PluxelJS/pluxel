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

候选最小作者模型：root named export 的 concrete `BasePlugin` subclass 自动成为 Plugin，展示名使用 static fact：

```ts
export class OrdersPlugin extends BasePlugin {
	static readonly displayName = 'Orders'
}
```

潜在收益：删除 `@Plugin` marker 与 marker-specific lowering，root export 同时成为
declaration/identity namespace。它不会自动删除通用 decorator transform：当前公开
`pluginMethodDecorator()` 以及 Cache 的 `@Cached` / `@Memoized` 仍依赖 method decorator 语义，不属于本方向。

尚未证明：

- root re-export 多 Plugin package（以 `@pluxel/redis` 为基准）；
- `displayName`、`startTimeoutMs`、literal `forkable: true` 与显式 abstract provider relation 四类 marker fact
  应使用何种单一 static declaration，并保持 build-time 可判定与同等错误质量；
- abstract base、inherited constructor、provider import alias 与同包 token；
- package ESM/d.ts/multi-output 与 Vite source facts 等价；
- HMR export rename/replacement 的 slot 稳定与诊断；
- concrete exported helper subclass 被意外 catalog 化的治理；
- JavaScript authoring 与未 lowering 产物的错误质量。

实验必须把 decoratorless 与“薄 `@Plugin({ displayName })` marker”比较。若 marker 显著简化 semantic discovery 或错误定位，保留一个 decorator
可能比追求零 decorator 更清晰。最终不得同时支持两种 declaration。
