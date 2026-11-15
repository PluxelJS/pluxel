---
title: 查询插件源码
description: 从标准插件地址定位声明、Part、Schema、依赖和应用输入，区分目标环境的磁盘源码与已接纳运行版本。
---

已有 Script SDK 时，使用 `sdk.plugin(nodeAddress).inspect()`。它按地址中的 definition 查询作者声明，默认只返回 summary 和声明文件、行列；default 与 fork 指向同一份声明。生成控制入口、当前源码 class 和动态发现的地址使用相同写法。

尚无地址时，通过 `sdk.plugins.list({ packageName })` 取得有界发现页，再把所选 `node.address` 直接交给 `sdk.plugin()`。分页、按完整 definition 筛选与同步类型材料见[动态发现](./plugin-control.md#动态安装后的发现与操作)。

## 从插件地址定位源码

在所选 Vite root 的脚本目录中编写普通项目脚本：

```ts no-twoslash
import type { ProjectScript } from '@pluxel/host-vite/project'
import { TodoPlugin } from '@example/todo-plugin'

export default (async (sdk) => {
	const report = await sdk.plugin(TodoPlugin.nodeAddress()).inspect()
	if (report.isErr()) return report
	return report.value
}) satisfies ProjectScript
```

```sh
pluxel dev status
pluxel dev run host/web/dev/inspect.ts
```

Vite 为同一个 ScriptSdk / ProjectSdk 安装源码后端，固定所选实例的 Vite root 与实际 application entry。查询复用离线静态分析器，不求值项目模块、Schema 或应用工厂。脚本本身仍由现有控制台加载、检查和执行，选择 profile、保存 receipt 与 HMR 流程见[开发控制台](./dev-console.md)。

`report.value` 包含 `root`、`revision`、`data.summary`、`data.sections` 与 `source`：

```ts no-twoslash
const { file, start, end } = report.value.data.summary.declaration
// start/end: { line, column }；均从 1 开始，column 按 UTF-16 计数，end 不包含在范围内。
// 文件由拥有该环境的编辑器或 agent 打开；inspect 只读，不打开编辑器。
```

`source.content: 'current-disk'` 表示本次实际读取的磁盘内容；`source.environment: 'execution-target'` 表示路径属于执行目标进程。服务端绝对路径需要在服务端工作区中使用，不能当成客户端可编辑文件。离线查询使用 `environment: 'query-process'`，路径属于运行查询脚本的环境。`root` 是该次查询固定的观察根目录，源码可以来自其解析到的其他工作区或安装包。

`source.runtimeMatch: 'unverified'` 明确表示尚未核对运行版本。`revision` 标识观察到的源码及解析选择；catalog revision、managed revision 与 generation 各有自己的含义。HMR 暂停后磁盘可以领先于运行实例。项目脚本在存在未应用更新时返回 `hmr_pending`；这时可离线查询磁盘，完成修改和检查后再 apply、核对报告并重新查询。查询过程中已读取的文件发生变化会返回 `source_changed`。

作者源码通过正式 package source conditions 或 canonical source-space 解析。`.d.ts` 控制声明和普通构建 JavaScript 不会被当成作者源码；缺少可用源码时保留具体诊断。远程与静态部署默认未安装源码后端，返回 `inspection_unavailable`，其 reason 为 `inspection_backend_unavailable`。同步控制材料提供类型和调用证据，源码查询仍需要独立的作者材料。

## 按需查询 Part、Schema、依赖和应用输入

扩展查询沿用同一引用的 `include`、`partPath` 和 `signal`：

```ts no-twoslash
const selected = sdk.plugin(TodoPlugin.nodeAddress())
const report = await selected.inspect({
	include: ['parts', 'config', 'dependencies', 'inputs', 'checks'],
})
if (report.isErr()) return report
const config = report.value.data.sections.config
if (config.status === 'unavailable') return config
return config.value.declarations
```

- `parts` 返回 occurrence 路径、Part 声明和挂载位置。
- `config` 返回 Plugin / Part 配置字段、Schema 使用与定义位置，不执行默认值或转换。
- `dependencies` 返回 required / optional definition 地址、provider 关系和声明来源。
- `inputs` 返回所选应用的 config 表达式和 env/file bindings，不读取部署值。fork binding 保留 forkId；内容属于整个 definition。
- `checks` 返回所属 package 声明的 scripts，查询不会执行这些命令。

`partPath: ['delivery', 'retry']` 缩小 parts、config 和 dependency origins；依赖全集及 inputs 仍描述整个 Plugin。Section 的 `complete` 表示请求范围内分析完整，`partial` 保留可用值与 `gaps`，`unavailable` 保留 `reason`。未知表达式不能解释成空列表或不存在。

SDK 返回共享 Better Result。已知分析失败保留原 `code`、`message`、`context`；section gaps 和 unavailable 数据原样返回。旧 class 的实现证据在 HMR 替换后返回 `stale_target`，重新导入当前 class；动态身份可继续查询当前磁盘。长查询接受 signal，scope 关闭会撤回接纳并等待已接纳的查询及其资源结算。关闭后的调用返回 `scope_closed`，取消返回 `cancelled`；未知实现缺陷继续 reject。

## 应用无法启动、跨工作区和文件反查

没有可用 Host，或需要显式选择另一个 application、发现工作区声明、反查文件时，使用独立的 `@pluxel/rolldown/inspect`。它直接运行在 Node 环境，应用或 Schema 即使抛错也无需执行：

```ts no-twoslash
import { openProject } from '@pluxel/rolldown/inspect'

await using project = await openProject({ root: '/workspace/my-app' })
const plugins = await project.plugins({ packageName: '@example/mail', limit: 50 })
if (plugins.data.status === 'unavailable') throw new Error(plugins.data.reason.message)
const selected = plugins.data.value.items.find(
	(p) => p.definition.entry.kind === 'package-root' && p.exportName === 'MailPlugin',
)
if (!selected) throw new Error('MailPlugin was not found in this page')
const report = await project.plugin(selected.definition, {
	include: ['config', 'inputs'],
	application: { root: 'host', entry: 'src/app.ts' },
})
console.log(JSON.stringify(report, null, 2))
```

保存为 `dev/inspect.mts` 后运行 `node dev/inspect.mts`。发现结果中的完整 `definition` 直接用于后续查询；同名导出按完整 entry 区分。已知地址时直接传 definition，省去发现步骤。

`openProject({ root })` 固定观察工作区。每次查询读取当前磁盘并创建新的 resolver，不保留跨查询缓存。`application` 固定该次查询的解析来源；package 从其 entry 上下文解析，source-space 使用显式 `sourceSpaces` 映射。source-entry 和 `inputs` 查询要求显式 application；纯 package 查询省略它时使用观察工作区。离线解析使用原生 resolver 与正式源码条件，自定义 Vite alias/hook 不能据此推断。

`project.plugins({ packageName, limit, cursor })`、`overview({ limit, cursor })` 与 `file(path, { limit, cursor })` 默认每页 50，最多 200。继续读取 `nextCursor`，源码或查询改变后旧 cursor 返回 `cursor_stale`。`overview()` 同时给出 package scripts；`file('plugins/mail/src/schema.ts')` 在公开 Plugin 声明范围内反查 declaration、Part 和 Schema 归属。它们不扩大到任意 import 影响分析。

独立 API 以 `InspectionError` 报告查询级失败；SDK 后端只在其边界转换一次 Result。调用方通过 `await using` 关闭离线 scope；关闭拒绝新查询并排空已接纳工作。它不拥有 Host 或应用资源。

自定义同进程 Host 确实持有作者源码时，可以在原 Node 执行 owner 中显式安装同一后端。以下代码接在现有 Host 启动之后，owner 借用 Host，并在释放时排空自己的运行：

```ts no-twoslash
import { createNodeScriptOwner } from '@pluxel/host/agent/node'
import { createInspectionBackend } from '@pluxel/rolldown/inspect'

await using owner = createNodeScriptOwner({
	ctx: host.ctx,
	inspection: createInspectionBackend({
		root: '/workspace/my-app',
		application: { root: 'host', entry: 'src/app.ts' },
	}),
})
```

后端也可作为 `createScriptScope` 或 `executeHostScript` 的 `inspection` 输入，每次查询拥有并释放独立的离线 scope。可移植的 `@pluxel/host/agent` / runtime 本身不加载编译器、Vite 或文件系统；部署 Management 的默认 Node owner 继续不安装源码后端。
