# ConfigService（Core）设计说明

## 目标

`ConfigService` 是唯一的内存配置引擎：按 interned `PluginNodeSlot` 保存 raw record 与 revision，在 Plugin `init()` 前
校验完整 object schema、回填默认值并缓存 normalized snapshot。

Plugin 只用一个普通 class field 声明配置：

```ts
private readonly config = this.configs.use(PluginConfig)
```

工具链将 field name、Standard Schema 对象和可选 source 注册到 Plugin definition facts。Core 负责注入时机和校验；runtime
子类只增加 persistence load/save、readonly policy 与 write coalescing，不复制 record、revision 或 validation 状态。

## Schema contract

`ConfigService.ensureValidated(slot, schema, options)` 只接受 Standard Schema v1。每个具体 Plugin 最多一个 object schema；
嵌套对象表达 section 和层级，不存在额外 schema-key namespace、binding map 或 layout template。

纯函数 helper：

- `collectConfigDefaults(schema, { missingObjectDefault })`：取得完整 object defaults；
- `validateConfigRecord(schema, record)`：校验并返回 normalized object。

## 关键语义

- owner 来自 `ctx.pluginInfo.nodeAddress` intern 后的 `PluginNodeSlot`；不使用 Plugin name、displayName 或 constructor key。
- `getValidatedConfig(slot)` 不回退 raw；未先 `ensureValidated()` 时抛错。
- `getRawConfig(slot)` 返回持久层 raw snapshot，用于 runtime control plane。
- `ensureValidated(slot, schema)` 在 raw revision 和 schema reference 未变化时复用 cache。
- `patchConfig(slot, patch)` 与 `unsetConfigKeys(slot, keys)` 修改同一个 owner record；`batch()` 只用于 runtime 合并持久化写入，
  不承诺事务回滚。
- config sentinel 在实例构造后、`init()` 前替换；constructor 和其他 field initializer 不得读取它。

## Runtime adapter

runtime 可以从 disk/readonly backend 或 host snapshot初始化 records。Node host 的 environment 入口是单一
`PLUXEL_CONFIG` JSON，其中当前 writer 使用 `version: 3`、`plugins[]` 的 `owner` 是结构化 `PluginNodeAddress`，`config` 是一个
object record。已有 file config 是权威来源；environment 只初始化新 store。runtime migration reader 可确定性读取 v2
`{ source, instance }` owner，file backend 随后原子写回 v3。

## 测试策略

优先用经过 semantic lowering 的 core/runtime test host 走真实 Plugin 启动流程：通过 `host.cfg(PluginCtor)` 设置 config，
并在 `init()` 或之后读取声明 field。另行覆盖 invalid schema、defaults、cache revision、structured owner isolation 与 runtime
persistence；所有路径都消费同一个 lowered object-schema fact。
