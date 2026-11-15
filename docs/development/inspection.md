---
title: 查询插件源码
description: 通过 @pluxel/agent-sdk/source 的普通函数发现插件、定位声明、Part、Schema、依赖和应用输入。
---

`@pluxel/agent-sdk/source` 提供普通异步函数。安装依赖后，用 Node 即可查询磁盘源码；查询不启动 Host、不加载项目模块、不执行应用工厂或 Schema。运行中的应用操作使用 [`@pluxel/agent-sdk/host`](./agent-sdk.md)。

## 直接定位声明

将以下内容保存为项目根的 `inspect.mjs`，执行 `node inspect.mjs`：

```js
import { inspectPlugin } from '@pluxel/agent-sdk/source'

const report = await inspectPlugin('package:@example/todo-plugin::TodoPlugin', {
	root: process.cwd(),
})
console.log(report.data.summary.declaration)
```

`root` 固定本次查询的观察工作区。目标接受标准 definition 对象或 definition reference；从运行节点取得的 `address.definition`、依赖结果的 definition 可直接传入。无需导入和执行 Plugin class 来取得地址。

声明位置包含绝对 `file` 和 `start/end: { line, column }`。行列从 1 开始，column 按 UTF-16 计数，end 不包含在范围内。编辑器或 agent 可直接打开该位置。

查询应用自己的源码或配置绑定时，显式指定解析来源：

```js
const application = { root: 'host', entry: 'src/app.ts' }
const report = await inspectPlugin('source:app/src/mail.ts::MailPlugin', {
	root: process.cwd(),
	application,
	include: ['config', 'inputs'],
})
console.log(report.data)
```

`application.root` 相对观察工作区，`entry` 相对 application root。默认 `app` source-space 对应该应用根目录，额外映射通过 `application.sourceSpaces` 提供。source-entry 和 `inputs` 查询要求 application；package 查询提供 application 时从其 entry 解析依赖，省略时从观察工作区解析。

仓库已有可运行示例：`node projects/plugin-host/dev/source.mjs`。生成项目使用 `node dev/inspect.mjs`。

## 发现与文件反查

同一入口提供四个函数：

| 函数                                 | 用途                                       |
| ------------------------------------ | ------------------------------------------ |
| `inspectPlugin(definition, options)` | 定位声明，按需取得结构和应用绑定           |
| `listPlugins(options)`               | 分页发现定义，返回可继续查询的 definition  |
| `inspectFile(path, options)`         | 反查文件所属的 Plugin、Part 和 Schema      |
| `inspectProject(options)`            | 列出工作区 package 及根 package 的 scripts |

所有 options 都要求 `root`。`listPlugins`、`inspectFile` 和 `inspectProject` 默认每页 50，最多 200；把非空 `nextCursor` 交给相同查询的 `cursor` 参数。查询输入或观察到的源码变化后返回 `cursor_stale`，从第一页重新查询。

```js
import { listPlugins, inspectPlugin } from '@pluxel/agent-sdk/source'

const options = {
	root: process.cwd(),
	application: { root: 'host', entry: 'src/app.ts' },
}
const found = await listPlugins({ ...options, limit: 50 })
if (found.data.status === 'unavailable') throw new Error(found.data.reason.message)
for (const item of found.data.value.items) {
	const report = await inspectPlugin(item.definition, options)
	console.log(report.data.summary.declaration)
}
```

发现范围由输入决定：

- 省略 application 时，查询工作区 package 的公开插件入口；`packageName` 可定位某个工作区或已安装 package。
- 提供 application 时，沿 entry 的静态 import/re-export 和字面量动态 import，查找显式 source-spaces 内的 TypeScript 声明。应用无需 package exports。结果描述源码图；运行时安装的节点由 Host 发现。
- 同时提供 application 与 packageName 时，从该应用解析指定 package 的公开入口。

未知动态 import 和无法读取的源码保留 `partial.gaps`。`inspectFile` 使用同样的范围，返回 `scope`、定义及 declaration/part/config-schema 关系；它不分析任意 import 的修改影响。

## 结构与依赖

`inspectPlugin` 默认只返回 `summary`，通过 `include` 选择其他 section：

- `parts`：occurrence 路径、Part 声明与挂载位置。
- `config`：Plugin/Part 配置字段、Schema 使用与定义位置。
- `dependencies`：required/optional definition、provider 关系和声明来源。
- `inputs`：应用 config 表达式及 env/file bindings 的源码位置，保留 forkId；不读取部署值。
- `checks`：所属 package 声明的 scripts；查询不会执行命令。

```js
const report = await inspectPlugin(definition, {
	root: process.cwd(),
	application,
	include: ['dependencies'],
})
const dependencies = report.data.sections.dependencies
if (dependencies.status === 'unavailable') throw new Error(dependencies.reason.message)
for (const required of dependencies.value.requires) {
	console.log(await inspectPlugin(required, { root: process.cwd(), application }))
}
```

抽象 token 与具体 Plugin 使用同样的 definition 查询。`partPath: ['delivery', 'retry']` 缩小 parts、config 和 dependency origins；依赖全集与 inputs 仍描述整个 Plugin。

Section 的 `complete` 表示请求范围内分析完整；`partial` 保留可用值和 `gaps`；`unavailable` 保留 `reason`。未知表达式不会被解释成空列表。

## 结果与失败

每个函数返回 `Inspection<T>`，包含 `root`、`revision`、`data` 和 `source`。`source.content: 'current-disk'`、`environment: 'query-process'` 表示位置属于执行查询的进程；`runtimeMatch: 'unverified'` 表示未核对运行版本。HMR 暂停、应用损坏或未启动时仍可查询磁盘。

作者源码通过正式 package source conditions 或 canonical source-space 解析。控制 `.d.ts` 和普通构建 JavaScript 不充当作者源码；缺少源码时保留具体诊断。解析使用原生 resolver 与正式源码条件，自定义 Vite alias/hook 应显式对应到查询输入。

查询级失败 reject `InspectionError`，调用方可按 `code` 分支。源码在查询期间变化返回 `source_changed`；传入 `signal` 可取消，返回 `aborted`。每次调用自行完成并释放文件 IO，结果是冻结的普通数据，不要求创建会话或执行 dispose。
