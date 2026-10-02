---
title: 编写第一个插件
description: 从 CLI 模板完成普通方法、配置、日志和资源清理，不需要额外 Host 服务。
---

在[快速开始](./index.md)中运行应用后，这篇教程带你创建一个可独立发布的 Plugin 包，加入普通业务方法、配置、日志和定时资源，并用测试验证启动与清理。这个插件只使用 Core 基础机制，不要求 HTTP、Vault 或 Workbench。

## 创建独立插件包

在 `my-app` 所在的父目录执行以下命令。这篇练习先用独立包验证插件，接入应用宿主的步骤见文末。

```sh
pnpm dlx @pluxel/cli@1 new --template plugin --name @acme/pluxel-plugin-status --root .
cd status
pnpm add -D @types/node@24 --save-catalog
pnpm verify
```

生成命令默认安装依赖。本例额外安装 Node.js 类型，因为下面会使用计时器；`--save-catalog` 将版本加入模板已有的 catalog。
模板已配置好导出、构建、测试和热更新；接下来只需修改两个文件：

```text
src/status.ts
tests/status.test.ts
```

## 编写 Plugin

用下面的内容替换 `src/status.ts`：

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'

export const StatusConfig = v.object({
	label: v.optional(v.string(), 'ready'),
	intervalMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_000)), 30_000),
})

@Plugin({ displayName: 'Status' })
export class StatusPlugin extends BasePlugin {
	private readonly config = this.configs.use(StatusConfig)
	private samples = 0

	protected override init(): void {
		this.ctx.logger.info('status sampler started', { label: this.config.label })

		const timer = setInterval(() => {
			this.samples += 1
		}, this.config.intervalMs)
		this.ctx.effects.defer(() => clearInterval(timer), { tag: 'status-sampler' })
	}

	snapshot() {
		return { label: this.config.label, samples: this.samples }
	}
}
```

这个文件包含四个固定位置：

| 内容                     | 位置                                   |
| ------------------------ | -------------------------------------- |
| identity 和展示 metadata | module-level `@Plugin()` class         |
| config contract          | class-level `this.configs.use()` field |
| 日志和长期资源           | `init()`                               |
| 资源释放                 | 当前 Context 的 `effects`              |

默认值和范围只写在 schema 中。constructor 只用于 required Plugin dependency；当前 Plugin 没有依赖，所以省略。

## 验证运行结果

用下面的内容替换 `tests/status.test.ts`：

```ts no-twoslash
import { createTestHost } from '@pluxel/test'
import { expect, it, vi } from 'vitest'
import { StatusPlugin } from '@acme/pluxel-plugin-status'

it('reads config and stops its sampler', async () => {
	vi.useFakeTimers()
	try {
		await using host = await createTestHost()
		const plugin = await host.start(StatusPlugin, {
			initialConfig: { label: 'healthy', intervalMs: 1_000 },
		})
		expect(plugin.snapshot()).toEqual({ label: 'healthy', samples: 0 })
		vi.advanceTimersByTime(1_000)
		expect(plugin.snapshot().samples).toBe(1)
		await host.stop(StatusPlugin)
		vi.advanceTimersByTime(1_000)
		// 测试宿主返回 raw fixture；这里只观察停止后计时器没有继续修改它。
		expect(plugin.snapshot().samples).toBe(1)
	} finally {
		vi.useRealTimers()
	}
})
```

`createTestHost()` 无需传入 services 即可验证 Core 插件。它使用真实配置校验、依赖图和 lifecycle；`initialConfig` 只建立首次启动配置，后续更新使用 `host.config.patch()`。`await using` 在作用域结束后关闭 host。

测试先观察业务结果，再确认 stop 撤销了定时任务。logger 写法可用，但可见输出由宿主的 Logging 配置决定；不安装 Logging 不影响 Plugin 使用 `ctx.logger`。

运行完整检查：

```sh
pnpm verify
```

## 接下来

- 发布通知或订阅提供方事件：[事件](../plugin-development/events.md)
- 写诊断与结构化字段：[日志](../plugin-development/logging.md)
- 管理后台工作和清理：[生命周期](../plugin-development/lifecycle.md)
- 添加 required 或 optional dependency：[插件依赖与组成](../plugin-development/model.md)
- 拆分 owner 内部的 config、registration 和 cleanup：[使用 PluginPart](../plugin-development/parts.md)
- 增加配置字段和表单 metadata：[配置模型](../plugin-development/configuration.md)
- 把 Plugin 放进应用宿主：[配置插件宿主](../host/configuration.md)
- 覆盖失败、replacement 和 rollback：[测试 Pluxel 插件](../plugin-development/testing.md)

只有要对外提供网络接口时，再按[HTTP 指南](../plugin-development/http.md)安装服务并添加路由；管理页面和其他服务同样按需选择。
