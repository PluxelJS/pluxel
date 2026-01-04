import { BasePlugin, Plugin } from '@pluxel/core'

/**
 * Demo: abstract base tokens + base-provider selection.
 *
 * - Enable exactly one provider plugin (DemoClock.*)
 * - Then enable DemoClockConsumer
 * - In UI: Plugin → 依赖注入 → (基类) DemoClock → 选择实现
 */
export abstract class DemoClock extends BasePlugin {
	abstract now(): number
	format(ts = this.now()): string {
		return new Date(ts).toISOString()
	}
}

@Plugin(DemoClock, { name: 'DemoClock.System', type: 'demo' })
export class DemoClockSystem extends DemoClock {
	override init(): void {
		this.ctx.logger.info`ready ${this.ctx.pluginInfo.id}`
	}

	now(): number {
		return Date.now()
	}
}

@Plugin(DemoClock, { name: 'DemoClock.Fixed', type: 'demo' })
export class DemoClockFixed extends DemoClock {
	private fixed = Date.now()

	override init(): void {
		this.fixed = Date.now()
		this.ctx.logger.info(l => l`ready ${this.ctx.pluginInfo.id} (fixed=${this.format(this.fixed)})`)
	}

	now(): number {
		return this.fixed
	}
}

@Plugin({ name: 'DemoClockConsumer', type: 'demo' })
export class DemoClockConsumer extends BasePlugin {
	constructor(private clock: DemoClock) {
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
