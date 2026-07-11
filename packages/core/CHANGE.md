# CHANGE

- 0.3.0
  配置系统重构（破坏性变更）：

- **移除** `ConfigRuntimeService`：以单一 `ConfigService` 作为配置引擎与读取契约。
- **唯一校验合同**：采用 Standard Schema v1（`~standard.validate`），core 依赖 `@standard-schema/spec`。
- **显式区分 raw vs validated**：
  - `getRawConfig()` 只读落盘原始快照（可能包含未知 key / 未填默认）。
  - `ensureValidated(pluginName, schemaMap)` 负责校验 + 回填默认 + 缓存 last-known-good。
  - `getValidatedConfig()` 不再隐式回退 raw：未 ensure 时直接抛错。
- **更确定的注入时序**：插件/Feature 的配置注入只从 validated 快照注入；并在插件启动前完成校验与默认值回填（避免 Feature 在字段初始化期间构造导致读取到未注入值）。

- 0.2.0
  feature 组合模型重构（破坏性变更）：

- **不再提供** `registry.optional` / `.optional()` 这类“双入口”API；
- **插件内组合**统一用 `BaseFeature/FeatureHost`：子模块作为 Feature 在宿主插件 `ctx` 下运行与回收；
- Required feature 用 `this.features.use(FeatureCtor)`；它属于宿主的静态组成。
- Lazy feature 先用 `defineLazyFeature(spec)` 声明，再用 `this.features.load(spec)` 激活；它表达“条件启用的能力”，而不是 plugin constructor 的 soft dependency。
- `this.plugins.use(DepPlugin, cb?)` 继续只负责“feature 已启用后”的运行期可选协作；`ctx.registry.getInstance(Token)` 作为底层读接口，只返回“已运行”的实例。

补充：为了让 HMR/UI 能在“插件启动前”拿到 schema/source，我们引入了类型优先写法与编译期注入约定：

- `field = this.configs.use(schema)`：零类型标注的配置声明（真实值在启动时注入；schema/source 由工具链注册）。
- `field = this.features.use(FeatureCtor)`：插件内组合 Feature；Feature 必须显式列入 `@Plugin({ features: [...] })`，使配置与 required dependency 元数据在启动前确定。
