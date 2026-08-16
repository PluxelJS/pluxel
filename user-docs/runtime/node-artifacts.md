---
title: Node module 与 worker task
description: 为独立 Node ESM 和 CPU 密集工作选择正确的 artifact 与生命周期。
---

# Node module 与 worker task

Pluxel 提供两种独立构建的 Node artifact。它们解决的问题不同：

| 需求                                                  | 选择                 |
| ----------------------------------------------------- | -------------------- |
| 把另一份源码图构建成独立 Node ESM，并在当前线程 setup | `defineNodeModule()` |
| 把 CPU 密集、可 structured clone 的工作放入共享线程池 | `defineWorkerTask()` |
| 普通异步 I/O、数据库或短小调用                        | 直接在 Plugin 中执行 |

两种 declaration 都必须是 module-level、literal entry，交给 Pluxel build pipeline 提取。不要在 method 内动态声明 artifact。

## 独立 Node module

```ts twoslash
import { BasePlugin, defineNodeModule, Plugin } from '@pluxel/runtime'

const rulesModule = defineNodeModule(import.meta.url, './rules-entry.ts')

@Plugin({ displayName: 'Rules' })
export class RulesPlugin extends BasePlugin {
	override async init() {
		await this.ctx.nodeModules.use(rulesModule, async (url) => {
			const module = await import(url.href)
			return module.setup({ logger: this.ctx.logger })
		})
	}
}
```

`defineNodeModule()` 只声明 entry，不创建线程。`ctx.nodeModules.use()`：

- 等待 artifact 首次可用和 setup 完成；
- setup/import 失败会让 Plugin `init()` 失败；
- callback 返回的 cleanup/disposable 绑定当前 owner generation；
- 开发期 replacement 先 setup 新 URL，成功后再清理上一成功消费者；
- 新 artifact 失败时保留旧成功 consumer，不提交半成品。

artifact 是自包含单文件 Node ESM。它可以使用 Node builtin 和可安全 bundle 的普通 library，但不能 value-import Pluxel runtime/core、Plugin、Context 或 Workbench server API，也不能嵌套声明 Plugin/Workbench/Node module。

需要把 Context 能力交给 module 时，传入窄的、明确 owner 的 facade，不要传整个 Context 或 Plugin instance。

## 共享 worker task

持续占用 JavaScript event loop、thread-safe 且能用纯数据描述的 CPU/native 工作使用 worker task：

```ts twoslash
import { BasePlugin, defineWorkerTask, Plugin } from '@pluxel/runtime'

type SumInput = { values: number[] }
type SumOutput = { total: number }

const sumTask = defineWorkerTask<SumInput, SumOutput>(import.meta.url, './sum-worker.ts')

@Plugin({ displayName: 'Reports' })
export class ReportsPlugin extends BasePlugin {
	calculate(values: number[], signal?: AbortSignal) {
		return this.ctx.workers.run(sumTask, { values }, { signal })
	}
}
```

worker entry 默认导出 handler，并且没有 Pluxel Context：

```ts twoslash
import type { WorkerTaskHandler } from '@pluxel/runtime'

type SumInput = { values: number[] }
type SumOutput = { total: number }

const run: WorkerTaskHandler<SumInput, SumOutput> = ({ values }) => ({
	total: values.reduce((sum, value) => sum + value, 0),
})

export default run
```

所有 Plugin 共享 root-owned、lazy、bounded、owner-fair 的 worker pool。host 统一配置线程数、全局和每 Plugin queue limit、idle timeout；Plugin 不创建私有 Tinypool，也不自行扩大进程预算。

## 什么可以跨线程

输入输出必须满足 structured clone：

- 可以：plain object、array、string、number、boolean、`ArrayBuffer`、typed array；
- 不可以：function、closure、Context、Plugin instance、数据库连接、native Canvas/Image；
- native binding 必须明确 thread-safe，并由拥有它的 package 声明构建 metadata。

网络/数据库 I/O、短调用、不可重试 side effect 通常不应为了“统一”而进入 worker。worker cancellation 可能终止线程，任务必须能安全重做或丢弃。

## 大型二进制 transfer

默认输入在 `run()` 接纳时 snapshot。大型 `ArrayBuffer` 可以明确移交 ownership：

```ts no-twoslash
const bytes = new Uint8Array(await response.arrayBuffer())
const result = this.ctx.workers.run(
	decodeTask,
	{ bytes },
	{
		signal,
		transfer: [bytes.buffer],
	},
)

// 接纳成功后 bytes.buffer 已同步 detached。
return result
```

transfer 规则：

- 只接受 `ArrayBuffer`；
- 同一个 buffer 不能重复列出；
- accepted 后即使任务最终失败也不会恢复 ownership；
- queue 已满、任务未接纳时 runtime 不 detach；
- `SharedArrayBuffer` 本来就是共享内存，不进入 transfer，调用方自行负责同步协议。

## 取消与 Plugin stop

`run(task, input, { signal })` 的 signal 取消 admission 或运行中任务。Plugin stop/replacement 也会取消并等待该 owner 已接纳任务，不让旧 generation 在后台继续写结果。

不要只 fire-and-forget：

```ts no-twoslash
// 错误：调用方无法观察失败，业务也不知道结果是否提交。
void this.ctx.workers.run(task, input)
```

后台调用需要明确捕获 error、更新有界状态，并决定重试/丢弃。请求级任务把 Promise 返回给 HTTP/command 边界。

## Canvas 与 ECharts

native Canvas/Image 不能 structured clone。`@pluxel/canvas` 提供纯数据 `workerSnapshot` 和 `@pluxel/canvas/worker` adapter，让 worker 在自己的线程内创建 native surface；业务插件不直接传 native handle。

`@pluxel/echarts` 默认已经使用 runtime shared worker pool。调用方只需调用 `render()`，不要再套一层自建 worker。

## 构建与验证

Plugin build 会提取 literal declaration，并输出独立 artifact。验证至少覆盖：

- declaration 使用 literal relative entry；
- artifact 中没有 Pluxel runtime/Context import；
- input/output 可 clone，transfer 后调用方不再访问 buffer；
- queue full、abort、worker error 和 Plugin stop；
- native dependency metadata 与真正 package owner 一致。

构建产物与缓存位置见 [CLI 与工具链](../development/tooling.md)，测试 host 选择见 [测试 Pluxel 插件](../development/testing.md)。
