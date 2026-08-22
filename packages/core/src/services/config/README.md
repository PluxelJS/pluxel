# ConfigService（Core）设计说明

## 目标

`ConfigService` 是唯一的内存配置引擎：按 canonical `PluginNodeAddress` index key 保存 raw record 与 revision，在 Plugin `init()` 前
校验完整 object schema、回填默认值并缓存 normalized snapshot。

Plugin 只用一个普通 class field 声明配置：

```ts
private readonly config = this.configs.use(PluginConfig)
```

工具链将 field name、Standard Schema 对象和可选 source 注册到 Plugin definition facts。Core 负责注入时机和校验；runtime
子类只增加 persistence load/save、readonly policy 与 write coalescing，不复制 record、revision 或 validation 状态。

## Schema contract

`ConfigService.ensureValidated(address, authority, options)` 接受携带 Standard Schema v1 的 immutable config-definition authority。
每个具体 Plugin 最多一个 object schema；嵌套对象表达 section 和层级，不存在额外 schema-key namespace、binding map 或 layout template。

纯函数 helper：

- `collectConfigDefaults(schema, { missingObjectDefault })`：取得完整 object defaults；
- `validateConfigRecord(schema, record)`：校验并返回 normalized object。

schema output 必须是可持久化的 plain object/array tree，leaf 只允许 JSON-compatible primitive。validation boundary 会 deep clone、
deep freeze 并拒绝 cycle、accessor、`Date`、`Map`、`Set`、class instance、function、symbol 等携带隐藏 identity 或 behavior 的值；缓存和
generation 只读取这份 immutable snapshot。

## 关键语义

- owner 是 `ctx.pluginInfo.nodeAddress` 或 control plane 提交的 canonical `PluginNodeAddress`；ConfigService 不 intern Core slot，
  因此 disabled definition/fork 的 durable config 不会创建 Core tombstone。
- `getValidatedConfig(address, authority)` 不回退 raw；revision 或 candidate authority 不匹配、或未先完成 validation 时抛错。
- `getRawConfig(address)` 返回持久层 raw snapshot，用于 runtime control plane。
- `ensureValidated(address, authority)` 只在 raw revision 与 immutable candidate authority 都未变化时复用 cache。
- control plane 第一次校验成功后先 stage normalized desired record 与 validated snapshot，persistence flush 成功后才 confirm 为新的
  revision；随后 Core generation 注入复用同一对象，不再次执行可能非确定的 schema transform。confirm 同时检查校验前 revision，拒绝覆盖
  并发的新 record；flush 失败的 staged revision 对 Core 不可见。
- `patchConfig(address, patch)` 与 `unsetConfigKeys(address, keys)` 修改同一个 owner record；`batch()` 只用于 runtime 合并持久化写入，
  不承诺事务回滚。
- config sentinel 在实例构造后、`init()` 前替换；constructor 和其他 field initializer 不得读取它。

## Runtime adapter

runtime 可以从 disk/readonly backend 或 host snapshot初始化 records。Node host 的 environment 入口是单一
`PLUXEL_CONFIG` JSON，其中当前 writer 使用 `version: 3`、`plugins[]` 的 `owner` 是结构化 `PluginNodeAddress`，`config` 是一个
object record。已有 file config 是权威来源；environment 只初始化新 store。reader 只接受 v3，不按旧 owner shape 猜测或迁移。

## 测试策略

优先用经过 semantic lowering 的 core/runtime test host 走真实 Plugin 启动流程：通过 `host.cfg(PluginCtor)` 设置 config，
并在 `init()` 或之后读取声明 field。另行覆盖 invalid schema、defaults、cache revision、structured owner isolation 与 runtime
persistence；所有路径都消费同一个 lowered object-schema fact。
