# @pluxel/agent-sdk

Agent 和自动化调用方使用具名入口选择所需环境：

- `/source`：普通 Node 函数 `inspectPlugin`、`listPlugins`、`inspectFile`、`inspectProject`，直接查询磁盘源码。
- `/host`：`Script`、`ScriptSdk` 及 `createScriptScope`，操作进程内已启动的 Host。
- `/client`：普通 Node 函数，发现现有 Host、执行脚本、查询/取消原 receipt、控制 HMR 和同步控制材料。CLI 使用同一实现。

```js
import { inspectPlugin } from '@pluxel/agent-sdk/source'

const report = await inspectPlugin('package:@example/mail::MailPlugin', {
	root: process.cwd(),
})
console.log(report.data.summary.declaration)
```

源码查询无需 CLI、Host 或资源会话。源码与 Host 共享标准 definition/node 地址，各入口按需要加载依赖；包不提供混合根入口。完整用法见 [Agent SDK](../../docs/development/agent-sdk.md)、[源码查询](../../docs/development/inspection.md) 与[自动化脚本](../../docs/development/scripts.md)。
