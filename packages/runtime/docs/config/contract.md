# Plugin Config (Runtime Contract)

这份文档描述的是 **runtime 与 host/UI** 在“插件配置”上的实现契约；设计原则与推荐写法见仓库级设计文档 `docs/design/plugin-config/overview.md`。

## `plugin.schema()` 返回值

Host 通过 `plugin.schema()` 获取：

- `schemaSource: Record<schemaKey, string>`
  Valibot schema 的源码字符串（供 UI/调试展示等）。
- `defaults: Record<schemaKey, unknown>`
  Schema 归一化后的默认值快照。
- `layout?: BuiltinMarkdownPart[] | null`
  可选的 cfg layout parts，用于 Host 侧自定义配置页排版。

`layout` 是构建期从 `this.configs.use(cfg(schemaMap)\`...\`)` 提取并注入的；未提供时 Host 使用默认布局。

## Build Metadata Flow

构建期 `configSourcePlugin` 只分析启动前静态声明，并注入：

- `__setConfigSource__(Ctor, key, schemaSource)`
- `__registerConfigSchema__(Ctor, key, schema)`
- `__registerConfigBinding__(Ctor, field, keys)`
- `__setConfigLayout__(Ctor, field, layoutParts)`

core 快照把这些 metadata 组织到 `configSourceMap / configBindingsMap / configLayoutMap`。
runtime 的 `plugin.schema()` 再把 Host 真正需要的部分整理成：

- `schemaSource`
- `defaults`
- `layout`

如果存在多个 layout 绑定，runtime 会优先选择“覆盖全部 schema keys”的那个绑定；否则退回到确定性的首个绑定。

## `layout` parts

`BuiltinMarkdownPart` 只有 3 种：

- `{ kind: 'md', text }`：纯静态 markdown 文本片段
- `{ kind: 'schema', key }`：渲染单个 `schemaKey` 的配置表单
- `{ kind: 'schemas', keys: string[] | null }`：
  - `keys: string[]`：按顺序渲染指定 keys
  - `keys: null`：渲染“剩余未放置”的 keys（推荐在末尾放一个避免漏项）

约束：

- 同一个 schema key 不能重复放置
- `schemas()` 只能出现一次，且必须是最后一个 schema-placement token

Host 渲染时应跟踪“已放置 key”，并把未放置的 key 追加到页面末尾（例如 `Unplaced Schemas`），保证配置始终可编辑。

## Builtin Doc 里的 `schema/schemas`

运行期 builtin doc 的 markdown layout 也复用同一套 `{ kind: 'schema' | 'schemas' }` 语义，
仅用于“在文档里嵌入配置表单”。doc 本身不参与启动前 schema 提取。
