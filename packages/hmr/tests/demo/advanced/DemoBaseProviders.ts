// packages/hmr/tests/demo/advanced/DemoBaseProviders.ts
// 演示：抽象基类 Token + 多实现（Provider 选择）
//
// 适用场景：
// - 你希望下游只依赖“能力接口”（抽象类/接口），而不固定依赖某个具体插件实现
// - 由宿主/用户在 UI 中选择实际实现（Provider）
//
// 玩法（在 UI → 插件 → 依赖注入）：
// - 只启用一个 Provider：DemoClock.System 或 DemoClock.Fixed（二选一）
// - 再启用 DemoClockConsumer，观察注入到的 provider 变化

import { BasePlugin, Plugin } from '@pluxel/hmr'

export abstract class DemoClock extends BasePlugin {
	abstract now(): number
	format(ts = this.now()): string {
		return new Date(ts).toISOString()
	}
}

@Plugin(DemoClock, { name: 'DemoClock.System' })
export class DemoClockSystem extends DemoClock {
	override init(): void {
		this.ctx.logger.info('ready', { id: this.ctx.pluginInfo.id })
	}

	now(): number {
		return Date.now()
	}
}

@Plugin(DemoClock, { name: 'DemoClock.Fixed' })
export class DemoClockFixed extends DemoClock {
	private fixed = Date.now()

	override init(): void {
		this.fixed = Date.now()
		this.ctx.logger.info('ready', { id: this.ctx.pluginInfo.id, fixed: this.format(this.fixed) })
	}

	now(): number {
		return this.fixed
	}
}

@Plugin({ name: 'DemoClockConsumer' })
export class DemoClockConsumer extends BasePlugin {
	constructor(private readonly clock: DemoClock) {
		super()
	}

	override init(): void {
		this.ctx.logger.info('injected base provider', {
			consumer: this.ctx.pluginInfo.id,
			provider: this.clock.ctx.pluginInfo.id,
			now: this.clock.format(),
		})
	}
}

