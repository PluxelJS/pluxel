---
title: 查询插件源码
description: 用 TypeScript 定位插件、Part、配置声明与应用输入，帮助 coding agent 找到修改位置和验证入口。
---

在修改或重构插件前，可以通过 `@pluxel/rolldown/inspect` 提供的静态代码分析接口，快速获取工作区内所有插件、Part 组成结构、配置项定义及宿主环境变量绑定。查询过程基于 AST 静态分析，直接输出纯 JSON 数据与精确的源码位置（文件绝对路径及行列号），无需启动应用或执行实际业务代码。

## 场景速查

| 查询目标 | 推荐调用方式 |
| :--- | :--- |
| 查询某个特定 npm 包内的插件 | `plugins({ packageName })` 获取定义后，调用 `plugin()` 深入分析 |
| 查询具体插件的完整结构 | `plugin(reference, { include: ['parts', 'config', 'dependencies'] })` |
| 根据文件反查归属插件 | `file(path)`，返回引用了该文件的插件及 Part 列表 |
| 定位宿主环境变量与配置文件映射 | `plugin(..., { application, include: ['inputs', 'config'] })` |
| 浏览工作区项目概览 | `overview()` 列出所有子包与可用脚本 |

## 查询子包中的插件定义

在工程中创建 `dev/inspect.mts`：

```ts no-twoslash
import { openProject } from '@pluxel/rolldown/inspect'

await using project = await openProject({ root: '/workspace/my-app' })

// 查询指定包中的插件导出
const plugins = await project.plugins({ packageName: '@example/mail' })
console.log(JSON.stringify(plugins, null, 2))
```

直接通过 Node.js 执行：

```sh
node dev/inspect.mts
```

- `openProject` 会自动解析 `pnpm-workspace.yaml` 中的子包成员列表。
- `plugins()` 会返回指定包暴露的具体 Plugin 类名与抽象依赖定义。

## 提取插件全量元数据

获取到插件定义后，可一次性提取其 Part 拓扑、配置项 Schema 与外部依赖关系：

```ts no-twoslash
if (plugins.data.status !== 'unavailable') {
	const selected = plugins.data.value.items.find((p) => p.exportName === 'MailPlugin')
	if (selected) {
		const report = await project.plugin(selected.definition, {
			include: ['parts', 'config', 'dependencies', 'checks'],
		})
		console.log(JSON.stringify(report, null, 2))
	}
}
```

各 Section 数据内容说明：
- `parts`：按挂载路径展开的所有 Part 实例、类声明代码位置及依赖；
- `config`：插件及各 Part 声明的配置字段、Schema 表达式及其原始定义位置；
- `dependencies`：当前插件必需（required）与可选（optional）的外部插件依赖列表；
- `checks`：该包在 `package.json` 中配置的构建、测试与类型检查 scripts；
- `inputs`：宿主应用中针对该插件配置的环境变量映射（Env Bindings）与配置文件路径（需指定 `application`）。

若仅需分析某个深层 Part，可通过 `partPath` 进行精准过滤：

```ts no-twoslash
const report = await project.plugin('package:@example/mail::MailPlugin', {
	partPath: ['delivery', 'retry'],
	include: ['config', 'dependencies'],
})
```

## 定位宿主应用的输入与环境映射

通过传入宿主应用的入口配置，可静态追踪该插件在具体应用中的环境变量与配置参数绑定：

```ts no-twoslash
const report = await project.plugin('package:@example/mail::MailPlugin', {
	application: { root: 'host', entry: 'src/app.ts' },
	include: ['config', 'inputs', 'checks'],
})

const inputs = report.data.sections.inputs
if (inputs.status === 'complete' || inputs.status === 'partial') {
	console.log('配置字段位置:', inputs.value.config)
	console.log('环境变量/文件绑定:', inputs.value.bindings)
}
```

- `bindings`：返回每项环境映射的声明代码行、对应的环境变量名称（如 `SMTP_PORT`）或本地配置文件路径。

## 根据文件反查关联插件

已知某份配置文件或工具代码时，可通过 `file()` 反查属于哪些插件：

```ts no-twoslash
const owners = await project.file('plugins/mail/src/retry-config.ts')
console.log(JSON.stringify(owners, null, 2))
```

返回包含该文件的 Plugin 声明、Part 声明或共享配置 Schema。

<span id="读取结果"></span>
<span id="读取结果和处理变化"></span>
## 结果状态与数据契约

返回的 `Inspection` 数据对象中包含 `root`、`revision` 与 `data`：
- `status: 'complete'`：在当前解析范围内完整提取了所有静态元数据；
- `status: 'partial'`：已提取部分可用事实，并在 `gaps` 中列出由于动态表达式或外部模块无法静态分析的节点；
- `status: 'unavailable'`：无法完成该 section 的分析，具体原因记录在 `reason` 字段中。

源码位置均采用绝对路径，行号与列号从 1 开始计数。每次调用均实时重新解析最新代码，修改代码后再次调用即可获得最新结果。
