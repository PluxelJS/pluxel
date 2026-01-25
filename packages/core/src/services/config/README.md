# ConfigService（Core）设计说明

## 目标

`ConfigService` 的职责是给 **插件侧** 提供一个稳定、极小的“读取配置快照”的契约，并且提供一个“是否启用”的偏好存储。

- Core 只负责：已声明配置字段的注入时机/规则、在插件 Context 下按插件名取配置。
- 更推荐的用法：插件用 `field = this.configs.use(schema)` 声明字段；schema/source 由上层工具链（如 configSourcePlugin）注册。
- 上层（App/HMR/Loader）负责：持久化、校验、默认值、合并策略、启用策略的解释。

## 关键语义

- `getConfig()` 默认用 `ctx.pluginInfo?.id` 作为 key：**只有在插件 Context 里调用才有意义**。
- `patchConfig(name, patch)` 是“对某个插件名的配置快照打补丁”，用于测试/加载器模拟。
- `enabledInConfig` 是偏好集合：Core 不解释它，上层可用它决定是否启动插件。
- `batch(run)` 用于对齐 HMR 版 API：Core 版仅同步合批，不做事务回滚。

## 扩展点（上层可覆盖）

如果你需要：

- 从磁盘/远端加载配置
- 支持 schema 校验、默认值、环境变量、热更新
- 把 enable/disable 变成真正的启动策略

建议在上层运行时覆盖/替换 `ConfigService` 的实现（保持同名 service key），Core 只依赖这个最小接口。

## 测试策略

优先用 `@pluxel/core/test` 的 `withTestHost()` 走真实插件启动流程：

- 通过 `host.setConfig(pluginCtor, record)` 构造注入快照
- 在插件里调用 `ctx.configService.getConfig()` 或读取 `this.configs.use(...)` 声明的字段并断言
