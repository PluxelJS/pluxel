# CHANGE

- 0.2.0
我们意识到 @Optional 的多余，因为你总是要导入一个包才能声明可选依赖，而可选依赖的意义就是包可能不存在，这是相悖的。
现在的设计思路是：

- **不再提供** `registry.optional` / `.optional()` 这类“双入口”API；
- **插件内组合**用 `BaseFeature/FeatureHost`（方案 A）：子模块作为 Feature 在宿主插件 `ctx` 下运行与回收；
- “可选依赖”在运行时直接用 `ctx.registry.getInstance(Token)` 读取即可（不存在就返回 `undefined`），保持入口单一且可预测。

补充：为了让 HMR/UI 能在“插件启动前”拿到 schema/source，我们引入了类型优先写法与编译期注入约定：

- `field = this.configs.use(schema)`：零类型标注的配置声明（真实值在启动时注入；schema/source 由工具链注册）。
- `field = this.features.use(FeatureCtor)`：插件内组合 Feature；如 Feature 内使用 `pluginMethodDecorator()` 声明 requiredDeps，需要在启动前声明 Feature（`@UseFeature` 或工具链注入的 `__registerUsedFeatures__(PluginCtor, FeatureCtor)`），以保持 DI 校验可预测。
