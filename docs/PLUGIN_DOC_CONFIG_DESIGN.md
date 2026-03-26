# Plugin Config + Doc Design

## Decision

采用两层、单向依赖的设计：

- 启动前配置声明：`this.configs.use(cfg\`\`)`
- 运行期 doc 扩展：`this.ctx.ext.ui.doc(doc\`\`)`

规则：

- `cfg\`\`` 是**静态可提取子集**
- `doc\`\`` 是**运行期超集**
- AST / rolldown 插件**只分析 `cfg\`\``**

不要反过来让 `doc\`\`` 承担启动前 schema 提取。

## API

### 1. `cfg\`\``

`cfg\`\`` 只服务启动前配置注入。

允许：

- markdown
- `cfg.card(...)`
- `cfg.config({ key: Schema })`

不允许：

- `doc.form(...)`
- `doc.action(...)`
- callback
- 任何依赖运行时结果的动态拼装

示例：

```ts
settings = this.configs.use(cfg`
	# Runtime

	${cfg.card({
		rows: [{ label: 'Mode', value: 'normal' }],
	})}

	${cfg.config({
		display: DisplaySchema,
		auth: AuthSchema,
	})}
`)
```

读取：

```ts
this.settings.display.refreshMs
this.settings.auth.username
```

### 2. `doc\`\``

`doc\`\`` 是运行期 builtin doc 的统一入口。

允许：

- markdown
- `doc.card(...)`
- `doc.config(key)`
- `doc.form(...)`
- `doc.action(...)`

示例：

```ts
init() {
	this.ctx.ext.ui.doc(doc`
		# Runtime

		${doc.config('display')}

		${doc.form({
			id: 'reset-runtime',
			schema: ResetSchema,
			handler: 'resetRuntime',
			submitLabel: 'Reset',
		})}

		${doc.action({
			id: 'pause-runtime',
			label: 'Pause',
			handler: 'pauseRuntime',
		})}
	`)
}
```

这里：

- `doc.config('display')` 只引用已在 `cfg.config(...)` 里声明的 config group
- `doc.form(...)` 是运行期表单动作
- `doc.action(...)` 是运行期无参动作

## Static Rules

`this.configs.use(cfg\`\`)` 必须满足：

- 写在 class field initializer 上
- 内容静态可提取
- schema key 稳定且唯一
- schema 表达式可静态解析

rolldown 仅支持：

- class field initializer
- module-scope const 间接引用
- imported schema identifier
- inline schema expression

不支持：

- `init()` 里构造 `cfg`
- 条件分支里声明 schema
- closure / callback / runtime object 混入 `cfg`

核心约束：

**插件启动前的 `this.configs.use(...)` 只接收静态 `cfg\`\``。**

## Runtime Rules

`doc\`\`` 只在运行期注册，因此可以承载静态能力的超集。

### `doc.config(key)`

- 只引用已声明 config key
- 不重新声明 schema
- 用于把配置表单渲染到 doc 中某个位置

### `doc.form(...)`

- 有输入的运行期动作
- 自带 schema，用于本次提交的渲染与校验
- 不进入插件持久 config snapshot
- 提交后按 `handler` 路由到插件实例方法

### `doc.action(...)`

- 无输入的运行期动作
- 不持有表单 state
- 触发后按 `handler` 路由到插件实例方法

## Build-Time Responsibilities

构建期只围绕 `cfg\`\`` 提取 metadata：

1. config schema map
2. schema source
3. 静态 cfg 内容

注入接口建议保持分离：

- `__registerCfgSchemas__(Ctor, field, schemaMap)`
- `__setCfgSource__(Ctor, field, normalizedSource)`
- `__registerCfgBuiltinDoc__(Ctor, field, builtinDocContent)`

`doc\`\`` 不进入启动前 AST 提取链路。

## Runtime Responsibilities

### Pre-start

在插件 `init()` 前：

- 读取 `cfg` metadata
- 汇总 `cfg.config(...)` 得到 schema map
- `ensureValidated(...)`
- 填充 defaults
- 注入到 `this.configs.use(cfg\`\`)` 返回字段

### Post-start

插件启动后：

- runtime 可自动注册 `cfg` 内的静态 builtin doc
- 插件可继续通过 `this.ctx.ext.ui.doc(doc\`\`)` 注册运行期 doc

### Dynamic dispatch

运行期仅处理 `doc.form(...)` / `doc.action(...)`：

- `doc.form(...)`：校验输入后调用 handler
- `doc.action(...)`：直接调用 handler

## Type Model

`this.configs.use(cfg\`\`)` 的返回类型只由 `cfg.config(...)` 决定。

例如：

```ts
settings = this.configs.use(cfg`
	${cfg.config({
		display: DisplaySchema,
		auth: AuthSchema,
	})}
`)
```

则返回：

```ts
{
	display: InferOutput<typeof DisplaySchema>
	auth: InferOutput<typeof AuthSchema>
}
```

以下内容不影响返回类型：

- markdown
- `cfg.card(...)`
- 运行期 `doc.form(...)`
- 运行期 `doc.action(...)`

## Preferred Path

推荐写法只有这一条：

- 配置声明：`this.configs.use(cfg\`\`)`
- 运行期 doc：`this.ctx.ext.ui.doc(doc\`\`)`
- 配置引用：`doc.config(key)`
- 运行期交互：`doc.form(...)` / `doc.action(...)`

不要：

- 用 `doc\`\`` 做启动前 schema declaration
- 把动态交互塞进 `this.configs.use(...)`
- 在运行期重复声明 config schema

## Summary

一句话：

**配置声明和启动前注入走 `cfg`，运行期展示与动作走 `doc`；AST 只分析静态 `cfg`。**
