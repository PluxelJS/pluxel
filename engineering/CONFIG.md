# Config Architecture

配置链分成 declaration/validation 与宿主持久化两层：

```text
Plugin + owned PluginPart fields: configs.use(ObjectSchema)
  -> toolchain owner/path schema facts
  -> core composite defaults / validation / normalized aggregate snapshot
  -> one Plugin config record / revision / restart owner
  -> runtime persistence / patch / reset / Workbench section projection
```

## 不变量

- 每个具体 Plugin 和每个 direct `PluginPart` subclass 各自最多一个普通 class field 调用 `this.configs.use(ObjectSchema)`。
- Plugin schema 保持现有 flat root；Part schema 位于 occurrence field path。owner schema output 不能与直接 Part field 重名。
- 默认值和展示 metadata 属于同一个 schema；runtime 和业务代码不重复 fallback。
- 配置在实例构造后、`init()` 前注入；constructor 和其他 field initializer 不读取配置值。
- config metadata 是 build-time semantic fact，不是 runtime AST 推断。
- config owner 始终是 canonical `PluginNodeAddress`，内存索引使用其稳定 binary-derived index key；ConfigService 不创建或保留 Core slot，
  也不使用 Plugin name/schema key。
- core validation 不依赖文件系统或 Workbench Plane。
- raw record、revision 与 validation cache 只有 core `ConfigService` 一份；runtime 子类只增加持久化策略。
- 任意 Part config patch 都重新验证 composite record，并重启整个 owning Plugin；没有 Part config revision 或独立 persistence owner。
- static application build 固定的是 Plugin code graph 和 `configure()` resolver code，不是 resolver 的启动返回值。

## Static startup config

`defineStaticRuntime({ configure(startup) {} })` 将固定 catalog 与启动值分开。`startup` 提供 mode、env、platform bindings
和 deployment facts；resolver 每次 host startup 重新执行，可选择 persistence、ConfigService、RuntimeState、HTTP、
logging、profile 和 Workbench policy。

Static application 可以另外声明 `configEnvironmentBootstrap`。每个 direct `bindConfigEnvironment(Plugin, Schema, mapping)`
把 portable environment name 绑定到该 Plugin default node 的 raw config path；`Schema` 必须与 Plugin root
`configs.use()` 的实际对象 identity 相同。Mapping 由 `StandardSchemaV1.InferInput<Schema>` 递归推导，object 可展开或作为
JSON subtree leaf，array/tuple/record/scalar 只能作为 leaf。Binding 位于 product host，不进入 Plugin metadata、decorator 或
schema，也不扩展到 Part、fork 或 dynamic source。

Startup 在 graph construction 前读取 canonical candidate，用 `valibot-form` raw-input projector 从真实 schema node 推导唯一
`string | number | boolean | json` transport。它不执行 validation、transform、lazy/default getter，也不复制默认值、requiredness
或 custom validator。环境缺失不生成 raw path；string 空值保留，number/boolean/JSON 空值失败，JSON `null` 保持显式值。
Malformed value 的诊断只包含 environment name 和 target，不包含原始 value。

新 store 的 merge authority 固定为：

```text
configure() configService.snapshot
  < configEnvironmentBootstrap decoded seed
  < PLUXEL_CONFIG bootstrap snapshot
  < existing persisted file
```

最后一层继续由既有 `ConfigService.loadFromDisk()` 实现。Writable file 首次保存合成 seed；memory 每个新 host 重建；readonly
在没有 file 时只在当前 host 使用 seed。Binding 不是 permanent overlay，不改变 revision、patch/reset、persistence format、
Workbench presentation 或 restart graph。普通 config 仍不承载长期 secret。

Plugin config records 与 enabled state 继续由 ConfigService/RuntimeState 管理，可以在 fixed catalog 范围内修改并跨启动
持久化。production bundle 不把这些 records 烘焙成不可变常量。

Static 与 dynamic Node host 读取单一 `PLUXEL_CONFIG` 环境变量。它必须是 ConfigService v3 的完整 JSON snapshot，owner
使用结构化 Plugin node address：

```json
{
	"version": 3,
	"plugins": [
		{
			"owner": {
				"definition": {
					"entry": { "kind": "package-root", "packageName": "@acme/orders" },
					"exportName": "OrdersPlugin"
				},
				"variant": "default"
			},
			"config": { "endpoint": "https://orders.example.com", "concurrency": 8 }
		}
	]
}
```

JSON parse、snapshot version、address 或 config record 非法时启动 fail-fast。environment snapshot 覆盖 host initial snapshot
中相同 owner 的字段，并只初始化新的 config store；已有 file config 始终是权威来源。结果继续进入同一 Standard Schema
校验、raw record、revision、Workbench 与持久化链，不建立第二套 env 状态。secret 仍进入 Vault/credential contract。

file writer 用 atomic replace 持久化完整 v3 snapshot；file reader 和 `PLUXEL_CONFIG` 都只接受 v3。其他版本、非法 owner 或
重复 node record 一律 fail-fast，不从 class/display name 猜测或转换。

control-plane patch/reset/field mutation 与 fork/catalog mutation 共用 host coordinator exclusive queue。顺序固定为 validate once -> stage
normalized immutable snapshot -> flush -> confirm persisted revision -> restart addressed node 及真实 dependent closure。stage 不是已提交的内存
authority；flush 失败时未确认 revision 和 normalized snapshot 都不能被 Core generation 观察。第一次 schema validation 的 normalized output 是唯一
pre-persistence authority；写入后不得再次执行可能非确定或 throw 的 schema 并把已经改变的内存状态误报为 `unchanged`。真正 generation apply
仍在 restart/config phase 核对当前 definition facts，失败归入 `saved-not-applied`。validated snapshot 同时绑定 config record revision 与
immutable candidate config-definition identity；只有两者都匹配时 Core generation 注入才可复用，candidate replacement 不按相同 schema reference
猜测等价。

运行中的 node 重启成功返回 `applied`；node 未运行返回 `deferred`；重启失败返回 `saved-not-applied`，但已经验证并保存的 desired
record 不回滚，供显式 restart 或下次 boot 重试。fork 的 config record/revision 相互隔离，修改一个 fork 不重启 default 或 sibling。

running apply 使用 coordinator addressed-restart fast path：按 canonical node key 检查 applied node 并让 Core 处理真实 dependent closure，不扫描
catalog 或运行 full reconciler。RuntimeStateStore 返回 revision-bound immutable snapshot/cache；同一 revision 的 read 不 deep clone。readonly backend
读取既有文件但不创建缺失文件，拒绝 mutation；malformed/version error fail-fast，且不隔离或重写原文件。

RPC 输入先按 `unknown` 校验 owner address、patch object 与 field mutation。nested `fieldPath` 必须非空、有界，并拒绝 `__proto__`、
`constructor`、`prototype` 等危险 segment；非法输入返回封闭 `invalid_input` 或 `validation_failed` 且 `state: 'unchanged'`，不能触发
prototype mutation。unexpected schema/programming error 继续 reject，不能按 message 分类成 domain failure。

内存 owner lookup 和 revision cache 为 O(1)。file backend 在 200 ms 内合并 mutation，随后原子重写 O(B) 的完整 snapshot，B 是
serialized config bytes；当前契约不宣称适合无界 fork/config 基数。实测超出预算时在 backend 内升级 shard/journal/KV，不改变 identity。

## Toolchain metadata

`configSourcePlugin()` 在 TypeScript class field lowering 前验证具体 `@Plugin`/`PluginPart` 各自最多一个非 `#private`
`configs.use(ObjectSchema)` declaration，并写入 owner metadata：field name、schema 对象和可选的诊断 source。Plugin
semantic pass 同时 lower Part occurrence field path；这些 build helper 不是作者 API。

core 按 path partition raw input，分别执行 owner/Part schema default、transform 与校验，再冻结 aggregate output。Plugin field
只注入 root owner slice，每个 Part field只注入自己的 slice。runtime management API 把每个 declaration 编译成带 path、defaults
和可移植 field node 的 version 1 presentation plan；无法表达的 node 显式成为 read-only `unsupported`，浏览器不执行 schema source。
Workbench 可以按 General/Part sections 编辑，但提交、持久化和 server validation 仍指向同一个 Plugin node owner。
Workbench Plane 不拥有配置事实，也不恢复 layout/template DSL。

schema normalized output 必须是可持久化、无环的 plain object/array tree；leaf 只允许 JSON-compatible primitive。Core 在接受 snapshot
前 deep clone 并 deep freeze，拒绝 `Date`、`Map`、`Set`、class instance、function、symbol、accessor、cycle 与其他带隐藏 identity/behavior 的
value。这样 config revision 才能安全跨 persistence、RPC、Workbench 与 generation boundary，不把 schema library 的临时对象变成运行时权威。

control-plane query 返回当前 raw `config` 与 `defaults`，并以 `saved: false` 和当前 `applied | deferred | saved-not-applied` application
状态表达 desired/applied revision 关系。成功 mutation
只返回已确认持久化的 `config`、application 状态与 apply report，不重复携带 defaults；`validation_failed.defaults` 仅在 defaults 能独立安全
计算时出现。调用者必须按 discriminant 分支，不能假设所有 `ConfigResult` 都有 defaults。

## 实现入口

- `packages/core/src/services/config/`
- `packages/core/src/plugins/composition/PluginConfigs.ts`
- `packages/core/src/plugins/runtime/definition.ts`
- `packages/runtime/src/services/ConfigService.ts`
- `packages/runtime/src/services/config-environment.ts`
- `packages/runtime-static/src/config-environment.ts`
- `packages/valibot-form/src/core/rawInput.ts`
- `packages/runtime/src/api/usecases/pluginConfig.ts`
- `packages/rolldown/src/rolldown/plugins/configSourcePlugin.ts`
- `packages/rolldown/src/rolldown/plugins/staticConfigEnvironment.ts`
- `packages/rolldown/src/cli/static-config-environment-output.ts`
- `packages/runtime/docs/config/contract.md`

作者用法见 [`docs/getting-started/configuration.md`](../docs/getting-started/configuration.md#声明规则)。
