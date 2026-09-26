---
title: 查询插件源码
description: 用 TypeScript 定位插件、Part、配置声明与应用输入，帮助 coding agent 找到修改位置和验证入口。
---

修改插件前，可以通过 `@pluxel/rolldown/inspect` 找到插件、Part 组成、配置声明和应用绑定。查询返回可以直接 JSON 序列化的数据及源码位置，不需要启动应用，也不会执行插件模块、应用工厂、schema 工厂或构建脚本。

源码查询适合回答“在哪里改、影响哪些声明”。检查当前生效配置、调用业务方法和验证在线状态，使用[开发控制台](./dev-console.md)；验证隔离的行为回归，使用[插件测试](./testing.md)。

| 已知线索                    | 最短查询                                                      |
| --------------------------- | ------------------------------------------------------------- |
| Plugin package              | `plugins({ packageName })` → 返回的 `definition` → `plugin()` |
| Plugin identity             | `plugin(reference, { include })`，只请求需要的 sections       |
| 待修改文件                  | `file(path)`，再读确认关联的 Plugin 声明                      |
| 应用 env/file/configRecords | `plugin(..., { application, include: ['inputs', 'config'] })` |
| 项目结构未知                | `overview()`；列表分页沿用原 `nextCursor`                     |

先检查结果的 `complete / partial / unavailable`，再使用其中的事实；缺口不等于不存在。完整状态、错误和预算见[读取结果](#读取结果和处理变化)。

## 从一个包开始

项目需要 Node.js 24+，并声明开发依赖 `@pluxel/rolldown`。在项目中保存 `dev/inspect.mts`，替换 root 和包名：

```ts no-twoslash
import { openProject } from '@pluxel/rolldown/inspect'

await using project = await openProject({ root: '/workspace/my-app' })

const plugins = await project.plugins({ packageName: '@example/mail' })
console.log(JSON.stringify(plugins, null, 2))
```

直接运行：

```sh
node dev/inspect.mts
```

脚本使用包的发布入口。使用本地 source overlay 时，先按[源码工作区流程](./source-workspaces.md)运行 `pluxel source build --package @pluxel/rolldown`，使 Node 可加载工具本身的构建产物。不要让普通 Node 脚本直接导入工具链的内部源码。

`root` 是明确选定的项目或 workspace 目录；相对路径在打开时相对当前工作目录解析，之后固定为绝对真实路径。Workspace 包来自 `package.json` 的 `workspaces` 或 `pnpm-workspace.yaml` 的 `packages` 声明。pnpm 当前支持缩进的块状字符串列表；复杂或内联 YAML 写法会明确报告分析不可用。没有声明时不会猜测 `packages/` 或 `apps/` 目录。

`plugins()` 默认查询该 workspace 的包；指定 `packageName` 时，优先选择 workspace 包，再从 root 解析已安装的包。插件身份来自包根公开导出，结果同时标明具体 Plugin 与 abstract requirement。查询需要可分析的源码声明：只有已 lower 的发行 JavaScript 时，会返回分析缺口，不能据此推断源码中没有插件。

## 一次拿到修改所需信息

从列表选取返回的 `definition`，避免手工拼接身份。以下代码接在上面的脚本后：

```ts no-twoslash
if (plugins.data.status !== 'unavailable') {
	const selected = plugins.data.value.items.find((plugin) => plugin.exportName === 'MailPlugin')
	if (selected) {
		const report = await project.plugin(selected.definition, {
			include: ['parts', 'config', 'dependencies', 'checks'],
		})
		console.log(JSON.stringify(report, null, 2))
	}
}
```

已知身份时，也可以传入列表返回的规范 `reference`。离线查询处理 definition，不接受 fork 引用。省略 `include` 只返回插件概览；返回类型只包含所请求的 sections。

| Section        | 返回内容                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------- |
| `parts`        | 按挂载字段路径展开的 Part occurrence、class 声明位置、挂载位置及直接依赖                      |
| `config`       | Plugin/Part 的配置字段、所属配置路径、schema 表达式、使用位置和可解析的声明位置               |
| `dependencies` | 整个所属 Plugin 的 required/optional 依赖、provider requirement，以及各 occurrence 的依赖来源 |
| `checks`       | 所属包在 `package.json` 声明的 scripts、执行目录和 manifest 位置；查询不运行命令              |

`inputs` section 定位所选应用的 `configRecords` 表达式和目标 Plugin 的 config env/file bindings，需要显式 `application`。

只改一个 Part 时，通过它的实际字段路径缩小范围：

```ts no-twoslash
const report = await project.plugin('package:@example/mail::MailPlugin', {
	partPath: ['delivery', 'retry'],
	include: ['config', 'dependencies'],
})
```

`partPath` 选择该 occurrence 及其子树。同一个 Part class 挂载两次，会有两条不同路径。它们仍属于同一个 Plugin，不拥有独立插件身份。`dependencies.requires` / `optional` 始终描述整个所属 Plugin；`origins` 按选定子树缩小。

Config 的 `configPath` 是所属 occurrence 的路径：Plugin 根为 `[]`，Part 为它的 `partPath`，不会追加保存配置值的 class field 名称。`schema.usage` 定位 `configs.use()` 的 schema 参数；`schema.declaration` 定位可解析的 schema 声明。引用无法解析时后者为 `null`，并通过 section 缺口说明原因。内联 schema 的声明位置就是其使用位置。

这里只提供声明与定位，不推断完整 schema 字段、运行期默认值或校验输出。应用绑定按下节显式选择；Vault 用法与 RPC 查询不在此接口范围内。

## 定位应用的配置输入

同一个 Plugin 可以被不同应用使用。修改环境映射、文件输入或应用初始配置时，给 `plugin()` 指定应用，再请求 `inputs`：

```ts no-twoslash
const report = await project.plugin('package:@example/mail::MailPlugin', {
	application: { root: 'host', entry: 'src/app.ts' },
	include: ['config', 'inputs', 'checks'],
})

const inputs = report.data.sections.inputs
if (inputs.status === 'unavailable') {
	console.log(inputs.reason)
} else {
	console.log(inputs.value.configRecords, inputs.value.bindings)
	if (inputs.status === 'partial') console.log(inputs.gaps)
}
```

这个例子假设 project root 下有 `host/src/app.ts`。application.root 必填，相对路径基于 project root；entry 相对 application.root。
这项选择仅影响本次调用，不会改变其他查询。所有请求的 sections 都使用所选应用的源码解析上下文，包从 entry 的位置解析，
不会优先拿 workspace 中的同名包替代。没有 application 时，保留前述 workspace 包优先的行为。

`inputs.value` 包含：

- `application`：规范化的 root、entry 与 sourceSpaces 绝对路径，方便核对结果属于哪个应用。
- `configRecords`：应用对象中该字段的值表达式位置；确认没有字段时为 `null`。例如 `configRecords: makeRecords(startup.env)`
  会定位 `makeRecords(...)`，供继续阅读，不执行工厂，也不声称其中一定包含所选 Plugin。
- `bindings`：目标 Plugin 的 config env/file 声明。每个 env mapping 叶子有一条记录，file binding 有一条记录。

每条 binding 的 `configPath` 是声明的 schema **输入**路径；整体 JSON/env 输入和 config file 输入为 `[]`。
`declaration` 指向 helper 调用，`schema` 提供表达式与可解析的声明位置；`source.kind` 为 `env` 时读取 `name`，为 `file` 时读取 `path`，
`source.usage` 是变量名或文件路径表达式的准确位置。查询不读取环境值或绑定文件；相对文件路径由运行时 `startup.root` 解释，
不能把返回的 path 直接当成相对 entry 目录的部署路径。

`inputs` 始终描述整个 owning Plugin；即使同时传入 `partPath` 缩小 config 查询，也会保留整体 JSON/file 输入。
它只查询 config binding，不包含 Vault binding，也不发现 fork 的运行期配置。
空 bindings 只表示没有找到该范围内的绑定；配置仍可能来自 `configRecords` 或运行时保存的记录。

动态 mapping、未知 binding target 或无法定位的 schema 通过 gaps 给出源码位置；其他可独立确认的记录仍可使用。
若应用对象的 spread、重复字段等使配置入口无法确认，inputs 返回 unavailable，其他独立 sections 仍可用。
`complete` 表示声明导航完整，不表示 schema 已验证、环境变量存在或绑定已经生效。

## 查询应用中的源码插件

已知本地 Plugin 文件时，使用正式 source reference，并显式提供 application：

```ts no-twoslash
const local = await project.plugin('source:app/plugins/mail.ts::MailPlugin', {
	application: { root: 'host', entry: 'src/app.ts' },
	include: ['parts', 'config', 'dependencies', 'inputs', 'checks'],
})
```

内建 `app` 对应 application.root，所以上例定位 `host/plugins/mail.ts`。外部或嵌套源码目录使用工具链相同的显式映射：

```ts no-twoslash
const managed = await project.plugin('source:managed/mail.ts::MailPlugin', {
	application: {
		root: 'host',
		entry: 'src/app.ts',
		sourceSpaces: [{ name: 'managed', root: '../managed-plugins' }],
	},
	include: ['config', 'inputs'],
})
```

sourceSpaces 省略时只有内建 app；附加 root 相对 application.root。查询使用工具链相同的 package 优先、最具体 source root 和 native realpath 规则。
不能把包根 Plugin 当成本地 source Plugin，也不能通过 symlink 逃出映射范围；地址与实际 canonical identity 不符时查询会拒绝。
`checks` 使用源码文件最近的所属 package scripts，没有所属 package 时返回 unavailable。

这是定向源码查询，不会扫描整个 sourceSpace。`plugins()` 与 `file()` 仍保持 workspace/package 的发现与反查范围。
离线解析不加载 Vite 配置、不执行自定义 resolver hook，也不声称结果就是当前 Host catalog；需要在线事实时使用开发控制台。

## 从项目和文件反查

```ts no-twoslash
const overview = await project.overview()
const owners = await project.file('plugins/mail/src/retry-config.ts')
console.log(JSON.stringify({ overview, owners }, null, 2))
```

`overview()` 返回包列表，以及选定 root 的 package scripts。`file()` 的相对路径基于固定 root，返回 workspace 公开插件与该文件的已确认关系：Plugin 声明、Part 声明或 config schema。共享 schema 可以关联多个插件。

文件反查的范围是 `workspace-plugin-declarations`，不等于任意 import 使用者、完整影响分析或测试覆盖关系。没有关联只表示在这一范围内未找到声明关系。

`overview()`、`plugins()` 和 `file()` 支持 `limit` / `cursor`，默认每页 50 项，最大 200。将 `nextCursor` 原样传给同一查询读取下一页；`null` 表示结束。查询输入或结果变化时，旧 cursor 可能以 `cursor_stale` 拒绝，需要从第一页重新开始。

## 读取结果和处理变化

返回的 `Inspection` 包含 `root`、`revision` 和 `data`，是与查询对象分离、深冻结的普通数据。源码位置使用绝对文件路径、从 1 开始的 UTF-16 行列，结束位置不包含在范围内。

有完整性标记的结果必须先检查 `status`：

- `complete`：约定查询范围内完整；不承诺任意 JavaScript 的运行行为可静态推导。
- `partial`：`value` 中已有可用事实，同时通过 `gaps` 给出未解析部分。
- `unavailable`：没有该 section 的可靠值，原因位于 `reason`。

不能把 `partial` 的空列表当成“不存在”。依赖源码缺失、未解析的 Part 或 schema 引用，需要结合缺口和源码继续判断。

每次查询使用新的解析状态读取源码；编辑后直接再次查询即可，没有需要手动刷新的长期索引。返回前会复核本次已读取的文件；检测到变化时，以 `source_changed` 拒绝查询。

`revision` 标识本次观察到的文件内容集合与显式应用解析选择，不是文件系统的原子快照，也不是 Host revision。未命中的解析候选、尚不存在的文件等负向查询不在这个集合中；不能用 revision 相同证明整个项目没有变化，或证明源码与当前运行实例一致。

请求 `inputs` 或 source-entry 却没有 application 时，以 `invalid_input` 拒绝。诊断的 `location`（可用时）给出可继续阅读的表达式位置。

调用失败使用 `InspectionError.code` 分支。例如 `package_not_found`、`plugin_not_found` 和 `part_not_found` 指向选择错误；`analysis_unavailable` 表示无法完成本次分析；`source_changed` / `cursor_stale` 可在源码稳定后重新查询。错误的 `message` 供诊断，不作为程序分支协议。

打开和每次查询都可以传入 `AbortSignal`；打开时的 signal 只控制打开过程。查询在一个 project 内串行执行，最多允许 16 个等待请求，超过时报告 `query_queue_full`。优先一次请求需要的 sections，减少重复分析。

`await using` 在作用域结束时释放查询对象；释放会拒绝新请求并等待已接纳的工作退出，重复释放安全。它不会启动 watcher 或保留在线应用资源。

查询有整体预算：最多读取 4096 个文件、32 MiB 源码，展开 2048 个 Part occurrence（深度最多 64），返回数据最多 1 MiB。
超过预算报告 `analysis_unavailable`，不会静默截断。可以减少 sections、选择 Part 子树，或直接读取已定位的源码。

## 用查询完成一次修改

先用已知 Plugin 或文件定向查询；不知道目标时再列出包与插件。按返回的 declaration/schema/binding 位置读源码，
修改后运行 `checks` 中实际声明的脚本；脚本存在不代表它覆盖了本次行为，需要结合测试内容判断。
编辑后直接重查，不需要刷新索引。若任务需要确认当前配置或应用结果，使用开发控制台，不用离线 revision 代替运行实例证据。
