# Agent RPC、沙盒执行与 Commands 重设计提案

状态：待评审，未实现。日期：2026-09-24。

本提案允许破坏兼容，不要求保留 AgentTools、旧 Pi 集成或旧 Command 作者 API。
它不改变当前工程文档的权威，也不授权立即删除实现。文中的新接口是设计契约示例，尚不能在仓库运行。

## 1. 决策摘要

Command 是一个带稳定名称、说明、输入契约和校验执行入口的操作定义。它可以成为 CLI、聊天命令、
LLM tool 和 RPC 方法的共同来源；不因适配多个接收者而膨胀成管理所有业务函数的框架。

```text
领域实现
  ├─ Command（一次定义操作）
  │    ├─ toCli / 聊天 carrier → 人类命令
  │    ├─ 框架 tool adapter / toMcp → 精选原生 LLM tools
  │    └─ toCapnweb({ methods }) → 原生 RpcTarget class
  │                                      ↓
  └─ 原生 RpcTarget ──────────────→ 嵌套能力对象树
                                         ↓
                             受限会话 → 沙盒程序 → Agent
```

1. Command 内核保留 name、description、input、execute、输入校验和类型推导；不内置模型 SDK 或 transport。
2. 删除核心 `behavior`、`output`、`validateOutput` 及 output codec/examples；输入和正常返回值保留。
3. 平台提示、协议结果与输出投影由 adapter 拥有；含义相同的结果定义共享一份引用。
4. Command 可以直接作为各框架 LLM tool 的定义来源，不必先变成 MCP 或 RPC；具体 SDK 调用约定仍需薄适配。
5. `toCapnweb()` 将一组 Command 组成真正的原生 RpcTarget class，实例绑定可信上下文；不重复写 RPC handler。
6. 生成 class 可嵌入或扩展为原生能力树：Command 方法返回数据，原生方法显式返回子能力，保留原生 promise pipelining。
7. 授权选择用途明确的对象树，撤销约束覆盖所有子对象；不能只保护根对象或靠文档隐藏方法。
8. 复杂任务采用发现加沙盒编程；少量操作采用原生 tools。所有出口显式选择，不全量自动暴露。
9. 删除旧 AgentTools/Toolset 主链；保留插件生命周期基础设施，HTTP batch 边界显式化。

操作定义、对象组合、传输接入各有一个所有者。不为同一操作同时维护 Command handler、RPC handler 和 tool handler。

### 1.1 信息只声明一次，适配是纯函数派生

同一语义只有一个作者源。适配器引用基础定义，追加自己拥有的事实，不复制一套 name/description/input/handler，
也不使用后写覆盖前写的 metadata merge。生成的 schema、help、MCP description 和 `.d.ts` 是可重建投影，不是新权威。

| 信息                                       | 唯一来源                             | 派生方式                                  |
| ------------------------------------------ | ------------------------------------ | ----------------------------------------- |
| 命令逻辑名称、业务说明、输入契约、执行函数 | defineCommand 的基础定义             | CLI、聊天、LLM、RPC view 引用同一 command |
| CLI 路由、别名、位置参数与显示方式         | CLI view                             | parser/help 从 binding 生成               |
| MCP annotations 与模型操作提示             | MCP view                             | 追加到继承的业务说明，不覆盖说明          |
| 多出口确实相同的 JSON DTO/schema/project   | 一个普通的共享结果定义               | CLI JSON/LLM/RPC 数据结果引用同一对象     |
| 生成 RPC 方法的说明、参数和实现            | 源 Command 与共享结果定义            | toCapnweb 派生方法与文档                  |
| RPC 成员放置位置                           | toCapnweb 的对象成员键或原生类方法名 | 接口路径，不冒充源 Command 的 identity    |
| 原生 RPC 方法签名、方法说明                | 原生 RpcTarget 方法与 JSDoc          | 类型文档/发现制品由工具链提取             |
| RPC 对象用途说明                           | target class 的 JSDoc                | publication/发现页面读取生成制品          |
| RPC 发现别名、实例创建与所有权             | publication                          | 不从 class name 猜稳定身份                |

追加函数属于对应适配器：`toCli`/`toMcp` 返回不可变消费 view，`toCapnweb` 返回原生 target class；
它们保留源 command 引用和类型，不修改源对象、不注册服务、不执行 handler。`bind()`/`expose()` 才拥有副作用和 disposer。
基础定义不需要知道这些追加函数存在，也不需要通用 `.extend()`、插件化 metadata 容器或全局装饰器注册表。
不同平台从同一个源分支派生，不要求 `toMcp(toCli(...))` 这种无意义的跨平台叠加。

平台选项不再次接受相同语义的 `name`/`description`/`input`/`execute`。确有命名空间冲突时，可以显式指定
`exportAs` 作为外部协议别名；这不是第二个业务身份。默认优先保留合法原名，必要时用确定性编码派生，冲突在 bind 时拒绝。
CLI 的 `notes search` 是用户输入语法而非重复声明 command identity，因此仍留在 CLI view。

## 2. 已核对的当前事实

以下是本次源码核对结果，不是对未来设计的假设：

| 当前事实                                                                 | 证据                                                                                                                                                                                                   | 对决策的影响                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Commands 的公开入口只有根、`/argv`、`/typebox`                           | [package.json](../../packages/commands/package.json)、[index.ts](../../packages/commands/src/index.ts)                                                                                                 | 没有一个已经存在的 `/mcp` 模块可直接删除                 |
| provider name、MCP annotations、输入输出 schema 投影由 carrier 负责      | [Commands 用法](../../docs/runtime/commands.md)、[工程边界](../COMMANDS.md)                                                                                                                            | 保持这个边界，删除“Agent 必须经过 Commands”的依赖        |
| `output` 参与 encode、严格 JSON 检查、schema 校验和可选 `validateOutput` | [执行实现](../../packages/commands/src/define.ts)、[包文档](../../packages/commands/README.md)                                                                                                         | 把有用的投影/校验迁入实际出口，再删除核心 output 管线    |
| 当前省略 output 要求 handler 返回 undefined，且 output 限于 object-root  | [公开类型](../../packages/commands/src/types.ts)                                                                                                                                                       | 可以重定这个契约，避免普通消息处理也被迫声明 wire output |
| 管理命令、Package Manager、ReportStudio 使用 Commands                    | [管理命令](../../packages/services/src/management/commands.ts)、[Package Manager](../../plugins/package-manager/src/index.ts)、[ReportStudio](../../projects/plugin-host/src/showcase/ReportStudio.ts) | 保留实际 CLI/消息与管理用例；不是只剩 Agent 消费者       |
| Package Manager 的 Command 和 Workbench RpcTarget 已经调用同一个 store   | [实现](../../plugins/package-manager/src/index.ts)                                                                                                                                                     | “共享业务、分别发布入口”已有真实先例                     |
| Pi 当前遍历整个受限 catalog 生成 tools                                   | [tool-adapter.ts](../../plugins/pi-agent/src/tool-adapter.ts)                                                                                                                                          | token 扩张发生在投影层，不是插件安装本身                 |
| AgentTools 保存 Toolset/assignment，执行时重新检查                       | [设计](../../plugins/agent-tools/DESIGN.md)                                                                                                                                                            | 复用其授权时机经验，不保留配置模型                       |

本提案保留 Core 的 graph、generation、effects 和 owner invocation 思路，不将其改造成 Agent 专用 runtime。
Commands、RPC、Workbench 的启用各自显式；关闭 RPC/Agent 时不创建网关、沙盒或模型客户端。

## 3. Commands：哪些简化，哪些留下

### 3.1 操作定义与命令入口

保留 `defineCommand()`、输入 validation/codec、错误、独立 registry，以及 `/argv` 的路由、参数解析、帮助与 tail。
聊天平台 carrier 继续拥有账号/频道身份、斜杠命令语法、授权、确认与回复渲染。
CLI carrier 拥有 argv、stdout/stderr、exit code 与 `--json`；不隐式连接到正在运行的应用。

Command 是可被多种接收者调用的操作定义；CLI/聊天仍拥有各自的语法和交互，不让这些信息渗入执行内核。
名称用于稳定识别源操作和派生导出，不强迫所有 RPC 方法、UI action 或普通领域函数注册为 Command。
业务内部仍可直接调用普通领域方法，Command 不成为 Plugin dependency 或 lifecycle 协议。

### 3.2 返回值与输出出口

Command 核心只处理输入与执行，handler 正常返回业务结果。核心不再拥有 `output`、`validateOutput`、
output codec、output examples 或 `outputSchema` descriptor，也不再有 Output/Void 两套定义重载。
`Command<I, O, Context>` 的 O 从 handler 推导；返回 undefined 就是无结果，不靠额外声明选择模式。

```ts
const searchNotes = defineCommand({
	name: 'notes.search',
	description: '按关键词搜索当前笔记本的笔记。',
	input: obj({ query: Type.String() }),
	async execute({ query }, context: NotebookContext) {
		return notes
			.forNotebook(context.actor, context.notebookId)
			.search(query, { signal: context.signal })
	},
})

// CLI JSON、LLM 与 RPC 使用相同 DTO 时，只写一次。
const noteSearchJson = {
	schema: NoteSearchResultSchema,
	project: (notes: NoteSummary[]) => ({ items: notes.map(toNoteSummary) }),
}

const cliSearch = toCli(searchNotes, {
	routes: ['notes search'],
	positionals: ['query'],
	render: renderNotesTable,
	json: noteSearchJson,
})

cli.bind(cliSearch)
```

`toCli` 和 `cli.bind` 属于拟议 CLI carrier，分别负责纯定义派生与路由安装；不往现有 `/argv` parser 增加 IO。
底层 parser 继续只解析候选输入；安装时继承基础 command 的 name/description/input，不能重新填写这些信息。
`render` 服务文本输出，`json` 是可选且明确承诺的 `--json` 出口。聊天平台类似地绑定自己的消息 renderer。

| 责任                                               | 所有者                                               |
| -------------------------------------------------- | ---------------------------------------------------- |
| 参数 schema、defaults、input codec、跨字段输入校验 | Command 内核                                         |
| 业务结果及其不变量                                 | handler 调用的领域实现                               |
| 进程内返回类型                                     | handler 推导，不强加 JSON 或 object-root             |
| CLI 表格、聊天消息                                 | 对应 carrier renderer                                |
| 稳定 JSON DTO、MCP structured output               | 相同 DTO 的共享结果定义，由出口执行 project + schema |
| 多出口共用的 DTO 转换                              | 领域边界的普通函数/schema，按需复用                  |

保留 input 的 object-root，因为 argv positionals/options 需要字段模型。字符串动态 dispatch 的结果仍是 unknown。
原始结果不自动进入日志、RPC 或模型上下文；不盲目 stringify 内部对象。output schema 不是授权，且不能自动代替显式 DTO 投影。
出口若需要日期/大整数等编码，在 project 中或该出口明确支持的 codec 中完成，不回流到 Command 内核。

CLI 在执行前检查所选输出模式是否受支持；MCP 在 mount 时检查结果出口和 schema 是否可投影。
缺少 renderer/project 时在 handler 执行前拒绝，避免写入完成后才发现无法返回结果。
实际 renderer、project 或结果校验仍可能在业务提交后失败，必须报告结果呈现失败，不自动重试业务操作。
原 `OUTPUT_VALIDATION` 的接收者契约归对应 carrier；不再作为每个 Command 的统一执行错误。

### 3.3 metadata 与注册句柄

- 名称、描述、input 字段说明与输入示例保留，用于命令 help；argv 用法示例留在 binding。
- `behavior` 整体删除，连同 `world`、`destructive`、`idempotent` 和 query/mutation 分类。
- 具体确认、授权、并发与重试在实际业务/平台边界处理；不能从函数名或无 metadata 推断只读。
- registry 保留名称查找、revision、撤销与订阅，服务实际动态 help/router 用例；不变成 RPC catalog。
- 删除 registration 自动跟随“schema 兼容替换”的 executable handle；正常返回值不再有 schema 可用于这种兼容承诺。
- 新 `register()` 返回 `{ name, dispose() }`。直接调用持有的 command 是固定实现；`registry.execute(name, ...)`
  是明确的当前名称查找，返回 unknown；host/carrier 安装的 wrapper 固定 owner generation，旧 wrapper 撤销后拒绝调用。
- root registration 与 carrier mount 分开发布，保留 provider/consumer ownership、取消和 generation admission。

### 3.4 MCP：适配时补信息，而非污染核心

Command 已经拥有名称、业务说明和输入约束。MCP view 引用这些事实，追加协议自己的信息：

```ts
const mcpSearch = toMcp(searchNotes, {
	annotations: { readOnlyHint: true },
	result: noteSearchJson,
})

mcp.expose(mcpSearch)
```

`toMcp` 不再声明 name、description、input 或 handler。名称和说明默认直接来自 searchNotes，
`result` 引用前面同一个 noteSearchJson；adapter 负责校验/编码，不能再维护第二份 DTO schema 或 project。
`NoteSearchResultSchema` 描述符合该 MCP 版本要求的结构化 JSON，例如 `{ items: [...] }`。
只需要文本结果时追加明确的 renderer；不要求每个 tool 都声明 structured result。
如果 CLI 与 MCP 的实际输出含义不同，则各自拥有投影，不能为“统一”强迫不相同的输出共用 schema。

- 输入 schema 从 Command 复用；不支持的 provider schema/codec 在 bind 时拒绝，不能静默放宽或裁剪校验。
- 业务 description 只在基础定义中维护。确有模型专用操作提示时追加 `instructions`，adapter 将其作为标识清楚的补充段落生成最终说明；
  不提供相同字段的隐式覆盖。只有确实不同的操作才建立新基础定义。
- provider name 转换与反向映射由 adapter 确定性派生，必要的外部别名使用 exportAs；不按注册顺序生成不稳定名字。
- annotations 只是提示，不是服务端授权、调度或重试规则；缺失时使用协议的保守语义，不伪造只读保证。
- MCP connection 在可信 carrier 中映射到 actor、授权和取消上下文；模型输入不能填写可信 context。
- 调用继续经过 Command 输入校验和 owner generation gate，不能为 MCP 暴露 unchecked handler。
- provider 特有 result blocks、task support、错误和 schema 子集只进入 adapter；MCP 不依赖 AgentTools。

Commands 核心不增加 MCP SDK。适配器可以是独立 carrier/module，不提前承诺一个独立发布包。
当前没有独立 MCP exporter；上述是目标适配契约，不声称已经存在，也不要求无实际消费者时立即实现。

| Agent 接入方式              | 适用场景                                        | 暴露入口                               |
| --------------------------- | ----------------------------------------------- | -------------------------------------- |
| 精选 Command → MCP tools    | 能力少、操作明确，或已有命令要给外部 Agent 使用 | 显式 expose 的命令                     |
| 发现 → 沙盒代码 → Cap’n Web | 能力多，需要循环、批量调用和跨 API 组合         | search_apis / describe_apis / run_code |

两条路径共享领域实现，不强制对方作为中转。不把全量 command catalog 自动注入模型。
Cap’n Web API 若需要变成 MCP tool，同样写显式适配；远程对象、回调、stream 不能直接无损映射成 JSON 工具。
不要求为了支持 MCP 先把 RPC 改写成 Command，也不设计所有接口都可自动互转的框架。

### 3.5 Command 本身就是 LLM tool 的定义来源

典型 tool 的 name、description、JSON input schema 和执行函数都可从 Command 派生，不要求作者另写一份 tool 定义。
这里的“直接”指信息和执行权威直接来自 Command，不是声称一个 JS 对象能原封不动兼容所有 SDK。

| tool 所需信息                          | 来源/责任                                                          |
| -------------------------------------- | ------------------------------------------------------------------ |
| name / description                     | Command，必要的协议别名由 adapter 派生或显式 exportAs              |
| parameters / inputSchema               | Command 的 wire input schema，不能把 TypeBox codec 函数传给模型    |
| 实际执行                               | Command.execute(candidate, trustedContext)，codec 只在这里执行一次 |
| tool call ID、signal、用户身份         | 可信运行时适配，不属于模型参数                                     |
| result content / structured output     | 共用 result 定义或该框架的显式 renderer                            |
| strict schema 子集、流式事件和错误呈现 | 对应 SDK adapter，不能反向污染基础定义                             |

例如某个具体框架的 adapter 可导出以下形态；`framework.bind` 只是拟议接入示意，不是任何现成 SDK 的 API：

```ts
const tool = toTool(searchNotes, { result: noteSearchJson })
framework.bind(tool, {
	context: (invocation) => trustedNotebookContext(invocation),
})
```

`toTool` 从选定框架的 adapter 入口导入，没有声称统一所有 SDK 的 universal tool 类型。
也可以由宿主手写几行适配，但必须走同一个校验执行边界。框架可额外校验原始 wire input，不能在进入 Command 前
先运行其 input codec，导致二次 decode。上下文绑定失败须在 handler 之前拒绝；命令原始返回值不得默认全量送入模型。

注册 adapter 不等于该操作已被授予每个用户；可见集合、调用授权和 owner withdrawal 由实际宿主执行。
内置代码型 Agent 和直接 tools 型外部 Agent 共享 Command/领域实现，不共享一份全局可调用目录。

## 4. RPC 作者 API：Command 组成 class，原生对象组成能力树

所有示例仍是提案。`NotebookContext` 是服务端绑定的 actor、notebookId、signal 等事实；`readNote`、`createNote`
与 searchNotes 一样是普通 Command，省略其领域实现。前文的 searchNotes/noteSearchJson 在此直接复用。

### 4.1 一组 Command 生成一个原生 RpcTarget class

```ts
const searchMethod = { command: searchNotes, result: noteSearchJson }
const readMethod = { command: readNote, result: noteJson }
const createMethod = { command: createNote, result: noteJson }

/** 搜索和读取已获授权笔记本中的笔记。 */
export const NotesReader = toCapnweb({
	search: searchMethod,
	read: readMethod,
})

/** 编辑已获授权笔记本中的笔记。 */
export const NotesEditor = toCapnweb({
	search: searchMethod,
	read: readMethod,
	create: createMethod,
})
```

`toCapnweb(methods)` 是外部适配器，不是 Commands 内核方法；返回真正继承 Cap’n Web RpcTarget 的 class。
同一个 method binding 可放进不同 target，组合不复制 name/description/input/handler/result。
`search` 是当前对象上的成员位置，`notes.search` 是源 Command identity；前者允许按领域组织路径，并非重复声明业务名称。
重复/保留成员名在定义时拒绝，不能覆盖 constructor、协议基础成员或出现静默 last-wins。

构造实例时绑定服务端上下文：`new NotesReader(context)`。多个方法要求的 Context 必须能由同一个 context 满足，
类型不兼容时组合失败；上下文不可由模型参数提供，也不能通过改写共享 this.ctx 临时切换。
对象保留不可变的上下文视图，构造时不执行 Command，也不自动授予访问权。

其 search 方法语义等价于下列代码（projectAndValidate 为解释性伪代码，不增加公开 helper）：

```ts
class GeneratedNotesReader extends RpcTarget {
	#context: NotebookContext
	constructor(context: NotebookContext) {
		super()
		this.#context = context
	}
	async search(input: SearchInput) {
		const value = await searchNotes.execute(input, this.#context)
		return projectAndValidate(noteSearchJson, value)
	}
}
```

实际生成固定的 prototype 方法，不返回带任意名称 lookup 的万能 execute(name, args)。
输入类型来自 Command 的 wire schema，返回类型来自 result 的 wire 契约，文档说明来自 Command。
本路径无需从手写 wrapper 重新抽取同一套类型，不要求作者再写 RPC schema/class method。
数据方法必须在 binding 明确选择结果出口；有明确 void 的操作也有对应的无结果出口，不能默默暴露任意内部对象。
结果出口处理数据转换/校验，不偷偷赋予返回的 RpcTarget 新能力；创建子能力由下面的原生对象方法明确负责。

### 4.2 原生 RpcTarget 组织资源与子能力

```ts
import { RpcTarget } from 'capnweb'

/** 一个已获读取授权的笔记本。 */
export class NotebookReader extends RpcTarget {
	#context: NotebookContext
	constructor(context: NotebookContext) {
		super()
		this.#context = context
	}
	/** 获得本笔记本的笔记读取能力。 */
	notes() {
		return new NotesReader(this.#context)
	}
}

/** 当前身份可以读取的笔记本集合。 */
export class LibraryReader extends RpcTarget {
	#scope: LibraryScope
	constructor(scope: LibraryScope) {
		super()
		this.#scope = scope
	}
	/** 校验资源 ID 和访问权，打开一个笔记本。 */
	async notebook(id: string) {
		const context = await this.#scope.openNotebook(id)
		return new NotebookReader(context)
	}
}
```

`LibraryScope.openNotebook` 是可信领域入口，负责运行时输入校验和资源授权，返回固定的 NotebookContext；
不是依据模型提供的 actor/tenant 构造上下文。后续读写仍检查可变的数据权限，不能把一次 open 当作永久授权。
NotesReader 也可以从 WorkspaceReader 等其他原生 target 返回：重新绑定该资源的可信 context，不改 command。
NotesEditor 只放进明确的写权限对象树，LibraryReader 的可达对象图中不存在它。

反过来，生成 class 也可以作为原生 class 的基类；增加原生方法即可继续返回子能力，不必重写已有 Command 方法：

```ts
class NotesWithAttachments extends NotesReader {
	#context: NotebookContext
	constructor(context: NotebookContext) {
		super(context)
		this.#context = context
	}
	/** 获得同一笔记本的附件读取能力。 */
	attachments() {
		return new AttachmentsReader(this.#context)
	}
}
```

AttachmentsReader 是应用提供的原生读取 target，此处省略其领域方法。组合语义有意区分：
Command/result binding 只输出数据，原生 prototype 方法负责授予能力；不把 JSON schema/project 暗中当成能力返回协议。
继承后的契约必须包含 inherited Command 方法与新增原生方法；同名 override 首版拒绝，避免继承说明与实际实现失配。

```text
LibraryReader
  └─ notebook(id) → NotebookReader
       └─ notes() → NotesReader
            ├─ search(input) → 数据
            └─ read(input) → 数据
```

### 4.3 只发布根对象，元信息不重复

```ts
@Plugin()
export class NotesPlugin extends BasePlugin {
	// 领域依赖通过现有 constructor graph 提供。
	protected override init() {
		this.ctx.require(Rpc).publish(LibraryReader, {
			id: 'library.read',
			create: (batch) => new LibraryReader(this.store.scopeFor(batch.principal, batch.signal)),
		})
	}
}
```

`publish(TargetClass, { id, create })` 是唯一 publication 入口。原生 class/method 的说明来自 JSDoc；
生成 class 的说明来自导出声明 JSDoc，生成 method 的说明来自 Command；publish 不再填写 description。
id 是发现根的稳定别名，子对象通过原生方法返回，不给每个实例注册全局 ID/目录项。
直接发布 `NotesReader` 这类生成 class 也合法，create 负责绑定 context；无需为了 publication 再写一层 class。

根工厂每个 batch、每个被打开 publication 最多执行一次，惰性创建。子对象按领域方法创建，同一个 Command
可有不同 context 的多个实例。业务连接由 Plugin 共享，batch 资源登记 effects，调用 drain 后才释放。
Command 与原生方法均可直接调用领域实现，不强迫已有原生 RPC API 先改写为 Commands。

## 5. 契约生成与嵌套能力的边界

### 5.1 一张可达接口图，不是第二份手写定义

生成 target 的 method inventory、说明和类型来自 toCapnweb 的静态成员组合及源 Command/result；
原生 target 的签名与说明由工具链从公开方法/JSDoc 提取。两种来源进入同一份可重建接口图。
原生返回类型引用生成 class 时，通过生成元信息连接，不需要再从动态 prototype 反推类型。

publication 的制品包含根和可达 target 的接口关系、方法说明、数据类型与 contract digest，不包含 server 实现。
获取 `library.read` 文档时能理解 notebook → notes → search 的实际调用路径；不为每个资源实例生成 schema。
契约可以循环引用，但必须使用类型引用封闭表达，不能展开成无限文本。摘要和文档仍需有界。

原生输入继续在方法/领域入口校验；Command 输入只走自己的校验执行器一次。TS 类型不替代运行时校验。
原生数据结果由领域 DTO 投影负责；生成方法由 result 定义负责。同一个意义的 schema/project 共享引用。
不能静默把未知类型变成 any；无法提取的动态成员、复杂泛型或跨包类型在构建时明确拒绝，并作为技术 gate 验证。

### 5.2 嵌套对象是正式能力，不是被序列化的普通数据

- 支持原生方法返回生成/原生 target，或在继承生成 class 后添加原生方法；支持原生结果容器中明确声明的 target 引用。
- 公开 prototype 方法构成远程面；不隐式发布 property/getter、constructor、静态 helper 或任意函数字段。
- 返回能力必须属于制品中可达的 target 类型。未声明 target、裸函数或意外能力返回 fail closed，不作为普通 JSON 放行。
- 首版不支持反向 callback、stream 或 sandbox 向服务端传入任意 target。这些是独立双向信任边界，不影响服务端能力嵌套。
- 生成类和原生类的成员清单必须约束实际服务端 facade；文档删方法不构成授权。

用途明确的小对象是访问单位：只给 Reader 就不能取得 Editor。不靠大对象的方法名过滤拼出角色，
也不把每个方法都做成独立 capability。工厂、原生返回方法和领域规则决定能力授予，toCapnweb 只转换操作。

### 5.3 所有子引用都继承有效期与权限上界

这是支持嵌套的必要实现条件，不能推迟到“后续加固”：

1. 根 publication 持有 owner address/generation；每个 execution pin 契约和当前授权。
2. 返回边界将每个 target 引用（包括容器内引用）纳入同一个受限 RPC 范围，绑定 session、execution、batch、
   授予路径和 owner generation。默认新建子对象由当前 publication 拥有，不从类的 import 来源、构造参数或 closure 猜 provider。
   publication 必须真实承担其资源生命周期；子对象不能脱离 scope 直接以 raw target 暴露。
3. 子方法每次接纳都检查当前 session access、execution 状态与 owner gate。撤销根访问或停止 provider 后，
   已拿到的子引用也不能继续发起调用；不能只检查 root.open。
4. 调用其他领域 Plugin 继续经过已有 dependency caller/owner-bound 调用边界，不把依赖对象原始实例借出。
   独立跨 provider 的子能力返回必须经可信的 owner-bound handle 提供 provenance，保留 provider lease 并叠加授予路径约束。
   现有机制不能携带这些事实时首版拒绝这类返回，不自行给外部对象贴上当前 owner；这不妨碍同一 batch 分别 open 多个 publication。
   生成类不是生命周期 owner，创建/发布它的受控 scope 才承担归属；class identity 和 closure 都不是可信凭据。
5. native stub 的引用释放不是权限撤销。dispose 父 stub 不保证其他独立持有的子引用失效；scope 撤销才保证禁止新调用。
6. 已接纳调用退出前保留 lease，随后释放资源；dispose/重复引用的 cleanup 必须幂等，不依靠 GC 关闭业务事务。

facade/返回能力约束是 Pluxel 的安装边界，不是新 RPC 协议。继续使用 Cap’n Web 的对象引用与 promise pipelining，
不创建自己的远程 object ID registry，也不要求业务方法换成 execute(name, args)。
无法正确约束递归返回对象时，嵌套支持尚未完成；不能通过只检查根对象声称支持。

同一 host 的根 publication ID 冲突拒绝；子实例不争用根目录名。public surface 指纹覆盖可达接口图，
新增返回 Editor 的路径和给 Reader 添加方法一样属于授权面变化，不能用旧 access 自动开放。

## 6. 宿主配置与授权会话

Rpc 服务在 root 创建前由宿主显式安装；其安装入口拟放在 `@pluxel/services/rpc`，遵循现有 capability composition。
独立协议类型和客户端辅助代码放在 `@pluxel/rpc`。具体 physical HTTP route 由宿主 HTTP integration 安装，不由业务 Plugin listen。

可信应用在认证后创建会话：

```ts
const session = rpc.createSession({
	principal: authenticatedUser,
	access: ['library.read', 'orders.read'],
})

const hits = await session.search({ query: '订单相关笔记', limit: 5 })
const docs = await session.describe({ apis: ['library.read', 'orders.read'] })

const result = await executor.run({
	session,
	contracts: docs,
	code,
	signal: request.signal,
})

// 可信应用可缩小/更新权限；模型没有这个入口。
session.setAccess(['library.read'])
await session.dispose()
```

`access` 显式选择已经发布的小 API 对象，不支持 `'*'`，也没有“预设名称自动等于权限”。
createSession/setAccess 将 ID 解析为可信 publication owner 和公开接口指纹，保存授权快照；不存在的 ID 拒绝。
新增根对象不自动授权，已授权对象图增加公开方法/新能力路径/改变契约时也不自动扩权，必须由可信应用重新 setAccess。
因此兼容实现替换与权限界面扩张不同，单纯重新 describe 不能越过重新授权边界。

应用拥有身份验证与策略来源，RPC session 拥有当前有效 access 快照；不新增 Toolset 管理插件或第二个策略持久库。
需要持久化时仍由应用配置/权限存储生成 access。`setAccess()` 原子更新，后续调用重新检查；已接纳调用不追溯回滚。
`dispose()` 拒绝后续调用并取消本 session 的执行，等待可合作清理。日志中的 session ID 本身不是访问凭据。

`search()` 只返回当前可用且获准访问的 ID/摘要；检索发生在服务端。`describe()` 返回不可变的契约快照，包含
被授权根及可达子对象的接口文档、digest、publication identity 与 generation。快照由调用方/conversation 持有，RPC session 不保存
“当前已描述版本”的共享可变状态。两个 conversation 共用身份授权时，重新 describe 不会互相替换接口版本。

`executor.run({ contracts })` 显式捕获本次需要的 API 快照集合；只允许 open 其中的 API，生成的类型环境也来自同一集合。
在任何业务调用前核对快照并 pin 对应 generation；变化时返回 `API_CHANGED` 要求重新 describe，不静默执行旧代码与新签名。
无关 API 的更新不使本次执行失效。读取文档不授予权限；快照也不能替代每次调用的当前 access 检查。

首次发现用名称、说明、关键词检索和有界分页，提供列举/扩大查询范围的回退。接口名已知时直接 describe；
不要求先搜索。授权目录很小时允许少量摘要固定可见，但不全量加载所有接口签名。

## 7. 沙盒调用 API：显式 HTTP batch

### 7.1 HTTP batch 的实际语义

仓库锁定 Cap’n Web 0.12.0。其 `newHttpBatchRpcSession()` 是一次 batch，不是可连续 await 的长期连接。
官方 README 说明 batch 在下一次 I/O tick 发送，需在发送前订阅需要返回的 promise。
`await api.search(); await api.read()` 若复用同一个已完成的 HTTP batch stub，第二次调用不能成立。

因此首版不承诺一个隐藏 HTTP 边界的长期 `api.notes` proxy，采用显式的 `rpc.batch()`：

```ts
const hits = await rpc.batch((root) =>
	root.open('library.read').notebook('book-123').notes().search({ query: '退款' }),
)

const notes = await rpc.batch((root) => {
	const reader = root.open('library.read').notebook('book-123').notes()
	return Promise.all(hits.items.map((hit) => reader.read({ id: hit.id })))
})

return notes.map((note) => ({ title: note.title, excerpt: note.body.slice(0, 1000) }))
```

每次 `rpc.batch()` 建立一个新的原生 batch stub，使用同一个 execution 的受限身份。callback 同步排队调用，
返回一个待结算的 promise；可以返回 `Promise.all`，不能在 callback 内先 await 再追加调用。
实现应拒绝批次发送后的调用并返回明确诊断，不能仅靠禁止 `async` 关键字假装静态保证。
helper 负责订阅返回结果并释放 batch。没有返回/等待的调用也可能已排队执行，因此所有调用仍计入授权、预算和审计；
fire-and-forget 不提供脱离 execution 的后台执行保证。

`root.open(id)` 是精确名称访问，返回受限 target facade。其输入不能选择 URL、凭据、租户或 owner。
生成的 sandbox `.d.ts` 提供本次 contracts 集合的精确 overload；不把服务端类 import 到沙盒。
同一 batch 内可直接在尚未 await 的 target promise 上继续调用子方法，保留原生 pipeline。
`rpc.batch()` 结算后只向后续程序交付数据；能力引用可以存在于 batch 内，不能逃逸到下一 HTTP batch 或最终模型结果。
这是短期 transport 的生命周期边界，不是禁止 API 返回 RpcTarget。helper 必须检测引用逃逸并安全失败。

如果直接用原生客户端连接宿主为该会话提供的根，其调用形式为：

```ts
const gateway = newHttpBatchRpcSession<Gateway>(endpoint)
const reader = gateway.open('library.read').notebook('book-123').notes()
const result = await Promise.all([
	reader.search({ query: '退款' }),
	reader.search({ query: '发票' }),
])
```

Gateway 的具体类型由本次契约制品生成；它并非把全部能力导出给任意 URL client。
中间没有 await，多个层级仍可进入一个 HTTP batch。任何单个方法是否有副作用或需要事务，仍由领域定义。

数据依赖意味着可能有多次 HTTP 往返；上面的先 search 再 read 示例是两个请求，原生并发 search 示例是一个请求。
`Promise.all`、promise pipelining、一次模型工具调用、
一次 HTTP 请求、服务端事务是五个不同概念。服务端执行多个方法不会自动构成事务，也不保证并发顺序。

### 7.2 多个 API 和多个 endpoint

第一版一个受限 root 可 `open()` 多个插件 API，同一 batch 可以跨这些 API 排队。
外部独立 Cap’n Web 服务由宿主可信的接入 provider 包装、保存上游凭据并显式发布；不把任意 URL/fetch 暴露给模型。
多个上游 endpoint 不会因此合成一个上游 HTTP 请求或分布式事务；其额外延迟需如实计量。
没有真实外部服务需求时不实现泛化联邦、协议发现或任意远程 `.d.ts` 导入。

长期远程对象、双向 callback 或订阅如果成为实际需求，应单独评估 WebSocket transport；不通过自建 object ID 存储
偷偷把 HTTP batch 变成长连接对象协议。第一版没有该承诺。

## 8. Agent、沙盒与调用生命周期

### 8.1 内置代码执行型 Agent 消费三个工具

```ts
search_apis({ query: '退款', limit: 5 })
describe_apis({ apis: ['library.read'] })
run_code({ code: '...' })
```

三者绑定同一个可信 RPC session。这是内置复杂任务 Agent 的默认路径，不限制外部 MCP client 使用精选 Commands。
普通闲聊无需调用发现；业务工具描述不按安装插件数扩张。
Agent adapter 在每个 conversation 内保存 describe 返回的快照；run_code 捕获本任务当前选择的集合传给 executor，
无需模型复制 digest 或 generation。一次成功的 describe_apis 显式替换该 conversation 的当前集合；
需要两个 API 就同时描述它们。已开始的 run 持有不可变快照，后续 describe 不影响它，不引入自动判断任务切换的策略层。
执行器用该集合和固定 sandbox globals 检查代码类型，再启动执行；类型检查不是权限边界，手写动态访问仍由服务端拒绝。
预设只拥有指令、模型默认项和预算；不安装业务插件、不赋予权限、不复制角色策略。
Skills 是按需操作指南，不承担授权或执行入口；首版不引入独立 skill 管理系统。

新 agent engine 的最小装配形态：

```ts
const conversation = agent.createSession({ model, rpc: session, executor })
await conversation.prompt('从笔记中整理退款问题', { signal })
await conversation.dispose()
```

conversation 借用 rpc session，拥有自己的模型运行；dispose 会取消自己的 executions，不撤销其他消费者借用的 session。
外层应用最终 dispose rpc session。executor 为宿主共享，单次 execution 资源不在 conversation 间共享。
无需为了删除旧 Pi 插件重写模型 SDK；可在新 engine 内复用 Pi，但不继承其旧 toolSetupId/Toolset 协议。

### 8.2 信任与资源边界

| 对象                | 所有者与结束条件                                          |
| ------------------- | --------------------------------------------------------- |
| publication         | Plugin generation；commit 可见，撤销/停止后不接纳新调用   |
| RPC session         | 可信应用；拥有 principal/access，显式 dispose             |
| execution           | executor；一次 run_code，固定契约版本和 execution ID      |
| HTTP batch / target | execution 内的短期范围；含全部子能力，完成并 drain 后释放 |
| 业务事务/持久资源   | 领域服务；不由 sandbox 退出或 RPC stub GC 隐式回滚        |

沙盒内不保存宿主模型凭据、数据库凭据或上游 API token。execution 凭据短期、限定 endpoint 和 session/execution，
必须经过受控网络出口；跨 session 重放与撤销后的调用拒绝。principal、access、owner、execution ID 不从业务参数信任。

默认只允许运行临时程序和访问注入的 RPC 客户端；网络、文件、子进程、环境变量均按隔离 backend 明确约束。
Node vm、worker、TypeScript 类型检查都不是安全隔离。首个支持的平台必须选定并验证实际 OS/container/microVM 边界，
不可在 backend 缺失时静默退回宿主 eval。当前提案不指定一个未经本机部署验证的沙盒产品。

设定单次执行的 wall time、CPU/内存、batch 数、总 RPC 次数、并发、请求/响应字节、日志和结果预算；数值在实际平台验证后给默认值。
预算统计覆盖失败、未 await 和嵌套 root.open 调用，不能只数 run_code 次数。队列与沙盒数量均有上限。
最终返回只接受有界 JSON 数据，日志也计入预算；超限返回 `RESULT_TOO_LARGE` 和安全摘要，不返回损坏的截断 JSON。
首版不自动保存结果文件；大数据应通过领域 API 分页/筛选，额外 artifact 系统待实际需求再设计。

### 8.3 取消、错误和写入

取消/超时先关闭 execution 接纳，再终止沙盒并向服务端工作发送合作式 signal；已执行写入不能撤销。
远程已接纳工作在真正 settle 前仍计占用并持有 owner lease；不能因为本地超时就释放服务端资源或宣称副作用不存在。
不合作的同进程任务不能被 JS 强制杀死，报告未完成清理，由宿主策略处置，不自动重跑。

RPC 控制错误至少区分 `INVALID_INPUT`、`FORBIDDEN`、`UNAVAILABLE`、`API_CHANGED`、`CANCELLED`、`LIMIT_EXCEEDED`、`INTERNAL`。
Cap’n Web 默认 Error 传递不等于能保留自定义字段；服务端 facade 和 sandbox stub 必须验证稳定错误 codec，不能依赖 message 解析。
业务预期失败优先用明确的 discriminated DTO；未知异常对外给安全消息，诊断 cause 留在服务端。

每次业务调用记录 session、execution、publication owner/generation、对象授予路径、方法、源 Command identity（若有）和结果状态；参数/返回值默认不全量记录。
单次 run_code 失败时返回 execution ID，并明确可能已提交副作用；传输断开后的写入结果不确定，不当作未执行。
幂等键、退款确认和事务由对应领域操作负责，不能用 method metadata 或一次人工批准覆盖整段可变程序。
需要人工确认的操作必须经过服务端的具体动作授权边界；首版未接入确认 UI 时不得默认开放这类写入。

## 9. 依赖、删除与代码组织

| 组件                        | 决策                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `@pluxel/commands`          | 保留独立包，删除 AI metadata/核心 output 管线，简化 registration                              |
| `@pluxel/services/commands` | 保留 owner-bound registry/mount；不导入 RPC/Agent                                             |
| 可选 MCP carrier            | 显式 expose 精选 Command，补协议信息；复用 host mount 归属，不依赖 AgentTools、不自动发布目录 |
| 框架 tool adapter           | 从 Command 派生 SDK tool，绑定可信 context 与结果出口；不要求先经过 MCP/RPC                   |
| toCapnweb adapter           | 从 Command/result 组合原生 target class，保留上下文类型和源操作 identity；归 RPC 适配入口     |
| `@pluxel/agent-tools`       | 删除实现、Toolset/assignment 配置、Workbench 页面、文档与依赖                                 |
| 旧 `@pluxel/pi-agent`       | 删除旧公开集成；新 engine 可内部复用 SDK，不保留兼容别名                                      |
| `@pluxel/rpc`               | 协议类型、契约文档、会话与客户端辅助逻辑；不依赖模型 SDK                                      |
| `@pluxel/services/rpc`      | root 前安装、owner publication、HTTP gateway 与 lifecycle 集成                                |
| 沙盒模块                    | 隔离执行和受控 RPC 出口；首版先有一个实际 backend，不做泛化 provider 框架                     |
| Agent 模块                  | 模型循环和三个工具接入；沙盒和 Agent 是否独立发布包不在本提案提前冻结                         |
| Workbench                   | 继续自己的 fresh target/publication；不把管理对象树直接暴露给 agent                           |

同一领域实现可同时服务 CLI、聊天、Workbench 和 RPC，但每个出口显式发布且分别绑定身份。
通过显式 toCapnweb 成员组合导出 Command，不自动镜像全量 command registry，也不自动导出 Elysia route 或 Plugin prototype。
toCapnweb 与框架 tool adapter 对 Commands 的依赖是单向的，Commands 不导入 Cap’n Web 或模型 SDK。
原生 RpcTarget 不必经过 Command；两者生成/提取的制品进入同一套 publication 和受控生命周期。

Core 不依赖 Cap’n Web、MCP、sandbox 或模型 SDK。Context shape 仍在 root 创建前固定，业务 Plugin 不动态安装新 Context capability。

## 10. 实施顺序与替换范围

本节是未来实施计划，不是本轮实现授权。每个阶段都走最终路径，不落地临时兼容架构。

1. **证明边界**：Command 生成 target + 原生嵌套 target + 两者契约图 + 实际沙盒 backend + HTTP batch。
   验证权限拒绝、伪造成员、跨 batch 失效、子引用撤销、取消和 generation 撤销。任一关键边界失败先修正设计，不扩展 Agent 产品。
2. **交付操作基础与适配**：删除核心 output/behavior，迁移其有用投影、编码与校验到领域/输出出口；相同结果定义共享引用，实现新 registration 语义。
   覆盖管理命令、Package Manager、ReportStudio 和 argv/carrier tests，不能只删除 schema 后丢掉机器输出。
   清理 `CommandBehavior`、`outputSchema`、Output/Void 定义重载、output examples 和内核输出错误；
   Input codec、输入示例和输入错误保留。存在真实 MCP 消费者时按第 3.4 节实现显式 carrier，不恢复旧 AgentTools。
   此阶段不以改造 RPC 为由重写 CLI parser 或改变聊天平台产品语法。
3. **交付 RPC/执行器**：toCapnweb 与原生对象接入、递归能力约束、publication、session、discovery、版本 pinning、稳定错误、资源预算。
4. **交付新 Agent 集成**：三个工具、会话生命周期和结果预算。旧 AgentTools/Pi 路径随调用点切换一次删除；
   需要直接 tools 的框架消费同一个 Command，而非另写 tool 定义或恢复全量工具投影。
5. **清理权威文档和发布信息**：修改 engineering、docs、package README、showcase catalog/policy、package dependencies 和 docs type fixtures。
   公共包行为变更添加有显式 bump type 的 Tegami pending changelog；不手改版本或 publish-lock。

删除检查至少覆盖 `plugins/agent-tools`、`plugins/pi-agent` 的旧配置/导出、
`projects/plugin-host/src/showcase/catalog.ts`、`policy.ts` 与相关测试，以及 `docs/plugins/agent-tools.md`、`pi-agent.md`。
保留旧配置不生效的静默状态不可接受：清理 bundled 配置，外部旧配置明确报不支持；本次没有迁移兼容期。

## 11. 验收与当前证据

单源组合必须额外验证：只修改基础 command 的 name/description/input，CLI help 与 MCP 投影同步改变；
基础对象保持不变，派生顺序不改变结果，不支持的重复字段在类型层和非类型调用边界拒绝。
CLI JSON/LLM/RPC 共用结果定义时只改这一份即可；RPC class/method JSDoc 修改后无需同步编辑 publication。
`toCli`/`toMcp`/`toCapnweb`/框架 tool adapter 不产生注册副作用，bind/expose/publish 撤销仍正确固定 owner generation。

RPC 组合必须验证同一个 searchMethod 进入 NotesReader/NotesEditor 和两个不同资源实例：类型正确、context 不串线，
input codec 执行一次、result projection 执行一次。原生父 target 返回生成子 target 时，CLI/MCP 不需要知道这条对象路径。
先取得子引用，再撤销 access/停止 provider，后续子方法必须拒绝；也要覆盖 DTO 内子引用、重复引用和父 stub 释放。
LLM adapter 以实际选定 SDK 为证据验证名称、schema 子集、tool call ID、取消、结果与错误，不用自定义假 SDK 代替兼容性验收。

| 需要证明的结果                        | 应使用的证据                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 普通聊天不承担所有 API 类型成本       | 记录实际模型请求，增加到 100 个 publication，确认未注入全量 schema/目录                                       |
| 发现可靠且跨插件完成任务              | 只给 agent 公开工具与任务，不给包名；记录成功率、发现轮数、总 token/延迟                                      |
| HTTP batch 语义诚实                   | 真实 HTTP 验证 pipelining、两轮数据依赖、同 stub 后续调用失败                                                 |
| 不靠客户端类型保证权限                | 手写/猜测成员、绕过 describe、非法数据、伪造凭据、跨用户 ID 的真实网关调用                                    |
| access 更新和 HMR 不绕过撤销          | 已获得引用后的调用、进行中调用 drain、旧 generation 不跟随替换                                                |
| API 对象授权不隐式扩张                | 只开放 NotesReader 时不能取得 NotesEditor；同 ID 换 owner/增加公开方法后旧 access 拒绝调用                    |
| 契约快照不跨 conversation 串线        | 两个 conversation 共用 session，各自 describe 不同版本，旧代码执行必须报 API_CHANGED                          |
| 沙盒确实隔离                          | 实际 backend 上尝试宿主文件、环境凭据、任意网络、子进程与资源耗尽                                             |
| Commands 的 CLI/聊天价值保留          | 类型测试 + argv/消息解析、render、explicit JSON output、codec、取消和 mount ownership                         |
| 输出语义没有隐式丢失                  | handler 结果推导、出口 project/schema/编码、跨 carrier 一致的领域结果、错误后不自动重试                       |
| 缺少输出投影不触发写入                | CLI 选择不支持的输出模式/MCP mount 缺少 renderer 时，handler 调用次数为零                                     |
| MCP 适配没有建立第二条 unchecked 路径 | 实施 carrier 时，让同一 Command 经 CLI/MCP 调用，验证 input codec 只执行一次、可信 actor 映射、结果投影及撤销 |
| 写入失败不误导重试                    | 部分提交、响应丢失、重复幂等键、出口结果校验失败的受控领域测试                                                |

本次已完成：源码/文档审阅；用 npm 发布的 `capnweb@0.12.0` 在临时 Node HTTP server 上验证以下序列：

```text
请求 1：root.open('notes').search()，open 与 search 通过 promise pipelining 组合
复用已完成的请求 1 stub：拒绝
请求 2：新 stub + Promise.all(read('n1'), read('n2'))
观察结果：HTTP 请求数 2，旧 stub 复用失败，两个 read 结果成功返回
```

补充的原生嵌套探针在同一个 HTTP batch 中执行：

```text
root.open('library.read').notebook('book-a').notes().search({ query: 'refund' })
复用 book-a reader 执行 search({ query: 'invoice' })
同一 batch 创建 book-b reader 执行 search({ query: 'refund' })
观察结果：HTTP 请求数 1；三个结果分别绑定 book-a / book-a / book-b，没有资源身份串线。
```

探针使用手写原生 RpcTarget，证明多层对象、异步父方法、pipeline 和不同实例的基本传输行为；
不证明 toCapnweb 生成器、Pluxel 嵌套授权/撤销或编译出的契约图已实现。
上述探针均不证明新 `rpc.batch()` helper、沙盒、错误 codec 或 lifecycle 已实现。
没有执行运行中 Pluxel 应用操作，没有做性能结论；提案代码未进行新 API 的编译验证。

参考上游：[Cap’n Web](https://github.com/cloudflare/capnweb)、
[本次读取的 0.12.0 发布包](https://registry.npmjs.org/capnweb/-/capnweb-0.12.0.tgz)。

## 12. 未决技术 gate 与不再摇摆的边界

架构决策已经明确：Commands 保留且不作为 Agent 必经入口；Command 是 CLI/LLM/RPC 操作的单一来源，原生 RpcTarget 保留能力嵌套；output 契约移到出口；
旧 AgentTools 模型删除；HTTP batch 显式化。这些不因选用哪个模型 SDK 而改变。

实施前仍需解决的技术 gate：

1. 选定第一个真实隔离 backend 和支持的平台，验证网络出口、资源限制和退出后的远程 drain。
2. 验证 Command 元信息与原生 `.d.ts`/JSDoc 的混合可达接口图，含 schema-inferred 类型、跨包 DTO 和生成 class；不手写第二份接口。
3. 验证 Cap’n Web facade 对嵌套对象/容器引用的完整约束、稳定错误、factory、dispose、取消和 HMR；特别验证已持有子引用的撤销。
   跨 provider 子能力的 provenance/lease 不可推测；不能可靠携带时拒绝其返回，不以跨对象库引用冒充生命周期支持。
4. 基于真实任务确定执行预算与发现质量基线；不预先声称比原生工具调用快多少或省多少 token。

这些 gate 失败时，重新审视对应机制；不保留旧 AgentTools 作为永久 fallback，也不降低权限或隔离要求以宣称完成。
