---
title: Agent SDK
description: 通过 @pluxel/agent-sdk 的 host 与 source 子入口选择运行操作或普通源码查询。
---

`@pluxel/agent-sdk` 是面向 agent 和自动化调用方的公共库，按操作所需环境选择子入口：

| 入口                       | 环境                | 调用                                                                      |
| -------------------------- | ------------------- | ------------------------------------------------------------------------- |
| `@pluxel/agent-sdk/source` | Node 与可读取的源码 | 普通 `inspectPlugin`、`listPlugins`、`inspectFile`、`inspectProject` 函数 |
| `@pluxel/agent-sdk/host`   | 已启动的 Host       | Script SDK 或 `createScriptScope({ ctx })`                                |

`/source` 的函数接收显式工作区，直接用 `node query.mjs` 调用；用法见[源码查询](./inspection.md)。同一个标准 definition 可来自源码发现、生成控制入口或运行节点的 `address.definition`。

`/host` 导出 `Script`、`ScriptSdk` 与控制类型。远端脚本由现有执行通道注入 SDK，见[自动化脚本](./scripts.md)。持有现成 Host 的进程也可以直接借用它：

```ts no-twoslash
import { createScriptScope } from '@pluxel/agent-sdk/host'

await using scope = createScriptScope({ ctx: host.ctx })
const status = await scope.sdk.plugin(nodeAddress).status()
if (status.isErr()) throw new Error(status.error.message)
console.log(status.value)
```

Host scope 跟踪已接纳的操作，关闭时排空操作，Host 的寿命仍由创建者管理。`/host` 不加载源码分析器；`/source` 不创建 Host、脚本执行器或远端连接。包不提供混合两者的根入口。

Vite 项目脚本使用 `@pluxel/host-vite/project` 的 `ProjectScript`，在同一 Host SDK 上增加真实模块图和 Context 访问，见[开发控制台](./dev-console.md)。
