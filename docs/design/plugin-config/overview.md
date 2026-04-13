# Plugin Config + Doc Design

## Decision

采用两层、单向依赖的设计：

- 启动前配置声明（唯一推荐）：`this.configs.use(cfg(schemaMap))`（可选：附带 cfg layout）
- 纯 schema（单 key）：`this.configs.use(schema)`（等价于单 key 的 cfg 声明）
- 运行期 doc（统一入口）：`this.ctx.ext.ui.builtin.doc({ content: doc(schemaMap)\`...\` })`

规则：

- `cfg(schemaMap)` 是**静态可提取子集**
- `doc(schemaMap)\`...\`` 是**运行期超集**
- AST / rolldown 插件**只分析启动前配置声明**（`cfg(schemaMap)` 以及 `this.configs.use(schema)` / `@Config(schema)` 这类静态 schema 声明）

不要反过来让 `doc(...)` 承担启动前 schema 提取。

## API

### 1. `cfg(schemaMap)`

`cfg(schemaMap)` 只服务启动前配置注入与 schema 提取（以及可选的“配置页排版”静态 layout）。

推荐写法（schema 与 cfg 内容拆开）：

```ts
const schemas = {
	display: DisplaySchema,
	auth: AuthSchema,
} as const

settings = this.configs.use(cfg(schemas))
```

也支持附带一段纯静态 markdown（用于说明或控制配置页排版；允许插入**受限 token**以获得 schema key 的类型提示）：

```ts
const c = cfg(schemas)

settings = this.configs.use(c`
  # Runtime
  - display: UI 刷新频率
  - auth: 认证信息
`)
```

### cfg layout：用 schema key 掌控配置页排版

cfg layout 是一段“纯静态、可提取”的 markdown 排版描述，允许你把配置表单放进 markdown 的任意位置（无回调）。

唯一推荐写法：用 `cfg(schemaMap)` 的 builder token（有 TS key 补全）：

```ts
const schemas = {
	display: DisplaySchema,
	auth: AuthSchema,
} as const

const c = cfg(schemas)

settings = this.configs.use(c`
# 基础
${c.schema('display')}

# 认证
${c.schema('auth')}

${c.schemas()}
`)
```

支持的 token：

- `c.schema(key)`：放置单个 schema key 的配置表单
- `c.schemas(...keys)`：按顺序放置多个 key
- `c.schemas()`：放置所有“尚未放置”的 key（推荐末尾放一个避免漏项）

约束：

- 同一个 schema key 不能重复放置
- `c.schemas()` 只能出现一次，且必须是最后一个 schema-placement token

若 cfg layout 未覆盖所有 key，Host UI 会把剩余 key 追加到页面末尾的 `Unplaced Schemas` 区域，确保仍可编辑。

也允许单 schema 的快捷写法：

```ts
foo = this.configs.use(FooSchema)
```

读取：

```ts
this.settings.display.refreshMs
this.settings.auth.username
```

### 2. `doc(schemaMap)\`...\``

`doc(schemaMap)\`...\`` 是运行期 builtin doc 的统一入口（强制显式传入 schemaMap 以获得类型约束）。

允许：

- markdown
- `d.card(...)`
- 直接插入运行期字符串（`${someString}`）会被当作 markdown 片段拼接进去
- `d.schema(key)` / `d.schemas(...keys)`：把配置表单嵌入到 markdown 的任意位置（有 TS key 补全）
- 其他运行期 builtin（如 `docHandle.form(...)` / `docHandle.action(...)`，来自 signaldb doc handle）

不允许：

- 非字符串 primitive 插值（如 number / boolean / null）
- 重复放置同一个 schema key
- 在 `d.schemas()` 之后继续放置 `d.schema(...)` / `d.schemas(...)`

示例：

```ts
init() {
	const schemas = {
		display: DisplaySchema,
		auth: AuthSchema,
	} as const
	const d = doc(schemas)

	this.ctx.ext.ui.builtin.doc({
		id: 'runtime',
		point: 'plugin:tabs',
		title: 'Runtime',
		content: d`
		# Runtime

		## Display
		${d.schema('display')}
		`,
	})
}
```

这里：

- `doc(schemaMap)` 返回一个带类型约束的 doc builder：`d.schema('display')` 的 key 只能来自 schemaMap（运行时也会校验 key 是否存在）
- `d.schema('display')` 只引用已在启动前声明里声明的 config key（否则 Host 无法渲染该表单）

## Static Rules

`this.configs.use(cfg(schemaMap))` 必须满足：

- 写在 class field initializer 上
- schemaMap 表达式可静态解析
- schema key 稳定且唯一

rolldown 仅支持：

- class field initializer
- module-scope const 间接引用
- 同文件的 static class field 间接引用（`static c = cfg(...)` / `static c = cfg(...)\`...\``）
- 跨文件导入的 schemaMap const（`import { schemas } from './schemas'`；要求导出为对象字面量、无 spread、无 computed key）
- imported schema identifier
- inline schema expression

不支持：

- `init()` 里构造 `cfg(...)`
- 条件分支里声明 schema
- closure / callback / runtime object 混入 `cfg`

核心约束：

**插件启动前的 `this.configs.use(...)` 必须是静态可提取声明：使用 `cfg(schemaMap)`，也允许 `this.configs.use(schema)` 这种单 schema 的快捷写法。**

## Type Model

`this.configs.use(cfg(schemaMap))` 的返回类型只由 `schemaMap` 决定：`{ [K in keyof schemaMap]: InferOutput<schemaMap[K]> }`。

补充：

- Host / runtime 实现 contract 见 `packages/runtime/docs/config/contract.md`。

## Summary

一句话：

**配置声明和启动前注入走 `cfg(schemaMap)`，运行期展示走 `doc(schemaMap)\`...\``；AST 只分析启动前的静态 `cfg(...)`。**
