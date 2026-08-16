# Config Architecture

配置链分成 declaration/validation 与宿主持久化两层：

```text
Plugin class field: configs.use(ObjectSchema)
  -> toolchain single-schema facts
  -> core defaults / validation / normalized snapshot
  -> runtime persistence / patch / reset / Workbench projection
```

## 不变量

- 每个具体 Plugin 最多一个普通 class field 调用 `this.configs.use(ObjectSchema)`；相关 section 使用 schema 的嵌套对象表达。
- 默认值和展示 metadata 属于同一个 schema；runtime 和业务代码不重复 fallback。
- 配置在实例构造后、`init()` 前注入；constructor 和其他 field initializer 不读取配置值。
- config metadata 是 build-time semantic fact，不是 runtime AST 推断。
- config owner 是 interned `PluginNodeSlot`；跨边界使用 `PluginNodeAddressSnapshot`，不使用 Plugin name/schema key。
- core validation 不依赖文件系统或 Workbench Plane。
- raw record、revision 与 validation cache 只有 core `ConfigService` 一份；runtime 子类只增加持久化策略。
- static application build 固定的是 Plugin code graph 和 `configure()` resolver code，不是 resolver 的启动返回值。

## Static startup config

`defineStaticRuntime({ configure(startup) {} })` 将固定 catalog 与启动值分开。`startup` 提供 mode、env、platform bindings
和 deployment facts；resolver 每次 host startup 重新执行，可选择 persistence、ConfigService、RuntimeState、HTTP、
logging、profile 和 Workbench policy。

Plugin config records 与 enabled state 继续由 ConfigService/RuntimeState 管理，可以在 fixed catalog 范围内修改并跨启动
持久化。production bundle 不把这些 records 烘焙成不可变常量。

Static 与 dynamic Node host 读取单一 `PLUXEL_CONFIG` 环境变量。它必须是 ConfigService v2 的完整 JSON snapshot，owner
使用结构化 Plugin node address：

```json
{
	"version": 2,
	"plugins": [
		{
			"owner": {
				"definition": {
					"entry": { "kind": "package-root", "packageName": "@acme/orders" },
					"exportName": "OrdersPlugin"
				},
				"instance": "default"
			},
			"config": { "endpoint": "https://orders.example.com", "concurrency": 8 }
		}
	]
}
```

JSON parse、snapshot version、address 或 config record 非法时启动 fail-fast。environment snapshot 覆盖 host initial snapshot
中相同 owner 的字段，并只初始化新的 config store；已有 file config 始终是权威来源。结果继续进入同一 Standard Schema
校验、raw record、revision、Workbench 与持久化链，不建立第二套 env 状态。secret 仍进入 Vault/credential contract。

## Toolchain metadata

`configSourcePlugin()` 在 TypeScript class field lowering 前验证具体 `@Plugin` 最多一个非 `#private`
`configs.use(ObjectSchema)` declaration，并通过 `@pluxel/runtime/toolchain` 写入 definition metadata：field name、schema
对象和可选 schema source。该 subpath 不是作者 API。

runtime 将同一个 schema 投影为 host/UI 所需的 field name、source、defaults 与 validation。Workbench Plane 只是其中一个
消费者，不拥有配置事实，也不恢复 layout/template DSL。

## 实现入口

- `packages/core/src/services/config/`
- `packages/core/src/plugins/composition/ConfigHost.ts`
- `packages/core/src/plugins/runtime/definition.ts`
- `packages/runtime/src/services/ConfigService.ts`
- `packages/runtime/src/services/config-environment.ts`
- `packages/runtime/src/api/usecases/pluginConfig.ts`
- `packages/rolldown/src/rolldown/plugins/configSourcePlugin.ts`
- `packages/runtime/docs/config/contract.md`

作者用法见 [`user-docs/plugin-authoring.md`](../user-docs/plugin-authoring.md#配置声明一次只读取归一化结果)。
