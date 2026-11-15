# @pluxel/agent-sdk

Agent 和自动化调用方使用具名入口选择所需环境：

- `/source`：普通 Node 函数 `inspectPlugin`、`listPlugins`、`inspectFile`、`inspectProject`，直接查询磁盘源码。
- `/host`：`Script`、`ScriptSdk` 及 `createScriptScope`，操作已启动的 Host。

```js
import { inspectPlugin } from '@pluxel/agent-sdk/source'

const report = await inspectPlugin('package:@example/mail::MailPlugin', {
	root: process.cwd(),
})
console.log(report.data.summary.declaration)
```

源码查询无需 CLI、Host 或资源会话。两条入口共享标准 definition/node 地址，各自加载依赖；包不提供混合根入口。完整用法见 [Agent SDK](../../docs/development/agent-sdk.md)、[源码查询](../../docs/development/inspection.md) 与[自动化脚本](../../docs/development/scripts.md)。
