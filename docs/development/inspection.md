---
title: 查询插件源码
description: 用 TypeScript 找出包的插件、Part 组成、配置声明和依赖来源，为 coding agent 提供准确修改位置。
---

修改插件前，可以通过 `@pluxel/rolldown/inspect` 找到公开插件、Part 组成和配置声明。查询返回可以直接 JSON 序列化的数据及源码位置，不需要启动应用，也不会执行插件模块、schema 工厂或构建脚本。

源码查询适合回答“在哪里改、影响哪些声明”。检查当前生效配置、调用业务方法和验证在线状态，使用[开发控制台](./dev-console.md)；验证隔离的行为回归，使用[插件测试](./testing.md)。

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

只改一个 Part 时，通过它的实际字段路径缩小范围：

```ts no-twoslash
const report = await project.plugin('package:@example/mail::MailPlugin', {
	partPath: ['delivery', 'retry'],
	include: ['config', 'dependencies'],
})
```

`partPath` 选择该 occurrence 及其子树。同一个 Part class 挂载两次，会有两条不同路径。它们仍属于同一个 Plugin，不拥有独立插件身份。`dependencies.requires` / `optional` 始终描述整个所属 Plugin；`origins` 按选定子树缩小。

Config 的 `configPath` 是所属 occurrence 的路径：Plugin 根为 `[]`，Part 为它的 `partPath`，不会追加保存配置值的 class field 名称。`schema.usage` 定位 `configs.use()` 的 schema 参数；`schema.declaration` 定位可解析的 schema 声明。引用无法解析时后者为 `null`，并通过 section 缺口说明原因。内联 schema 的声明位置就是其使用位置。

这里只提供声明与定位，不推断完整 schema 字段、运行期默认值、校验输出或 Host binding。当前也没有 Vault、RPC 或应用声明 section。

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

`revision` 只标识本次观察到的文件内容集合，不是文件系统的原子快照，也不是 Host revision。未命中的解析候选、尚不存在的文件等负向查询不在这个集合中；不能用 revision 相同证明整个项目没有变化，或证明源码与当前运行实例一致。

调用失败使用 `InspectionError.code` 分支。例如 `package_not_found`、`plugin_not_found` 和 `part_not_found` 指向选择错误；`analysis_unavailable` 表示无法完成本次分析；`source_changed` / `cursor_stale` 可在源码稳定后重新查询。错误的 `message` 供诊断，不作为程序分支协议。

打开和每次查询都可以传入 `AbortSignal`；打开时的 signal 只控制打开过程。查询在一个 project 内串行执行，最多允许 16 个等待请求，超过时报告 `query_queue_full`。优先一次请求需要的 sections，减少重复分析。

`await using` 在作用域结束时释放查询对象；释放会拒绝新请求并等待已接纳的工作退出，重复释放安全。它不会启动 watcher 或保留在线应用资源。
