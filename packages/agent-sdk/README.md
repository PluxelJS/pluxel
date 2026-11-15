# @pluxel/agent-sdk

Agent 和自动化调用方使用具名入口选择所需环境：

- `/source`：普通 Node 函数 `inspectPlugin`、`listPlugins`、`inspectFile`、`inspectProject`，直接查询磁盘源码。
- `/host`：`Script`、`ScriptSdk` 及 `createScriptScope`，操作进程内已启动的 Host。
- `/client`：普通 Node 函数，发现现有 Host、执行脚本、查询/取消原 receipt、控制 HMR 和同步控制材料。终端命令也使用这些函数。

官方 CLI 通过内部 `/internal/cli` 入口按需挂载 agent 命令；唯一可执行入口 `pluxel` 由 `@pluxel/cli` 提供。普通 Node 调用继续使用上述公共函数，完整说明见 [终端命令](../../docs/development/agent-sdk.md#终端命令)。

```js
import { inspectPlugin } from '@pluxel/agent-sdk/source'

const report = await inspectPlugin('package:@example/mail::MailPlugin', {
	root: process.cwd(),
})
console.log(report.data.summary.declaration)
```

源码查询无需 CLI、Host 或资源会话。源码与 Host 共享标准 definition/node 地址，各入口按需要加载依赖；包不提供混合根入口。完整用法见 [Agent SDK](../../docs/development/agent-sdk.md)、[源码查询](../../docs/development/inspection.md) 与[自动化脚本](../../docs/development/scripts.md)。
