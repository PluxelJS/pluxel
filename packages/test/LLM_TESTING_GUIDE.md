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

每个 Plugin/PluginPart class 最多声明一个 `this.configs.use(ObjectSchema)` 字段。配置测试只通过 owning Plugin
constructor/address 设置 aggregate record；Part config 位于 occurrence field path。

需要 config/effects/capability owner、但不独立治理的内部拆分使用 `PluginPart`；简单 helper 仍可显式使用 owner effects。
需要独立生命周期、配置 revision 或治理的能力建模为 Plugin。

Workbench Plane 至少覆盖：关闭时 callback 不执行且插件可运行；开启时 backend 在首个 init 前安装；publication cleanup、target layout、Direct View/Attachment 的 fresh root 生命周期，以及 dev/production immutable MF producer 路径。

仅测试底层 lowering facts 时，显式从 test/unsafe surface 导入 mutation helper，不要把它们当作 runtime 作者 API。
