# Pluxel testing guide

按所测边界选择最小 host：

- core lifecycle、DI、effects 与 config composition：`@pluxel/core/test`。
- runtime HTTP、persistence、Workbench Plane service：`@pluxel/runtime/test`。
- static/dynamic route、Vite、HMR 与 UI compiler：对应 runtime package 的集成测试。

插件依赖测试使用最终声明。required provider 从插件包根入口 value-import，并直接写在 constructor；
测试必须经过 `@pluxel/test/vitest` semantic lowering，让 Core 消费与 Vite/production 相同的 slot edge facts：

```ts
import { ProviderPlugin } from '@acme/provider'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin()
class Consumer extends BasePlugin {
	constructor(readonly provider: ProviderPlugin) {
		super()
	}
}
```

optional integration 使用目标包根入口的 type-only import、non-exported module-level
`definePluginRef<T>()`，并只在 `init()` 的直接同步 `plugins.use(ref, callback)` statement 中消费。测试 absent、
provider start failure、replacement/restart 与 callback cleanup；ref 只观察 host catalog，不加载或注册 package。

每个 Plugin 最多声明一个 `this.configs.use(ObjectSchema)` 字段。配置测试只通过 Plugin constructor/address 设置值；
嵌套结构、section 与展示 metadata 属于该 object schema。

内部拆分用 owner-managed 普通对象与 effects cleanup；需要独立生命周期、配置或治理的能力建模为 Plugin。

Workbench Plane 至少覆盖：关闭时 callback 不执行且插件可运行；开启时 backend 在首个 init 前安装；module cleanup、target layout、opaque resource binding，以及 dev source 与 production artifact 路径。

仅测试底层 lowering facts 时，显式从 test/unsafe surface 导入 mutation helper，不要把它们当作 runtime 作者 API。
