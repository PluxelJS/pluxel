# Pluxel testing guide

按所测边界选择最小 host：

- core lifecycle、DI、feature、effects 与 config composition：`@pluxel/core/test`。
- runtime HTTP、persistence、Workbench Plane service：`@pluxel/runtime/test`。
- static/dynamic route、Vite、HMR 与 UI compiler：对应 runtime package 的集成测试。

插件依赖与 feature 测试使用最终声明：

```ts
@Plugin({
	name: 'Consumer',
	features: [CacheFeature],
})
class Consumer extends BasePlugin {
	cache = this.features.use(CacheFeature)

	constructor(readonly provider: Provider) {
		super()
	}
}
```

lazy feature 使用 module top-level `defineLazyFeature()` spec 与 `await features.load(spec)`；optional plugin integration 使用 `plugins.get/use()`。

Workbench Plane 至少覆盖：关闭时 callback 不执行且插件可运行；开启时 backend 在首个 init 前安装；module cleanup、target layout、opaque resource binding，以及 dev source 与 production artifact 路径。

仅测试底层 metadata/decorator 机制时，显式从 test/unsafe surface 导入 mutation helper，不要把它们当作 runtime 作者 API。
