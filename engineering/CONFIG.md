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
- config owner 是 interned `PluginNodeSlot`；跨边界使用 `PluginNodeAddress`，不使用 Plugin name/schema key。
- core validation 不依赖文件系统或 Workbench Plane。
- raw record、revision 与 validation cache 只有 core `ConfigService` 一份；runtime 子类只增加持久化策略。
- 任意 Part config patch 都重新验证 composite record，并重启整个 owning Plugin；没有 Part config revision 或独立 persistence owner。
- static application build 固定的是 Plugin code graph 和 `configure()` resolver code，不是 resolver 的启动返回值。

## Static startup config

`defineStaticRuntime({ configure(startup) {} })` 将固定 catalog 与启动值分开。`startup` 提供 mode、env、platform bindings
和 deployment facts；resolver 每次 host startup 重新执行，可选择 persistence、ConfigService、RuntimeState、HTTP、
logging、profile 和 Workbench policy。

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

control-plane patch 的顺序固定为 validate -> 保存 desired record -> flush -> restart addressed node 及真实 dependent closure。
运行中的 node 重启成功返回 `applied`；node 未运行返回 `deferred`；重启失败返回 `saved-not-applied`，但已经验证并保存的 desired
record 不回滚，供显式 restart 或下次 boot 重试。fork 的 config record/revision 相互隔离，修改一个 fork 不重启 default 或 sibling。

内存 owner lookup 和 revision cache 为 O(1)。file backend 在 200 ms 内合并 mutation，随后原子重写 O(B) 的完整 snapshot，B 是
serialized config bytes；当前契约不宣称适合无界 fork/config 基数。实测超出预算时在 backend 内升级 shard/journal/KV，不改变 identity。

## Toolchain metadata

`configSourcePlugin()` 在 TypeScript class field lowering 前验证具体 `@Plugin`/`PluginPart` 各自最多一个非 `#private`
`configs.use(ObjectSchema)` declaration，并写入 owner metadata：field name、schema 对象和可选 schema source。Plugin
semantic pass 同时 lower Part occurrence field path；这些 build helper 不是作者 API。

core 按 path partition raw input，分别执行 owner/Part schema default、transform 与校验，再冻结 aggregate output。Plugin field
只注入 root owner slice，每个 Part field只注入自己的 slice。runtime API 额外返回每个 declaration 的 path/source/defaults；
Workbench 以 General/Part tabs 编辑这些 section，但提交、持久化和 server validation 仍指向同一个 Plugin node owner。
Workbench Plane 不拥有配置事实，也不恢复 layout/template DSL。

## 实现入口

- `packages/core/src/services/config/`
- `packages/core/src/plugins/composition/ConfigHost.ts`
- `packages/core/src/plugins/runtime/definition.ts`
- `packages/runtime/src/services/ConfigService.ts`
- `packages/runtime/src/services/config-environment.ts`
- `packages/runtime/src/api/usecases/pluginConfig.ts`
- `packages/rolldown/src/rolldown/plugins/configSourcePlugin.ts`
- `packages/runtime/docs/config/contract.md`

作者用法见 [`docs/getting-started/configuration.md`](../docs/getting-started/configuration.md#声明规则)。
