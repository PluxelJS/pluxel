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

## Presentation result

Host 通过 `RuntimeManagementClient.config.presentation(owner)` 查询结构化 `PluginNodeAddress`。成功结果是 versioned、
serializable plan：

```ts
{
	ok: true
	plan: {
		version: 1
		fieldName: string
		defaults: Record<string, JSONValue>
		fields: readonly ConfigPresentationFieldV1[]
		sections: readonly {
			path: readonly string[]
			fieldName: string
			defaults: Record<string, JSONValue>
			fields: readonly ConfigPresentationFieldV1[]
		}[]
	}
}
```

`fieldName` 是工具链验证过的声明 field；`fields` 只包含可移植的 field kind、path、约束和 presentation hint；`defaults` 是
normalized JSON snapshot。Host 不执行 schema source、`new Function()` 或官方 Mantine renderer。无法无损表示的 schema node
投影为显式 read-only `unsupported` field；server schema 仍是 validation/default/transform 的唯一权威。

`sections` 包含 root owner（空 path）和拥有 config declaration 的 Part path。宿主可以选择 tabs 或其他布局，但所有 patch、
persistence、revision 和 restart 仍指向同一个 Plugin node owner。

## Build metadata flow

`configSourcePlugin()` 在 TypeScript class field lowering 前：

1. 识别具体 `@Plugin`/`PluginPart` 的 `this.configs.use(ObjectSchema)`；
2. 拒绝 `#private` field、非 object schema 和同一 owner class 的第二次声明；
3. 注入 Plugin/Part config facts，并从 `parts.use()` facts 建立 occurrence path；
4. core 在实例构造后、任何 `init()` 前按 node slot 校验 aggregate，并向每个 owner 注入 normalized slice；
5. runtime control plane 使用同一 schema 完成 defaults、validate、patch、field patch 和 reset。

Config record owner 始终是 canonical node address；Core materialization 使用 slot，但 Config/HTTP/RPC/file/environment lookup
不为读取创建或保留 slot。Workbench 只渲染这个事实，不拥有另一份 config layout 或 validation engine。
