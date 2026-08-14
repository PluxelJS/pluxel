# ConfigService（Core）设计说明

## 目标

`ConfigService` 是唯一的内存配置引擎：保存 raw record 与 revision，在插件启动前**确保配置已校验并回填默认值**，并维护 normalized snapshot 缓存。

- Core 只负责：已声明配置字段的注入时机/规则、在插件 Context 下按插件名取配置。
- 插件用 class field initializer 声明字段，例如 `field = this.configs.use(schema)` 或 `field = this.configs.use(cfg(schemaMap))`；schema/source 以及可选 layout 由工具链注册。
- 上层（App/HMR/Loader）负责：持久化、启用策略的解释、以及 UI/RPC 侧的“schema defaults / patch validation”等业务编排（这些在 core 里提供为纯函数 helper，不需要走 service）。
- runtime 的 `ConfigService` 直接继承此引擎，只增加 persistence load/save、readonly policy 与 write coalescing；不复制 record、revision 或 validation 状态。

## Schema 合同（Standard Schema v1）

`ConfigService.ensureValidated(...)` 采用 **Standard Schema v1** 作为“唯一校验合同”：schema 只要实现 `~standard.validate(...)` 即可被校验与归一化（valibot 原生支持）。

实现上，core 依赖 `@standard-schema/spec`（类型包）来引用该合同定义。

这带来两个好处：

- Core 不需要感知/绑定任何具体校验库（不需要 “adapter registry”）。
- HMR/app 不需要额外的 runtime service：直接调用 `configService.ensureValidated(...)` 即可。

## UI/RPC helper（纯函数）

UI/RPC 往往需要：

- 从 schema 推导“默认值快照”
- 校验局部 patch（只校验变更的 tab/key）

对应 helper：

- `collectConfigDefaults(schemaMap, { missingObjectDefault })`
- `validateConfigPatch(schemaMap, patch)`

## 关键语义

- `getValidatedConfig()` 默认用 `ctx.pluginInfo?.id` 作为 key：**只有在插件 Context 里调用才有意义**。它不会隐式回退 raw：若未 `ensureValidated(...)`，会抛错（避免静默读取未校验配置）。
- `getRawConfig(name)` 永远返回持久层原始快照（可能包含未知 key/未填充默认值），用于调试/迁移/底层实现。
- `ensureValidated(pluginName, schemaMap)` **是幂等的**：当 raw revision 未变化且 schema 稳定（同一对象引用；或 schemaMap 仅被重新创建但复用同一批 schema 引用）时，会直接返回缓存的 validated 快照（避免 loader/runtime 重复校验）。
- `patchConfig(name, patch)` 是“对某个插件名的配置快照打补丁”，用于测试/加载器模拟/持久化写入。
- `unsetConfigKeys(name, keys)` 用于“重置到默认值”的语义：先删除 key，再由 `ConfigService.ensureValidated(...)` 回填。
- `batch(run)` 在 core 中只是同步执行；runtime 子类用它合并持久化写入，不提供事务回滚语义。

## 扩展点（上层可覆盖）

如果你需要：

- 从磁盘/远端加载配置
- 支持 schema 校验、默认值、环境变量、热更新
- 把 enable/disable 变成真正的启动策略

上层运行时通过继承 `ConfigService` 并覆盖受保护的加载、可变策略与 mutation hook 增加 I/O。record/revision/validation 状态必须继续由 core 基类持有，避免出现第二套配置引擎。

当前 persistent runtime 还会把 host 提供的 `PLUXEL_CONFIG__<plugin-id>__<schema-key>[__<field>...]`
environment record 合并进初始 snapshot；这仍只是 raw record 的启动来源，校验、默认回填和 revision 全部由本 core
service 处理。已有 file config 在加载后替换启动 snapshot。

## 测试策略

优先用 core test host 走真实插件启动流程：

- 通过 `host.cfg(pluginCtor).set(record)` 构造注入快照
- 在插件里调用 `ctx.configService.getValidatedConfig()` 或读取 `this.configs.use(...)` 声明的字段并断言
