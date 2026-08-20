import { BasePlugin, Plugin, v } from '@pluxel/runtime'

const MessageConfig = v.object({
	message: v.optional(v.string(), 'ready'),
})

@Plugin()
export class {{className}}Plugin extends BasePlugin {
	readonly config = this.configs.use(MessageConfig)

	override init(): void {
		this.ctx.logger.info('{{className}}Plugin ready', { message: this.config.message })
	}
}
