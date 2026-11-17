---
title: 编写第一个插件
description: 从零构建一个包含业务方法、Valibot 配置校验、结构化日志与生命周期清理的独立插件。
---

本篇教程带你从零实现一个独立的状态采样插件（`StatusPlugin`）。通过这个例子，你将掌握 Pluxel 插件最核心的四个机制：

1. 使用 `@Plugin()` 装饰器声明插件身份；
2. 使用 Valibot 定义并注入强类型配置；
3. 在 `init()` 钩子中启动后台工作并输出日志；
4. 使用 `ctx.effects.defer()` 登记资源清理回调，确保插件停止时无泄漏。

## 初始化插件包

在终端中执行以下命令生成一个插件模板并安装基础开发依赖：

```sh
vp dlx @pluxel/cli@1 new --template plugin --name @acme/pluxel-plugin-status --root .
cd status
vp add -D @types/node@24 --save-catalog
vp run verify
```

模板会自动生成标准插件项目结构。我们将主要关注两个核心文件：

- `src/status.ts`：插件的实现代码。
- `tests/status.test.ts`：插件的自动化测试。

## 编写插件逻辑

打开 `src/status.ts`，写入以下代码：

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'

// 1. 定义配置 Schema：包含默认值与校验规则
export const StatusConfig = v.object({
	label: v.optional(v.string(), 'ready'),
	intervalMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_000)), 30_000),
})

// 2. 声明插件类
@Plugin({ displayName: 'Status' })
export class StatusPlugin extends BasePlugin {
	// 3. 注入配置：框架自动校验并返回深度冻结的配置对象
	private readonly config = this.configs.use(StatusConfig)
	private samples = 0

	// 4. 插件初始化：启动后台采样任务
	protected override init(): void {
		this.ctx.logger.info('Status sampler started', { label: this.config.label })

		const timer = setInterval(() => {
			this.samples += 1
		}, this.config.intervalMs)

		// 5. 登记资源清理：插件卸载、重启或热重载时自动执行
		this.ctx.effects.defer(() => clearInterval(timer), { tag: 'status-sampler' })
	}

	// 6. 暴露业务方法给调用方
	snapshot() {
		return { label: this.config.label, samples: this.samples }
	}
}
```

### 关键设计点

- **配置即契约**：使用 Valibot 的 `v.optional` 表达默认值。业务逻辑中直接读取 `this.config.label`，不需要在代码各处重复编写类似 `?? 'ready'` 的回退逻辑。
- **副作用就近登记**：在启动定时器的同时，通过 `this.ctx.effects.defer()` 立即注册清理函数。当插件生命周期结束时，框架会严格按序触发释放，避免定时器持续占用系统资源。

## 编写单元测试

Pluxel 提供了 `@pluxel/test` 工具库，允许我们在隔离环境中快速验证插件的行为与资源释放。

打开 `tests/status.test.ts`，填入以下测试用例：

```ts no-twoslash
import { createTestHost } from '@pluxel/test'
import { expect, it, vi } from 'vitest'
import { StatusPlugin } from '../src/status'

it('能够正确读取配置，并在停止后销毁定时器', async () => {
	vi.useFakeTimers()
	try {
		// 创建测试宿主并在当前作用域结束时自动释放
		await using host = await createTestHost()

		// 启动待测插件，并传入自定义初始配置
		const plugin = await host.start(StatusPlugin, {
			initialConfig: { label: 'healthy', intervalMs: 1_000 },
		})

		// 校验初始状态
		expect(plugin.snapshot()).toEqual({ label: 'healthy', samples: 0 })

		// 时间推进 1 秒，观察采样数递增
		vi.advanceTimersByTime(1_000)
		expect(plugin.snapshot().samples).toBe(1)

		// 停止插件
		await host.stop(StatusPlugin)

		// 再次推进时间，确认后台定时器已彻底停止
		vi.advanceTimersByTime(1_000)
		expect(plugin.snapshot().samples).toBe(1)
	} finally {
		vi.useRealTimers()
	}
})
```

运行测试验证：

```sh
vp run verify
```

如果所有检查项均通过，说明你的第一个插件已经具备了规范的配置校验、生命周期管理与自动化测试保障。

## 进阶探索

掌握了单插件的基础写法后，你可以继续探索更多高级能力：

- [插件依赖拓扑](../plugin-development/model.md)：如何在构造函数中注入其他插件，或声明可选依赖。
- [结构化日志最佳实践](../plugin-development/logging.md)：使用上下文日志记录关键指标与调试信息。
- [插件拆分与 Part 机制](../plugin-development/parts.md)：使用 `PluginPart` 将庞大插件的内部状态模块化拆分。
- [接入宿主应用](../host/configuration.md)：将写好的插件打包并注册进完整的宿主应用中。
