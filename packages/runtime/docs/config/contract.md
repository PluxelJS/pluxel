# Plugin Config (Runtime Contract)

这份文档描述 runtime 与 host/UI 的 Plugin config contract。作者声明见
[`../../../../docs/getting-started/configuration.md`](../../../../docs/getting-started/configuration.md#声明规则)，架构不变量见
[`../../../../engineering/CONFIG.md`](../../../../engineering/CONFIG.md)。

## Author fact

每个具体 Plugin 和每个 direct `PluginPart` subclass 各自最多一个普通 class field：

```ts
private readonly config = this.configs.use(PluginConfig)
```

参数必须是完整 object schema。Part config 位于 occurrence field path；raw/config revision/persistence/restart owner 仍只有 owning
Plugin 一个。runtime 不接受额外 namespace、binding/layout map 或 template DSL。

## `pluginSchema()` result

Host 用结构化 `PluginNodeAddressSnapshot` 查询 owner。成功结果为：

```ts
{
	ok: true
	fieldName: string
	schemaSource: string
	defaults: Record<string, unknown>
	sections: readonly {
		path: readonly string[]
		fieldName: string
		schemaSource: string
		defaults: Record<string, unknown>
	}[]
}
```

`fieldName` 是工具链验证过的声明 field；`schemaSource` 用于当前 Workbench renderer；`defaults` 是完整 object schema 的
normalized default snapshot。Plugin 没有 schema 或 source 未由 toolchain 注入时返回稳定的失败 code，不从 runtime AST
或旧 metadata map 猜测。

`sections` 包含 root owner（空 path）和拥有 config declaration 的 Part path。Workbench 用它渲染 tabs；`schemaSource` 与
`defaults` 仍是完整 aggregate，供旧 consumer/诊断和 server-authoritative record 使用。

## Build metadata flow

`configSourcePlugin()` 在 TypeScript class field lowering 前：

1. 识别具体 `@Plugin`/`PluginPart` 的 `this.configs.use(ObjectSchema)`；
2. 拒绝 `#private` field、非 object schema 和同一 owner class 的第二次声明；
3. 注入 Plugin/Part config facts，并从 `parts.use()` facts 建立 occurrence path；
4. core 在实例构造后、任何 `init()` 前按 node slot 校验 aggregate，并向每个 owner 注入 normalized slice；
5. runtime control plane 使用同一 schema 完成 defaults、validate、patch、field patch 和 reset。

Config record owner 始终是 interned node slot；HTTP/RPC、file 与 environment boundary 使用结构化 node address。Workbench
只渲染这个事实，不拥有另一份 config layout 或 validation engine。
