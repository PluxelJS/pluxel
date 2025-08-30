import { type Awaitable, BasePlugin, Config, Plugin, v } from '@pluxel/hmr'

const CfgSchema = v.object({ test: v.optional(v.boolean(), true)})

@Plugin({ name: 'example' })
export class Example extends BasePlugin {
	@Config(CfgSchema) 
	private config!: Config<typeof CfgSchema>

	constructor() {
		super()
	}
	async init(_abort: AbortSignal): Promise<void> {
		this.ctx.logger.info('Example initialized')
	}

	async stop(_abort: AbortSignal): Promise<void> {
		this.ctx.logger.info('Example stoped')
	}
}
