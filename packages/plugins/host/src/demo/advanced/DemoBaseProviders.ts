// Advanced: read this when:
// - 你需要“抽象能力 token + 多个 provider 实现”
// - 你不想让 consumer 依赖某个具体插件类

import { BasePlugin, Plugin } from '@pluxel/runtime'

export abstract class DemoClock extends BasePlugin {
	abstract now(): number
	format(ts = this.now()): string {
		return new Date(ts).toISOString()
	}
}

@Plugin(DemoClock, { name: 'DemoClock.System' })
export class DemoClockSystem extends DemoClock {
	override init(): void {
		this.logReady()
	}

	now(): number {
		return Date.now()
	}

	private logReady() {
		this.ctx.logger.info('ready', { id: this.ctx.pluginInfo.id })
	}
}

@Plugin(DemoClock, { name: 'DemoClock.Fixed' })
export class DemoClockFixed extends DemoClock {
	private fixed = Date.now()

	override init(): void {
		this.fixed = Date.now()
		this.logReady()
	}

	now(): number {
		return this.fixed
	}

	private logReady() {
		this.ctx.logger.info('ready', { id: this.ctx.pluginInfo.id, fixed: this.format(this.fixed) })
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
